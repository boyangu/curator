// Unified audio coordinator. Dispatches to either Spotify's Web Playback SDK
// (for Spotify tracks, requires Premium) or @tidal-music/player (for Tidal
// tracks, uses the sniffed listen.tidal.com bearer). The renderer treats
// both via the same play/pause/seek API; provider selection is per-track
// based on which source-link is available.
//
// Queue model: when play(track) is called, the queue is built from the
// visible playlist's `currentTracks` array starting at the played track's
// index. On natural track-end we advance one step. Cross-source advance
// works — if the next track has a different provider, we stop the current
// SDK and start the other.

// Tidal playback is gated off for now — the SDK integration is wired but
// disabled until we finish auth/streaming testing. Re-enable by uncommenting
// the imports below, the Tidal branches in play()/togglePause()/seekBy(), and
// the ensureTidal() body.
//
// import {
// 	bootstrap as tidalBootstrap,
// 	setCredentialsProvider as tidalSetCreds,
// 	load as tidalLoad,
// 	play as tidalPlay,
// 	pause as tidalPause,
// 	seek as tidalSeek,
// 	reset as tidalReset,
// 	getAssetPosition as tidalGetPosition,
// 	getPlaybackState as tidalGetState,
// 	events as tidalEvents,
// 	type MediaProduct,
// 	type MediaProductTransition,
// } from '@tidal-music/player';
// import type { CredentialsProvider, Credentials } from '@tidal-music/common';
import type { Track } from '@curator/shared';
import { formatArtistCredit, type TrackArtist } from '@curator/shared';
import { artistCreditFormat } from './features/uiSettings.js';
import { createEffect, createRoot, createSignal, type Accessor } from 'solid-js';
import { createMutable } from 'solid-js/store';
import { acquireLoopbackAnalyser } from './spectrum.js';
import { log } from './data/log.js';
import { isRemoteRow, RemoteOnlyPlayError } from './remoteRows.js';

const slog = log.for('player');
// Seek/jump latency instrumentation fires on every seek gesture (incl.
// controller-driven beat jumps) — debug keeps it DevTools-only.
const seekLog = log.for('seek');

// Spotify playback now lives in a dedicated sidecar process
// (apps/spotify-player/) that hosts the Web Playback SDK + Widevine. The
// renderer drives it over the `spotify:rpc` IPC channel and consumes its push
// events via onSpotifyEvent — no SDK, no <audio> element, no Widevine in this
// process. See [[curator]] CLAUDE.md "Spotify playback" + the sidecar host at
// apps/desktop/src/main/spotify-sidecar.ts.

export type PlayableTrack = {
	trackId: string;          // our internal track UUID
	source: 'spotify' | 'tidal' | 'local';
	sourceTrackId: string;    // the provider's id, OR for local: the normalized file path
	title: string;
	artist: string;
	// Structured credits beside the flat display string — the now-playing
	// surfaces render one clickable name per artist from these. Names only
	// (feed plays carry no Curator ids); the click resolves by name.
	artists?: TrackArtist[];
	duration: number;
	coverUrl: string | null;
	// True when a `local` source_link exists on this track even if the
	// caller's tab is Spotify/Tidal. UI shows a "local" chip in the
	// now-playing strip regardless of which backend is driving.
	hasLocal?: boolean;
};

export type PlayerState = {
	current: PlayableTrack | null;
	position: number;
	duration: number;
	playing: boolean;
	// 0-1. Applied to whichever backend is currently driving (Spotify SDK /
	// local Web Audio gain node). Persisted to localStorage so it survives restart.
	volume: number;
	// True between play() click and audio actually starting. Used by the
	// now-playing UI to show a "loading" indicator while local decode runs
	// (typically 100-500ms for FLAC) or Spotify start-up rolls. Spotify
	// path sets/clears this around its play network roundtrip.
	loading: boolean;
	// VU meter input — per-channel max-abs output sample observed by the
	// audio callback over the last ~50ms tick. Only updated on the local
	// backend (Spotify/Tidal play through their SDKs, which the sidecar
	// doesn't see). The VU meter component runs its own rAF loop to smooth
	// the live bar + drive a peak-hold dot, so the store carries the raw
	// tick value rather than a pre-decayed signal.
	peakL: number;
	peakR: number;
};

const VOLUME_LS_KEY = 'curator.player.volume';
function loadInitialVolume(): number {
	try {
		const v = parseFloat(localStorage.getItem(VOLUME_LS_KEY) ?? '');
		if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
	} catch { /* SSR / disabled storage */ }
	return 0.7;
}

// ─── Auto-play-next preference (per player-mode) ─────────────────────────────
// Two independent toggles, surfaced in Settings → Player. When a track ends
// NATURALLY and the matching mode's flag is on, the queue rolls into the next
// track in the list; off → playback parks at end-of-track. "User played a new
// one explicitly" needs no special-casing: a fresh play() stops the prior
// track, so the `ended` event only ever fires on natural completion.
//
// The mode is the backend that produced the `ended` event: local files →
// 'local', Spotify/Tidal (incl. the Discover feed, which runs on the Spotify
// backend) → 'streaming'. Split per-mode so a DJ-prep workflow (manual, no
// auto-advance) and a lean-back streaming workflow (auto-advance) can differ.
// Defaults ON for both — preserves the prior unconditional advance behaviour.
export type PlayerMode = 'streaming' | 'local';
const AUTOPLAY_LS_KEY: Record<PlayerMode, string> = {
	streaming: 'curator.player_streaming_autoplay',
	local: 'curator.player_local_autoplay',
};
function loadAutoplayNext(mode: PlayerMode): boolean {
	try {
		const v = localStorage.getItem(AUTOPLAY_LS_KEY[mode]);
		return v == null ? true : v === '1'; // default ON when unset
	} catch { return true; }
}
const autoplayNext: Record<PlayerMode, boolean> = {
	streaming: loadAutoplayNext('streaming'),
	local: loadAutoplayNext('local'),
};
export function getAutoplayNext(mode: PlayerMode): boolean {
	return autoplayNext[mode];
}
export function setAutoplayNext(mode: PlayerMode, on: boolean): void {
	autoplayNext[mode] = on;
	try { localStorage.setItem(AUTOPLAY_LS_KEY[mode], on ? '1' : '0'); } catch { /* private mode */ }
}

// Reactive store. createMutable wraps the object in a deep proxy — existing
// `state.position = …` mutations elsewhere in this file continue to work
// unchanged, but now also notify subscribers through Solid's tracking
// system. Replaces the previous hand-rolled `listeners[]` + `emit()` pair.
//
// Behavioural change vs. the old pub/sub: subscribers only re-fire when a
// field they actually read changes (instead of on every emit). The four
// existing subscribers in main.ts (renderPlayer, setNowPlayingTrackId,
// duration-watch, analysis-loader) all either read everything or read a
// single field — both shapes are strictly better-served by the new model.
const state: PlayerState = createMutable<PlayerState>({
	current: null, position: 0, duration: 0, playing: false, volume: loadInitialVolume(), loading: false,
	peakL: 0, peakR: 0,
});
let queue: Track[] = [];
let queueIndex = -1;

// Full Track snapshot of what's playing, captured at play() time. The
// now-playing surfaces (NowPlayingCard, SmallPlayer) read BPM / key / rating /
// genre / label off the visible-tracks cache keyed by id — but that cache is
// rebuilt from whatever list is on screen, so removing the playing track from
// the current playlist (or navigating away) evicts the row and blanks those
// fields under the still-playing audio. This snapshot is the player's OWN copy,
// independent of any list view; the display falls back to it when the cache no
// longer holds the row. Null for feed plays (no library Track) and when
// nothing is playing.
const [nowPlayingTrack, setNowPlayingTrack] = createSignal<Track | null>(null);
export const currentTrack: Accessor<Track | null> = nowPlayingTrack;

// Patch the snapshot in place when the playing track's data changes out from
// under it (e.g. a rating edit from the player's own star row while the row is
// absent from the visible cache). No-op when the id doesn't match what's
// playing. Replaces the object so the signal notifies its readers.
export function patchCurrentTrack(trackId: string, patch: Partial<Track>): void {
	const cur = nowPlayingTrack();
	if (!cur || cur.id !== trackId) return;
	setNowPlayingTrack({ ...cur, ...patch });
}
// Single source of truth for "which backend currently owns playback". The
// Spotify SDK keeps emitting state_changed events for ~1s after pause(),
// and those events overwrite state.current with the Spotify track shape.
// Without this gate, a fast Spotify→Local switch results in the player UI
// snapping back to the Spotify track (and to the user, both look like
// they're playing). All backend handlers that write to state.current /
// state.position / state.duration / state.playing now check this first.
let activeBackend: 'spotify' | 'tidal' | 'local' | null = null;

export class TidalNotReadyError extends Error {
	constructor() { super('Tidal playback — coming soon'); this.name = 'TidalNotReadyError'; }
}

// Play-history lifecycle taps (play-tracker.ts). The tracker infers most
// transitions from the reactive store (new track = replaced, pause = idle);
// only two moments are invisible to it — natural end-of-track ('ended' fires
// before autoplay decides what's next) and running off the end of the queue
// via manual next(). Same registration shape as setFeedAdvanceHandler.
let playLifecycleHook: ((evt: 'ended' | 'queue_end') => void) | null = null;
export function setPlayLifecycleHook(fn: (evt: 'ended' | 'queue_end') => void): void {
	playLifecycleHook = fn;
}

// External API is unchanged: cb runs immediately with the current state,
// re-runs whenever any field it READ inside the callback changes, returns
// an unsubscribe that disposes the underlying effect. Each subscribe is
// its own createRoot so disposal is per-subscriber, not global.
export function subscribe(cb: (s: PlayerState) => void): () => void {
	return createRoot((dispose) => {
		createEffect(() => { cb(state); });
		return dispose;
	});
}

export function getState(): PlayerState { return state; }

// Which source-capable tab the currently-playing audio comes from — the
// playback *backend*, not the tab that initiated play. Null when nothing is
// actively playing (stopped or paused), so a paused track shows no tab
// marker. `local` audio is Rekordbox-managed, so it maps onto the Rekordbox
// tab; `tidal` has no backend yet. Reading state.current/state.playing makes
// this reactive wherever it's called inside a tracking scope (e.g. JSX).
export function currentSource(): 'spotify' | 'rekordbox' | null {
	if (!state.current || !state.playing) return null;
	switch (state.current.source) {
		case 'local': return 'rekordbox';
		case 'spotify': return 'spotify';
		default: return null; // tidal deferred — no backend
	}
}

// No-op shim — createMutable already triggers reactivity on every mutation,
// so emit() is redundant. Kept as a no-op for one round so the 10+ call
// sites in this file (handleSpotifyStateChange, local audio handlers,
// setVolume, seekBy, advanceQueue, …) don't need to be touched in the
// same change that swaps the reactivity engine. Follow-up cleanup deletes
// every emit() call and this declaration together.
function emit(): void { /* superseded by createMutable */ }

// Tell the Spotify sidecar to load the SDK + connect a device without playing
// anything. Idempotent. Called at boot (once Spotify is confirmed connected)
// so the first play targets an already-ready device. Fire-and-forget — the
// sidecar reports readiness via a 'ready' event; a failure just means the
// first play eats the connect latency.
export function prewarmSpotify(): void {
	void window.api['spotify:rpc']('ensure').catch((err) => slog.error('spotify prewarm failed', err));
}

// ─── Spotify backend (sidecar) ────────────────────────────────────────────────

// Thrown by playSpotify when the sidecar reports a track is region-unavailable
// (403 "Restriction violated" confirmed by a market-scoped is_playable probe).
// The sidecar rejects the `play` RPC with kind 'track_unavailable'; that kind
// doesn't survive ipcRenderer.invoke (only the message string does), so the
// sidecar encodes the marker in the message and we match on it below. The
// Discover feed catches this class to flag + skip the track.
export class SpotifyTrackUnavailableError extends Error {
	constructor(public readonly sourceTrackId: string) {
		super('Spotify track unavailable in this market');
		this.name = 'SpotifyTrackUnavailableError';
	}
}

async function playSpotify(sourceTrackId: string): Promise<void> {
	// Arm the loopback FFT for the seek-bar spectrum FIRST — synchronously,
	// before the spotify:rpc round-trip — so we're still inside the click's
	// transient activation when getDisplayMedia consumes it. (Spotify's audio
	// now comes out of the sidecar process, but loopback taps the system mixer,
	// not the SDK media element, so the spectrum keeps working unchanged.)
	// Fire-and-forget + idempotent: only the first call prompts the grant.
	void acquireLoopbackAnalyser();
	state.loading = true;
	emit();
	// Hand ownership to Spotify FIRST, then stop the local sidecar if it was
	// driving. Order matters: setting activeBackend before stopping ensures any
	// in-flight audio:event state_changed messages from the local sidecar are
	// ignored (the subscriber bails when activeBackend !== 'local'), and the
	// spotify:event state_changed events that follow land on a properly-tagged
	// state.
	activeBackend = 'spotify';
	if (localCurrentPath) {
		stopLocal();
	}
	try {
		// The sidecar owns the SDK device + the Web API play call + the
		// region-lock probe. It rejects with a message marker on a confirmed
		// region-unavailable track (kind doesn't survive IPC — see the class
		// doc above), which we rethrow as the typed error the feed expects.
		await window.api['spotify:rpc']('play', { sourceTrackId });
		// Apply the persisted level — the sidecar's SDK player defaults to full
		// volume, so without this the first Spotify track ignores the slider.
		void window.api['spotify:rpc']('set_volume', { volume: state.volume }).catch(() => { /* non-fatal */ });
	} catch (err) {
		// Don't leave the spinner stuck on a failed start (region lock,
		// network) — no state_changed will arrive to clear it.
		state.loading = false;
		emit();
		if (err instanceof Error && /SPOTIFY_TRACK_UNAVAILABLE/.test(err.message)) {
			throw new SpotifyTrackUnavailableError(sourceTrackId);
		}
		throw err;
	}
}

// ─── Tidal backend (disabled) ───────────────────────────────────────────────
// Stubbed out — the user action surfaces a friendly "coming soon" error and
// the queue auto-advance silently skips Tidal-only rows so a Spotify-rich
// playlist still plays straight through. Re-enable by reinstating the
// import block at the top and replacing these stubs.

async function playTidal(_track: Track, _sourceTrackId: string): Promise<void> {
	throw new TidalNotReadyError();
}

// ─── Local backend (native Rust sidecar) ────────────────────────────────────
// Audio decode + playback live in apps/audio/ — Rust binary using symphonia
// for decode (~5× faster than Chromium's FLAC decoder) and cpal for output
// (~10-15ms buffer vs Chromium's 41ms). Renderer talks to it via the
// `audio:rpc` IPC channel; the sidecar pushes state_changed + ended events
// back via `audio:event`.
//
// See:
//   - apps/audio/src/protocol.rs    — wire format
//   - apps/desktop/src/main/audio-sidecar.ts — Node-side host manager
//   - memory [[curator-audio-engine]] for the architectural commitment
//
// Renderer-side state we still own:
//   - state.current / state.position / state.duration / state.playing / state.volume
//     (drives the UI; updated synchronously from RPC responses + push events)
//   - the queue (queue / queueIndex)
//   - which path is currently loaded (so playLocal can short-circuit a replay)
//
// Renderer-side state we no longer own (moved to sidecar):
//   - decoded audio buffers
//   - cpal stream / AudioContext / gain / source node
//   - sample-accurate position math (sidecar publishes via state_changed)
//
// Native loop region: the Rust sidecar now wraps the source cursor inside
// its audio callback the moment the playhead would step past out_sec —
// sample-accurate, no IPC roundtrip, no audible seam from late wrap. The
// deck's poll-based wrap stays in place as a fallback for Spotify (whose
// SDK has no native loop) and as a no-op safety net for local (the
// native wrap fires first; the renderer's pos read after wrap is already
// inside [in, out]).

let localCurrentPath: string | null = null;

// Latency instrumentation — UI surfaces call markUiAction(kind) at click
// time, and seekLocal logs the delta when the seek RPC resolves. Kept from
// the Web Audio era — the budget structure changes (IPC dispatch instead of
// node.start()) but the user-perceived number is what we care about.
let lastUiActionAt = 0;
let lastUiActionKind = '';
export function markUiAction(kind: string): void {
	lastUiActionAt = performance.now();
	lastUiActionKind = kind;
}

// Public hook for the DeckController. Forwards the loop region to the
// Rust sidecar's set_loop RPC; the sidecar's audio callback enforces the
// region per-frame. Called only on the local backend — Spotify has no
// native loop, so the deck's poll-based wrap still drives that path.
//
// Fire-and-forget: the RPC is cheap (one atomic ArcSwap on the sidecar
// side, no engine lock contention with the audio thread) and the deck's
// reactive wrap will catch the boundary on the next poll regardless if
// this RPC ever drops.
export function setNativeLoop(region: { inSec: number; outSec: number } | null): void {
	const params = region
		? { in_sec: region.inSec, out_sec: region.outSec }
		: { in_sec: null, out_sec: null };
	void window.api['audio:rpc']('set_loop', params);
}

// Public hook for the DeckController's quantized-cue path. Forwards an
// armed cue trigger to the sidecar's arm_trigger RPC; the sidecar's
// audio callback fires the seek + a 10ms linear crossfade sample-
// accurately the moment `source_pos` would step past `triggerAtSec`,
// matching what the loop wrap already does. Null clears any armed
// trigger.
//
// Returns whether the sidecar actually armed. A `false` means the
// cursor caught up before the RPC arrived (renderer view of position
// is stale by ≤50 ms reporter tick + ≤RPC roundtrip) and the trigger
// was silently rejected — caller must fall back to an immediate seek
// or the UI flash strands.
//
// Local-only — Spotify/Tidal have no sample-accurate seek so cue
// quantize there still goes through DeckController's poll-based
// scheduler.
export async function armNativeTrigger(
	args: { triggerAtSec: number; seekToSec: number } | null
): Promise<{ armed: boolean }> {
	const params = args
		? { trigger_at_sec: args.triggerAtSec, seek_to_sec: args.seekToSec }
		: { trigger_at_sec: null, seek_to_sec: null };
	try {
		const result = await window.api['audio:rpc']('arm_trigger', params) as { armed?: boolean };
		return { armed: !!result.armed };
	} catch (err) {
		slog.error('arm_trigger RPC failed', err);
		return { armed: false };
	}
}

// Crossfaded seek for the "fire immediately" cue path on local. Hard
// engine.seek produces a sample-level DC discontinuity that clicks just
// like a pause→play transition; this RPC instead arms a pending trigger
// at `cursor + pad + xfade` so the audio callback applies the 10 ms
// linear crossfade across the seam. ~30 ms latency from RPC arrival to
// audible seek — imperceptible vs. the click that the hard seek made.
//
// Local-only. Streaming backends use the SDK seek which has its own
// latency characteristics and never went through this path.
export function seekWithXfade(positionSec: number): Promise<unknown> {
	return window.api['audio:rpc']('seek_with_xfade', { seconds: positionSec });
}

// ─── Beatgrid push + engine-side beat jump ─────────────────────────────
// The sidecar owns beat-jump target math (see engine.rs::jump_beats): it
// computes the landing from its authoritative cursor, so the jump is
// exactly N grid-beats no matter how stale the renderer's position view
// is. The renderer's job is just to keep the sidecar's beatgrid copy
// current: pushed after every load (load clears the per-track grid) and
// re-pushed by main.ts when analysis arrives late or flips source.
//
// Provider indirection instead of importing analysisStore here — the
// analysis store already imports player, and playLocal needs the grid at
// load time. main.ts registers the provider at boot.
let beatgridProvider: (() => Float32Array | null) | null = null;
export function setBeatgridProvider(fn: () => Float32Array | null): void {
	beatgridProvider = fn;
}

export function setNativeBeatgrid(beats: Float32Array | null): void {
	const payload = beats && beats.length >= 2 ? Array.from(beats) : [];
	void window.api['audio:rpc']('set_beatgrid', { beats: payload }).catch(() => {
		/* sidecar disabled — jump_beats will report not-jumped and the deck falls back */
	});
}

// Engine-side phase-preserving beat jump. Resolves to the sidecar's
// landing outcome, or null when the RPC itself failed (sidecar disabled
// or dead) so the caller can fall back to the renderer-computed walk.
// `jumped: false` with a live sidecar means the engine had nothing
// sensible to do (no grid pushed, mid-scrub, loop-move at a track edge).
//
// On success the optimistic position update mirrors seekLocal: the deck
// scheduler + UI must not act on the pre-jump position for up to a
// reporter tick. The engine's own StateChanged/TriggerFired reconciles.
export async function jumpNativeBeats(deltaBeats: number): Promise<{
	jumped: boolean;
	targetSec: number;
	loopInSec: number | null;
	loopOutSec: number | null;
} | null> {
	try {
		const res = await window.api['audio:rpc']('jump_beats', { delta_beats: deltaBeats }) as {
			jumped: boolean; target_sec: number; loop_in_sec: number | null; loop_out_sec: number | null;
		};
		if (res.jumped) {
			state.position = res.target_sec;
			emit();
			// Same click→engine latency log seekLocal emits — jumps used to
			// route through it, keep the instrumentation continuous.
			if (lastUiActionAt > 0) {
				const uiToEngine = performance.now() - lastUiActionAt;
				seekLog.debug('ui→engine (jump_beats)', { kind: lastUiActionKind, uiToEngineMs: uiToEngine, targetSec: res.target_sec });
				lastUiActionAt = 0;
				lastUiActionKind = '';
			}
		}
		return {
			jumped: res.jumped,
			targetSec: res.target_sec,
			loopInSec: res.loop_in_sec ?? null,
			loopOutSec: res.loop_out_sec ?? null,
		};
	} catch (err) {
		slog.warn('jump_beats RPC failed', undefined, err);
		return null;
	}
}

// Tick signal bumped once per sidecar-emitted `trigger_fired` event.
// DeckController subscribes to clear its pendingTrigger UI flash + snap
// the waveform overlay to the post-jump position at the audible moment
// (worst case ~50ms behind the actual sample-accurate fire). Counter
// rather than a payload signal because subscribers care about "did a
// fire happen since last tick" — payload comes from state.position.
const [triggerFiredTick, setTriggerFiredTick] = createSignal(0);
export const onTriggerFired: Accessor<number> = triggerFiredTick;

// Speculative decode prewarm. The previous Web Audio version filled an
// LRU cache. The sidecar holds a single decoded buffer at a time, so
// calling load() here would REPLACE the currently-playing buffer — wrong
// for a prewarm. A non-replacing "decode-and-cache" RPC is a Phase 2 add.
// Kept as an exported no-op so callers (track-list hover, future Omnibar
// peek) don't error.
export function prewarmLocal(_path: string): void {
	/* Phase 2 — sidecar prewarm cache not yet implemented. */
}

// Boot-time hook — used to be AudioContext creation, now a no-op because
// the sidecar process is already spawned at main-process boot. Kept on
// the export surface so the boot() call in main.ts doesn't break.
export function prewarmAudio(): void {
	/* No-op — Rust sidecar is spawned at main-process startup. */
}

// Wire the sidecar's push events into the player state once at module load.
// state_changed → mutate state.position / state.playing reactively.
// ended → advance the queue (same as the previous onended handler).
window.api.onAudioEvent((evt) => {
	if (evt.event === 'state_changed') {
		// Ignore stale events for non-local active backends (e.g. arrival
		// during a switch from local→Spotify). The sidecar will keep
		// reporting position on a track that's no longer "playing" from
		// the renderer's POV; the activeBackend gate filters those out.
		if (activeBackend !== 'local') return;
		state.position = evt.position;
		state.playing = evt.playing;
		// Push raw per-channel peaks into the store. The VU meter
		// component reads these reactively and runs its own rAF loop
		// for inter-tick smoothing + peak-hold decay.
		state.peakL = evt.peak_l;
		state.peakR = evt.peak_r;
		emit();
	} else if (evt.event === 'ended') {
		slog.debug('local ended', { activeBackend, autoplayLocal: autoplayNext.local, queueIndex, queueLen: queue.length });
		if (activeBackend !== 'local') return;
		playLifecycleHook?.('ended');
		state.playing = false;
		// Drop the meter to silence on natural end so the bar doesn't
		// linger at the last-tick value while the queue advances.
		state.peakL = 0;
		state.peakR = 0;
		emit();
		// Roll into the next list entry only when Local auto-play is on;
		// otherwise park at end-of-track (state.playing already false).
		if (autoplayNext.local) {
			advanceQueue().catch((err) => slog.error('local advance failed', err));
		}
	} else if (evt.event === 'trigger_fired') {
		if (activeBackend !== 'local') return;
		// Reconcile position ahead of the next state_changed tick so any
		// renderer subscriber that reads position at trigger_fired time
		// already sees the post-jump value. Bump the tick afterwards so
		// the DeckController's createEffect re-runs with the new value.
		state.position = evt.position;
		emit();
		setTriggerFiredTick((c) => c + 1);
	}
});

// Wire the Spotify sidecar's push events into player state — the streaming
// counterpart to onAudioEvent above. state_changed carries position/track from
// the sidecar's 20Hz poll (the SDK has no position event); ended fires once on
// natural end-of-track (detected sidecar-side). The activeBackend gate mirrors
// the old in-renderer handleSpotifyStateChange: the SDK keeps emitting for ~1s
// after a switch, and those late events must not overwrite state.current.
window.api.onSpotifyEvent((evt) => {
	if (evt.event === 'state_changed') {
		if (activeBackend !== 'spotify') return;
		if (evt.track) {
			state.current = {
				// Library row id for the tracks-list now-playing row (+ its live
				// eq). The snapshot (setNowPlayingTrack — set on every library play,
				// cleared to null on feed plays) is authoritative; without this,
				// Spotify plays left trackId '' so no streaming row ever lit up.
				trackId: nowPlayingTrack()?.id ?? '',
				source: 'spotify',
				sourceTrackId: evt.track.id,
				title: evt.track.title,
				artist: evt.track.artist,
				// The SDK event is flat; keep the credits we seeded at play time.
				artists: nowPlayingTrack()?.artists ?? state.current?.artists,
				duration: evt.duration,
				coverUrl: evt.track.coverUrl,
			};
		}
		state.position = evt.position;
		state.duration = evt.duration;
		state.playing = evt.playing;
		// Once the sidecar reports playing, audio is actually out — clear the
		// loading indicator playSpotify set before the RPC.
		if (evt.playing && state.loading) state.loading = false;
		emit();
	} else if (evt.event === 'ended') {
		if (activeBackend !== 'spotify') return;
		playLifecycleHook?.('ended');
		// Streaming auto-play gates both the library queue and the Discover
		// feed (both run on the Spotify backend). Off → stop at end-of-track.
		if (autoplayNext.streaming) {
			advanceQueue().catch((err) => slog.error('spotify advance failed', err));
		} else {
			state.playing = false;
			emit();
		}
	} else if (evt.event === 'auth_error') {
		slog.error('spotify auth error', undefined, { message: evt.message });
	}
	// 'ready' is informational (device registered); play targets it sidecar-side.
});

async function playLocal(track: Track, filePath: string): Promise<void> {
	const playT0 = performance.now();
	// Arm the system-loopback analyser within this click gesture so the live
	// now-playing equalizer reacts to local audio too — loopback taps the OS
	// mixer (source-agnostic), so the same path Spotify uses covers local files.
	// Idempotent; getDisplayMedia needs transient activation on the first grant.
	void acquireLoopbackAnalyser();
	// Capture the PREVIOUS backend so we can decide whether to pause
	// Spotify. After activation the Spotify SDK is loaded but holds no
	// track unless we've actually played one through it — calling pause()
	// in that state throws "Cannot perform operation; no list was loaded".
	// Gate the pause on "Spotify was actually the active backend".
	const wasSpotify = activeBackend === 'spotify';
	// Hand ownership BEFORE the Spotify pause races in. The Spotify SDK
	// keeps firing state_changed events for ~1s after pause(); without
	// flipping activeBackend first, those late events overwrite state.current.
	activeBackend = 'local';
	localCurrentPath = filePath;

	if (wasSpotify) {
		void window.api['spotify:rpc']('pause').catch(() => { /* fire-and-forget */ });
	}

	// Set state.current synchronously so the UI updates BEFORE the load
	// RPC completes — the now-playing card switches to the new track + shows
	// the spinner overlay while the sidecar is decoding.
	state.current = {
		trackId: track.id,
		source: 'local',
		sourceTrackId: filePath,
		title: track.title,
		artist: formatArtistCredit(track.artists, artistCreditFormat()),
		artists: track.artists ?? [],
		duration: track.duration ?? 0,
		coverUrl: null,
		hasLocal: true,
	};
	state.position = 0;
	state.duration = track.duration ?? 0;
	state.playing = false;
	state.loading = true;
	emit();

	// Send load + (sidecar auto-stops previous stream first thing in its
	// load() handler). Renderer doesn't need a separate `stop` RPC.
	let loadResult: { duration: number; sample_rate: number; channels: number };
	try {
		loadResult = await window.api['audio:rpc']('load', { path: filePath }) as typeof loadResult;
	} catch (err) {
		// Clear loading on failure so the UI doesn't get stuck.
		if (state.current?.sourceTrackId === filePath) {
			state.loading = false;
			emit();
		}
		slog.error('sidecar load failed', err, { filePath });
		throw err;
	}
	// Stale check — user switched tracks while load was in flight. Bail
	// without sending play; the new playLocal() invocation owns the engine
	// state from here on.
	if (state.current?.sourceTrackId !== filePath || activeBackend !== 'local') {
		return;
	}

	// Mirror the sidecar-reported duration into state. The renderer's
	// track row may have a stale duration (e.g. from an old import); the
	// decoded buffer is authoritative.
	state.duration = loadResult.duration;
	if (state.current) state.current.duration = loadResult.duration;
	// Push the new track's beatgrid — load() cleared the engine's copy
	// (grids are per-track). Must come AFTER load resolves for that same
	// reason. Covers the analysis-already-cached case; late-arriving
	// analysis re-pushes via the analysis-loaded listener in main.ts.
	setNativeBeatgrid(beatgridProvider?.() ?? null);
	// Apply the persisted volume on every load — the sidecar's master
	// gain doesn't survive the per-load stream rebuild in cpal, so we
	// re-send the level. Cheap (microseconds) and avoids a "first track
	// plays at full volume" surprise after the user has lowered the
	// slider.
	void window.api['audio:rpc']('set_volume', { volume: state.volume });
	// Kick off playback. Fire-and-forget — state_changed events will
	// update state.playing once cpal actually starts pushing samples.
	void window.api['audio:rpc']('play');
	state.playing = true;
	state.loading = false;
	emit();

	const totalMs = performance.now() - playT0;
	log.for('play').info('kind=local', { totalMs, durationSec: loadResult.duration, sampleRate: loadResult.sample_rate });
}

function pauseLocal(): void {
	void window.api['audio:rpc']('pause');
	state.playing = false;
	emit();
}

// Hard stop — tells the sidecar to release its loaded buffer entirely.
// Used by end-of-queue + switch-to-other-backend paths.
function stopLocal(): void {
	void window.api['audio:rpc']('stop');
	localCurrentPath = null;
	state.playing = false;
}

async function resumeLocal(): Promise<void> {
	void acquireLoopbackAnalyser(); // keep the loopback analyser armed (idempotent)
	await window.api['audio:rpc']('play');
	state.playing = true;
	emit();
}

function seekLocal(seconds: number): void {
	const dur = state.duration;
	const target = Math.max(0, Math.min(dur || 0, seconds));
	// Optimistic state.position update so the deck's scheduler + UI react
	// immediately; the sidecar's state_changed event will reconfirm.
	state.position = target;
	emit();
	void window.api['audio:rpc']('seek', { seconds: target });

	// Instrumentation — log click → RPC-dispatched time. With the sidecar,
	// the ui→engine number is now JS click → renderer process boundary.
	// Add a fixed estimate for IPC + cpal buffer (~10ms WASAPI default)
	// to get an honest audible figure. The sidecar logs its own
	// decode/build numbers on stderr for cross-reference.
	if (lastUiActionAt > 0) {
		const uiToEngine = performance.now() - lastUiActionAt;
		seekLog.debug('ui→engine', { kind: lastUiActionKind, uiToEngineMs: uiToEngine, targetSec: target, audibleMsWithCpalEstimate: uiToEngine + 10 });
		lastUiActionAt = 0;
		lastUiActionKind = '';
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Look up the source-track id for a given source. Returns null if missing
// (e.g. asking for Spotify on a Tidal-only track).
async function resolveSourceTrackId(trackId: string, source: 'spotify' | 'tidal'): Promise<string | null> {
	const links = await window.api['tracks:source-links'](trackId);
	const hit = links.find((l) => l.source === source);
	return hit ? hit.sourceTrackId : null;
}

// Decide which backend to use. Local always wins when a `source='local'`
// link exists on the track — even if the user is browsing the Spotify or
// Tidal tab. Otherwise prefer Spotify (warm SDK, fast state events) over
// Tidal (currently stubbed).
function pickSource(track: Track): 'spotify' | 'tidal' | 'local' | null {
	// Remote rows carry no links here; explicit so queue auto-advance skips
	// them silently whatever `sources` says.
	if (isRemoteRow(track)) return null;
	const sources = new Set(track.sources ?? []);
	if (sources.has('local')) return 'local';
	if (sources.has('spotify')) return 'spotify';
	if (sources.has('tidal')) return 'tidal';
	return null;
}

export async function play(track: Track, list?: Track[]): Promise<void> {
	// A remote row has nothing to play on this device. Refused before any
	// state moves (queue, ownership, now-playing) so the current playback
	// carries on; callers toast the message.
	if (isRemoteRow(track)) throw new RemoteOnlyPlayError();
	// Library play takes playback ownership back from the feed.
	feedPlaybackActive = false;
	// Grab the loopback analyser HERE — before the async source-id resolve below —
	// so it lands inside the click's transient activation (getDisplayMedia needs
	// it). playSpotify calls it too, but on the library path that runs after an
	// await, too late for the gesture on a fresh session. Idempotent. This is what
	// makes the now-playing tracks-list eq go live for streaming plays.
	void acquireLoopbackAnalyser();
	// EME activation no longer happens here — the sidecar primes the CDM with
	// autoplay-policy disabled, so there's no user-gesture window to protect on
	// the renderer side.

	const source = pickSource(track);
	if (!source) throw new Error(`No playable source for ${track.title}`);

	// Snapshot the full Track so the now-playing surfaces keep BPM/key/rating
	// even if this row later leaves the visible-tracks cache (removed from the
	// current playlist, navigated away).
	setNowPlayingTrack(track);

	// Build the queue from the supplied list (typically the visible playlist).
	if (list && list.length > 0) {
		queue = list;
		queueIndex = list.findIndex((t) => t.id === track.id);
		if (queueIndex < 0) queueIndex = 0;
	} else {
		queue = [track];
		queueIndex = 0;
	}

	if (source === 'local') {
		const local = await window.api['library:track-local-file'](track.id);
		if (!local) throw new Error(`No local file for ${track.title}`);
		await playLocal(track, local.path);
		return;
	}

	const stid = await resolveSourceTrackId(track.id, source);
	if (!stid) throw new Error(`Missing ${source} track id for ${track.title}`);

	// Switching from local → Spotify/Tidal: release the sidecar's buffer
	// so we don't double-play.
	if (localCurrentPath) {
		stopLocal();
	}

	if (source === 'spotify') {
		// Seed state.current before the sidecar roundtrip — same treatment as
		// playFeedSpotify. The now-playing surfaces (and the presence
		// derivation that unhides the player strip) must react to the click,
		// not ~1s later when the SDK's first state_changed lands; that event
		// overwrites this seed with authoritative data.
		state.current = {
			trackId: track.id,
			source: 'spotify',
			sourceTrackId: stid,
			title: track.title,
			artist: formatArtistCredit(track.artists, artistCreditFormat()),
			artists: track.artists ?? [],
			duration: track.duration ?? 0,
			// coverImage() falls back to curator-cover://trackId, same as the
			// local path — the event's coverUrl fills the real art.
			coverUrl: null,
		};
		state.position = 0;
		state.duration = track.duration ?? 0;
		state.playing = false;
		emit();
		await playSpotify(stid);
	} else {
		// Tidal-only track via direct user action — surface the "coming soon"
		// error so the caller can show a toast. We don't pause Spotify here
		// because nothing is starting up.
		await playTidal(track, stid);
	}
}

// Play a Spotify track that is NOT in the library — Discover feed cards.
// Mirrors play()'s Spotify branch but skips the source_link resolution
// (feed items only have a source track id) and seeds state.current with
// the card's metadata so the now-playing UI is correct before the SDK's
// first state_changed lands.
export async function playFeedSpotify(
	sourceTrackId: string,
	meta: { title: string; artist: string; artists?: string[]; coverUrl: string | null; durationSec: number | null },
): Promise<void> {
	// Feed plays don't use the library queue — natural end is routed to
	// the feed's advance handler via the feedPlaybackActive flag.
	feedPlaybackActive = true;
	queue = [];
	queueIndex = -1;
	// Feed cards aren't library rows — no Track to snapshot. The now-playing
	// surfaces fall back to state.current's title/artist (trackId is '').
	setNowPlayingTrack(null);
	state.current = {
		trackId: '',
		source: 'spotify',
		sourceTrackId,
		title: meta.title,
		artist: meta.artist,
		artists: meta.artists?.map((name) => ({ name })),
		duration: meta.durationSec ?? 0,
		coverUrl: meta.coverUrl,
	};
	await playSpotify(sourceTrackId);
}

export async function togglePause(): Promise<void> {
	if (!state.current) return;
	if (state.current.source === 'local') {
		if (state.playing) pauseLocal();
		else await resumeLocal();
		return;
	}
	if (state.current.source === 'spotify') {
		await window.api['spotify:rpc']('toggle');
	}
}

export function getVolume(): number { return state.volume; }

// Set the master volume (0-1, clamped). Applied to whichever backend is
// loaded — Spotify SDK + local Web Audio gain node both, so toggling sources
// doesn't lose the level. Persisted to localStorage so a restart honors it.
export async function setVolume(v: number): Promise<void> {
	const next = Math.max(0, Math.min(1, v));
	if (next === state.volume) return;
	state.volume = next;
	try { localStorage.setItem(VOLUME_LS_KEY, String(next)); } catch { /* ignore */ }
	// Forward to the active backend(s). The audio sidecar applies an internal
	// short ramp inside its callback so the level glides rather than stepping —
	// same zipper-noise mitigation the Web Audio version did with
	// setTargetAtTime. The Spotify sidecar sets it via the SDK's own API.
	if (activeBackend === 'local') {
		void window.api['audio:rpc']('set_volume', { volume: next });
	}
	if (activeBackend === 'spotify') {
		void window.api['spotify:rpc']('set_volume', { volume: next }).catch((err) => slog.warn('spotify setVolume failed', undefined, err));
	}
	emit();
}

export async function nudgeVolume(delta: number): Promise<void> {
	await setVolume(state.volume + delta);
}

export async function seekBy(deltaSec: number): Promise<void> {
	if (!state.current) return;
	const next = Math.max(0, Math.min(state.duration || 0, state.position + deltaSec));
	if (state.current.source === 'local') {
		seekLocal(next);
		return;
	}
	if (state.current.source === 'spotify') {
		void window.api['spotify:rpc']('seek', { seconds: next });
	}
	state.position = next;
	emit();
}

// ─── Waveform-drag scrub ───────────────────────────────────────────────
// Vinyl-style drag dispatched per source:
//   • local → Rust sidecar emits variable-rate audio (forward + reverse)
//     via the scrub_begin / scrub_to / scrub_end JSON-RPC trio.
//   • spotify / tidal → no rate control in the SDKs; we just pause at
//     start and seek once at end. The renderer still drives the visual
//     scrub 1:1 (silent during drag).
// The renderer drives this from MainWaveformView's pointer-event flow.
// `wasPlaying` is captured at scrubStart and threaded back into scrubEnd
// so the caller decides whether to resume.

// targetSec — optional. When provided, the engine snaps cursor + initial
// scrub target to that position before entering scrub mode (mini-wavemap
// click-anywhere-to-jump semantic). When omitted, the engine stays at
// the current cursor (big-waveform grab-and-drag from playhead).
export function scrubStart(targetSec?: number): { wasPlaying: boolean } {
	const wasPlaying = state.playing;
	if (!state.current) return { wasPlaying };
	if (state.current.source === 'local') {
		// Local: tell the sidecar to enter scrub mode. The engine clears
		// `playing` internally; emit a state event so listeners (UI) see
		// the pause. When targetSec is set, also snap engine cursor.
		void window.api['audio:rpc']('scrub_begin', targetSec != null ? { seconds: targetSec } : {});
		state.playing = false;
		// Optimistic position update for the snap case so the UI jumps
		// without waiting for the engine's StateChanged round-trip.
		if (targetSec != null) {
			const dur = state.duration || 0;
			state.position = Math.max(0, Math.min(dur, targetSec));
		}
		emit();
		return { wasPlaying };
	}
	if (state.current.source === 'spotify') {
		// SDK pause. Silent scrub for the drag's duration.
		void window.api['spotify:rpc']('pause');
		state.playing = false;
		if (targetSec != null) {
			const dur = state.duration || 0;
			state.position = Math.max(0, Math.min(dur, targetSec));
		}
		emit();
		return { wasPlaying };
	}
	return { wasPlaying };
}

export function scrubMove(targetSec: number): void {
	if (!state.current) return;
	const dur = state.duration || 0;
	const clamped = Math.max(0, Math.min(dur, targetSec));
	// Optimistic UI position update so the painted playhead tracks the
	// drag at rAF rate; the sidecar's state_changed event will reconfirm
	// on the next 50 ms reporter tick.
	state.position = clamped;
	emit();
	if (state.current.source === 'local') {
		void window.api['audio:rpc']('scrub_to', { seconds: clamped });
	}
	// Streaming sources: no per-move IPC. Visual update only.
}

export async function scrubEnd(finalSec: number, resumePlaying: boolean): Promise<void> {
	if (!state.current) return;
	const dur = state.duration || 0;
	const clamped = Math.max(0, Math.min(dur, finalSec));
	if (state.current.source === 'local') {
		void window.api['audio:rpc']('scrub_end', {
			final_seconds: clamped,
			resume_playing: resumePlaying,
		});
		state.position = clamped;
		state.playing = resumePlaying;
		emit();
		return;
	}
	if (state.current.source === 'spotify') {
		await window.api['spotify:rpc']('seek', { seconds: clamped });
		if (resumePlaying) {
			await window.api['spotify:rpc']('resume');
		}
		state.position = clamped;
		state.playing = resumePlaying;
		emit();
	}
}

export async function next(): Promise<void> {
	await advanceQueue();
}

export async function prev(): Promise<void> {
	if (queueIndex > 0) {
		queueIndex -= 2; // advanceQueue will increment
		await advanceQueue();
	}
}

// Feed playback (DiscoverView) owns its own "what plays next" logic — the
// feed list isn't a Track[] queue, so natural end-of-track hands control
// back to the registered handler instead of the library queue. The flag
// flips on playFeedSpotify() and off on any library play().
let feedPlaybackActive = false;
let feedAdvanceHandler: (() => void) | null = null;
export function setFeedAdvanceHandler(fn: (() => void) | null): void {
	feedAdvanceHandler = fn;
}

async function advanceQueue(): Promise<void> {
	if (feedPlaybackActive && feedAdvanceHandler) {
		feedAdvanceHandler();
		return;
	}
	queueIndex++;
	const t = queue[queueIndex];
	if (!t) {
		// End of queue — stop every backend + relinquish ownership so a
		// future play() starts from a clean slate. The lifecycle tap only
		// matters on the manual next()-past-the-end path; after a natural
		// end the tracker already finalized on 'ended' and this no-ops.
		playLifecycleHook?.('queue_end');
		try { await window.api['spotify:rpc']('pause'); } catch { /* */ }
		stopLocal();
		activeBackend = null;
		state.playing = false;
		setNowPlayingTrack(null);
		emit();
		return;
	}
	const source = pickSource(t);
	// Skip rows that have no playable source — and, until Tidal playback
	// lands, also skip tidal-only rows. Auto-advance must stay silent for
	// these (no toast spam) so a hybrid playlist still flows through its
	// spotify-backed entries.
	if (!source || source === 'tidal') {
		await advanceQueue();
		return;
	}
	if (source === 'local') {
		const local = await window.api['library:track-local-file'](t.id);
		if (!local) {
			await advanceQueue();
			return;
		}
		setNowPlayingTrack(t);
		await playLocal(t, local.path);
		return;
	}
	const stid = await resolveSourceTrackId(t.id, source);
	if (!stid) {
		await advanceQueue();
		return;
	}
	// Switching from local → Spotify: release the sidecar's loaded buffer.
	if (localCurrentPath) {
		stopLocal();
	}
	setNowPlayingTrack(t);
	await playSpotify(stid);
}

// Spotify position no longer polls here: the SDK exposes no position event, so
// the Spotify sidecar polls getCurrentState at 50ms internally and pushes
// state_changed over `spotify:event` (the same 50ms precision the
// DeckController's quantize/loop scheduling needs). Local audio likewise pushes
// state_changed at 20Hz over `audio:event`. Both land in the subscribers above.

// PlayerFooter — composes every player-surface component into one mount.
//
// First "layout" in the renderer (Phase 3.A). main.ts/boot() used to
// look up five separate host divs and call five different `mountX(...)`
// functions; now it makes one call into this layout and the layout
// internally composes its component tree.
//
// The components used inside are imported directly as Solid JSX — they
// share one Solid root, which means snapTo plumbing flows cleanly
// through prop callbacks and lifecycle (destroy) tears the whole tree
// down at once.
//
// Why this step matters: today the footer is single-instance, but the
// shape of this file is what a future `mountTwoDeckLayout(root)` would
// call twice with different deck contexts to put two players side by
// side. The component contracts already support multi-instance —
// per-instance state, no module-level singletons — so it's just a
// matter of where you choose to mount them.

import { render } from 'solid-js/web';
import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Track, SegmentRecord } from '@curator/shared';
import type { PeaksTier, CueData } from '../stores/analysisStore.js';
import { NowPlayingCard } from '../components/NowPlayingCard.jsx';
import { MainWaveformView, type LoopRegionView } from '../components/MainWaveformView.jsx';
import { MiniWaveMapView } from '../components/MiniWaveMapView.jsx';
import { TransportView } from '../components/TransportView.jsx';
import { CueGridView } from '../components/CueGridView.jsx';
import { SmallPlayer } from '../components/SmallPlayer.jsx';
import type { SkinId } from '../renderers/waveformStyles.js';

export interface PlayerFooterProps {
	// NowPlayingCard inputs
	getTrack: (id: string) => Track | undefined;
	onFavoriteToggle?: ((trackId: string) => void) | null;
	onSetRating?: ((trackId: string, rating: number) => void) | null;
	onAddTag?: ((trackId: string) => void) | null;
	onTagContextMenu?: ((evt: MouseEvent, trackId: string, tagId: string) => void) | null;
	onArtistClick?: ((name: string) => void) | null;
	// Bump-counter signal the caller increments whenever a value backing
	// getTrack() changes for an already-cached track. NowPlayingCard reads
	// it inside its display memo so cache mutations (e.g. rating edits)
	// propagate to the player view — Maps aren't reactive on their own.
	tracksCacheRev?: Accessor<number>;
	// Shared playback state (read by waveform, wavemap, transport, cues)
	mode: Accessor<'small' | 'big'>;
	// Player variant (mirrors shell.effectiveVariant — the playing track's
	// backend, tab-context fallback when idle). Picks SmallPlayer's layout:
	// deck strip for local playback, Spotify-style transport for streaming.
	variant: Accessor<'local' | 'streaming'>;
	peaks: Accessor<PeaksTier | null>;
	beats: Accessor<Float32Array | null>;
	// Downbeat times (s) — the authoritative bar grid. Not derivable from
	// `beats[::4]` for rb-sourced tracks that start with a pickup of N
	// non-downbeat beats. Forwarded straight to MainWaveformView for the
	// bar-tick layer + bar counter.
	downbeats: Accessor<Float32Array | null>;
	cues: Accessor<CueData[]>;
	segments: Accessor<SegmentRecord[] | null>;
	duration: Accessor<number>;
	positionSec: Accessor<number>;
	isPlaying: Accessor<boolean>;
	beatsAvailable: Accessor<boolean>;
	// Zoom state for the main waveform
	initialZoomIdx?: number;
	onZoomChange?: (idx: number) => void;
	// Waveform skin — single shared value across big + mini. Reactive
	// accessor so changes in either direction (user changing the picker,
	// or external state migrations) flow into both painters.
	skin: Accessor<SkinId>;
	onSkinChange: (id: SkinId) => void;
	// Actions
	onSeek: (positionSec: number) => void;
	// Vinyl-scrub callbacks forwarded straight to MainWaveformView.
	// See the prop docs in MainWaveformView for behaviour.
	onScrubStart: (targetSec?: number) => void;
	onScrubMove: (positionSec: number) => void;
	onScrubEnd: (positionSec: number, resumePlaying: boolean) => void;
	onCueJump: (positionSec: number, lengthSec: number | null, cueId: string) => void;
	// Empty-pad click and right-click on a set pad. Wired straight through
	// from CueGridView so PlayerFooter doesn't have to know cue shape.
	onCreateCue?: (slot: number) => void;
	onCueContextMenu?: (evt: MouseEvent, cue: CueData) => void;
	onBeatJump: (deltaBeats: number) => void;
	// Quantize lives in the Settings → Player tab now; PlayerFooter no
	// longer surfaces it.
	// Deck-driven reactive signals — both forward straight through to the
	// painters / cue grid. PlayerFooter owns no musical-time state of its
	// own; it's purely a composition layer.
	activeLoop: Accessor<LoopRegionView | null>;
	pendingTrigger: Accessor<number | null>;
	// Loop controls — reactive `armed` state for the "in" indicator +
	// callbacks for each button. PlayerFooter doesn't know about the
	// deck's internal beat math; it just dispatches clicks.
	loopArmed: Accessor<number | null>;
	onLoopIn: () => void;
	onLoopOut: () => void;
	onLoopNBeats: (n: number) => void;
	onHalveLoop: () => void;
	onDoubleLoop: () => void;
}

export interface PlayerFooterHandle {
	destroy(): void;
	// Instant-jump the main waveform's played-position overlay (no CSS
	// transition). Used externally by callers that don't go through
	// this layout's onSeek/onCueJump props — e.g. the keyboard beat-
	// jump shortcut in main.ts which talks directly to player.seekBy.
	snapTo(positionSec: number): void;
}

export function PlayerFooter(props: PlayerFooterProps & { onMainWaveformSnapTo: (fn: ((positionSec: number) => void) | null) => void }) {
	// Mode fork: the big workstation tree (NowPlayingCard + deck) and the
	// 64px SmallPlayer strip are SEPARATE subtrees — Show mounts exactly
	// one. Toggling remounts the inactive side (waveforms repaint fresh at
	// their new size), which is cheap and keeps neither tree carrying
	// hidden-DOM weight for the other. Both sides may mount a
	// MainWaveformView (the local strip does, compact), so its inputs are
	// forwarded to both branches.
	return (
		<Show
			when={props.mode() === 'big'}
			fallback={
				<SmallPlayer
					getTrack={props.getTrack}
					tracksCacheRev={props.tracksCacheRev}
					onSetRating={props.onSetRating ?? null}
					onArtistClick={props.onArtistClick ?? null}
					variant={props.variant}
					peaks={props.peaks}
					beats={props.beats}
					downbeats={props.downbeats}
					cues={props.cues}
					segments={props.segments}
					duration={props.duration}
					positionSec={props.positionSec}
					isPlaying={props.isPlaying}
					initialZoomIdx={props.initialZoomIdx}
					onZoomChange={props.onZoomChange}
					skin={props.skin}
					onSkinChange={props.onSkinChange}
					activeLoop={props.activeLoop}
					onSeek={props.onSeek}
					onScrubStart={props.onScrubStart}
					onScrubMove={props.onScrubMove}
					onScrubEnd={props.onScrubEnd}
					setSnapTo={props.onMainWaveformSnapTo}
				/>
			}
		>
			<NowPlayingCard
				getTrack={props.getTrack}
				onFavoriteToggle={props.onFavoriteToggle ?? null}
				onSetRating={props.onSetRating ?? null}
				onAddTag={props.onAddTag ?? null}
				onTagContextMenu={props.onTagContextMenu ?? null}
				onArtistClick={props.onArtistClick ?? null}
				tracksCacheRev={props.tracksCacheRev}
			/>
			<div class="player-deck">
				<MainWaveformView
					compact={false}
					peaks={props.peaks}
					beats={props.beats}
					downbeats={props.downbeats}
					cues={props.cues}
					segments={props.segments}
					duration={props.duration}
					positionSec={props.positionSec}
					isPlaying={props.isPlaying}
					initialZoomIdx={props.initialZoomIdx}
					onZoomChange={props.onZoomChange}
					skin={props.skin}
					onSkinChange={props.onSkinChange}
					onSeek={props.onSeek}
					onScrubStart={props.onScrubStart}
					onScrubMove={props.onScrubMove}
					onScrubEnd={props.onScrubEnd}
					activeLoop={props.activeLoop}
					setSnapTo={props.onMainWaveformSnapTo}
				/>
				<MiniWaveMapView
					peaks={props.peaks}
					cues={props.cues}
					duration={props.duration}
					positionSec={props.positionSec}
					isPlaying={props.isPlaying}
					onSeek={props.onSeek}
					onScrubStart={props.onScrubStart}
					onScrubMove={props.onScrubMove}
					onScrubEnd={props.onScrubEnd}
					skin={props.skin}
					activeLoop={props.activeLoop}
				/>
				<div class="player-controls-row">
					<TransportView
						beatsAvailable={props.beatsAvailable}
						onBeatJump={props.onBeatJump}
					/>
					{/* Loop controls — three buttons laid out horizontally as
					    In | Out | 4. When a loop is active, the In/Out pair
					    re-skins to ½× / 2× (halve / double the active region)
					    and the "4" button becomes the Exit toggle. See
					    deck.loopIn / loopOut / loopNBeats / halveLoop /
					    doubleLoop for the underlying semantics. */}
					<div class="loop sunken big-only">
						<button
							class="t-btn small loop-in"
							classList={{
								'is-armed': props.activeLoop() == null && props.loopArmed() != null,
								'is-active': props.activeLoop() != null,
							}}
							title={props.activeLoop() != null ? 'Halve loop length' : 'Mark loop in'}
							onClick={() => props.activeLoop() != null ? props.onHalveLoop() : props.onLoopIn()}
						>{props.activeLoop() != null ? '½×' : 'In'}</button>
						<button
							class="t-btn small loop-out"
							classList={{ 'is-active': props.activeLoop() != null }}
							title={props.activeLoop() != null ? 'Double loop length' : 'Mark loop out'}
							disabled={props.activeLoop() == null && props.loopArmed() == null}
							onClick={() => props.activeLoop() != null ? props.onDoubleLoop() : props.onLoopOut()}
						>{props.activeLoop() != null ? '2×' : 'Out'}</button>
						<button
							class="loop-bars-btn"
							classList={{ 'is-active': props.activeLoop() != null }}
							title={props.activeLoop() != null ? 'Exit loop' : 'Loop 4 beats'}
							onClick={() => props.onLoopNBeats(4)}
						>{props.activeLoop() != null ? 'Exit' : '4'}</button>
					</div>
					<CueGridView
						cues={props.cues}
						onCueJump={props.onCueJump}
						pendingTrigger={props.pendingTrigger}
						onCreateCue={props.onCreateCue}
						onCueContextMenu={props.onCueContextMenu}
					/>
				</div>
			</div>
		</Show>
	);
}

export function mountPlayerFooter(host: HTMLElement, props: PlayerFooterProps): PlayerFooterHandle {
	let snapToFn: ((positionSec: number) => void) | null = null;
	const dispose = render(() => (
		<PlayerFooter
			{...props}
			onMainWaveformSnapTo={(fn) => { snapToFn = fn; }}
		/>
	), host);
	return {
		destroy: dispose,
		// snapToFn is non-null exactly while a MainWaveformView is mounted
		// (the big deck, or the local small strip) — it nulls itself on
		// dispose, so the streaming strip is a no-op here.
		snapTo: (positionSec) => { snapToFn?.(positionSec); },
	};
}

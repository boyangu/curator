// Play-history capture — observes the player store and turns raw playback
// state into play_event upserts over the plays:record channel. Lives beside
// player.ts rather than inside it: the player owns transport, this module
// only *watches* (one subscribe + the lifecycle hook), so playback behaviour
// can't regress from tracking bugs.
//
// Model: one "open play" at a time, keyed by the playing track's
// source|sourceTrackId. Audible time is accumulated from position ticks —
// a tick credits playedMs only when the position delta roughly matches the
// wall-clock delta (a seek/scrub/beat-jump moves position without matching
// wall time and credits nothing; pauses credit nothing because playing is
// false). Nothing is emitted until MIN_PLAY_MS so rapid feed auditioning
// doesn't spray one-second rows; after that the same id is upserted:
// insert → 30s checkpoints (crash story: an abandoned non-final row reads
// as an interrupted play) → finalize with endedReason.

import { subscribe, getState, currentTrack, setPlayLifecycleHook } from './player.js';
import type { PlayRecordUpsert, PlayEndedReason } from '@curator/shared';
import { playsApi } from './data/api.js';
import { log } from './data/log.js';

const plog = log.for('play-tracker');

// Below this the play never touches the DB — noise gate for skip-throughs.
const MIN_PLAY_MS = 5000;
const CHECKPOINT_MS = 30_000;
// A position delta is "honest playback" when it tracks wall time within
// this slack (local ticks at 20Hz, spotify at ~50ms poll — one tick of
// jitter each way stays well inside 2s).
const TICK_SLACK_MS = 2000;

type OpenPlay = {
	id: string;
	key: string; // `${source}|${sourceTrackId}` — identity of the playing track
	trackId: string | null;
	sourceTrackId: string;
	source: 'local' | 'spotify';
	startedAt: number;
	playedMs: number;
	durationMs: number | null;
	maxPositionMs: number;
	contextType: string | null;
	contextId: string | null;
	inserted: boolean;
};

let open: OpenPlay | null = null;
let lastPosMs = 0;
let lastTickAt = 0; // 0 = no baseline (paused / just started / just sought)
let lastFlushAt = 0;

// Registered from main.ts — answers "where was this play launched from"
// (playlist id, tag view, search, feed…). Snapshotted at play start.
let contextProvider: (() => { type: string; id: string | null } | null) | null = null;
export function setPlayContextProvider(fn: () => { type: string; id: string | null } | null): void {
	contextProvider = fn;
}

function flush(final: boolean, endedReason: PlayEndedReason | null): void {
	if (!open || open.playedMs < MIN_PLAY_MS) return;
	const e: PlayRecordUpsert = {
		id: open.id,
		trackId: open.trackId,
		sourceTrackId: open.sourceTrackId,
		source: open.source,
		startedAt: open.startedAt,
		playedMs: Math.round(open.playedMs),
		durationMs: open.durationMs,
		maxPositionMs: Math.round(open.maxPositionMs),
		endedReason: final ? endedReason : null,
		contextType: open.contextType,
		contextId: open.contextId,
		final,
	};
	open.inserted = true;
	lastFlushAt = Date.now();
	playsApi.record(e).catch((err) => plog.error('record failed', err));
}

function finalize(reason: PlayEndedReason): void {
	if (!open) return;
	flush(true, reason);
	open = null;
	lastTickAt = 0;
}

function start(key: string, source: 'local' | 'spotify', sourceTrackId: string): void {
	const s = getState();
	const ctx = contextProvider?.() ?? null;
	open = {
		id: crypto.randomUUID(),
		key,
		// state.current.trackId is '' for feed plays; the library snapshot is
		// authoritative when present.
		trackId: currentTrack()?.id ?? (s.current?.trackId || null),
		sourceTrackId,
		source,
		startedAt: Date.now(),
		playedMs: 0,
		durationMs: s.duration > 0 ? Math.round(s.duration * 1000) : null,
		maxPositionMs: 0,
		contextType: ctx?.type ?? null,
		contextId: ctx?.id ?? null,
		inserted: false,
	};
	lastPosMs = s.position * 1000;
	lastTickAt = 0;
}

export function initPlayTracker(): void {
	setPlayLifecycleHook((evt) => {
		finalize(evt === 'ended' ? 'ended' : 'queue_end');
	});

	subscribe((s) => {
		// Reads: current, position, playing, duration — the effect re-runs on
		// any of them changing (20Hz while local audio plays).
		const cur = s.current;
		const key =
			cur && (cur.source === 'local' || cur.source === 'spotify')
				? `${cur.source}|${cur.sourceTrackId}`
				: null;

		if (key !== (open?.key ?? null)) {
			// Track switched under a still-open play — user replaced it.
			if (open) finalize('replaced');
			if (key && cur) start(key, cur.source as 'local' | 'spotify', cur.sourceTrackId);
			return;
		}
		if (!open) return;

		// The authoritative duration can land after start (local decode
		// overrides the row's stored duration; spotify's first state_changed
		// carries the SDK's value).
		if (s.duration > 0) open.durationMs = Math.round(s.duration * 1000);
		// Late trackId resolution (spotify state_changed re-seeds it from the
		// now-playing snapshot).
		if (!open.trackId && cur && cur.trackId) open.trackId = cur.trackId;

		const posMs = s.position * 1000;
		if (!s.playing) {
			// Paused (or scrubbing — scrubStart flips playing off): drop the
			// baseline so the resume tick can't credit the gap.
			lastTickAt = 0;
			lastPosMs = posMs;
			return;
		}
		const now = Date.now();
		if (lastTickAt > 0) {
			const posDelta = posMs - lastPosMs;
			const wallDelta = now - lastTickAt;
			if (posDelta > 0 && Math.abs(posDelta - wallDelta) < TICK_SLACK_MS) {
				open.playedMs += posDelta;
				// First flush the moment the noise gate opens, so even a crash
				// before the first checkpoint keeps the row.
				if (!open.inserted && open.playedMs >= MIN_PLAY_MS) flush(false, null);
			}
		}
		if (posMs > open.maxPositionMs) open.maxPositionMs = posMs;
		lastPosMs = posMs;
		lastTickAt = now;
	});

	// Checkpoint loop — refresh playedMs/maxPositionMs on the open row while
	// playing so a crash/quit loses at most CHECKPOINT_MS of listening.
	setInterval(() => {
		if (open && open.inserted && getState().playing && Date.now() - lastFlushAt >= CHECKPOINT_MS) {
			flush(false, null);
		}
	}, CHECKPOINT_MS / 2);
}

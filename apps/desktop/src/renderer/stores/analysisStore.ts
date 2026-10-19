// analysisStore — per-track-keyed cache of decoded analysis (beats,
// downbeats, BPM, key, cues) + decoded peaks (.cpk tier). Single source of
// truth for these reads. Replaces the module-level currentAnalysis /
// currentPeaks / loadAnalysisFor / loadPeaksFor that used to live in
// main.ts.
//
// API in three layers:
//   1. Direct trackId access — getAnalysis(id) / getPeaks(id). Future
//      multi-instance consumers (BigWaveformView with a specific trackId,
//      preview decks, track-list inline peak charts) read here.
//   2. "Current track" wrappers — getCurrentAnalysis() / getCurrentPeaks().
//      Closes over the player's current trackId. Today's painters all use
//      these because Curator's product invariant is one playback context.
//   3. Listeners — onAnalysisLoaded(cb) / onPeaksLoaded(cb). Caller-side
//      repaint hooks. main.ts subscribes once and runs all dependent paints.
//
// The store internally subscribes to the playerStore (via player.subscribe)
// and auto-kicks loads when the current track changes. No explicit
// ensureLoaded() call is needed for the "current track" case; the
// multi-instance API takes a trackId so future widgets bound to a
// specific track can still drive loads on their own schedule.

import * as player from '../player.js';
import type { SegmentRecord } from '@curator/shared';
import { log } from '../data/log.js';

const slog = log.for('analysis');

export type PeaksSource = 'essentia' | 'rekordbox';

// One channel's three bands.
export interface PeaksBands {
	low: Uint8Array;
	mid: Uint8Array;
	high: Uint8Array;
}

export interface PeaksTier {
	samplesPerSec: number;
	source: PeaksSource;
	// 1 = mono (renders the classic mirrored waveform), 2 = stereo L/R (big
	// wave draws top=left / bottom=right). Every mono path — v1 .cpk files,
	// rekordbox imports — reports 1; the painter falls back accordingly.
	channels: 1 | 2;
	// Channel 0 PEAK — left channel for stereo, the mono signal otherwise. Kept
	// at the top level so mono/peak-only consumers (mini-map SVG, per-track
	// norm) need no channel/metric awareness.
	low: Uint8Array;
	mid: Uint8Array;
	high: Uint8Array;
	// Channel 1 PEAK — present only when channels === 2.
	right: PeaksBands | null;
	// RMS metric (the loudness "body" the Ableton skin fills inside the peak
	// outline). Present only for v3 .cpk files; null for v1/v2, in which case
	// the Ableton skin falls back to a faked peak×fraction fill. `rms` is
	// channel 0, `rightRms` channel 1 (the latter only when channels === 2).
	rms: PeaksBands | null;
	rightRms: PeaksBands | null;
}

export interface CueData {
	id: string;
	// 0-indexed slot in its `kind` namespace. For hot cues, slot 0..7 are
	// the page-1 pads A..H (page 2 starts at 8). For memory cues the slot
	// is a time-ordered ordinal starting at 100. Renderers index pads by
	// this field — NOT by array position — so a track with hot cues at
	// rekordbox slots A,B,C,H leaves D-G empty instead of collapsing the
	// four cues into A-D.
	slot: number;
	positionSec: number;
	lengthSec: number | null;
	color: string | null;
	name: string | null;
	kind: 'hot' | 'memory';
}

export interface AnalysisEntry {
	trackId: string;
	beats: Float32Array | null;
	downbeats: Float32Array | null;
	bpm: number | null;
	keyCamelot: string | null;
	cues: CueData[];
	segments: SegmentRecord[] | null;
}

// Dual-source analysis. Each track_analysis row carries two slots — the
// Curator slot (the analyzer's own grid/segments/key) and the Rekordbox slot
// (rb_* columns from the importer). We cache BOTH decoded so the displayed
// `AnalysisEntry` can be re-resolved instantly when the user flips the
// `analysisSource` player setting, with no re-fetch.
export type AnalysisSource = 'rekordbox' | 'curator';
interface SlotData {
	beats: Float32Array | null;
	downbeats: Float32Array | null;
	bpm: number | null;
	keyCamelot: string | null;
	segments: SegmentRecord[] | null;
}
interface RawAnalysis {
	curator: SlotData;
	rb: SlotData;
	cues: CueData[];
}
// Default Rekordbox: rb-imported grids are the protected source of truth.
let currentSource: AnalysisSource = 'rekordbox';
const rawAnalyses = new Map<string, RawAnalysis>();

// Per-unit resolution: for each of {beatgrid (beats+downbeats+bpm), key,
// segments} pick the preferred slot when it has data, else fall back to the
// other. So with the default 'rekordbox', a track shows rb's grid where rb has
// one and Curator's where it doesn't — and flipping to 'curator' inverts it.
function resolveEntry(trackId: string, raw: RawAnalysis): AnalysisEntry {
	const primary = currentSource === 'rekordbox' ? raw.rb : raw.curator;
	const fallback = currentSource === 'rekordbox' ? raw.curator : raw.rb;
	const beatSlot = (primary.beats?.length ? primary : (fallback.beats?.length ? fallback : primary));
	const keySlot = (primary.keyCamelot != null ? primary : (fallback.keyCamelot != null ? fallback : primary));
	const segSlot = (primary.segments?.length ? primary : (fallback.segments?.length ? fallback : primary));
	return {
		trackId,
		beats: beatSlot.beats,
		downbeats: beatSlot.downbeats,
		bpm: beatSlot.bpm,
		keyCamelot: keySlot.keyCamelot,
		segments: segSlot.segments,
		cues: raw.cues,
	};
}

export interface PeaksEntry {
	trackId: string;
	tier: PeaksTier;
}

type Listener = (trackId: string) => void;

// Track-keyed caches, FIFO-bounded. Peaks dominate the budget so they get the
// tighter cap. A hi-tier file can now reach ~360 KB (v3 stereo: 12 B/sample ×
// 100/s × 300 s = peak+rms × L/R); at 128 entries that's ≈46 MB worst case.
// v1 mono files are ~90 KB so most caches sit far below that. Analysis entries
// are an order of magnitude smaller (beats + cues + segments). Eviction is
// insertion-order FIFO rather than true LRU — the painters hit
// getCurrentAnalysis() inside rAF loops, and touch-on-read bookkeeping at 60 Hz
// buys nothing over FIFO for this access pattern. The player's current track is
// never evicted.
const MAX_ANALYSIS_ENTRIES = 512;
const MAX_PEAKS_ENTRIES = 128;
const analyses = new Map<string, AnalysisEntry>();
const peaks = new Map<string, PeaksEntry>();

function evictOver<T>(cache: Map<string, T>, max: number): void {
	while (cache.size > max) {
		const oldest = cache.keys().next().value as string | undefined;
		if (oldest === undefined) return;
		if (oldest === currentTrackId) {
			// Re-insert at the tail so the current track survives the sweep.
			const entry = cache.get(oldest)!;
			cache.delete(oldest);
			cache.set(oldest, entry);
			// Cache holds only the current track and we're still over max —
			// max is misconfigured; bail rather than spin.
			if (cache.size <= 1) return;
			continue;
		}
		cache.delete(oldest);
	}
}
const loadingAnalysis = new Set<string>();
const loadingPeaks = new Set<string>();
const analysisListeners = new Set<Listener>();
const peaksListeners = new Set<Listener>();

let currentTrackId: string | null = null;

// ─── Decode helpers (moved out of main.ts) ──────────────────────────────────

// Decode a packed Float32LE blob (track_analysis.beatgrid / .downbeats) into
// a typed array. SQLite drivers can hand us a Uint8Array, a Buffer, or —
// once it goes through structured-clone IPC — an ArrayBuffer-ish wrapper.
// Normalize all three through the underlying buffer offsets.
function decodeFloat32Blob(buf: Uint8Array | ArrayBufferView | null | undefined): Float32Array | null {
	if (!buf) return null;
	if (buf instanceof Float32Array) return buf;
	const view = buf as ArrayBufferView;
	if (!view.buffer || view.byteLength === 0) return null;
	// Float32Array requires the byte offset to be 4-byte aligned. SQLite
	// blobs are almost always aligned but copy defensively when they aren't.
	if (view.byteOffset % 4 === 0 && view.byteLength % 4 === 0) {
		return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
	}
	const copy = new Uint8Array(view.byteLength);
	copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	return new Float32Array(copy.buffer);
}

// Minimal .cpk decoder. Format reference: apps/core/src/analyzer/cpk.ts.
// Reads v1 (mono, 20-byte header) and v2 (mono or stereo, 21-byte header with
// num_channels at offset 10). Body is channel-major per sample:
//   mono:   [low,mid,high, …]
//   stereo: [L_low,L_mid,L_high, R_low,R_mid,R_high, …]
// Our split lo/hi files store everything in the detail block; overview_count
// is always 0 per file, so we only read the detail block here.
function decodeCpk(buf: Uint8Array, source: PeaksSource): PeaksTier | null {
	if (buf.byteLength < 20) return null;
	const magic = 'CURPEAKS';
	for (let i = 0; i < 8; i++) if (buf[i] !== magic.charCodeAt(i)) return null;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = dv.getUint8(8);
	const numBands = dv.getUint8(9);
	if ((version !== 1 && version !== 2 && version !== 3) || numBands !== 3) return null;
	// v1 is mono; v2/v3 carry num_channels at offset 10 and push the rest of the
	// header down by one byte. v3 also doubles the metrics (peak + rms), implied
	// by the version.
	const channels = version === 1 ? 1 : dv.getUint8(10);
	if (channels !== 1 && channels !== 2) return null;
	const metrics = version === 3 ? 2 : 1;
	const headerSize = version === 1 ? 20 : 21;
	const spsOff = version === 1 ? 10 : 11;
	const samplesPerSec = dv.getUint16(spsOff, true);
	const detailCount = dv.getUint32(spsOff + 2, true);
	const stride = 3 * metrics * channels;
	const needed = headerSize + detailCount * stride;
	if (buf.byteLength < needed) return null;
	// Within a sample: (ch0 peak)(ch0 rms)(ch1 peak)(ch1 rms) — only present
	// groups. Group index = channel × metrics + metric; byte offset = group × 3.
	const readGroup = (channel: number, metric: number): PeaksBands => {
		const groupOff = (channel * metrics + metric) * 3;
		const low = new Uint8Array(detailCount);
		const mid = new Uint8Array(detailCount);
		const high = new Uint8Array(detailCount);
		for (let i = 0; i < detailCount; i++) {
			const base = headerSize + i * stride + groupOff;
			low[i] = buf[base]!;
			mid[i] = buf[base + 1]!;
			high[i] = buf[base + 2]!;
		}
		return { low, mid, high };
	};
	const stereo = channels === 2;
	const hasRms = metrics === 2;
	const left = readGroup(0, 0);
	return {
		samplesPerSec,
		source,
		channels: channels as 1 | 2,
		low: left.low,
		mid: left.mid,
		high: left.high,
		right: stereo ? readGroup(1, 0) : null,
		rms: hasRms ? readGroup(0, 1) : null,
		rightRms: hasRms && stereo ? readGroup(1, 1) : null,
	};
}

// Drizzle's `mode: 'json'` normally parses on read, but the IPC boundary can
// hand us a raw string when better-sqlite3 returns the column unparsed in some
// configurations. Defensive parse; null on absent/malformed.
function parseSegments(raw: unknown): SegmentRecord[] | null {
	if (Array.isArray(raw)) return raw as SegmentRecord[];
	if (typeof raw === 'string' && raw.length > 0) {
		try { return JSON.parse(raw) as SegmentRecord[]; }
		catch { return null; }
	}
	return null;
}

// Switch the displayed analysis source (player setting). Re-resolves every
// cached track from its already-decoded slots — no re-fetch — and notifies the
// current track so the waveform/player repaint immediately.
export function setAnalysisSource(source: AnalysisSource): void {
	if (source === currentSource) return;
	currentSource = source;
	for (const [id, raw] of rawAnalyses) analyses.set(id, resolveEntry(id, raw));
	if (currentTrackId) for (const cb of analysisListeners) cb(currentTrackId);
}
export function getAnalysisSource(): AnalysisSource { return currentSource; }

// ─── Loaders ────────────────────────────────────────────────────────────────

async function loadAnalysis(trackId: string): Promise<void> {
	if (analyses.has(trackId) || loadingAnalysis.has(trackId)) return;
	loadingAnalysis.add(trackId);
	try {
		const [analysis, cues] = await Promise.all([
			window.api['analysis:get'](trackId).catch(() => null),
			window.api['analysis:cues'](trackId).catch(() => []),
		]);
		// Decode both slots: the Curator slot (legacy columns) and the
		// Rekordbox slot (rb_* columns). The displayed entry is resolved from
		// these per the current analysisSource (see resolveEntry).
		const curator: SlotData = {
			beats: decodeFloat32Blob(analysis?.beatgrid as Uint8Array | null),
			downbeats: decodeFloat32Blob(analysis?.downbeats as Uint8Array | null),
			bpm: analysis?.bpm ?? null,
			keyCamelot: analysis?.keyCamelot ?? null,
			segments: parseSegments(analysis?.segmentsJson),
		};
		const rb: SlotData = {
			beats: decodeFloat32Blob(analysis?.rbBeatgrid as Uint8Array | null),
			downbeats: decodeFloat32Blob(analysis?.rbDownbeats as Uint8Array | null),
			bpm: analysis?.rbBpm ?? null,
			keyCamelot: analysis?.rbKeyCamelot ?? null,
			segments: parseSegments(analysis?.rbSegmentsJson),
		};
		const raw: RawAnalysis = {
			curator,
			rb,
			cues: cues.map((c) => ({
				id: c.id,
				slot: c.slot,
				positionSec: c.positionSec,
				lengthSec: c.lengthSec,
				color: c.color,
				name: c.name,
				kind: c.kind,
			})),
		};
		rawAnalyses.set(trackId, raw);
		analyses.set(trackId, resolveEntry(trackId, raw));
		evictOver(analyses, MAX_ANALYSIS_ENTRIES);
		evictOver(rawAnalyses, MAX_ANALYSIS_ENTRIES);
		slog.info('loaded', {
			trackId,
			analysisRow: !!analysis,
			source: currentSource,
			rbBeats: rb.beats?.length ?? 0,
			curatorBeats: curator.beats?.length ?? 0,
			cuesCount: cues.length,
		});
		for (const cb of analysisListeners) cb(trackId);
	} finally {
		loadingAnalysis.delete(trackId);
	}
}

async function loadPeaks(trackId: string): Promise<void> {
	if (peaks.has(trackId) || loadingPeaks.has(trackId)) return;
	loadingPeaks.add(trackId);
	try {
		// 'hi' tier — 100 Hz detail, full-res per-track peaks. A 5-min track is
		// ~90 KB (30k samples × 3 bytes); fine for the renderer's memory budget
		// and gives one peak per pixel on a 1000-px-wide scrubber.
		const resp = await fetch(`curator-peaks://${encodeURIComponent(trackId)}/hi`);
		if (!resp.ok) {
			// 404 just means "no peaks for this track yet" (analyzer hasn't
			// run, no rb_*.cpk file). Silent; listener still fires so the
			// painter can clear the bar.
			for (const cb of peaksListeners) cb(trackId);
			return;
		}
		const buf = new Uint8Array(await resp.arrayBuffer());
		// Producer hint: main process sets this based on the resolved file
		// path (rb_*.cpk → rekordbox, else → essentia). Drives the channel-
		// to-display-colour mapping inside the waveform painters.
		const sourceHdr = resp.headers.get('X-Peaks-Source');
		const source: PeaksSource = sourceHdr === 'rekordbox' ? 'rekordbox' : 'essentia';
		const tier = decodeCpk(buf, source);
		if (tier) {
			peaks.set(trackId, { trackId, tier });
			evictOver(peaks, MAX_PEAKS_ENTRIES);
		}
		for (const cb of peaksListeners) cb(trackId);
	} catch (err) {
		log.for('peaks').warn('load failed', { trackId }, err);
		for (const cb of peaksListeners) cb(trackId);
	} finally {
		loadingPeaks.delete(trackId);
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Multi-instance entry point — caller asks for a specific trackId to be
// loaded. Idempotent; no-op when already cached or loading. Fires
// listeners on completion, OR synchronously if the entry is already
// cached so subscribers re-anchor on the new current track (e.g. user
// revisits a previously-played track — load short-circuits but the
// downstream signals still need a kick).
export function ensureLoaded(trackId: string): void {
	void loadAnalysis(trackId);
	void loadPeaks(trackId);
	// Synchronous cache-hit notification. loadAnalysis/loadPeaks above
	// early-return without firing listeners when the entry is already
	// cached; this path covers that gap.
	if (analyses.has(trackId)) {
		for (const cb of analysisListeners) cb(trackId);
	}
	if (peaks.has(trackId)) {
		for (const cb of peaksListeners) cb(trackId);
	}
}

// Synchronous reads. Return null when no entry is cached (caller paints
// empty state). Pass null / undefined to short-circuit to null — callers
// often pass `state.current?.trackId` directly.
export function getAnalysis(trackId: string | null | undefined): AnalysisEntry | null {
	return trackId ? analyses.get(trackId) ?? null : null;
}
export function getPeaks(trackId: string | null | undefined): PeaksEntry | null {
	return trackId ? peaks.get(trackId) ?? null : null;
}
export function getCurrentAnalysis(): AnalysisEntry | null {
	return getAnalysis(currentTrackId);
}
export function getCurrentPeaks(): PeaksEntry | null {
	return getPeaks(currentTrackId);
}
export function getCurrentTrackId(): string | null { return currentTrackId; }

// Re-fetch cues for a track and patch them into the cached entry. Used
// after user-driven cue mutations (upsert/update/delete from the pad
// context menu) so the UI repaints without re-loading beats + peaks. No-op
// when the entry isn't cached yet — the next regular ensureLoaded() will
// pick the new state up.
export async function refreshCues(trackId: string): Promise<void> {
	const raw = rawAnalyses.get(trackId);
	if (!raw) return;
	try {
		const cues = await window.api['analysis:cues'](trackId);
		raw.cues = cues.map((c) => ({
			id: c.id,
			slot: c.slot,
			positionSec: c.positionSec,
			lengthSec: c.lengthSec,
			color: c.color,
			name: c.name,
			kind: c.kind,
		}));
		analyses.set(trackId, resolveEntry(trackId, raw));
		for (const cb of analysisListeners) cb(trackId);
	} catch (err) {
		slog.warn('refreshCues failed', { trackId }, err);
	}
}

// Evict a track's cached analysis + peaks — called when the analyzer
// re-runs a track, so the next read (or the immediate reload below, when
// it's the playing track) picks up the fresh beats/cues/peaks instead of
// painting the pre-re-analysis state until the session restarts. The
// peaks fetch bypasses HTTP caching concerns because curator-peaks:// is
// re-resolved per request in the main process.
export function invalidate(trackId: string): void {
	const hadEntry = analyses.delete(trackId);
	rawAnalyses.delete(trackId);
	const hadPeaks = peaks.delete(trackId);
	if (trackId === currentTrackId) {
		// Playing track: reload immediately so painters swap to the new data
		// as soon as it lands (ensureLoaded fires the listeners on completion).
		ensureLoaded(trackId);
	} else if (hadEntry || hadPeaks) {
		// Non-current track: just notify so any widget bound to this trackId
		// (preview decks, inline charts) can clear or re-request.
		for (const cb of analysisListeners) cb(trackId);
		for (const cb of peaksListeners) cb(trackId);
	}
}

// Observer registration. Listeners receive the trackId whose load just
// completed — caller decides whether to repaint (e.g. only if it matches
// the player's current track, or only if it matches a preview-deck's
// own trackId).
export function onAnalysisLoaded(cb: Listener): () => void {
	analysisListeners.add(cb);
	return () => analysisListeners.delete(cb);
}
export function onPeaksLoaded(cb: Listener): () => void {
	peaksListeners.add(cb);
	return () => peaksListeners.delete(cb);
}

// Subscribe once at module load to track the player's current trackId
// and auto-load on track change. Idempotent — re-importing the module
// doesn't re-subscribe because module evaluation runs once per renderer.
player.subscribe((st) => {
	const id = st.current?.trackId ?? null;
	if (id === currentTrackId) return;
	currentTrackId = id;
	if (id) ensureLoaded(id);
});

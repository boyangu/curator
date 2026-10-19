// MainWaveformView — the main scrubber bar (#t-bar). The largest player
// component yet. Zoomed canvas via paintWaveformOntoCanvas + beat grid
// overlay + playhead + viewport-aware cue badges, all driven by an rAF
// tick at vsync, plus zoom controls (+/-/label) and a bar-count readout.
//
// Mounted in BOTH player modes: the big deck (full phrase geometry; zoom,
// skin picker and bar readout visible) and the 44px small-player strip
// (`compact` — thin phrase bands, no lane labels; those overlays are
// `.big-only` and CSS-hidden there). One instance exists at a time —
// PlayerFooter's mode <Show> remounts on every toggle.
//
// Per-instance ownership of every sub-surface the bar contains:
//   • the bar element + wave-inner + played-position fill + playhead
//   • the rAF loop (starts on mode → big, stops on mode → small)
//   • the beat-grid DOM pool
//   • zoom state + persistence callback
//   • cue badges (rendered via <For>, viewport-aware in big mode)
//   • position-interpolation anchors (per-component, no globals)
//   • the time readout
//   • click-to-seek with optional snap (no CSS transition for the snap)
//
// External imperative hook — `snapTo(positionSec)` on the handle — lets
// callers outside the component (cue grid pad clicks, beat-jump
// keyboard shortcuts) make the played-position overlay snap-jump to a
// new position without the CSS transition, then let the next reactive
// update settle into smooth animation. Wired through `setSnapTo` to
// pierce the Solid component boundary.

import { For, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { SegmentRecord } from '@curator/shared';
import type { PeaksTier, CueData } from '../stores/analysisStore.js';
import { paintWaveformOntoCanvas, phraseGeometry } from '../renderers/canvasWaveform.js';
import { SKINS, getSkin, type SkinId } from '../renderers/waveformStyles.js';
import { cueColor } from '../cuePalette.js';
import { onFrame } from '../ticker.js';

// Loop region descriptor — mirrors the deck's LoopRegion shape so the
// component doesn't need a controller import (keeps presentational
// components free of musical-time logic).
export interface LoopRegionView {
	inSec: number;
	outSec: number;
}

// Big-mode zoom: how many bars fit in the visible viewport at each step.
// Lower index = more zoomed in (fewer bars). Default centres on 16 bars
// (idx=4) which matches Rekordbox's mid-range scrubber zoom.
export const BIG_ZOOM_BAR_LEVELS = [1, 2, 4, 8, 16, 32] as const;
export const BIG_ZOOM_DEFAULT_IDX = 4;
const BEATS_PER_BAR = 4;

function fmt(s: number): string {
	if (!Number.isFinite(s) || s < 0) return '--:--';
	const m = Math.floor(s / 60);
	const r = Math.floor(s % 60);
	return `${m}:${r.toString().padStart(2, '0')}`;
}

export interface MainWaveformViewProps {
	// Small-player strip variant: compact phrase geometry (phraseGeometry
	// in canvasWaveform.ts). Static — the view remounts on every mode /
	// variant flip, so no instance ever changes profile.
	compact: boolean;
	peaks: Accessor<PeaksTier | null>;
	beats: Accessor<Float32Array | null>;
	// Authoritative downbeat times (s). For rb-imported tracks the first
	// downbeat is routinely offset from `beats[0]` by a pickup of N beats
	// (e.g. beats=[0.444, 0.944, 1.444…] but downbeats=[1.444, 3.444…] on
	// a 120 BPM track with 2 pickup beats). Used by drawBeatGrid for the
	// bar-tick decision and by updateBarLabel for the bar counter so both
	// align with rb's bar grid instead of drifting by the pickup offset.
	// May be null on legacy rows or tracks whose analyzer pass predates
	// downbeat extraction — in that case we fall back to `beats[i] where
	// i % 4 === 0`, which is wrong for pickup tracks but no worse than
	// what we had before.
	downbeats: Accessor<Float32Array | null>;
	cues: Accessor<CueData[]>;
	segments: Accessor<SegmentRecord[] | null>;
	duration: Accessor<number>;
	positionSec: Accessor<number>;
	isPlaying: Accessor<boolean>;
	initialZoomIdx?: number;
	onZoomChange?: (idx: number) => void;
	// Skin is a reactive accessor so the mini-wavemap can read the same
	// signal — one user-visible picker, both views update.
	skin: Accessor<SkinId>;
	onSkinChange: (id: SkinId) => void;
	onSeek: (positionSec: number) => void;
	// Vinyl-style scrub callbacks. Fired by the pointer-event drag flow:
	//   • onScrubStart — fires once when the down crosses the 3 px drag
	//     threshold. Caller pauses local playback (or the streaming SDK)
	//     and notes whether to resume on scrubEnd.
	//   • onScrubMove — fires on every pointermove past the threshold.
	//     For local source this rate-controls audio via the Rust sidecar's
	//     scrub_to RPC; for streaming source it's a no-op (silent).
	//   • onScrubEnd — fires on pointerup. `resumePlaying` is the
	//     `wasPlaying` state captured at down so the deck restarts only
	//     if it was running when the user grabbed the wave.
	// Under-threshold up is a click-to-seek (existing onSeek path).
	//
	// `targetSec` is an optional snap-on-entry — mini-wavemap passes the
	// click position so the playhead jumps without slewing; big-wave
	// omits it (grab-and-drag from current playhead).
	onScrubStart: (targetSec?: number) => void;
	onScrubMove: (positionSec: number) => void;
	onScrubEnd: (positionSec: number, resumePlaying: boolean) => void;
	// Active loop region (null when no loop). When set, the painter overlays
	// a translucent band across [inSec, outSec] in viewport coords. Lives
	// in the rAF tick alongside cue painting so it tracks viewport scroll.
	activeLoop?: Accessor<LoopRegionView | null>;
	// Lifecycle hook — invoked with the snapTo function on mount and with
	// null on dispose, so callers outside the Solid component boundary can
	// drive instant-jumps while a bar is mounted and no-op otherwise.
	setSnapTo?: (fn: ((positionSec: number) => void) | null) => void;
}

export interface MainWaveformViewHandle {
	destroy(): void;
	snapTo(positionSec: number): void;
}

export function MainWaveformView(props: MainWaveformViewProps) {
	let barRef!: HTMLDivElement;
	let innerRef!: HTMLDivElement;
	let fillRef!: HTMLDivElement;
	let playheadRef!: HTMLDivElement;
	let loopOverlayRef!: HTMLDivElement;
	let barLabelRef!: HTMLSpanElement;
	let countdownRef!: HTMLSpanElement;

	// ─── Zoom state ─────────────────────────────────────────────────────────
	const [zoomIdx, setZoomIdx] = createSignal(props.initialZoomIdx ?? BIG_ZOOM_DEFAULT_IDX);
	const visibleBars = (): number => BIG_ZOOM_BAR_LEVELS[zoomIdx()] ?? 16;
	createEffect(() => { props.onZoomChange?.(zoomIdx()); });

	// ─── Skin ──────────────────────────────────────────────────────────────
	// Lifted to the parent — the picker writes via props.onSkinChange,
	// the painters read via props.skin(). The mini-wavemap reads the
	// same accessor so the two views stay in lock-step.
	const skin = () => getSkin(props.skin());
	const geom = phraseGeometry(props.compact);

	// ─── Position-interpolation anchors ─────────────────────────────────────
	// The audio backend emits state ticks at 4-20 Hz; the rAF tick paints
	// at 60. Interpolate locally between state ticks so the scroll motion
	// is smooth at the paint rate, not the backend's tick rate.
	//
	// Tolerance on backward corrections: the first few emits after a
	// play-start typically lag our wall-clock extrapolation — the audio
	// backend has codec/buffer latency, so position=0 emitted at play
	// time isn't where the audio actually is when it begins ticking. If
	// we re-anchor on every emit that's BEHIND extrapolation, the
	// playhead jumps backward sub-second. Instead, ignore small (<300ms)
	// backward corrections — extrapolation keeps running. Big jumps
	// (seek, track change) snap as usual.
	const BACK_DRIFT_TOLERANCE_SEC = 0.3;
	let lastStatePos = 0;
	let lastStateAt = 0;
	let lastStatePlaying = false;
	createEffect(() => {
		const newPos = props.positionSec();
		const playing = props.isPlaying();
		// Within-tolerance backward correction → keep extrapolating.
		if (playing && lastStatePlaying && lastStateAt > 0) {
			const extrapolated = lastStatePos + (performance.now() - lastStateAt) / 1000;
			const driftBack = extrapolated - newPos;
			if (driftBack > 0 && driftBack < BACK_DRIFT_TOLERANCE_SEC) {
				// Keep prior anchor; just track play state in case it changed.
				lastStatePlaying = playing;
				return;
			}
		}
		lastStatePos = newPos;
		lastStateAt = performance.now();
		lastStatePlaying = playing;
	});
	function getInterpolatedPosition(): number {
		if (!lastStatePlaying || lastStateAt === 0) return lastStatePos;
		const elapsed = (performance.now() - lastStateAt) / 1000;
		return lastStatePos + elapsed;
	}

	// ─── Played-position fill ───────────────────────────────────────────────
	// Painted on each rAF tick using getInterpolatedPosition() — see
	// paintPlayedFill() below. Previously this lived in a createEffect
	// reactive on props.positionSec(), which only re-fired on emit. With
	// Spotify's 200ms poll that meant the fill stepped in 200ms
	// increments while peaks were still loading (vp=null fallback mode).
	// rAF + extrapolation keeps it smooth between emits.
	function paintPlayedFill(): void {
		if (!fillRef) return;
		const dur = untrack(() => props.duration());
		const pct = dur > 0
			? Math.max(0, Math.min(100, (getInterpolatedPosition() / dur) * 100))
			: 0;
		fillRef.style.width = `${pct}%`;
	}
	function snapTo(positionSec: number): void {
		if (!fillRef) return;
		const dur = untrack(() => props.duration());
		if (!dur) return;
		const pct = Math.max(0, Math.min(100, (positionSec / dur) * 100));
		const prev = fillRef.style.transition;
		fillRef.style.transition = 'none';
		void fillRef.offsetWidth;
		fillRef.style.width = `${pct}%`;
		void fillRef.offsetWidth;
		fillRef.style.transition = prev;
	}
	if (props.setSnapTo) props.setSnapTo(snapTo);
	// The registry in PlayerFooter outlives this instance. Nulling on
	// dispose is what makes "no bar mounted" (the streaming strip) a no-op
	// rather than a call into a disposed closure; Solid runs this cleanup
	// before the next <Show> branch registers, so a mode flip can't leave
	// a stale fn behind.
	onCleanup(() => { props.setSnapTo?.(null); });

	// ─── Viewport (big mode) ────────────────────────────────────────────────
	// Grid-less fallback: tracks without a beat grid (not yet analyzed, no
	// rb import) still get the scrolling viewport, windowed by TIME with a
	// 120 BPM assumption (2 s/bar) so the zoom levels keep a sensible
	// scale. The beat grid / bar counter stay absent — paintBeatGrid and
	// updateBarLabel handle null beats on their own.
	const FALLBACK_SEC_PER_BAR = 2;
	// `cssW`/`dpr` enable the device-pixel scroll snap (below). The pointer-
	// event callers omit them — they only need the viewport for a click
	// hit-test, where a sub-pixel snap difference is irrelevant.
	function computeViewport(cssW?: number, dpr?: number): { start: number; end: number; positionWithin: number } | null {
		const beats = props.beats();
		const dur = props.duration();
		if (!dur) return null;
		const pos = getInterpolatedPosition();
		let windowSec: number;
		let anchor = pos;
		if (beats && beats.length >= 2) {
			const visBeats = visibleBars() * BEATS_PER_BAR;
			const beatDur = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
			windowSec = visBeats * beatDur;
			const firstBeat = beats[0]!;
			// Anchor on the first beat when the play position is before it and
			// within half a window away. Otherwise centre on the position.
			if (pos < firstBeat && (firstBeat - pos) <= windowSec / 2) anchor = firstBeat;
		} else {
			windowSec = visibleBars() * FALLBACK_SEC_PER_BAR;
		}
		let startSec = anchor - windowSec / 2;
		// Device-pixel scroll snap. Quantize the viewport's left edge to a
		// whole device pixel so that, frame-to-frame, the entire rendered
		// image — the canvas waves AND the beat-grid / cue overlays — shifts
		// by an integer number of device pixels. A raster translated by whole
		// pixels isn't re-anti-aliased, so the silhouette and the grid stop
		// shimmering ("breathing") as the view scrolls. Motion now advances in
		// ~1-device-pixel steps, imperceptible at 60 Hz. The playhead is fed
		// the true (un-snapped) position separately, so it still glides.
		if (cssW && cssW > 0 && dpr && dpr > 0 && windowSec > 0) {
			const secPerDevPx = windowSec / (cssW * dpr);
			startSec = Math.round(startSec / secPerDevPx) * secPerDevPx;
		}
		const endSec = startSec + windowSec;
		const positionWithin = (pos - startSec) / windowSec;
		return { start: startSec / dur, end: endSec / dur, positionWithin };
	}

	// ─── Cue badges — pooled DOM, painted on every rAF tick ────────────────
	// Solid <For> was tempting but its reactivity is tied to cueRows(),
	// which doesn't read positionSec(). In big mode the viewport scrolls
	// continuously via rAF; cue positions need to update at the paint
	// rate, not the backend's state-tick rate. So we manage the cue divs
	// imperatively (same shape as paintBeatGrid below): one DOM element
	// per cue, rebuilt only when the cue array identity changes, then
	// repositioned on every paint.
	//
	// Three marker families, each with RB's visual language:
	//   • Hot cues — lettered badge (slot letter, NOT array position; a
	//     track with hot cues at slots A,B,C,H keeps the H at slot 7
	//     instead of collapsing to D). Keep in sync with CueGridView.
	//   • Memory cues — small colored triangle at the top edge, no letter.
	//     Previously filtered out entirely; now rendered the way RB does.
	//   • Stored loops — any cue carrying `lengthSec` (RB loop cues, hot
	//     or memory) paints a translucent band across its region, dimmer
	//     than the ACTIVE loop overlay so saved vs. live read distinctly.
	const cueDomPool: HTMLDivElement[] = [];
	// Parallel array of the cues backing each DOM element — paintCues
	// reads positionSec off this list instead of indexing props.cues()
	// by `i` (which would re-introduce the slot-vs-position bug).
	let cueDomCues: CueData[] = [];
	const memCueDomPool: HTMLDivElement[] = [];
	let memCueDomCues: CueData[] = [];
	const loopBandPool: HTMLDivElement[] = [];
	let loopBandCues: CueData[] = [];
	let cueDomCueSig: string = '';
	function cueTitle(c: CueData): string {
		const mins = Math.floor(c.positionSec / 60);
		const secs = String(Math.floor(c.positionSec) % 60).padStart(2, '0');
		return `${c.name ?? c.kind} · ${mins}:${secs}`;
	}
	function rebuildCueDom(): void {
		if (!innerRef) return;
		for (const el of cueDomPool) el.remove();
		for (const el of memCueDomPool) el.remove();
		for (const el of loopBandPool) el.remove();
		cueDomPool.length = 0;
		memCueDomPool.length = 0;
		loopBandPool.length = 0;
		cueDomCues = [];
		memCueDomCues = [];
		loopBandCues = [];
		const cues = untrack(() => props.cues());
		for (const c of cues) {
			if (c.kind === 'hot') {
				const letter = c.slot < 26 ? String.fromCharCode(65 + c.slot) : String(c.slot + 1);
				const el = document.createElement('div');
				el.className = 't-cue';
				el.style.background = cueColor(c.color);
				el.textContent = letter;
				el.title = cueTitle(c);
				el.addEventListener('click', (ev) => {
					ev.stopPropagation();
					snapTo(c.positionSec);
					props.onSeek(c.positionSec);
				});
				innerRef.appendChild(el);
				cueDomPool.push(el);
				cueDomCues.push(c);
			} else {
				const el = document.createElement('div');
				el.className = 't-memcue';
				el.style.background = cueColor(c.color);
				el.title = cueTitle(c);
				el.addEventListener('click', (ev) => {
					ev.stopPropagation();
					snapTo(c.positionSec);
					props.onSeek(c.positionSec);
				});
				innerRef.appendChild(el);
				memCueDomPool.push(el);
				memCueDomCues.push(c);
			}
			if (c.lengthSec != null && c.lengthSec > 0) {
				// #RRGGBB from the palette — append alpha pairs for the dim
				// fill vs. the crisper edge color.
				const hex = cueColor(c.color);
				const el = document.createElement('div');
				el.className = 't-loop-band';
				el.style.background = `${hex}12`;
				el.style.borderColor = `${hex}99`;
				el.title = cueTitle(c);
				innerRef.appendChild(el);
				loopBandPool.push(el);
				loopBandCues.push(c);
			}
		}
	}
	// Rebuild when the cue set changes (track switch) OR when any field the
	// imperative paint consumes changes (color from the context-menu picker,
	// name from rename, slot/position/length from a position edit). Hash
	// covers every field rebuildCueDom + paintCues read so an id-only hash
	// can't mask a color/name change.
	createEffect(() => {
		const cues = props.cues();
		const sig = cues.map((c) => `${c.id}:${c.kind}:${c.slot}:${c.color ?? ''}:${c.name ?? ''}:${c.positionSec}:${c.lengthSec ?? ''}`).join('|');
		if (sig === cueDomCueSig) return;
		cueDomCueSig = sig;
		rebuildCueDom();
	});
	// Position a viewport-anchored overlay by a composited transform instead
	// of `left: %`. Two wins over `left`: it skips the layout reflow that
	// rewriting `left` across the whole beat-grid pool every frame would
	// trigger, and — with the device-snapped viewport — the commanded x
	// advances by whole device pixels, so the translate is shimmer-free and
	// stays pixel-aligned with the canvas waves. `center` folds in the
	// element's own centring offset ('-50%' for badges/triangles, '-0.5px'
	// for hairlines) so it composes with the scroll translate.
	const setX = (el: HTMLElement, xPx: number, center: string): void => {
		el.style.transform = `translateX(${xPx}px) translateX(${center})`;
	};
	// Loop region overlay. Reads activeLoop() and positions the band in
	// viewport coords (or whole-track when there's no viewport). Hidden
	// when no loop is active or when both ends are off-screen. Painted on
	// every rAF tick so it tracks the scrolling viewport in big mode and
	// the playback fill in small/no-beats mode.
	function paintLoop(vp: { start: number; end: number } | null): void {
		if (!loopOverlayRef) return;
		const loop = props.activeLoop?.();
		const dur = untrack(() => props.duration());
		if (!loop || !dur || loop.outSec <= loop.inSec) {
			loopOverlayRef.style.display = 'none';
			return;
		}
		const vpStartSec = vp ? vp.start * dur : 0;
		const vpEndSec   = vp ? vp.end   * dur : dur;
		const spanSec    = Math.max(0.0001, vpEndSec - vpStartSec);
		const leftPct  = ((loop.inSec  - vpStartSec) / spanSec) * 100;
		const rightPct = ((loop.outSec - vpStartSec) / spanSec) * 100;
		// Cull when entirely off-viewport; otherwise clamp ends so a loop
		// that only partially intersects still paints its visible portion.
		if (rightPct < 0 || leftPct > 100) {
			loopOverlayRef.style.display = 'none';
			return;
		}
		const lo = Math.max(0, leftPct);
		const hi = Math.min(100, rightPct);
		loopOverlayRef.style.display = '';
		loopOverlayRef.style.left = `${lo}%`;
		loopOverlayRef.style.width = `${Math.max(0, hi - lo)}%`;
	}

	function paintCues(vp: { start: number; end: number } | null, cssW: number): void {
		const dur = untrack(() => props.duration());
		if (!dur) {
			for (const el of cueDomPool) el.style.display = 'none';
			for (const el of memCueDomPool) el.style.display = 'none';
			for (const el of loopBandPool) el.style.display = 'none';
			return;
		}
		const vpStartSec = vp ? vp.start * dur : 0;
		const vpEndSec   = vp ? vp.end   * dur : dur;
		const spanSec    = Math.max(0.0001, vpEndSec - vpStartSec);
		// Point markers (hot badges + memory triangles) — one x per cue,
		// culled when outside the viewport.
		const paintPoints = (pool: HTMLDivElement[], list: CueData[]): void => {
			for (let i = 0; i < pool.length; i++) {
				const c = list[i]!;
				const el = pool[i]!;
				const xPx = ((c.positionSec - vpStartSec) / spanSec) * cssW;
				// Cull off-viewport with a badge-width margin so a marker whose
				// centre sits just outside still paints its visible sliver.
				if (!Number.isFinite(xPx) || xPx < -16 || xPx > cssW + 16) {
					el.style.display = 'none';
				} else {
					el.style.display = '';
					setX(el, xPx, '-50%');
				}
			}
		};
		paintPoints(cueDomPool, cueDomCues);
		paintPoints(memCueDomPool, memCueDomCues);
		// Stored-loop bands — clamp partially-visible regions to the
		// viewport edges, same shape as paintLoop below.
		for (let i = 0; i < loopBandPool.length; i++) {
			const c = loopBandCues[i]!;
			const el = loopBandPool[i]!;
			const leftPct  = ((c.positionSec - vpStartSec) / spanSec) * 100;
			const rightPct = ((c.positionSec + (c.lengthSec ?? 0) - vpStartSec) / spanSec) * 100;
			if (!Number.isFinite(leftPct) || rightPct < 0 || leftPct > 100) {
				el.style.display = 'none';
				continue;
			}
			const lo = Math.max(0, leftPct);
			const hi = Math.min(100, rightPct);
			el.style.display = '';
			el.style.left = `${lo}%`;
			el.style.width = `${Math.max(0, hi - lo)}%`;
		}
	}

	// ─── Beat grid (big mode) — pooled DOM ──────────────────────────────────
	// Two visual treatments per RB convention:
	//   • Downbeats — full-height vertical line through the wave + red
	//     triangle markers at top + bottom (downbeatLinePool + downbeatTopPool/BotPool).
	//   • Mid-bar beats — small 2×2 px ticks at the top and bottom edges of
	//     the wave area only, no through-line (beatTickTopPool/BotPool).
	// Separate pools so the cleanup pass doesn't need to track which beat
	// type each element was last painted as.
	const downbeatLinePool: HTMLDivElement[] = [];
	const downbeatTopPool: HTMLDivElement[] = [];
	const downbeatBotPool: HTMLDivElement[] = [];
	const beatTickTopPool: HTMLDivElement[] = [];
	const beatTickBotPool: HTMLDivElement[] = [];
	function clearBeatGrid(): void {
		for (const el of downbeatLinePool) el.style.display = 'none';
		for (const el of downbeatTopPool) el.style.display = 'none';
		for (const el of downbeatBotPool) el.style.display = 'none';
		for (const el of beatTickTopPool) el.style.display = 'none';
		for (const el of beatTickBotPool) el.style.display = 'none';
	}
	// Downbeat lookup Set, cached on the source array's identity — the
	// tick calls paintBeatGrid at 60 Hz and rebuilding a Set from a few
	// hundred floats every frame is pure allocation churn. The array is
	// replaced wholesale on track change / re-analysis, so identity is a
	// sufficient cache key.
	let downbeatSetSrc: Float32Array | null = null;
	let downbeatSetCache: Set<number> | null = null;
	function getDownbeatSet(downbeats: Float32Array | null): Set<number> | null {
		if (downbeats !== downbeatSetSrc) {
			downbeatSetSrc = downbeats;
			downbeatSetCache = downbeats && downbeats.length > 0
				? new Set<number>(Array.from(downbeats))
				: null;
		}
		return downbeatSetCache;
	}
	function paintBeatGrid(vp: { start: number; end: number }, cssW: number): void {
		if (!innerRef) return;
		const beats = props.beats();
		const dur = props.duration();
		if (!beats || !dur) { clearBeatGrid(); return; }
		// Downbeat detection: prefer the dedicated downbeats array (rb +
		// modern-analyzer source of truth, handles pickup beats correctly).
		// Match by float-equality — both arrays come from the same
		// persistence and share the exact float values, so equality holds.
		// Fall back to `i % 4 === 0` only when downbeats is absent
		// (legacy / pre-downbeat-extraction rows).
		const downbeatSet = getDownbeatSet(props.downbeats());
		const startSec = vp.start * dur;
		const endSec = vp.end * dur;
		const spanSec = Math.max(0.0001, endSec - startSec);
		let downbeatIdx = 0;
		let tickIdx = 0;
		for (let i = 0; i < beats.length; i++) {
			const t = beats[i]!;
			if (t < startSec || t > endSec) continue;
			const xPx = ((t - startSec) / spanSec) * cssW;
			const isDownbeat = downbeatSet ? downbeatSet.has(t) : (i % BEATS_PER_BAR === 0);
			if (isDownbeat) {
				// Through-the-wave vertical line, red.
				let line = downbeatLinePool[downbeatIdx];
				if (!line) {
					line = document.createElement('div');
					line.className = 'beat-line is-downbeat';
					downbeatLinePool.push(line);
					innerRef.appendChild(line);
				}
				setX(line, xPx, '-0.5px');
				line.style.display = '';
				// Triangle markers at top + bottom.
				let top = downbeatTopPool[downbeatIdx];
				if (!top) {
					top = document.createElement('div');
					top.className = 'downbeat-marker is-top';
					downbeatTopPool.push(top);
					innerRef.appendChild(top);
				}
				setX(top, xPx, '-50%');
				top.style.display = '';
				let bot = downbeatBotPool[downbeatIdx];
				if (!bot) {
					bot = document.createElement('div');
					bot.className = 'downbeat-marker is-bottom';
					downbeatBotPool.push(bot);
					innerRef.appendChild(bot);
				}
				setX(bot, xPx, '-50%');
				bot.style.display = '';
				downbeatIdx++;
			} else {
				// Mid-bar beat — 2×2 ticks at the top + bottom edges of the
				// wave area, no through-line. Matches RB's visual hierarchy
				// (downbeats dominate; mid-bar beats hint at the grid).
				let top = beatTickTopPool[tickIdx];
				if (!top) {
					top = document.createElement('div');
					top.className = 'beat-tick is-top';
					beatTickTopPool.push(top);
					innerRef.appendChild(top);
				}
				setX(top, xPx, '-0.5px');
				top.style.display = '';
				let bot = beatTickBotPool[tickIdx];
				if (!bot) {
					bot = document.createElement('div');
					bot.className = 'beat-tick is-bottom';
					beatTickBotPool.push(bot);
					innerRef.appendChild(bot);
				}
				setX(bot, xPx, '-0.5px');
				bot.style.display = '';
				tickIdx++;
			}
		}
		for (let i = downbeatIdx; i < downbeatLinePool.length; i++) downbeatLinePool[i]!.style.display = 'none';
		for (let i = downbeatIdx; i < downbeatTopPool.length; i++) {
			downbeatTopPool[i]!.style.display = 'none';
			downbeatBotPool[i]!.style.display = 'none';
		}
		for (let i = tickIdx; i < beatTickTopPool.length; i++) {
			beatTickTopPool[i]!.style.display = 'none';
			beatTickBotPool[i]!.style.display = 'none';
		}
	}

	// ─── Playhead + played-fill visibility ─────────────────────────────────
	// Two indicators, mutually exclusive based on whether the waveform
	// is scrolling (viewport-anchored) or static (whole-track):
	//   • viewport scrolling → playhead is the indicator (fixed at the
	//     viewport's positionWithin); t-fill is meaningless because the
	//     waveform moves under it.
	//   • whole-track static → t-fill is the indicator (sweeping left→
	//     right overlay); playhead is hidden because "centre of viewport"
	//     has no meaning when there IS no viewport.
	// The tick toggles display via `updateIndicators(vp != null)`.
	function updatePlayhead(vp: { positionWithin: number } | null): void {
		if (!playheadRef) return;
		playheadRef.style.left = vp ? `${Math.max(0, Math.min(100, vp.positionWithin * 100))}%` : '50%';
	}
	function updateIndicators(scrolling: boolean): void {
		if (playheadRef) playheadRef.style.display = scrolling ? 'block' : 'none';
		if (fillRef) fillRef.style.display = scrolling ? 'none' : '';
	}

	// Index of the last element <= v, or -1 when v precedes the array.
	// Shared by the bar label + phrase countdown (both binary-search the
	// beat / downbeat grids inside the rAF tick).
	function lastIndexLE(arr: Float32Array, v: number): number {
		if (arr.length === 0 || v < arr[0]!) return -1;
		let lo = 0, hi = arr.length - 1;
		while (lo < hi) {
			const m = (lo + hi + 1) >>> 1;
			if (arr[m]! <= v) lo = m; else hi = m - 1;
		}
		return lo;
	}

	// ─── Bar.beat label (big mode) ──────────────────────────────────────────
	// RB-style phrase meter: `bar.beat / totalBars` (e.g. `12.3 / 140`).
	function updateBarLabel(vp: { start: number; end: number } | null): void {
		if (!barLabelRef) return;
		const beats = props.beats();
		const dur = props.duration();
		if (!vp || !beats || beats.length < 2 || !dur) {
			barLabelRef.textContent = '--.-';
			return;
		}
		const pos = getInterpolatedPosition();
		const beatIdx = lastIndexLE(beats, pos);
		// Prefer the downbeats array — it's the authoritative bar grid and
		// already handles pickup beats. Bar 1 starts at downbeats[0]; the
		// pre-first-downbeat region reports `0 / N` so it's visibly distinct
		// from "in bar 1". Falls back to beats/4 only when downbeats absent.
		const downbeats = props.downbeats();
		let totalBars: number;
		let curBar: number;
		let beatInBar: number;
		if (downbeats && downbeats.length > 0) {
			totalBars = downbeats.length;
			const dIdx = lastIndexLE(downbeats, pos);
			curBar = dIdx + 1;
			if (dIdx < 0) {
				// Pickup region before bar 1 — count beats from the track
				// start so the meter still moves.
				beatInBar = beatIdx + 1;
			} else {
				// Downbeats share exact float values with the beats array
				// (same persistence), so the downbeat's beat index resolves
				// by the same search.
				const dBeatIdx = lastIndexLE(beats, downbeats[dIdx]!);
				beatInBar = Math.max(1, beatIdx - dBeatIdx + 1);
			}
		} else {
			totalBars = Math.max(1, Math.floor(beats.length / BEATS_PER_BAR));
			curBar = Math.floor(Math.max(0, beatIdx) / BEATS_PER_BAR) + 1;
			beatInBar = (Math.max(0, beatIdx) % BEATS_PER_BAR) + 1;
		}
		barLabelRef.textContent = `${curBar}.${beatInBar} / ${totalBars}`;
	}

	// ─── Bars-to-next-phrase countdown (big mode) ───────────────────────────
	// RB's bars-remaining readout: "8 bars → CHORUS". Bars remaining =
	// downbeats in (pos, nextPhraseStart]; phrase boundaries land on
	// downbeats so the count hits 0 exactly at the transition. Hidden when
	// there's no next phrase (final segment) or no downbeat grid.
	function updatePhraseCountdown(): void {
		if (!countdownRef) return;
		const segs = props.segments();
		const downbeats = props.downbeats();
		if (!segs || segs.length === 0 || !downbeats || downbeats.length === 0) {
			countdownRef.style.display = 'none';
			return;
		}
		const pos = getInterpolatedPosition();
		// Segments are time-ordered; linear scan over ~10-20 entries is
		// cheaper than maintaining a parallel search structure.
		let next: SegmentRecord | null = null;
		for (const s of segs) {
			if (s.startSec > pos + 0.05) { next = s; break; }
		}
		if (!next) {
			countdownRef.style.display = 'none';
			return;
		}
		// +1ms tolerance so a phrase start that IS a downbeat counts itself.
		const bars = lastIndexLE(downbeats, next.startSec + 0.001) - lastIndexLE(downbeats, pos);
		countdownRef.style.display = '';
		countdownRef.textContent = bars > 0
			? `${bars} → ${next.label.toUpperCase()}`
			: `→ ${next.label.toUpperCase()}`;
	}

	// ─── Frame tick — runs in BOTH small and big modes ──────────────────────
	// Both modes share the canvas painter + frame loop; the small-strip
	// instance is the same scrolling viewport at 44px, differing only by
	// the compact phrase profile (`geom`) and CSS (hidden zoom/skin
	// overlay, tighter insets). Runs on the shared ticker (ticker.ts) so
	// this component, the VU meter, and any future animator pay for ONE
	// rAF loop between them.
	let offFrame: (() => void) | null = null;
	// Last-painted frame signature — every input the paint below reads.
	// When nothing changed since the previous tick (paused, no scroll, no
	// resize, no data/skin/cue/loop change) the entire paint is skipped,
	// making the paused state near-free instead of re-aggregating peak
	// buckets at 60 Hz. `pos` covers the playhead/fill even when the
	// viewport itself is anchored (pre-first-beat region).
	let lastFrame: {
		tier: unknown; beats: unknown; downbeats: unknown; segs: unknown;
		skin: unknown; cueSig: string; loopIn: number; loopOut: number;
		vpS: number; vpE: number; pos: number; w: number; h: number; dpr: number;
	} | null = null;
	function tick(): void {
		if (!innerRef) return;
		const tier = props.peaks();
		const cssW = innerRef.clientWidth;
		const dpr = window.devicePixelRatio || 1;
		const vp = tier ? computeViewport(cssW, dpr) : null;
		const loop = props.activeLoop?.();
		const f = {
			tier,
			beats: props.beats(),
			downbeats: props.downbeats(),
			segs: props.segments(),
			skin: skin(),
			cueSig: cueDomCueSig,
			loopIn: loop?.inSec ?? -1,
			loopOut: loop?.outSec ?? -1,
			vpS: vp ? vp.start : -1,
			vpE: vp ? vp.end : -1,
			pos: getInterpolatedPosition(),
			w: cssW,
			h: innerRef.clientHeight,
			dpr,
		};
		const lf = lastFrame;
		if (lf
			&& f.tier === lf.tier && f.beats === lf.beats && f.downbeats === lf.downbeats
			&& f.segs === lf.segs && f.skin === lf.skin && f.cueSig === lf.cueSig
			&& f.loopIn === lf.loopIn && f.loopOut === lf.loopOut
			&& f.vpS === lf.vpS && f.vpE === lf.vpE && f.pos === lf.pos
			&& f.w === lf.w && f.h === lf.h && f.dpr === lf.dpr
		) return;
		lastFrame = f;
		updateIndicators(vp != null);
		if (tier) {
			const currentSkin = skin();
			const overlay = { segments: props.segments(), duration: props.duration(), geometry: geom };
			if (vp) {
				paintWaveformOntoCanvas(innerRef, tier, { start: vp.start, end: vp.end }, currentSkin, overlay);
				paintBeatGrid(vp, cssW);
				paintCues(vp, cssW);
				paintLoop(vp);
				updatePlayhead(vp);
				updateBarLabel(vp);
				updatePhraseCountdown();
			} else {
				// Peaks loaded but no duration yet — paint whole-track waveform;
				// fill indicator (below) shows progress until duration arrives
				// and we can switch to the scrolling viewport + playhead mode.
				paintWaveformOntoCanvas(innerRef, tier, { start: 0, end: 1 }, currentSkin, overlay);
				clearBeatGrid();
				paintCues(null, cssW);
				paintLoop(null);
				updatePlayhead(null);
				updateBarLabel(null);
				updatePhraseCountdown();
			}
		}
		// Always paint the fill — it's the visible playhead indicator
		// whenever scrolling=false (no duration yet, or no peaks loaded yet).
		// Painting via rAF (rather than createEffect on positionSec) gives
		// us smooth motion from local wall-clock interpolation between
		// emits, so the fill doesn't visibly step on the 200ms poll boundary.
		if (!vp) paintPlayedFill();
	}
	function startRaf(): void {
		if (offFrame != null) return;
		offFrame = onFrame(tick);
	}
	function stopRaf(): void {
		offFrame?.();
		offFrame = null;
	}
	startRaf();

	onCleanup(() => {
		stopRaf();
	});

	// ─── Pointer-event drag-or-click ────────────────────────────────────────
	// Every pointerdown enters scrub mode immediately — the sidecar pauses
	// the track on `scrub_begin` so the user hears silence the instant
	// they grab the wave (PRD: "mousedown pauses playback for the
	// duration of the drag"). Past a 3 px movement threshold we commit
	// to "real drag"; under-threshold pointerup behaves as click-to-seek
	// but is still routed through `scrubEnd` so the engine cleanly exits
	// scrub mode with the correct final position + resume flag.
	//
	// Pointer capture on innerRef keeps pointermove flowing when the
	// cursor exits the bar (PRD edge case 5). pointercancel commits at
	// the last-known target as a defensive watchdog.
	const DRAG_THRESHOLD_PX = 3;
	let dragPointerId: number | null = null;
	let dragX0 = 0;
	let dragY0 = 0;
	let dragT0 = 0;
	let dragPxToSec = 0;
	let dragStarted = false;
	let dragWasPlaying = false;
	let dragDownTarget: HTMLElement | null = null;

	function computeClickTargetSec(downClientX: number, downClientY: number): number {
		// Click-to-seek semantics — lane-band hit-test snaps to the
		// bracketing phrase's startSec; everything else is a position
		// lookup in viewport coords. Uses the DOWN coordinates so a
		// jitter between down and up doesn't drift the target.
		const rect = innerRef.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (downClientX - rect.left) / rect.width));
		const dur = untrack(() => props.duration());
		if (!dur) return 0;
		const vp = computeViewport();
		const vpStartSec = vp ? vp.start * dur : 0;
		const vpEndSec   = vp ? vp.end   * dur : dur;
		const clickSec   = vpStartSec + ratio * (vpEndSec - vpStartSec);
		const yLocal = downClientY - rect.top;
		const segs = untrack(() => props.segments());
		if (segs && segs.length > 0 && yLocal >= rect.height - geom.laneH) {
			const hit = segs.find((s) => clickSec >= s.startSec && clickSec < s.endSec);
			return hit ? hit.startSec : clickSec;
		}
		return clickSec;
	}

	const handlePointerDown = (evt: PointerEvent): void => {
		if (evt.button !== 0) return; // primary button only
		const target = evt.target as HTMLElement;
		if (target.closest('.big-wave-zoom') || target.closest('.t-cue') || target.closest('.t-memcue')) return;
		const rect = innerRef.getBoundingClientRect();
		const dur = untrack(() => props.duration());
		if (!dur || rect.width <= 0) return;
		const vp = computeViewport();
		const vpStartSec = vp ? vp.start * dur : 0;
		const vpEndSec   = vp ? vp.end   * dur : dur;
		const vpSpanSec  = vpEndSec - vpStartSec;
		if (vpSpanSec <= 0) return;

		dragPointerId = evt.pointerId;
		dragX0 = evt.clientX;
		dragY0 = evt.clientY;
		// Anchor on the visually-current playhead time, not the last
		// engine-emit position. This is the time that was under the
		// cursor at the moment of mousedown — the 1:1 reference point.
		dragT0 = getInterpolatedPosition();
		dragPxToSec = vpSpanSec / rect.width;
		dragStarted = false;
		dragWasPlaying = untrack(() => props.isPlaying());
		dragDownTarget = target;

		try { innerRef.setPointerCapture(evt.pointerId); }
		catch { /* unsupported — moves outside bar will stop, that's fine */ }

		// Pause immediately. Engine enters scrub mode with target=cursor,
		// gap=0 → silence until the first scrubMove. Streaming sources
		// pause via the SDK; this round-trips a bit but matches the
		// PRD's "pause on mousedown" rule across sources.
		props.onScrubStart();
	};

	const handlePointerMove = (evt: PointerEvent): void => {
		if (dragPointerId !== evt.pointerId) return;
		const deltaX = evt.clientX - dragX0;
		if (!dragStarted) {
			if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
			dragStarted = true;
		}
		const dur = untrack(() => props.duration());
		if (!dur) return;
		// Mouse right → time decreases (waveform follows cursor; the
		// point that was under the cursor at down stays under it).
		const targetT = Math.max(0, Math.min(dur, dragT0 - deltaX * dragPxToSec));
		props.onScrubMove(targetT);
		snapTo(targetT);
	};

	const handlePointerUp = (evt: PointerEvent): void => {
		if (dragPointerId !== evt.pointerId) return;
		const pointerId = dragPointerId;
		const wasStarted = dragStarted;
		const downTarget = dragDownTarget;
		const downX = dragX0;
		const downY = dragY0;
		dragPointerId = null;
		dragStarted = false;
		dragDownTarget = null;
		try { innerRef.releasePointerCapture(pointerId); } catch { /* */ }

		const dur = untrack(() => props.duration());
		if (!dur) return;

		let finalT: number;
		if (wasStarted) {
			// Real drag — final position derived from cumulative deltaX.
			const deltaX = evt.clientX - downX;
			finalT = Math.max(0, Math.min(dur, dragT0 - deltaX * dragPxToSec));
		} else {
			// Under-threshold up → click-to-seek (with lane-band).
			void downTarget; // already filtered in handlePointerDown
			finalT = computeClickTargetSec(downX, downY);
		}
		snapTo(finalT);
		props.onScrubEnd(finalT, dragWasPlaying);
	};

	// Pointer cancel / lost-capture defensive — commits at the last-known
	// target so the engine cleanly exits scrub mode even on focus loss,
	// modal interruptions, or OS pointer pre-emption.
	const handlePointerCancel = (evt: PointerEvent): void => {
		if (dragPointerId !== evt.pointerId) return;
		const wasStarted = dragStarted;
		const downX = dragX0;
		const downY = dragY0;
		dragPointerId = null;
		dragStarted = false;
		dragDownTarget = null;
		try { innerRef.releasePointerCapture(evt.pointerId); } catch { /* */ }

		const dur = untrack(() => props.duration());
		if (!dur) {
			// Edge case: track unloaded mid-drag. Best we can do is
			// fire scrubEnd at time 0; sidecar's scrub_end with sr=0
			// errors gracefully.
			props.onScrubEnd(0, dragWasPlaying);
			return;
		}
		const finalT = wasStarted
			? Math.max(0, Math.min(dur, dragT0 - (evt.clientX - downX) * dragPxToSec))
			: computeClickTargetSec(downX, downY);
		props.onScrubEnd(finalT, dragWasPlaying);
	};

	// Zoom button handlers. Component blocks click bubbling so the bar's
	// click-to-seek doesn't fire.
	const zoomIn = (e: MouseEvent): void => {
		e.stopPropagation();
		setZoomIdx((i) => Math.max(0, i - 1));
	};
	const zoomOut = (e: MouseEvent): void => {
		e.stopPropagation();
		setZoomIdx((i) => Math.min(BIG_ZOOM_BAR_LEVELS.length - 1, i + 1));
	};

	return (
		<div
			ref={barRef}
			class="waveform sunken"
			id="t-bar"
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerCancel}
		>
			<div ref={innerRef} class="wave-inner">
				<div ref={fillRef} class="t-fill" id="t-fill" />
				<div ref={loopOverlayRef} class="loop-region" style={{ display: 'none' }} />
				<div ref={playheadRef} class="big-playhead" />
				{/* Cue badges are managed imperatively (see paintCues). */}
			</div>
			<div class="big-wave-zoom big-only">
				<button class="t-btn small" title="Zoom out (wider view)" onClick={zoomOut}>−</button>
				<span class="big-zoom-label" id="big-zoom-label">{visibleBars()} BARS</span>
				<button class="t-btn small" title="Zoom in (closer view)" onClick={zoomIn}>+</button>
				<span class="big-wave-skin-sep" />
				<select
					class="big-wave-skin"
					title="Waveform style"
					value={props.skin()}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => props.onSkinChange(e.currentTarget.value as SkinId)}
				>
					<For each={SKINS}>{(s) => (<option value={s.id}>{s.label}</option>)}</For>
				</select>
			</div>
			<div class="big-wave-info big-only">
				<span ref={barLabelRef} id="big-bar-label">--.-</span> Bars
				<span ref={countdownRef} class="phrase-countdown" style={{ display: 'none' }} />
			</div>
			<div class="t-time-overlay">
				<span class="time" id="t-pos">{fmt(props.positionSec())}</span>
				<span class="time-sep">/</span>
				<span class="time r" id="t-dur">{fmt(props.duration())}</span>
			</div>
		</div>
	);
}

export function mountMainWaveformView(
	host: HTMLElement,
	props: MainWaveformViewProps,
): MainWaveformViewHandle {
	let snapToFn: ((positionSec: number) => void) | null = null;
	const dispose = render(() => (
		<MainWaveformView
			{...props}
			setSnapTo={(fn) => { snapToFn = fn; }}
		/>
	), host);
	return {
		destroy: dispose,
		snapTo: (positionSec) => snapToFn?.(positionSec),
	};
}

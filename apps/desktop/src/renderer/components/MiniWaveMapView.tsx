// MiniWaveMapView — the small full-track wavemap. Sits between the main
// waveform and the controls row in big mode, and beside sec2 in the small
// local strip (where the compact main waveform fills the rest). The only
// consumer of the SVG painter. Cue ticks at absolute %-of-track positions
// (the wavemap is never zoomed/scrolled). Played-position overlay scales
// with playback.
//
// First component to internalize an *imperative* painter (SVG mutation
// of `.wave-inner` via paintWaveformInto). The pattern:
//   1. Component owns the outer wrapper + `.wave-inner` host + `.t-fill`.
//   2. A createEffect re-runs the painter whenever the peaks tier
//      changes (track switch, late peaks load).
//   3. Cue ticks render via Solid <For> reactive to cues + duration —
//      no manual pool / display:none toggling.
//   4. Played-position fill is a JSX style binding driven by the
//      positionSec / duration accessors.
//   5. Click handler computes ratio and dispatches onSeek.
//
// Multi-instance-ready: the host wires its own peaks/cues/duration/
// positionSec accessors. A future preview deck mounting two
// MiniWaveMapViews against different tracks would just pass different
// trackId-bound accessors here.

import { For, Show, createEffect, createSignal, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { PeaksTier, CueData } from '../stores/analysisStore.js';
import { paintWaveformInto } from '../renderers/svgWaveform.js';
import { getSkin, type SkinId } from '../renderers/waveformStyles.js';
import type { LoopRegionView } from './MainWaveformView.jsx';
import { cueColor } from '../cuePalette.js';

export interface MiniWaveMapViewProps {
	peaks: Accessor<PeaksTier | null>;
	cues: Accessor<CueData[]>;
	duration: Accessor<number>;
	positionSec: Accessor<number>;
	isPlaying: Accessor<boolean>;
	onSeek: (positionSec: number) => void;
	// Vinyl-style scrub callbacks — same shape and meaning as
	// MainWaveformView. The mini-map's drag is geometrically inverted
	// (playhead follows the cursor across a fixed full-track wave, vs.
	// the wave shifting under a fixed playhead in the big view) — that
	// inversion lives in the move handler below, not in these callbacks.
	//
	// onScrubStart's optional `targetSec` snaps the engine cursor to the
	// click position on entry — the mini-map passes the clicked time so
	// the playhead jumps immediately without producing a slewed scratch
	// from the prior playhead.
	onScrubStart: (targetSec?: number) => void;
	onScrubMove: (positionSec: number) => void;
	onScrubEnd: (positionSec: number, resumePlaying: boolean) => void;
	// Shared with the big waveform — the user picks once in the big-mode
	// picker and the mini-wavemap follows. No selector lives here.
	skin: Accessor<SkinId>;
	// Active loop region — overlaid as a translucent band across the
	// mini-map's full-track view. Null when no loop is active.
	activeLoop?: Accessor<LoopRegionView | null>;
}

export function MiniWaveMapView(props: MiniWaveMapViewProps) {
	let hostRef: HTMLDivElement | undefined;

	// Painter — re-runs when peaks OR skin changes. paintWaveformInto
	// inspects the host's `.wave-inner` width to size buckets, so the
	// host must be mounted + sized before the first paint. createEffect
	// runs after mount in Solid, which guarantees that.
	createEffect(() => {
		if (!hostRef) return;
		paintWaveformInto(hostRef, props.peaks(), getSkin(props.skin()));
	});

	// Played-position fill — % of track. Driven by the positionSec
	// accessor (likely `() => player.getState().position` on the
	// reactive proxy), with the CSS transition smoothing playback.
	const fillPct = (): number => {
		const dur = props.duration();
		if (!dur) return 0;
		return Math.max(0, Math.min(100, (props.positionSec() / dur) * 100));
	};

	// Cue positions — % of total duration. Both the vertical tick mark
	// (full-height bar at the cue's x) and the letter badge above it
	// share this list. Filter out cues outside [0, dur] so a corrupt cue
	// can't position itself off-canvas. Letters come from `cue.slot`
	// (NOT the array index) so a track with hot cues at slots A,B,C,H
	// renders the H marker at slot 7 rather than collapsing to D.
	// Memory cues render separately below (triangle, no letter) — RB's
	// visual language; lumping them into the lettered overlay
	// misattributes letters.
	const cueTitle = (c: CueData): string => {
		const mins = Math.floor(c.positionSec / 60);
		const secs = String(Math.floor(c.positionSec) % 60).padStart(2, '0');
		return `${c.name ?? c.kind} · ${mins}:${secs}`;
	};
	const cuePct = (c: CueData, dur: number): number | null => {
		const pct = (c.positionSec / dur) * 100;
		return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
	};
	const visibleCues = (): Array<{ id: string; letter: string; leftPct: number; color: string; positionSec: number; title: string }> => {
		const dur = props.duration();
		if (!dur) return [];
		const out: Array<{ id: string; letter: string; leftPct: number; color: string; positionSec: number; title: string }> = [];
		for (const c of props.cues()) {
			if (c.kind !== 'hot') continue;
			const pct = cuePct(c, dur);
			if (pct == null) continue;
			const letter = c.slot < 26 ? String.fromCharCode(65 + c.slot) : String(c.slot + 1);
			out.push({
				id: c.id,
				letter,
				leftPct: pct,
				color: cueColor(c.color),
				positionSec: c.positionSec,
				title: cueTitle(c),
			});
		}
		return out;
	};

	// Memory cues — RB-style colored triangles at the top edge, no letter.
	const visibleMemCues = (): Array<{ id: string; leftPct: number; color: string; positionSec: number; title: string }> => {
		const dur = props.duration();
		if (!dur) return [];
		const out: Array<{ id: string; leftPct: number; color: string; positionSec: number; title: string }> = [];
		for (const c of props.cues()) {
			if (c.kind !== 'memory') continue;
			const pct = cuePct(c, dur);
			if (pct == null) continue;
			out.push({ id: c.id, leftPct: pct, color: cueColor(c.color), positionSec: c.positionSec, title: cueTitle(c) });
		}
		return out;
	};

	// Stored loops — any cue (hot or memory) carrying lengthSec paints a
	// translucent band, dimmer than the ACTIVE loop overlay so saved vs.
	// live read distinctly.
	const storedLoops = (): Array<{ id: string; leftPct: number; widthPct: number; color: string; title: string }> => {
		const dur = props.duration();
		if (!dur) return [];
		const out: Array<{ id: string; leftPct: number; widthPct: number; color: string; title: string }> = [];
		for (const c of props.cues()) {
			if (c.lengthSec == null || c.lengthSec <= 0) continue;
			const leftPct  = Math.max(0, Math.min(100, (c.positionSec / dur) * 100));
			const rightPct = Math.max(0, Math.min(100, ((c.positionSec + c.lengthSec) / dur) * 100));
			if (!Number.isFinite(leftPct) || rightPct <= leftPct) continue;
			out.push({ id: c.id, leftPct, widthPct: rightPct - leftPct, color: cueColor(c.color), title: cueTitle(c) });
		}
		return out;
	};

	// Loop overlay bounds in % of total duration. Returns null when no
	// loop, no duration, or the loop is degenerate. Both ends are clamped
	// to [0,100] so a loop straddling track ends still renders the
	// in-bounds portion.
	const loopBand = (): { leftPct: number; widthPct: number } | null => {
		const loop = props.activeLoop?.();
		const dur = props.duration();
		if (!loop || !dur || loop.outSec <= loop.inSec) return null;
		const leftPct  = Math.max(0, Math.min(100, (loop.inSec  / dur) * 100));
		const rightPct = Math.max(0, Math.min(100, (loop.outSec / dur) * 100));
		const widthPct = Math.max(0, rightPct - leftPct);
		if (widthPct === 0) return null;
		return { leftPct, widthPct };
	};

	// ─── Pointer-event drag-or-click ───────────────────────────────────────
	// Full-track view, so the drag geometry is direct: cursor x → track
	// time via `ratio * duration`. mousedown pauses (scrubStart);
	// pointermove past the 3 px threshold rate-controls audio via
	// onScrubMove; pointerup commits via onScrubEnd. Under-threshold up
	// = click-to-seek (delegated to onScrubEnd for state consistency,
	// matches the big waveform's behaviour).
	const DRAG_THRESHOLD_PX = 3;
	let dragPointerId: number | null = null;
	let dragX0 = 0;
	let dragStarted = false;
	let dragWasPlaying = false;
	// Toggled on for the duration of a drag so the played-fill CSS
	// transition (`width 120ms linear`) gets suppressed — without that
	// override the visual playhead lags ~120 ms behind the cursor.
	const [isScrubbing, setIsScrubbing] = createSignal(false);

	function ratioToSec(clientX: number): number {
		if (!hostRef) return 0;
		const inner = hostRef.querySelector<HTMLElement>('.wave-inner') ?? hostRef;
		const rect = inner.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		const dur = untrack(() => props.duration());
		return dur ? ratio * dur : 0;
	}

	const handlePointerDown = (evt: PointerEvent): void => {
		if (evt.button !== 0) return; // primary button only
		const target = evt.target as HTMLElement;
		// Cue badges + memory triangles have their own onClick →
		// seek-to-cue. Let those handle clicks themselves; don't enter
		// scrub mode on them.
		if (target.closest('.t-cue') || target.closest('.t-memcue')) return;
		if (!hostRef) return;
		const dur = untrack(() => props.duration());
		if (!dur) return;

		dragPointerId = evt.pointerId;
		dragX0 = evt.clientX;
		dragStarted = false;
		dragWasPlaying = untrack(() => props.isPlaying());
		setIsScrubbing(true);

		try { hostRef.setPointerCapture(evt.pointerId); }
		catch { /* unsupported — moves outside the wavemap will stop, that's fine */ }

		// Snap engine cursor to the click position and pause there.
		// Audio is silent at scrub_begin (gap=0); the engine emits the
		// new position so the optimistic state.position update + the
		// fill render in lock-step.
		const clickTarget = ratioToSec(evt.clientX);
		props.onScrubStart(clickTarget);
	};

	const handlePointerMove = (evt: PointerEvent): void => {
		if (dragPointerId !== evt.pointerId) return;
		const deltaX = evt.clientX - dragX0;
		if (!dragStarted) {
			if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
			dragStarted = true;
		}
		// Direct mapping — cursor x → position. Mouse right = time advances.
		const targetT = ratioToSec(evt.clientX);
		props.onScrubMove(targetT);
	};

	const handlePointerUp = (evt: PointerEvent): void => {
		if (dragPointerId !== evt.pointerId) return;
		const pointerId = dragPointerId;
		dragPointerId = null;
		dragStarted = false;
		setIsScrubbing(false);
		if (hostRef) {
			try { hostRef.releasePointerCapture(pointerId); } catch { /* */ }
		}
		// Click and drag both terminate the same way — final position is
		// derived from the up event's clientX. Under-threshold up
		// effectively becomes a click-to-seek at that position.
		const finalT = ratioToSec(evt.clientX);
		props.onScrubEnd(finalT, dragWasPlaying);
	};

	const handlePointerCancel = (evt: PointerEvent): void => {
		if (dragPointerId !== evt.pointerId) return;
		dragPointerId = null;
		dragStarted = false;
		setIsScrubbing(false);
		if (hostRef) {
			try { hostRef.releasePointerCapture(evt.pointerId); } catch { /* */ }
		}
		const finalT = ratioToSec(evt.clientX);
		props.onScrubEnd(finalT, dragWasPlaying);
	};

	return (
		<div
			ref={hostRef}
			class="wavemap sunken"
			classList={{ 'is-scrubbing': isScrubbing() }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerCancel}
		>
			<div class="wave-inner">
				<div class="t-fill" style={{ width: `${fillPct()}%` }} />
				<For each={storedLoops()}>
					{(l) => (
						<div
							class="t-loop-band"
							style={{
								left: `${l.leftPct}%`,
								width: `${l.widthPct}%`,
								background: `${l.color}12`,
								'border-color': `${l.color}99`,
							}}
							title={l.title}
						/>
					)}
				</For>
				<Show when={loopBand()}>
					{(band) => (
						<div
							class="loop-region"
							style={{ left: `${band().leftPct}%`, width: `${band().widthPct}%` }}
						/>
					)}
				</Show>
				<For each={visibleMemCues()}>
					{(c) => (
						<div
							class="t-memcue"
							style={{ background: c.color, left: `${c.leftPct}%` }}
							title={c.title}
							onClick={(e) => {
								e.stopPropagation();
								props.onSeek(c.positionSec);
							}}
						/>
					)}
				</For>
				<For each={visibleCues()}>
					{(c) => (
						<>
							<div
								class="t-cue-tick"
								style={{ background: c.color, left: `${c.leftPct}%` }}
							/>
							<div
								class="t-cue"
								style={{ background: c.color, left: `${c.leftPct}%` }}
								title={c.title}
								onClick={(e) => {
									e.stopPropagation();
									props.onSeek(c.positionSec);
								}}
							>{c.letter}</div>
						</>
					)}
				</For>
			</div>
		</div>
	);
}

export interface MiniWaveMapViewHandle {
	destroy(): void;
}

export function mountMiniWaveMapView(host: HTMLElement, props: MiniWaveMapViewProps): MiniWaveMapViewHandle {
	const dispose = render(() => <MiniWaveMapView {...props} />, host);
	return { destroy: dispose };
}

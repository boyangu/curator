// Player dock-flip choreography — the "one-beat push".
//
// The shell derives WHERE the player strip lives (dock edge + presence);
// regionEffect commits those facts to body attributes. This module makes the
// commit *move*: the strip grows into its new edge with a critically damped
// spring while a throwaway ghost spacer shrinks at the old edge in lockstep,
// so the content slab between them translates as one rigid unit — new content
// pushes existing content, up when arriving from below, down from above.
//
// Design constraints that shaped this:
//   • The live Solid tree is never re-parented. The body attrs flip at t=0
//     (real strip jumps to the new edge, restyled, variant remounted) and the
//     ghost — a dumb styled div — stands in for the departing edge. Both are
//     driven by WAAPI keyframes sharing one progress curve.
//   • The strip SLIDES, it does not inflate: it keeps its full box the whole
//     time and moves in from off-edge via a negative leading margin, clipped
//     at the edge with clip-path. The negative margin is what shrinks the
//     space it occupies, so the push physics are identical to a height
//     animation — but the strip's inner layout (flex centering, waveform
//     canvases with resize observers) is computed exactly once instead of
//     re-flowing on every frame, which is what made the arrival read as
//     "expanding" with content glitches. The ghost, being featureless, is
//     fine to shrink by height (border-box: its 1px border rides along).
//   • This file must not read OR write the player body attributes — the
//     boundary check (Rule 1b) greps for those idioms and regionEffect.ts is
//     their only legal writer. Chrome facts arrive as arguments; everything
//     else is measured off the elements.
//   • No `await animation.finished` — cancel() rejects it, and an occluded
//     Electron window freezes the animation clock so it may never resolve.
//     Settling rides the `finish` event with a setTimeout fallback; when the
//     window is hidden at apply time we don't animate at all (frozen clock),
//     we snap — which is invisible anyway.

export interface PlayerChrome {
	dock: 'top' | 'bottom';
	presence: 'hidden' | 'dock';
}

export type DockTransitionKind = 'boot' | 'none' | 'fold' | 'grow' | 'push';

// What kind of motion (if any) a chrome change calls for.
//   boot — first-ever application: commit silently, never animate.
//   none — no visible change (equal, or an edge change while folded).
//   fold — dock→hidden: the existing CSS height transition handles it.
//   grow — hidden→dock: spring the strip in from 0, no ghost.
//   push — dock edge flip: spring + ghost at the departed edge.
export function classifyTransition(prev: PlayerChrome | null, next: PlayerChrome): DockTransitionKind {
	if (prev === null) return 'boot';
	if (prev.dock === next.dock && prev.presence === next.presence) return 'none';
	if (prev.presence === 'hidden' && next.presence === 'hidden') return 'none';
	if (next.presence === 'hidden') return 'fold';
	if (prev.presence === 'hidden') return 'grow';
	return 'push';
}

// Animate only when there's something to animate AND the animation clock is
// actually running. Occluded windows freeze WAAPI mid-flight, and reduced
// motion is a user contract — both snap.
export function decideMotion(kind: DockTransitionKind, reducedMotion: boolean, visible: boolean): 'animate' | 'snap' {
	if (kind !== 'grow' && kind !== 'push') return 'snap';
	return !reducedMotion && visible ? 'animate' : 'snap';
}

const OMEGA = 19; // s⁻¹ — with T=350ms, ωT≈6.65 ⇒ settled to <1% at the last frame
const DURATION_MS = 350;
const SAMPLES = 30;
const SETTLE_FALLBACK_MS = DURATION_MS + 100;

// Critically damped spring step response, sampled into uniform keyframe
// progress values. x(t) = 1 − (1+ωt)e^(−ωt); its derivative ω²t·e^(−ωt) is
// non-negative, so the curve provably never overshoots — the "drawer with a
// soft-close damper" feel. Normalized so the last sample lands exactly on 1
// (raw x(T)≈0.99; positive scaling preserves monotonicity).
export function sampleSpringProgress(opts?: { omega?: number; durationMs?: number; samples?: number }): number[] {
	const omega = opts?.omega ?? OMEGA;
	const durationMs = opts?.durationMs ?? DURATION_MS;
	const samples = opts?.samples ?? SAMPLES;
	const x = (tSec: number): number => 1 - (1 + omega * tSec) * Math.exp(-omega * tSec);
	const end = x(durationMs / 1000);
	const p: number[] = [];
	for (let i = 0; i < samples; i++) {
		p.push(x(((i / (samples - 1)) * durationMs) / 1000) / end);
	}
	return p;
}

// The strip's VISIBLE height — box height plus the (negative) leading margin
// the slide animation drives. Static state has no margin, so this reads the
// plain height there; mid-flight it reads how much of the slab has entered.
function readVisibleStripHeight(cs: CSSStyleDeclaration, edge: 'top' | 'bottom'): number {
	const h = parseFloat(cs.height);
	const m = parseFloat(edge === 'top' ? cs.marginTop : cs.marginBottom);
	const visible = (Number.isFinite(h) ? h : 0) + (Number.isFinite(m) ? Math.min(0, m) : 0);
	return Math.max(0, visible);
}

const ANIM_CLASS = 'player-dock-anim';

type Phase =
	| { kind: 'idle' }
	// apply() ran and committed; the starter microtask hasn't fired yet. A
	// second apply in the same task coalesces into `next` — no paint has
	// happened, so the original start values still describe the screen.
	| { kind: 'pending'; prev: PlayerChrome; next: PlayerChrome; stripStartH: number; ghostStartH: number }
	| { kind: 'running'; stripAnim: Animation; ghostAnim: Animation | null; ghost: HTMLDivElement | null; timer: ReturnType<typeof setTimeout> };

export interface PlayerDockTransitionController {
	// Apply a chrome change: `commit` performs the actual attribute writes
	// (kept at the call site so regionEffect stays the single writer); this
	// wraps it with the motion. Always converges on the committed state.
	apply(next: PlayerChrome, commit: () => void): void;
	dispose(): void;
}

export function createPlayerDockTransition(deps?: {
	playerEl?: () => HTMLElement | null;
	shellEl?: () => HTMLElement | null;
	reducedMotion?: () => boolean;
}): PlayerDockTransitionController {
	const playerEl = deps?.playerEl ?? (() => document.getElementById('player-footer-host'));
	const shellEl = deps?.shellEl ?? (() => document.querySelector<HTMLElement>('.app-shell'));
	const reducedMotion = deps?.reducedMotion ?? (() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

	const spring = sampleSpringProgress();
	let lastApplied: PlayerChrome | null = null;
	let phase: Phase = { kind: 'idle' };

	// Tear down whatever motion is in flight and return to static CSS. The
	// running animations fill 'forwards' with their last keyframe equal to
	// the static computed values, so cancel() lands with zero visual diff.
	const settle = (): void => {
		if (phase.kind === 'running') {
			clearTimeout(phase.timer);
			phase.stripAnim.cancel();
			phase.ghostAnim?.cancel();
			phase.ghost?.remove();
		}
		playerEl()?.classList.remove(ANIM_CLASS);
		phase = { kind: 'idle' };
	};

	// Starter — runs one microtask after apply(), i.e. after the ENTIRE Solid
	// effect flush for this update: the mode attribute and the remounted
	// variant content are final, so computed style yields the true target box
	// (64 vs 207 falls out for free, no CSS-var parsing).
	const start = (): void => {
		if (phase.kind !== 'pending') return;
		const { prev, next, stripStartH, ghostStartH } = phase;
		const el = playerEl();
		const shell = shellEl();
		const kind = classifyTransition(prev, next);
		if (!el || !shell || (kind !== 'grow' && kind !== 'push')) {
			// Coalesced back to a no-op (or fold) within one task — nothing
			// painted yet, so there is nothing to move.
			settle();
			return;
		}
		// This read is also the first forced style recalc since the class
		// went on — it's what guarantees the strip's own CSS transition never
		// arms against the attribute flip.
		const targetH = parseFloat(getComputedStyle(el).height);
		if (!(targetH > 0)) {
			settle();
			return;
		}

		// The slide: the strip keeps its full box and enters from off-edge.
		// A negative leading margin shrinks the space it occupies (that's
		// what pushes the content, same as a height animation would) while
		// clip-path trims the part still "behind" the edge — top dock slides
		// down from under the topframe (which it would otherwise paint over,
		// being later in the DOM), bottom dock rises from below the window.
		// The visible portion sweeps [stripStartH → targetH] along the
		// spring; fresh transitions start fully off-edge, an interrupted flip
		// picks up at the remnant the previous ghost left at this edge. The
		// -48px clip slack on the bottom dock keeps its upward box-shadow
		// (0 -10px 28px) unclipped; the final frame (offset 0) is therefore
		// visually identical to the unclipped static state settle() lands on.
		const f0 = Math.min(1, Math.max(0, stripStartH / targetH));
		const px = (n: number): string => `${n}px`;
		const stripFrames = spring.map((p) => {
			const off = targetH * (1 - (f0 + (1 - f0) * p));
			return next.dock === 'top'
				? { marginTop: px(-off), clipPath: `inset(${off}px 0 0 0)` }
				: { marginBottom: px(-off), clipPath: `inset(-48px 0 ${off}px 0)` };
		});
		const opts: KeyframeAnimationOptions = { duration: DURATION_MS, easing: 'linear', fill: 'forwards' };
		const stripAnim = el.animate(stripFrames, opts);

		// Ghost — stands in for the departed edge on a push. Its shadow (the
		// bottom chrome's big upward glow) would pop on removal, so opacity
		// holds at 1 until the slab is a few px tall, then fades out.
		let ghost: HTMLDivElement | null = null;
		let ghostAnim: Animation | null = null;
		if (kind === 'push' && ghostStartH > 0.5) {
			ghost = document.createElement('div');
			ghost.className = `player-ghost player-ghost--${prev.dock}`;
			if (prev.dock === 'top') {
				// Shell flex order: topframe → player → .app; only a
				// bottom-docked player carries order:10. Inserting before
				// .app puts the ghost at the top edge with default order;
				// appending puts it last, where its upward shadow paints
				// over the content like the real bottom strip's does.
				const app = shell.querySelector<HTMLElement>(':scope > .app');
				shell.insertBefore(ghost, app);
			} else {
				shell.appendChild(ghost);
			}
			const ghostFrames = spring.map((p) => ({
				height: px(ghostStartH * (1 - p)),
				borderTopWidth: px(prev.dock === 'bottom' ? 1 - p : 0),
				borderBottomWidth: px(prev.dock === 'top' ? 1 - p : 0),
				opacity: `${p < 0.85 ? 1 : 1 - (p - 0.85) / 0.15}`,
			}));
			ghostAnim = ghost.animate(ghostFrames, opts);
		}

		const timer = setTimeout(settle, SETTLE_FALLBACK_MS);
		stripAnim.addEventListener('finish', settle);
		phase = { kind: 'running', stripAnim, ghostAnim, ghost, timer };
	};

	const apply = (next: PlayerChrome, commit: () => void): void => {
		const prev = lastApplied;
		lastApplied = next;
		const kind = classifyTransition(prev, next);

		if (kind === 'boot') {
			commit();
			return;
		}
		if (kind === 'none') {
			// Includes a re-apply of the value a running animation is already
			// converging on — leave it in flight.
			commit();
			return;
		}
		const el = playerEl();
		if (kind === 'fold' || !el || decideMotion(kind, reducedMotion(), document.visibilityState === 'visible') === 'snap') {
			// Fold rides the strip's own CSS transition (settle removes the
			// suppression class first); snaps land instantly on static CSS.
			settle();
			commit();
			return;
		}

		// grow | push — start values describe what's on screen RIGHT NOW,
		// captured before the commit flips the attributes.
		let stripStartH = 0;
		let ghostStartH = 0;
		if (phase.kind === 'running') {
			// Interrupting a flip is always the reverse flip (dock is
			// binary): the strip returns to the edge where the old ghost's
			// remnant sits, and leaves a new ghost at how far it had slid in
			// (visible height = box height + the slide's negative margin;
			// prev.dock is the edge the strip is currently entering).
			const stripNow = readVisibleStripHeight(getComputedStyle(el), (prev as PlayerChrome).dock);
			const ghostNow = phase.ghost ? parseFloat(getComputedStyle(phase.ghost).height) : 0;
			clearTimeout(phase.timer);
			phase.stripAnim.cancel();
			phase.ghostAnim?.cancel();
			phase.ghost?.remove();
			phase = { kind: 'idle' };
			stripStartH = Number.isFinite(ghostNow) ? ghostNow : 0;
			ghostStartH = stripNow;
		} else if (phase.kind === 'pending') {
			// Same-task coalesce: no paint happened; keep the original start
			// values and just retarget the starter.
			phase.next = next;
			commit();
			return;
		} else if (kind === 'push') {
			// Static state — no margins in play, so this is the plain height.
			ghostStartH = readVisibleStripHeight(getComputedStyle(el), (prev as PlayerChrome).dock);
		}

		el.classList.add(ANIM_CLASS);
		commit();
		phase = { kind: 'pending', prev: prev as PlayerChrome, next, stripStartH, ghostStartH };
		queueMicrotask(start);
	};

	return { apply, dispose: settle };
}

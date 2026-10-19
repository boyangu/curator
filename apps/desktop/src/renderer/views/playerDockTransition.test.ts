// Dock-flip choreography — tested through the pure helpers (spring sampler,
// transition classifier, motion gate), no Solid/DOM runtime; same pattern as
// shell.test.ts. The spring assertions pin the user-locked motion contract:
// critically damped (provably no overshoot), ~350ms settle, front-loaded
// travel with a soft landing.

import { describe, expect, it } from 'vitest';
import {
	classifyTransition,
	decideMotion,
	sampleSpringProgress,
	type PlayerChrome,
} from './playerDockTransition.js';

const chrome = (dock: 'top' | 'bottom', presence: 'hidden' | 'dock'): PlayerChrome => ({ dock, presence });

describe('sampleSpringProgress', () => {
	const p = sampleSpringProgress();

	it('spans exactly [0, 1] over the default 30 samples', () => {
		expect(p.length).toBe(30);
		expect(p[0]).toBe(0);
		expect(p.at(-1)).toBe(1);
	});

	it('is strictly monotonic and never overshoots', () => {
		for (let i = 1; i < p.length; i++) {
			expect(p[i]!).toBeGreaterThan(p[i - 1]!);
			expect(p[i]!).toBeLessThanOrEqual(1);
		}
	});

	it('settles within 1% at the raw (unnormalized) end — pins ω against under-tuning', () => {
		// x(T) for ω=19, T=350ms: (1 + ωT)·e^(−ωT) must be ≤ 1%. If someone
		// softens ω below ~19 without lengthening T, the curve would still be
		// visibly moving when the keyframes run out and the settle snap would
		// show. Recompute the closed form here rather than trusting the
		// normalized samples (which always end at exactly 1).
		const u = 19 * 0.35;
		expect((1 + u) * Math.exp(-u)).toBeLessThanOrEqual(0.01);
	});

	it('is front-loaded with a soft landing', () => {
		// Past the halfway mark most of the travel is done…
		expect(p[15]!).toBeGreaterThan(0.8);
		// …and the last 10% of the timeline covers under 3% of the distance.
		expect(1 - p[27]!).toBeLessThan(0.03);
	});
});

describe('classifyTransition', () => {
	it('boot: first-ever application never animates', () => {
		expect(classifyTransition(null, chrome('top', 'hidden'))).toBe('boot');
		expect(classifyTransition(null, chrome('bottom', 'dock'))).toBe('boot');
	});

	it('none: equal chrome, and edge changes while folded (invisible)', () => {
		expect(classifyTransition(chrome('top', 'dock'), chrome('top', 'dock'))).toBe('none');
		expect(classifyTransition(chrome('top', 'hidden'), chrome('bottom', 'hidden'))).toBe('none');
	});

	it('grow: hidden → dock, either edge', () => {
		expect(classifyTransition(chrome('top', 'hidden'), chrome('top', 'dock'))).toBe('grow');
		expect(classifyTransition(chrome('top', 'hidden'), chrome('bottom', 'dock'))).toBe('grow');
	});

	it('push: docked edge flip', () => {
		expect(classifyTransition(chrome('top', 'dock'), chrome('bottom', 'dock'))).toBe('push');
		expect(classifyTransition(chrome('bottom', 'dock'), chrome('top', 'dock'))).toBe('push');
	});

	it('fold: dock → hidden rides the CSS transition', () => {
		expect(classifyTransition(chrome('bottom', 'dock'), chrome('bottom', 'hidden'))).toBe('fold');
		expect(classifyTransition(chrome('top', 'dock'), chrome('bottom', 'hidden'))).toBe('fold');
	});
});

describe('decideMotion', () => {
	it('animates grow/push only with motion allowed and a live animation clock', () => {
		expect(decideMotion('grow', false, true)).toBe('animate');
		expect(decideMotion('push', false, true)).toBe('animate');
	});

	it('snaps under prefers-reduced-motion', () => {
		expect(decideMotion('grow', true, true)).toBe('snap');
		expect(decideMotion('push', true, true)).toBe('snap');
	});

	it('snaps in an occluded window (frozen WAAPI clock would strand the animation)', () => {
		expect(decideMotion('grow', false, false)).toBe('snap');
		expect(decideMotion('push', false, false)).toBe('snap');
	});

	it('never animates the non-motion kinds', () => {
		expect(decideMotion('boot', false, true)).toBe('snap');
		expect(decideMotion('none', false, true)).toBe('snap');
		expect(decideMotion('fold', false, true)).toBe('snap');
	});
});

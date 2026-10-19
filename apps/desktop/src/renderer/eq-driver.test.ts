// The now-playing eq must never sit frozen while audio plays: local tracks
// follow the engine's peaks, and a silent live signal hands the bars back to
// the CSS keyframe animation (drops `eq-live`) until signal returns.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	state: { playing: true, current: { source: 'spotify' } as { source: string } | null, peakL: 0, peakR: 0 },
	subscriber: null as null | ((s: unknown) => void),
	frame: null as null | ((now: number) => void),
	bands: [0, 0, 0, 0] as number[] | null,
}));
vi.mock('./player.js', () => ({
	getState: () => h.state,
	subscribe: (cb: (s: unknown) => void) => { h.subscriber = cb; return () => {}; },
}));
vi.mock('./ticker.js', () => ({ onFrame: (fn: (now: number) => void) => { h.frame = fn; return () => { h.frame = null; }; } }));
vi.mock('./spectrum.js', () => ({ readBands: () => h.bands, followOutputDeviceChanges: () => {} }));

const classes = new Set<string>();
const vars = new Map<string, string>();
(globalThis as unknown as { document: unknown }).document = {
	documentElement: {
		classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
		style: { setProperty: (k: string, v: string) => vars.set(k, v) },
	},
};

const { startEqDriver } = await import('./eq-driver.js');
startEqDriver();

function play(): void { h.subscriber!(h.state); }

describe('now-playing eq driver', () => {
	beforeEach(() => { classes.clear(); vars.clear(); h.state.playing = true; });

	it('streaming: silence for 2 s falls back to the CSS animation, signal brings live bars back', () => {
		h.state.current = { source: 'spotify' };
		h.bands = [0, 0, 0, 0];
		play();
		h.frame!(1000);
		expect(classes.has('eq-live')).toBe(true); // brief silence is still drawn live
		h.frame!(3500);
		expect(classes.has('eq-live')).toBe(false); // stale capture → keyframes, never frozen
		h.bands = [0.6, 0.4, 0.8, 0.2];
		h.frame!(3600);
		expect(classes.has('eq-live')).toBe(true);
	});

	it('local: bars follow the engine peaks, not the loopback capture', () => {
		h.state.current = { source: 'local' };
		h.bands = null; // loopback never granted / bound to another device
		h.state.peakL = 0.9; h.state.peakR = 0.85;
		play();
		for (let t = 5000; t < 5300; t += 16) h.frame!(t);
		expect(classes.has('eq-live')).toBe(true);
		const heights = [1, 2, 3, 4].map((b) => parseFloat(vars.get(`--np-eq-${b}`)!));
		expect(Math.min(...heights)).toBeGreaterThan(40);
		expect(new Set(heights).size).toBeGreaterThan(1); // not four identical columns
	});
});

import { describe, expect, it } from 'vitest';
import { productionFlags, worstProductionSeverity } from './production-flags.js';

describe('productionFlags', () => {
	it('is quiet on a clean master', () => {
		expect(productionFlags({ prodCutoffHz: 22050, prodClipPct: 0, prodSubCorr: 0.98, prodPlr: 9.5, prodLufs: -10.5, stereoSource: true })).toEqual([]);
	});

	it('grades a lossy wall by where it sits', () => {
		expect(productionFlags({ prodCutoffHz: 16000 }).map((f) => [f.kind, f.severity])).toEqual([['transcode', 'bad']]);
		expect(productionFlags({ prodCutoffHz: 19800 }).map((f) => [f.kind, f.severity])).toEqual([['transcode', 'warn']]);
		// A gentle rolloff the profile knows is shallow is not a wall.
		expect(productionFlags({ prodCutoffHz: 16000, prodCutoffDepthDb: 6 })).toEqual([]);
	});

	it('derives overs from loudness + PLR when the true peak is absent', () => {
		const f = productionFlags({ prodLufs: -6, prodPlr: 7.5 });
		expect(f.map((x) => x.kind)).toEqual(['overs']);
		expect(f[0]!.severity).toBe('bad');
	});

	it('does not read stereo flags off a mono file', () => {
		expect(productionFlags({ prodSubCorr: -0.3, phaseCorr: -0.2, stereoSource: false })).toEqual([]);
		expect(productionFlags({ prodSubCorr: -0.3, stereoSource: true }).map((f) => f.severity)).toEqual(['bad']);
	});

	it('reports the worst severity', () => {
		expect(worstProductionSeverity([])).toBeNull();
		expect(worstProductionSeverity(productionFlags({ prodClipPct: 0.02, prodPlr: 5 }))).toBe('bad');
		expect(worstProductionSeverity(productionFlags({ prodClipPct: 0.02 }))).toBe('warn');
	});
});

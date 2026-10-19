import { describe, it, expect } from 'vitest';
import { analysisFlagsToOptions, DEFAULT_AUTO_FLAGS, DEFAULT_MANUAL_FLAGS } from './flags.js';

describe('analysisFlagsToOptions', () => {
	it('defaults the fingerprint on for both surfaces', () => {
		expect(DEFAULT_AUTO_FLAGS.fingerprint).toBe(true);
		expect(DEFAULT_MANUAL_FLAGS.fingerprint).toBe(true);
		expect(analysisFlagsToOptions(DEFAULT_AUTO_FLAGS).skipFingerprint).toBeUndefined();
		expect(analysisFlagsToOptions(DEFAULT_MANUAL_FLAGS).skipFingerprint).toBeUndefined();
	});

	it('maps an unchecked fingerprint to skipFingerprint', () => {
		const opts = analysisFlagsToOptions({ ...DEFAULT_AUTO_FLAGS, fingerprint: false });
		expect(opts.skipFingerprint).toBe(true);
	});

	it('translates each basic flag to its skip/override pair', () => {
		const everythingOff = analysisFlagsToOptions({ beatgrid: false, key: false, segments: false, peaks: false, fingerprint: false, advanced: false });
		expect(everythingOff).toEqual({ features: [], skipBeatgrid: true, skipKey: true, skipSegments: true, skipPeaks: true, skipFingerprint: true });

		const everythingOn = analysisFlagsToOptions({ beatgrid: true, key: true, segments: true, peaks: true, fingerprint: true, advanced: true });
		expect(everythingOn.features).toHaveLength(6);
		expect(everythingOn).toMatchObject({ overrideBeatgrid: true, overrideBpm: true, overrideKey: true, overrideSegments: true, overridePeaks: true });
		expect(everythingOn.skipFingerprint).toBeUndefined();
	});
});

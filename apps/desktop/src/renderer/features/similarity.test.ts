// Similarity matching rules — tested through the pure helpers
// (camelotRelation / computeSimilarLevels), same convention as shell.test.ts:
// the signal + localStorage plumbing is a thin wrapper around these.

import { describe, expect, it } from 'vitest';
import { camelotRelation, computeSimilarLevels, type SimilarityFields, type SimilaritySettings } from './similarity.js';

// All dimensions on, master on — individual tests flip what they probe.
const allOn = (overrides: Partial<SimilaritySettings> = {}): SimilaritySettings => ({
	enabled: true,
	bpm:        { enabled: true, range: 3 },
	key:        { enabled: true, level: 3 },
	brightness: { enabled: true, range: 1 },
	power:      { enabled: true, range: 1 },
	label:      { enabled: true },
	...overrides,
});

const track = (f: Partial<SimilarityFields> = {}): SimilarityFields => ({
	bpm: null, keyCamelot: null, label: null, brightness: null, power: null, ...f,
});

describe('camelotRelation', () => {
	// rekordbox Traffic Light semantics: for 8A —
	// Same key: 8A · Related 1: +8B · Related 2: +7A/9A · Related 3: +7B/9B.
	it('level 0 — same key', () => {
		expect(camelotRelation('8A', '8A')).toBe(0);
		expect(camelotRelation('12B', '12B')).toBe(0);
	});

	it('level 1 — relative major/minor (same number, other letter)', () => {
		expect(camelotRelation('8A', '8B')).toBe(1);
		expect(camelotRelation('8B', '8A')).toBe(1);
	});

	it('level 2 — ±1 on the wheel, same letter', () => {
		expect(camelotRelation('8A', '7A')).toBe(2);
		expect(camelotRelation('8A', '9A')).toBe(2);
		expect(camelotRelation('8B', '9B')).toBe(2);
	});

	it('level 3 — ±1 on the wheel, other letter', () => {
		expect(camelotRelation('8A', '7B')).toBe(3);
		expect(camelotRelation('8A', '9B')).toBe(3);
	});

	it('wraps around the wheel (12 and 1 are adjacent)', () => {
		expect(camelotRelation('12A', '1A')).toBe(2);
		expect(camelotRelation('1A', '12A')).toBe(2);
		expect(camelotRelation('12A', '1B')).toBe(3);
		expect(camelotRelation('1B', '12B')).toBe(2);
	});

	it('never relates ±2 numbers or further', () => {
		expect(camelotRelation('8A', '10A')).toBeNull();
		expect(camelotRelation('8A', '6B')).toBeNull();
		expect(camelotRelation('12A', '2A')).toBeNull();
	});

	it('rejects unparseable keys', () => {
		expect(camelotRelation('8A', 'Am')).toBeNull();
		expect(camelotRelation('', '8A')).toBeNull();
		expect(camelotRelation('13A', '8A')).toBeNull();
		expect(camelotRelation('0B', '8A')).toBeNull();
	});

	it('accepts lowercase and padded input', () => {
		expect(camelotRelation(' 8a ', '8B')).toBe(1);
	});
});

describe('computeSimilarLevels', () => {
	const ref = track({ bpm: 124, keyCamelot: '8A', label: 'Anjunadeep', brightness: 1.8, power: 2.2 });

	it('BPM levels subdivide the configured range into thirds; the range is the outer bound', () => {
		const s = allOn({ bpm: { enabled: true, range: 3 } });
		const at = (bpm: number) => computeSimilarLevels(track({ bpm }), ref, s).bpm;
		expect(at(124)).toBe(1);
		expect(at(125)).toBe(1);       // |d| = 1 = range/3, inclusive
		expect(at(125.5)).toBe(2);
		expect(at(126)).toBe(2);       // |d| = 2 = 2·range/3
		expect(at(122.5)).toBe(2);
		expect(at(127)).toBe(3);       // |d| = 3 = range
		expect(at(121)).toBe(3);
		expect(at(127.5)).toBeUndefined();   // outside the range — never highlighted
	});

	it('numeric dims never match when either side is null', () => {
		expect(computeSimilarLevels(track({ bpm: null }), ref, allOn()).bpm).toBeUndefined();
		expect(computeSimilarLevels(track({ bpm: 124 }), track(), allOn()).bpm).toBeUndefined();
	});

	it('key: the configured grade is the outer bound; levels subdivide it in thirds of the relation', () => {
		const at = (level: 0 | 1 | 2 | 3, key: string) =>
			computeSimilarLevels(track({ keyCamelot: key }), ref, allOn({ key: { enabled: true, level } })).key;
		// Configured "Same key" (0): only the exact key, solid.
		expect(at(0, '8A')).toBe(1);
		expect(at(0, '8B')).toBeUndefined();
		// Configured "Related key 1": relative lands in the outer third.
		expect(at(1, '8A')).toBe(1);
		expect(at(1, '8B')).toBe(3);
		expect(at(1, '9A')).toBeUndefined();
		// Configured "Related key 2": relation 1 ≤ 2·(2/3), relation 2 = bound.
		expect(at(2, '8A')).toBe(1);
		expect(at(2, '8B')).toBe(2);
		expect(at(2, '9A')).toBe(3);
		expect(at(2, '9B')).toBeUndefined();
		// Configured "Related key 3": same + relative ≤ 3/3 → solid, then
		// one grade per third.
		expect(at(3, '8A')).toBe(1);
		expect(at(3, '8B')).toBe(1);
		expect(at(3, '9A')).toBe(2);
		expect(at(3, '9B')).toBe(3);
	});

	it('unrelated keys never match at any configured grade', () => {
		expect(computeSimilarLevels(track({ keyCamelot: '10A' }), ref, allOn()).key).toBeUndefined();
	});

	it('label has no gradation — exact match is level 1, case-insensitive, never empty', () => {
		expect(computeSimilarLevels(track({ label: 'ANJUNADEEP' }), ref, allOn()).label).toBe(1);
		expect(computeSimilarLevels(track({ label: ' anjunadeep ' }), ref, allOn()).label).toBe(1);
		expect(computeSimilarLevels(track({ label: 'Afterlife' }), ref, allOn()).label).toBeUndefined();
		expect(computeSimilarLevels(track({ label: '' }), track({ label: '' }), allOn()).label).toBeUndefined();
	});

	it('brightness/power subdivide their range in thirds, with float-noise tolerance at the bound', () => {
		// The user's spec example: range 0.5 → diff ≤ 0.5/3 solid, ≤ 2·0.5/3
		// level 2, ≤ 0.5 level 3.
		const s = allOn({ brightness: { enabled: true, range: 0.5 }, power: { enabled: true, range: 1 } });
		const at = (brightness: number) => computeSimilarLevels(track({ brightness }), ref, s).brightness;
		expect(at(1.9)).toBe(1);           // |0.1| ≤ 0.5/3
		expect(at(2.05)).toBe(2);          // |0.25| ≤ 1/3
		expect(at(2.3)).toBe(3);           // |0.5| = range (float noise absorbed)
		expect(at(2.31)).toBeUndefined();  // just outside
		const dims = computeSimilarLevels(track({ power: 1.2 }), ref, s);
		expect(dims.power).toBe(3);        // |1.2 - 2.2| = 1 = range boundary (float noise absorbed)
		expect(computeSimilarLevels(track({ power: 2.5 }), ref, s).power).toBe(1);   // |0.3| ≤ 1/3
	});

	it('disabled dimensions never match at any level', () => {
		const s = allOn({
			bpm: { enabled: false, range: 10 },
			key: { enabled: false, level: 3 },
			label: { enabled: false },
			brightness: { enabled: false, range: 1 },
			power: { enabled: false, range: 1 },
		});
		const identical = track({ bpm: 124, keyCamelot: '8A', label: 'Anjunadeep', brightness: 1.8, power: 2.2 });
		expect(computeSimilarLevels(identical, ref, s)).toEqual({});
	});
});

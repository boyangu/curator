// Release-date label: recent full dates read as an age (≤ 30 local days),
// older or partial dates as "Mon, YYYY" / "YYYY". Pure.

import { describe, expect, it } from 'vitest';
import { fmtReleaseLabel } from './format.js';

const NOW = new Date(2026, 9, 16, 15, 30); // Oct 16 2026, local

describe('fmtReleaseLabel', () => {
	it('reads recent full dates as an age', () => {
		expect(fmtReleaseLabel('2026-10-16', NOW)).toBe('today');
		expect(fmtReleaseLabel('2026-10-15', NOW)).toBe('1 day');
		expect(fmtReleaseLabel('2026-10-02', NOW)).toBe('14 days');
		expect(fmtReleaseLabel('2026-09-16', NOW)).toBe('30 days');
	});
	it('falls back to month + year past 30 days, and for future or partial dates', () => {
		expect(fmtReleaseLabel('2026-09-15', NOW)).toBe('Sep, 2026');
		expect(fmtReleaseLabel('2021-03-15', NOW)).toBe('Mar, 2021');
		expect(fmtReleaseLabel('2026-11-01', NOW)).toBe('Nov, 2026');
		expect(fmtReleaseLabel('2026-10', NOW)).toBe('Oct, 2026');
		expect(fmtReleaseLabel('2021', NOW)).toBe('2021');
	});
	it('renders a dash for missing values', () => {
		expect(fmtReleaseLabel(null, NOW)).toBe('—');
		expect(fmtReleaseLabel('', NOW)).toBe('—');
	});
});

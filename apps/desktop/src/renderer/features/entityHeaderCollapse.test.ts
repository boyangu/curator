import { describe, expect, it } from 'vitest';
import { collapseAt, leadOf } from './entityHeaderCollapse.js';

// A header 207px tall that closes down to 62px.
const g = { full: 207, compact: 62 };

describe('entity header closing with the scroll', () => {
	it('is open at the top and closes pixel for pixel with the scroll, up to its two lines', () => {
		expect(leadOf(g)).toBe(145);
		expect(collapseAt(0, g)).toEqual({ shift: 0, progress: 0, height: 207, collapsed: false });
		const mid = collapseAt(58, g);
		expect(mid).toMatchObject({ shift: 58, height: 149, collapsed: false });
		expect(mid.progress).toBeCloseTo(0.4);
		expect(collapseAt(145, g)).toEqual({ shift: 145, progress: 1, height: 62, collapsed: true });
		// Past the lead the list scrolls under a header that no longer changes.
		expect(collapseAt(3000, g)).toEqual(collapseAt(145, g));
		// A bounce above the top is the top.
		expect(collapseAt(-20, g)).toEqual(collapseAt(0, g));
	});

	it('has nothing to close when the header is already about its two lines', () => {
		const flat = { full: 66, compact: 62 };
		expect(leadOf(flat)).toBe(0);
		expect(collapseAt(500, flat)).toEqual({ shift: 0, progress: 0, height: 66, collapsed: false });
	});
});

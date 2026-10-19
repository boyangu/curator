import { describe, it, expect } from 'vitest';
import { recordingKey } from './recording-key.js';

describe('recordingKey', () => {
	it('treats " - X Remix" and "(X Remix)" as the same recording', () => {
		expect(recordingKey('In Your Mind - Tim Engelhardt Remix', ['Pole Position']))
			.toBe(recordingKey('In Your Mind (Tim Engelhardt Remix)', ['Pole Position']));
	});

	it('keeps versions apart (Extended ≠ Radio Edit), but "Original Mix" is the bare title', () => {
		expect(recordingKey('Ahimsa - Extended Mix', ['X'])).not.toBe(recordingKey('Ahimsa - Radio Edit', ['X']));
		expect(recordingKey('Ahimsa - Original Mix', ['X'])).toBe(recordingKey('Ahimsa', ['X']));
	});

	it('ignores artist order, case and diacritics', () => {
		expect(recordingKey('Seen It All', ['TWO LANES', 'Aaron Ahrends']))
			.toBe(recordingKey('seen it all', ['Aaron Ahrends', 'Two Lanes']));
		expect(recordingKey('Mare', ['Christian Löffler'])).toBe(recordingKey('Mare', ['Christian Loffler']));
	});

	it('distinguishes the same title by different artists', () => {
		expect(recordingKey('Intro', ['A'])).not.toBe(recordingKey('Intro', ['B']));
	});
});

import { describe, it, expect } from 'vitest';
import { recordingIdForTrack } from './recording-id.js';

describe('recordingIdForTrack', () => {
	it('is a stable RFC 4122 v5 UUID per track id', () => {
		const a = recordingIdForTrack('3b241101-e2bb-4255-8caf-4136c566a962');
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(recordingIdForTrack('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(a);
	});

	it('differs between track ids', () => {
		expect(recordingIdForTrack('a')).not.toBe(recordingIdForTrack('b'));
	});
});

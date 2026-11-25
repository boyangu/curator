import { describe, it, expect } from 'vitest';
import { recordingKeysFor } from './recording.js';

describe('recordingKeysFor', () => {
	it('one key per track item, one per distinct album tracklist ref, none for an unresolved album', () => {
		expect(recordingKeysFor('track', { title: 'T', artists: ['A'] })).toHaveLength(1);
		const tracks = [
			{ sourceTrackId: '1', title: 'T', artists: ['A'], durationSec: 1 },
			{ sourceTrackId: '2', title: 'U', artists: ['A'], durationSec: 1 },
		];
		expect(recordingKeysFor('album', { title: 'Al', artists: ['A'], tracks })).toHaveLength(2);
		expect(recordingKeysFor('album', { title: 'Al', artists: ['A'] })).toEqual([]);
	});
});

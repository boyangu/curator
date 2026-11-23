// Unit tests for what a row states as its attributes (track-attrs.ts): its
// own values only, adopted ones as null; the key's source; provider listings
// compacted and shrunk under the op cap.

import { describe, it, expect } from 'vitest';
import { MAX_OP_PAYLOAD_BYTES, opPayloadBytes } from '@curator/protocol';
import { providerRefOf, refPayload, trackAttrsOf, type AttrsRow } from './track-attrs.js';

const row = (p: Partial<AttrsRow> = {}): AttrsRow => ({
	id: 't', recording_id: 'r', bpm: null, key_camelot: null, comment: null, color_label: null, explicit: null, mbid: null, copyright: null,
	play_count: 0, cues_edited_at: null, updated_at: 0, artists: '[]', overrides: null, attrs_adopted: null, ...p,
});
const ctx = (p: Partial<Parameters<typeof trackAttrsOf>[1]> = {}) => ({ sources: new Set<string>(), links: [], rbKey: null, artistName: () => null, ...p });

describe('trackAttrsOf', () => {
	it('states own values in wire form; an empty play counter and an explicit 0/1 read as the wire wants', () => {
		const a = trackAttrsOf(row({ bpm: 122.5, key_camelot: '8A', comment: 'x', color_label: 'red', explicit: 1, play_count: 0 }), ctx({ sources: new Set(['local']) }))!;
		expect(a).toMatchObject({ source: 'local', bpm: 122.5, key_camelot: '8A', explicit: true, play_count: null });
		// Curation is not an attribute (set-curation, track-curation.ts).
		expect('comment' in a || 'color_label' in a).toBe(false);
	});

	it('states an adopted field as null while the column still holds the adopted value, and as its own once a writer changed it', () => {
		const adopted = JSON.stringify({ bpm: { v: 120, from: 'account' }, mbid: { v: 'theirs', from: 'account' }, key_camelot: { v: '5A', from: 'catalogue' } });
		const a = trackAttrsOf(row({ bpm: 120, mbid: 'mine now', key_camelot: '5A', attrs_adopted: adopted }), ctx())!;
		expect([a.bpm, a.mbid, a.key_camelot]).toEqual([null, 'mine now', null]);
	});

	it('names the key source: rekordbox when it is the rb slot\'s, else the provider that fills keys', () => {
		expect(trackAttrsOf(row({ key_camelot: '8A' }), ctx({ rbKey: '8A', sources: new Set(['beatport']) }))!.key_source).toBe('rekordbox');
		expect(trackAttrsOf(row({ key_camelot: '8A' }), ctx({ rbKey: '9A', sources: new Set(['beatport']) }))!.key_source).toBe('beatport');
		expect(trackAttrsOf(row({ key_camelot: '8A' }), ctx({ sources: new Set(['tidal']) }))!.key_source).toBe('tidal');
		expect(trackAttrsOf(row({ key_camelot: null }), ctx())!.key_source).toBeNull();
	});

	it('takes the artist table\'s spelling of each credit', () => {
		const a = trackAttrsOf(row({ artists: JSON.stringify([{ name: 'Ayse Celikoglu' }, { name: 'B', role: 'remixer' }]) }), ctx({ artistName: (k) => (k === 'aysecelikoglu' ? 'Ayşe Çelikoğlu' : null) }))!;
		expect(a.artist_names).toEqual(['Ayşe Çelikoğlu', 'B']);
	});

	it('compacts listings, dedupes them, and drops refs (then cuts the comment) to fit the op cap', () => {
		const payload = JSON.stringify({ album: { id: 'al1', name: 'A', artists: [{ name: 'X' }], release_date: '2022', images: [{ url: 'https://i/x' }], album_type: 'album', total_tracks: 9 }, artists: [{ id: 'ar1', name: 'X' }], track_number: 2, disc_number: 1 });
		const links = [{ track_id: 't', source: 'spotify', payload }, { track_id: 't', source: 'spotify', payload }, { track_id: 't', source: 'beatport', payload: null }];
		const a = trackAttrsOf(row(), ctx({ links, sources: new Set(['spotify', 'beatport']) }))!;
		expect(a.provider_refs).toEqual([{ source: 'spotify', album: { id: 'al1', name: 'A', artists: ['X'], release_date: '2022', cover_url: 'https://i/x', album_type: 'album', total_tracks: 9 }, artists: [{ name: 'X', id: 'ar1' }], track_number: 2, disc_number: 1 }]);
		// Round trip into the payload shape the album seam reads.
		expect(providerRefOf('spotify', refPayload(a.provider_refs[0]!))).toEqual(a.provider_refs[0]);
		const huge = trackAttrsOf(row({ copyright: 'c'.repeat(1000) }), ctx({ links: Array.from({ length: 8 }, (_, i) => ({ track_id: 't', source: 'spotify', payload: JSON.stringify({ album: { id: `al${i}`, name: 'n'.repeat(1000), artists: Array.from({ length: 30 }, () => ({ name: 'a'.repeat(100) })) } }) })) }))!;
		expect(opPayloadBytes({ payload: huge })).toBeLessThanOrEqual(MAX_OP_PAYLOAD_BYTES);
		expect(huge.provider_refs.length).toBeLessThan(8);
	});
});

describe('curation (track-curation.ts): the comment as free text', () => {
	it('splits the free text off rekordbox\'s MyTag block and puts a received text in front of the row\'s own block', async () => {
		const { commentFreeText, composeComment } = await import('./track-curation.js');
		expect(commentFreeText(' /* hypnotic / love / uplift */')).toBeNull();
		expect(commentFreeText('Purchased at Beatport.com /* p3 / ! / house */')).toBe('Purchased at Beatport.com');
		expect(commentFreeText('ethnic, up')).toBe('ethnic, up');
		expect(commentFreeText(null)).toBeNull();
		// The same free text, two machines' blocks in different orders: one text.
		expect(commentFreeText('x /* a / b */')).toBe(commentFreeText('x /* b / a */'));
		expect(composeComment(' /* a / b */', 'new note')).toBe('new note /* a / b */');
		expect(composeComment('old /* b / a */', 'new')).toBe('new /* b / a */');
		expect(composeComment('old /* a */', null)).toBe(' /* a */');
		expect(composeComment(null, 'only text')).toBe('only text');
		expect(composeComment('plain', null)).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';
import { pageRef } from './page-ref.js';

const ref = (url: string) => {
	const r = pageRef(url);
	return r ? `${r.provider}:${r.kinds.join('|')}:${r.id}` : null;
};

describe('pageRef', () => {
	it('keys each store’s artist, label and release pages', () => {
		expect(ref('https://www.beatport.com/artist/ivo-lark/560627')).toBe('beatport:artist:560627');
		expect(ref('https://www.beatport.com/label/northfold-records/804?page=2')).toBe('beatport:label:804');
		expect(ref('beatport.com/release/glass-rivers/4412')).toBe('beatport:release:4412');
		expect(ref('https://open.spotify.com/intl-de/artist/1yatuhSYBeceXdDRg67hrm?si=abc')).toBe('spotify:artist:1yatuhSYBeceXdDRg67hrm');
		expect(ref('spotify:album:0i4bBGoAv4AxlDOpwRgy31')).toBe('spotify:release:0i4bBGoAv4AxlDOpwRgy31');
		expect(ref('https://www.deezer.com/en/artist/4532513')).toBe('deezer:artist:4532513');
		expect(ref('https://listen.tidal.com/album/18144631')).toBe('tidal:release:18144631');
		expect(ref('https://tidal.com/browse/artist/4752073')).toBe('tidal:artist:4752073');
	});

	it('reads a SoundCloud or Bandcamp profile as an artist’s or a label’s, and nothing under it', () => {
		expect(ref('https://soundcloud.com/Ivo-Lark')).toBe('soundcloud:artist|label:ivo-lark');
		expect(ref('https://soundcloud.com/ivo-lark/sets/glass-rivers')).toBeNull();
		expect(ref('https://soundcloud.com/discover')).toBeNull();
		expect(ref('https://northfold.bandcamp.com/music')).toBe('bandcamp:artist|label:northfold');
		expect(ref('https://northfold.bandcamp.com/album/glass-rivers')).toBeNull();
		expect(pageRef('https://northfold.bandcamp.com/')!.url).toBe('https://northfold.bandcamp.com');
	});

	it('refuses what is not a store page', () => {
		for (const s of ['', 'ivo lark', 'https://www.beatport.com/track/x/1', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'ftp://beatport.com/artist/a/1', 'https://example.com/artist/1']) expect(pageRef(s)).toBeNull();
	});
});

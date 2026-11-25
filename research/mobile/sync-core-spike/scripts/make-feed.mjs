// A feed for the test server (serve-cloud.ts --feed), made of the dataset's
// own tracks so covers load and the library knows some of them: playlist
// additions, releases with their tracklists, and the corners a card has to
// get right (no Spotify id, no label, a lone genre, a 20-track album, a
// track whose file is owned and must not show).
//
//   node scripts/make-feed.mjs [--work c:/tmp/curator-mobile-spike] [--name main] [--out <file>]
//
// Reads <work>/<name>/copy.db (prepare.mjs's copy, opened read-only) and
// writes feed.json: { watches, events, later } (serve-cloud.ts says the
// shape). Dates are relative to when the server starts.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'main'));
const db = new DatabaseSync(join(dir, 'copy.db'), { readOnly: true });

const sql = (where, n) => db.prepare(`SELECT t.id, t.title, t.artists, t.album_title AS album, t.isrc, t.duration, t.bpm, t.key_camelot AS key, t.label, t.genre, t.cover_url AS cover,
		l.source_track_id AS sid, json_extract(l.payload, '$.album.images[0].url') AS art, json_extract(l.payload, '$.artists') AS credits,
		EXISTS (SELECT 1 FROM source_link f WHERE f.track_id = t.id AND f.source = 'local') AS owned
	FROM track t JOIN source_link l ON l.track_id = t.id AND l.source = 'spotify'
	WHERE t.deleted_at IS NULL AND t.isrc IS NOT NULL AND json_extract(l.payload, '$.album.images[0].url') IS NOT NULL AND ${where}
	ORDER BY t.id LIMIT ${n}`).all();

const uuid = (s) => { const h = createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const handle = (id, kind = 'track') => ({ provider: 'spotify', id, url: `https://open.spotify.com/${kind}/${id}` });
const artistsOf = (t) => JSON.parse(t.credits ?? '[]').map((a) => ({ id: uuid(`artist:${a.id}`), name: a.name, handles: [handle(a.id, 'artist')] }));
// A track the library has never heard of: the same card under ids of its own.
const unknown = (t) => ({ ...t, isrc: `XXFEED${createHash('sha1').update(t.id).digest('hex').slice(0, 6)}`.toUpperCase(), sid: createHash('sha1').update(t.sid).digest('hex').slice(0, 22), fake: true });

const streamed = sql(`NOT EXISTS (SELECT 1 FROM source_link f WHERE f.track_id = t.id AND f.source = 'local') AND t.bpm IS NOT NULL AND t.label IS NOT NULL AND t.genre IS NOT NULL`, 60);
const owned = sql(`EXISTS (SELECT 1 FROM source_link f WHERE f.track_id = t.id AND f.source = 'local')`, 6);
const pinned = sql(`EXISTS (SELECT 1 FROM track_tag x WHERE x.track_id = t.id AND x.tag_id = 'interested') AND NOT EXISTS (SELECT 1 FROM source_link f WHERE f.track_id = t.id AND f.source = 'local')`, 4);

const HOUR = 3_600_000, DAY = 24 * HOUR;
const playlist = { id: uuid('playlist:hot'), name: 'Hot / Cold', handles: [handle('37i9dQZF1DXfeedtest', 'playlist')] };
const trackEvent = (t, ago, over = {}) => ({
	kind: 'playlist_add', subjectId: uuid(`rec:${t.sid}`), subjects: [playlist.id], ago,
	card: {
		version: 2, kind: 'track', title: t.title, artists: artistsOf(t), isrc: t.isrc, durationSec: t.duration, albumTitle: t.album, coverUrl: t.art, releaseDate: null,
		handles: [handle(t.sid)], container: { kind: 'playlist', ...playlist }, rank: null, bpm: t.bpm, key: t.key, genres: t.genre ? [t.genre] : [], label: t.label ? { id: null, name: t.label } : null, ...over,
	},
});
const releaseEvent = (title, list, ago, over = {}) => ({
	kind: 'new_release', subjectId: uuid(`rel:${title}`), subjects: [artistsOf(list[0])[0].id], ago,
	card: {
		version: 2, kind: 'release', title, artists: artistsOf(list[0]), label: list[0].label ? { id: null, name: list[0].label } : null, coverUrl: list[0].art, releaseType: 'single', releaseDate: null,
		tracks: list.map((t) => ({ id: uuid(`rec:${t.sid}`), title: t.title, artists: artistsOf(t).map((a) => a.name), isrc: t.isrc, durationSec: t.duration, handles: t.nowhere ? [] : [handle(t.sid)], bpm: t.bpm, key: t.key, genres: t.genre ? [t.genre] : [] })),
		handles: [handle(createHash('sha1').update(title).digest('hex').slice(0, 22), 'album')], genres: list[0].genre ? [list[0].genre] : [], catalogNumber: null, upc: null, ...over,
	},
});

const s = streamed.map(unknown);
const events = [
	// An EP with a track the library marked and one no player has.
	releaseEvent('Feed test EP', [s[0], ...(pinned[0] ? [pinned[0]] : []), { ...s[1], nowhere: true }, s[2]], 2 * HOUR),
	trackEvent(s[3], 2 * DAY),
	...(pinned[1] ? [trackEvent(pinned[1], 3 * DAY)] : []),
	trackEvent(s[4], 3 * DAY, { label: null, genres: [], key: null }),
	releaseEvent('Feed test album', s.slice(5, 25), 4 * DAY),
	trackEvent(s[25], 12 * DAY, { label: null, bpm: null, key: null }),
	trackEvent(s[26], 20 * DAY, { handles: [{ provider: 'bandcamp', id: 'b1', url: 'https://example.bandcamp.com/track/x' }] }),
	trackEvent(s[27], 75 * DAY),
	// Held as a file: must not show.
	...(owned[0] ? [trackEvent(owned[0], DAY)] : []),
	// Held as a stream only: shows, without the ribbon.
	trackEvent(streamed[40], 5 * DAY),
	...s.slice(28, 38).map((t, i) => trackEvent(t, (6 + i) * DAY)),
];
const first = artistsOf(s[0])[0];
const out = {
	watches: [
		{ id: playlist.id, kind: 'playlist', name: playlist.name, providerId: '37i9dQZF1DXfeedtest' },
		// Its cover stands in for the artist's picture.
		{ id: first.id, kind: 'artist', name: first.name, providerId: first.handles[0].id, imageUrl: s[0].art },
		{ id: artistsOf(s[5])[0].id, kind: 'artist', name: artistsOf(s[5])[0].name, providerId: artistsOf(s[5])[0].handles[0].id, imageUrl: null },
	],
	events,
	later: [trackEvent(s[38], 0), trackEvent(s[39], 0)],
};
const file = resolve(arg('out', join(dir, 'feed.json')));
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`${file}: ${events.length} events (${out.later.length} for later), ${out.watches.length} watches; from ${streamed.length} streamed, ${owned.length} owned, ${pinned.length} marked tracks`);

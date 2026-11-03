// The local collection as Global Catalog claims, over a seeded temp library
// (made-up names and ids; never the live database): one release per album
// with the owner's tracks, keyed by Spotify where the library holds the id,
// the label as a name unless it is a distributor's, biggest labels first.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZCatalogClaim } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { isDistributor, libraryClaims } from './library-claims.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-library-claims-'));
	const p = join(dir, 'c.db');
	migrate(p);
	db = new Database(p);
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const SP = (c: string) => c.repeat(22);

function artist(id: string, name: string, spotify?: string): void {
	db.prepare(`insert into artist (id, name, name_ascii, created_at, updated_at) values (?, ?, ?, 1, 1)`).run(id, name, name.toLowerCase());
	if (spotify) db.prepare(`insert into artist_link (artist_id, source, source_id, url) values (?, 'spotify', ?, null)`).run(id, spotify);
}
function album(id: string, o: { title: string; label?: string; upc?: string; date?: string; type?: string; total?: number; spotify?: string; artists?: string[] }): void {
	db.prepare(`insert into album (id, title, title_key, album_key, label, upc, release_date, album_type, total_tracks, cover_url) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		id,
		o.title,
		o.title.toLowerCase(),
		`${o.title.toLowerCase()}|k`,
		o.label ?? null,
		o.upc ?? null,
		o.date ?? null,
		o.type ?? null,
		o.total ?? null,
		'https://i.scdn.co/image/ab67616d0000b273cover',
	);
	if (o.spotify) db.prepare(`insert into album_link (album_id, source, source_id, url) values (?, 'spotify', ?, ?)`).run(id, o.spotify, `https://open.spotify.com/album/${o.spotify}`);
	(o.artists ?? []).forEach((a, i) => db.prepare(`insert into album_artist (album_id, artist_id, position) values (?, ?, ?)`).run(id, a, i));
}
let n = 0;
function track(o: { album?: string; title: string; label?: string; isrc?: string; spotify?: string; artists?: string[]; remixers?: string[]; membership?: 'local' | 'streaming'; date?: string; bpm?: number; key?: string; deleted?: boolean }): string {
	const id = `t${++n}`;
	db.prepare(
		`insert into track (id, recording_id, title, artists, album_id, album_title, label, isrc, duration, track_number, disc_number, bpm, key_camelot, release_date, membership, deleted_at, state, created_at, updated_at)
		values (?, ?, ?, '[]', ?, ?, ?, ?, 301, ?, 1, ?, ?, ?, ?, ?, 'backlog', 1, 1)`,
	).run(id, `rec-${id}`, o.title, o.album ?? null, o.album ? null : `${o.title} (single)`, o.label ?? null, o.isrc ?? null, n, o.bpm ?? null, o.key ?? null, o.date ?? null, o.membership ?? 'local', o.deleted ? 1 : null);
	if (o.spotify) db.prepare(`insert into source_link (id, track_id, source, source_track_id) values (?, ?, 'spotify', ?)`).run(`sl-${id}`, id, o.spotify);
	(o.artists ?? []).forEach((a, i) => db.prepare(`insert into track_artist (track_id, artist_id, role, position) values (?, ?, null, ?)`).run(id, a, i));
	(o.remixers ?? []).forEach((a, i) => db.prepare(`insert into track_artist (track_id, artist_id, role, position) values (?, ?, 'remixer', ?)`).run(id, a, 10 + i));
	return id;
}

describe('library claims', () => {
	it('tells a distributor from a label', () => {
		expect(isDistributor('DistroKid')).toBe(true);
		expect(isDistributor('1461444 Records DK')).toBe(true);
		expect(isDistributor('1885552 Records DK2')).toBe(true);
		expect(isDistributor('CD Baby')).toBe(true);
		expect(isDistributor('')).toBe(true);
		expect(isDistributor('Northfold Records')).toBe(false);
		expect(isDistributor('Believe Records Berlin')).toBe(false);
	});

	it("sends each album as a release with the owner's tracks, keyed by Spotify where the library holds the id, biggest label first — every claim valid", () => {
		artist('a1', 'Glass Rivers', SP('B'));
		artist('a2', 'Kaske');
		artist('a3', 'Ilka Rane', SP('E'));
		// Northfold: two albums, three tracks. Elsewhere: one album, one track.
		album('al1', { title: 'Low Tide EP', label: 'Northfold Records', upc: '0123456789012', date: '2026-06-12T00:00:00', type: 'single', total: 4, spotify: SP('A'), artists: ['a1'] });
		album('al2', { title: 'Night Swim', label: 'Northfold Records', date: '2025', artists: ['a2'] });
		album('al3', { title: 'Far Shore', label: 'Elsewhere Music', date: '2024-02-02', spotify: SP('F'), artists: ['a3'] });
		const t1 = track({ album: 'al1', title: 'Low Tide', isrc: 'GB-NFR-26-00001', spotify: SP('C'), artists: ['a1'], remixers: ['a3'], bpm: 122, key: '8A' });
		const t2 = track({ album: 'al1', title: 'Undertow', isrc: 'GBNFR2600002', artists: ['a1'], bpm: 124, key: '9A' });
		track({ album: 'al2', title: 'Night Swim', isrc: 'GBNFR2500009', artists: ['a2'] });
		track({ album: 'al3', title: 'Far Shore', spotify: SP('G'), artists: ['a3'] });
		// Not the collection: streaming-only, deleted.
		track({ album: 'al3', title: 'Streamed', membership: 'streaming', artists: ['a3'] });
		track({ album: 'al1', title: 'Deleted', deleted: true, artists: ['a1'] });

		const { labels, releases } = libraryClaims(db);
		expect(labels.map((l) => [l.name, l.tracks, l.claim.providerId])).toEqual([
			['Northfold Records', 3, 'name:northfold records'],
			['Elsewhere Music', 1, 'name:elsewhere music'],
		]);
		// Label-major, the biggest first; within a label, newest first.
		expect(releases.map((r) => r.claim.name)).toEqual(['Low Tide EP', 'Night Swim', 'Far Shore']);
		for (const r of [...labels.map((l) => l.claim), ...releases.map((x) => x.claim)]) expect(ZCatalogClaim.safeParse(r).success).toBe(true);

		const ep = releases[0]!;
		expect(ep).toMatchObject({ albumId: 'al1', trackIds: [t1, t2], labelFold: 'northfold records' });
		// Spotify's album: keyed by its id, only the album row's facts.
		expect(ep.claim).toMatchObject({
			provider: 'spotify',
			providerId: SP('A'),
			identifiers: [{ namespace: 'upc', value: '0123456789012' }],
			facts: { releaseDate: '2026-06-12', releaseType: 'single', trackCount: 4, labelText: 'Northfold Records' },
			artists: [{ provider: 'spotify', providerId: SP('B'), name: 'Glass Rivers' }],
			label: { provider: 'user', kind: 'label', providerId: 'name:northfold records' },
		});
		// The tracks: a Spotify-keyed one without the library's own BPM/key; a
		// user-keyed one by its recording, with them. Remixers stay off the credits.
		expect(ep.claim.recordings).toEqual([
			{ provider: 'spotify', kind: 'recording', providerId: SP('C'), url: `https://open.spotify.com/track/${SP('C')}`, name: 'Low Tide', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600001' }], facts: { durationSec: 301, trackNumber: 1, discNumber: 1 }, artists: [{ provider: 'spotify', kind: 'artist', providerId: SP('B'), name: 'Glass Rivers', url: `https://open.spotify.com/artist/${SP('B')}` }] },
			{ provider: 'user', kind: 'recording', providerId: `recording:rec-${t2}`, name: 'Undertow', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600002' }], facts: { durationSec: 301, trackNumber: 2, discNumber: 1, bpm: 124, key: '9A' }, artists: [{ provider: 'spotify', kind: 'artist', providerId: SP('B'), name: 'Glass Rivers', url: `https://open.spotify.com/artist/${SP('B')}` }] },
		]);
		// No Spotify album: the library's own key; an artist without a Spotify id scoped to this library, never a bare name.
		expect(releases[1]!.claim).toMatchObject({ provider: 'user', providerId: 'album:al2', facts: { releaseDate: '2025', labelText: 'Northfold Records' }, artists: [{ provider: 'user', providerId: 'local:a2', name: 'Kaske' }] });
	});

	it("keeps a distributor as text, sends a track with no album as its own release, and never states a file's tag as Spotify's", () => {
		artist('a1', 'Glass Rivers', SP('B'));
		album('al1', { title: 'Self Made', label: '1461444 Records DK', spotify: SP('A'), date: '2026-01-01', artists: ['a1'] });
		// The album row has no label; the file's tag names one.
		album('al2', { title: 'Tagged', spotify: SP('D'), date: '2025-05-05', artists: ['a1'] });
		track({ album: 'al1', title: 'Self Made', artists: ['a1'] });
		track({ album: 'al2', title: 'Tagged', label: 'Northfold Records', artists: ['a1'] });
		track({ title: 'Loose Track', label: 'Northfold Records', date: '2024-09-09', isrc: 'not an isrc', artists: ['a1'] });

		const { labels, releases } = libraryClaims(db);
		expect(labels.map((l) => l.name)).toEqual(['Northfold Records']);
		const byName = new Map(releases.map((r) => [r.claim.name, r]));
		// The distributor: text from Spotify's album, no label object.
		expect(byName.get('Self Made')!.claim.label).toBeUndefined();
		expect(byName.get('Self Made')!.claim.facts?.labelText).toBe('1461444 Records DK');
		// The tag names the label (the label edge), but not Spotify's label text.
		expect(byName.get('Tagged')!.claim).toMatchObject({ provider: 'spotify', label: { providerId: 'name:northfold records' } });
		expect(byName.get('Tagged')!.claim.facts?.labelText).toBeUndefined();
		// A track with no album: a one-track release of the library's own, its tag as label text; a malformed ISRC dropped.
		const loose = releases.find((r) => r.albumId === null)!;
		expect(loose.claim).toMatchObject({ provider: 'user', providerId: expect.stringMatching(/^track:t\d+$/), name: 'Loose Track (single)', facts: { releaseDate: '2024-09-09', releaseType: 'single', trackCount: 1, labelText: 'Northfold Records' } });
		expect(loose.claim.recordings![0]!.identifiers).toEqual([]);
		for (const r of releases) expect(ZCatalogClaim.safeParse(r.claim).success).toBe(true);
	});
});

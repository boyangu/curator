// The owner's library as the back office's filter: the tracks with local files in a generated
// curator.db (a temp folder, never the real one) found in the catalogue by Spotify id, library id
// and ISRC, and what they touch — their releases (and the albums the import mapped), labels and
// artists — while a streaming-only track and the rest of the catalogue stay out. Made-up names.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { browseList, browseObject } from './browse.js';
import { ingestClaims, linkReleasesToLabel } from './ingest.js';
import { loadLocalLibrary } from './local-library.js';

// node:sqlite by require: Vite (vitest) does not know it as a builtin yet and fails to resolve the import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof Sqlite;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SP = (c: string) => c.repeat(22);
const artist = (name: string) => ({ provider: 'spotify' as const, kind: 'artist' as const, providerId: SP(name[0]!.toUpperCase()), name });
const release = (id: string, title: string, by: string, tracks: { id: string; name: string; isrc?: string; provider?: 'spotify' | 'user' }[]) => ({
	provider: 'spotify' as const,
	kind: 'release' as const,
	providerId: id,
	name: title,
	artists: [artist(by)],
	recordings: tracks.map((t) => ({ provider: t.provider ?? ('spotify' as const), kind: 'recording' as const, providerId: t.id, name: t.name, identifiers: t.isrc ? [{ namespace: 'isrc' as const, value: t.isrc }] : [], artists: [artist(by)] })),
});

function curatorDb(rows: { id: string; membership: string; isrc?: string; recording_id?: string; album_id?: string; spotify?: string }[], refs: { album: string; object: string }[]): string {
	const dir = mkdtempSync(join(tmpdir(), 'curator-library-'));
	dirs.push(dir);
	const path = join(dir, 'curator.db');
	const db = new DatabaseSync(path);
	db.exec(`create table track (id text primary key, membership text, deleted_at integer, isrc text, recording_id text, album_id text);
		create table source_link (track_id text, source text, source_track_id text, fetched_at integer);
		create table catalog_ref (entity_kind text, entity_id text, object_id text, object_kind text, provider text, provider_id text, resolved_at integer)`);
	for (const r of rows) {
		db.prepare(`insert into track (id, membership, isrc, recording_id, album_id) values (?, ?, ?, ?, ?)`).run(r.id, r.membership, r.isrc ?? null, r.recording_id ?? null, r.album_id ?? null);
		if (r.spotify) db.prepare(`insert into source_link values (?, 'spotify', ?, 1)`).run(r.id, r.spotify);
	}
	for (const r of refs) db.prepare(`insert into catalog_ref values ('album', ?, ?, 'release', 'spotify', 'x', 1)`).run(r.album, r.object);
	db.close();
	return path;
}

describe('local library', () => {
	it('filters the lists to what the local files are and what they touch', async () => {
		const app = await createTestApp();
		const ids = await withSystemTx(app.db, async (tx) => {
			const [northfold, elsewhere] = (await ingestClaims(tx, [{ provider: 'user', kind: 'label', providerId: 'name:northfold', name: 'Northfold' }, { provider: 'user', kind: 'label', providerId: 'name:elsewhere', name: 'Elsewhere' }], { reason: 'library_import' })).outcomes;
			const claims = [
				// Found by Spotify id, by ISRC, and by the library's own id.
				release(SP('a'), 'Low Tide EP', 'Ivo Lark', [{ id: SP('b'), name: 'Low Tide' }, { id: SP('c'), name: 'Undertow', isrc: 'GBNFR2600002' }, { id: SP('h'), name: 'Breakwater' }]),
				release(SP('d'), 'Glass Rivers', 'Tamsin Ode', [{ id: 'recording:r9', name: 'Glass Rivers', provider: 'user' }]),
				// Only streamed, and an album the import mapped with no file of its own matched.
				release(SP('e'), 'Drift', 'Pell Ward', [{ id: SP('f'), name: 'Drift' }]),
				release(SP('g'), 'Mapped Album', 'Ivo Lark', []),
				// On the label, nothing of it owned.
				release(SP('i'), 'Unowned EP', 'Ivo Lark', [{ id: SP('j'), name: 'Shoreline' }]),
			];
			const out = await ingestClaims(tx, claims, { reason: 'tracker' });
			await linkReleasesToLabel(tx, northfold!.objectId, [0, 1, 4].map((i) => ({ objectId: out.outcomes[i]!.objectId, claim: claims[i]! })));
			await linkReleasesToLabel(tx, elsewhere!.objectId, [{ objectId: out.outcomes[2]!.objectId, claim: claims[2]! }]);
			return { releases: out.outcomes.map((o) => o.objectId), northfold: northfold!.objectId };
		});
		const path = curatorDb(
			[
				{ id: 't1', membership: 'local', spotify: SP('b'), album_id: 'al1' },
				{ id: 't2', membership: 'local', isrc: 'gb-nfr-26-00002' },
				{ id: 't3', membership: 'local', recording_id: 'r9' },
				{ id: 't4', membership: 'streaming', spotify: SP('f') },
			],
			[{ album: 'al1', object: ids.releases[3]! }],
		);
		const lib = await loadLocalLibrary(app.db, path);
		expect(lib.tracks).toBe(3);
		expect(lib.objects).toEqual({ recording: 3, release: 3, label: 1, artist: 2 });

		const names = async (kind: 'label' | 'artist' | 'recording', library: boolean) => (await withSystemTx(app.db, (tx) => browseList(tx, { kind, library }))).rows.map((r) => r.name);
		expect(await names('recording', true)).toEqual(['Glass Rivers', 'Low Tide', 'Undertow']);
		expect(await names('label', true)).toEqual(['Northfold']);
		expect(await names('artist', true)).toEqual(['Ivo Lark', 'Tamsin Ode']);
		// Off: the whole catalogue.
		expect(await names('label', false)).toEqual(['Elsewhere', 'Northfold']);

		// The counters follow: a label's releases, an artist's releases and tracks, a release's tracks.
		const row = async (kind: 'label' | 'artist', name: string, library: boolean) => (await withSystemTx(app.db, (tx) => browseList(tx, { kind, q: name, library }))).rows[0] as unknown as Record<string, number>;
		expect([(await row('label', 'Northfold', false)).releases, (await row('label', 'Northfold', true)).releases]).toEqual([3, 2]);
		expect(await row('artist', 'Ivo Lark', true)).toMatchObject({ releases: 2, tracks: 2 });
		expect(await row('artist', 'Ivo Lark', false)).toMatchObject({ releases: 3, tracks: 4 });
		const label = async (library: boolean) => (await withSystemTx(app.db, (tx) => browseObject(tx, ids.northfold, { library })))!;
		const mine = await label(true);
		expect(mine.releaseCount).toBe(2);
		expect(mine.releases!.map((r) => [r.title, r.tracks])).toEqual([['Glass Rivers', 1], ['Low Tide EP', 2]]);
		expect(mine.artists!.map((a) => [a.name, a.releases])).toEqual([['Ivo Lark', 1], ['Tamsin Ode', 1]]);
		const all = await label(false);
		expect(all.releases!.map((r) => [r.title, r.tracks]).sort()).toEqual([['Glass Rivers', 1], ['Low Tide EP', 3], ['Unowned EP', 1]]);

		// Reloaded after the library changed: rebuilt, not added to.
		const smaller = curatorDb([{ id: 't3', membership: 'local', recording_id: 'r9' }], []);
		expect((await loadLocalLibrary(app.db, smaller)).objects).toEqual({ recording: 1, release: 1, label: 1, artist: 1 });
	});

	it('counts a label’s unique tracks, sorts by them, and drops a label with none of the owner’s', async () => {
		const app = await createTestApp();
		const ids = await withSystemTx(app.db, async (tx) => {
			const labels = (await ingestClaims(tx, ['Northfold', 'Paper Label', 'Elsewhere'].map((name) => ({ provider: 'user' as const, kind: 'label' as const, providerId: `name:${name.toLowerCase()}`, name })), { reason: 'library_import' })).outcomes.map((o) => o.objectId);
			const claims = [
				// One track on the single and again on the EP: one track.
				release(SP('a'), 'Low Tide', 'Ivo Lark', [{ id: SP('b'), name: 'Low Tide' }]),
				release(SP('c'), 'Low Tide EP', 'Ivo Lark', [{ id: SP('b'), name: 'Low Tide' }, { id: SP('d'), name: 'Undertow' }]),
				release(SP('e'), 'Later Album', 'Ivo Lark', [{ id: SP('f'), name: 'Shoreline' }]),
				// Mapped from an album of the library's, but no file of it matched.
				release(SP('g'), 'Mapped Album', 'Tamsin Ode', []),
				release(SP('h'), 'Drift', 'Pell Ward', [{ id: SP('i'), name: 'Drift' }]),
			];
			const out = (await ingestClaims(tx, claims, { reason: 'tracker' })).outcomes.map((o) => o.objectId);
			await linkReleasesToLabel(tx, labels[0]!, [0, 1, 2].map((i) => ({ objectId: out[i]!, claim: claims[i]! })));
			await linkReleasesToLabel(tx, labels[1]!, [{ objectId: out[3]!, claim: claims[3]! }]);
			await linkReleasesToLabel(tx, labels[2]!, [{ objectId: out[4]!, claim: claims[4]! }]);
			return { mapped: out[3]! };
		});
		await loadLocalLibrary(app.db, curatorDb([{ id: 't1', membership: 'local', spotify: SP('b') }, { id: 't2', membership: 'local', spotify: SP('d'), album_id: 'al9' }], [{ album: 'al9', object: ids.mapped }]));
		const page = (library: boolean, sort?: 'tracks' | 'fewest_tracks') => withSystemTx(app.db, (tx) => browseList(tx, { kind: 'label', library, sort }));
		const counts = async (library: boolean, sort?: 'tracks' | 'fewest_tracks') => (await page(library, sort)).rows.map((r) => [r.name, r.tracks]);
		expect(await counts(false)).toEqual([['Elsewhere', 1], ['Northfold', 3], ['Paper Label', 0]]);
		expect(await counts(false, 'tracks')).toEqual([['Northfold', 3], ['Elsewhere', 1], ['Paper Label', 0]]);
		expect(await counts(false, 'fewest_tracks')).toEqual([['Paper Label', 0], ['Elsewhere', 1], ['Northfold', 3]]);
		// The library's: only its two tracks counted, and Paper Label — in it by
		// the mapped album alone — gone, from the rows and from the total.
		expect(await counts(true)).toEqual([['Northfold', 2]]);
		expect((await page(true, 'tracks')).total).toBe(1);
	});
});

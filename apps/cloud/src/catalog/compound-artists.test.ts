// Artists named like several (made-up names), each told apart by what stands
// beside the name: a real artist a credit line renamed, Apple's id under a
// credit line, a store's page for a credit, a packed credit a reader kept
// whole, a duo, and a name nothing settles. Nothing is written.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { classifyCompound, compoundArtists, decideCompound, splitInto, type CompoundRow } from './compound-artists.js';
import { ingestClaims } from './ingest.js';
import { lookUpNames } from './name-lookup.js';
import { AppleLookup } from './trackers/apple.js';

const artist = (provider: CatalogClaim['provider'], providerId: string, name: string): CatalogClaim => ({ provider, kind: 'artist', providerId, name });
const sp = (name: string) => artist('spotify', `sp-${name}`, name);
const user = (name: string) => artist('user', `name:${name.toLowerCase()}`, name);
const isrc = (n: number) => [{ namespace: 'isrc' as const, value: `DEUD9260000${n}` }];
const rec = (provider: CatalogClaim['provider'], id: string, name: string, n: number, artists: CatalogClaim[]): CatalogClaim => ({ provider, kind: 'recording', providerId: id, name, identifiers: isrc(n), facts: { durationSec: 300 }, artists });
const release = (provider: CatalogClaim['provider'], id: string, name: string, artists: CatalogClaim[], recordings: CatalogClaim[]): CatalogClaim => ({ provider, kind: 'release', providerId: id, name, facts: { releaseDate: '2026-05-08' }, artists, recordings });

// Apple's lookup, answering with its own name for each id asked about.
const APPLE_NAMES: Record<string, string> = { '555': 'Ilka Rane', '777': 'Lowtide' };
const apple = new AppleLookup(async (url) => {
	const ids = new URL(String(url)).searchParams.get('id')?.split(',') ?? [];
	return new Response(JSON.stringify({ results: ids.filter((id) => APPLE_NAMES[id]).map((id) => ({ wrapperType: 'artist', artistId: Number(id), artistName: APPLE_NAMES[id] })) }), { headers: { 'content-type': 'application/json' } });
});

async function seed() {
	const app = await createTestApp();
	const ingest = (claims: CatalogClaim[]) => withSystemTx(app.db, (tx) => ingestClaims(tx, claims, { reason: 'library_import' }));
	await ingest([
		release('spotify', 'al-1', 'Tidal Lines', [sp('Glass Rivers'), sp('Kaske')], [
			rec('spotify', 'tr-1', 'Tidal Lines', 1, [sp('Glass Rivers'), sp('Kaske')]),
			rec('spotify', 'tr-2', 'Halflight', 2, [sp('North & Vale')]),
			rec('spotify', 'tr-3', 'Undertow', 3, [sp('Ilka Rane')]),
			rec('spotify', 'tr-4', 'Slack Water', 4, [sp('&Or')]),
		]),
		// Two artists with Spotify pages of their own, on no track together.
		release('spotify', 'al-2', 'Neap Tide', [sp('Paper Mill')], [rec('spotify', 'tr-20', 'Neap Tide', 20, [sp('Paper Mill')]), rec('spotify', 'tr-21', 'Flood', 21, [sp('Quiet Harbour')])]),
		// Deezer's page for the credit, on the track Spotify credits to the two.
		release('deezer', 'dz-al-1', 'Tidal Lines', [artist('deezer', '900', 'Glass Rivers & Kaske')], [rec('deezer', 'dz-1', 'Tidal Lines', 1, [artist('deezer', '900', 'Glass Rivers & Kaske')])]),
		// Apple's id for Ilka Rane, first under one song's credit line…
		release('apple', 'ap-al-1', 'Tidal Lines', [artist('apple', '555', 'Ilka Rane & Lowtide')], [rec('apple', 'ap-3', 'Undertow', 3, [artist('apple', '555', 'Ilka Rane & Lowtide')])]),
		// A store's own page for Quiet Harbour.
		release('tidal', 'td-al-1', 'Longshore', [artist('tidal', '950', 'Quiet Harbour')], [rec('tidal', 'td-10', 'Longshore', 10, [artist('tidal', '950', 'Quiet Harbour')])]),
	]);
	await ingest([
		// …then under another's: an Apple line renames nothing (ingest.ts
		// isCreditLine), so the first stays the object's name.
		release('apple', 'ap-al-2', 'Ebb', [artist('apple', '555', 'Ilka Rane & Kaske')], [rec('apple', 'ap-5', 'Ebb', 5, [artist('apple', '555', 'Ilka Rane & Kaske')])]),
		// A claim naming Quiet Harbour's id with a credit line renames the artist.
		release('tidal', 'td-al-2', 'Rip Current', [artist('tidal', '950', 'Quiet Harbour & Kaske')], [rec('tidal', 'td-11', 'Rip Current', 11, [artist('tidal', '950', 'Quiet Harbour & Kaske')])]),
		// An id known only under a credit line.
		release('apple', 'ap-al-3', 'Neap', [artist('apple', '777', 'Lowtide & Glass Rivers')], [rec('apple', 'ap-6', 'Neap', 6, [artist('apple', '777', 'Lowtide & Glass Rivers')])]),
		// A reader's copies: the duo by name only, a packed credit kept whole.
		release('soundcloud', 'set:1', 'Spring Tide', [user('North & Vale')], [rec('soundcloud', '901', 'Spring Tide', 7, [user('North & Vale')]), rec('soundcloud', '902', 'Backwash', 8, [user('Paper Mill, Quiet Harbour')])]),
		// A Deezer page no store splits; the old splitter's "Sun" and "Moon",
		// known by name alone, stand beside it and say nothing.
		release('deezer', 'dz-al-2', 'Swell', [artist('deezer', '901', 'Sun & Moon')], [rec('deezer', 'dz-9', 'Swell', 9, [artist('deezer', '901', 'Sun & Moon')])]),
		release('soundcloud', 'set:2', 'Swell', [user('Sun'), user('Moon')], [rec('soundcloud', '903', 'Swell', 9, [user('Sun'), user('Moon')])]),
	]);
	return app;
}

describe('compound artists', () => {
	it('sorts each "A & B" name by the evidence beside it, and reads the catalogue page by page', async () => {
		const app = await seed();
		const all: CompoundRow[] = [];
		let after: string | null = null;
		let pages = 0;
		for (;;) {
			const r = await compoundArtists(app.db, { after, limit: 2, appleNames: (ids) => apple.artistNames(ids) });
			all.push(...r.rows);
			pages++;
			if (!r.next) break;
			after = r.next;
		}
		expect(pages).toBeGreaterThan(1);
		const by = (name: string) => all.filter((r) => r.name === name).map((r) => [r.class, r.decision, r.into ?? r.to ?? null]);
		// "&Or" lists nobody: not a candidate.
		expect(all.some((r) => r.name === '&Or')).toBe(false);
		expect(by('Quiet Harbour & Kaske')).toEqual([['renamed', 'rename', 'Quiet Harbour']]);
		// Apple names the id, not the line its page was stored under.
		expect(by('Ilka Rane & Lowtide')).toEqual([['apple_line', 'rename', 'Ilka Rane']]);
		expect(by('Lowtide & Glass Rivers')).toEqual([['apple_line', 'rename', 'Lowtide']]);
		// The line's other names are told, not credited: the id was one artist's.
		expect(all.find((r) => r.name === 'Lowtide & Glass Rivers')).toMatchObject({ also: ['Glass Rivers'] });
		expect(all.find((r) => r.name === 'Lowtide & Glass Rivers')!.into).toBeUndefined();
		expect(by('Glass Rivers & Kaske')).toEqual([['alias', 'split', ['Glass Rivers', 'Kaske']]]);
		// Neither a comma nor an "&" decides by itself.
		expect(by('Paper Mill, Quiet Harbour')).toEqual([['packed', 'ask', null]]);
		expect(by('Sun & Moon')).toEqual([['unsure', 'ask', null]]);
		// The store's duo, and the reader's copy of it known by name only.
		expect(by('North & Vale').map(([c, d]) => [c, d])).toEqual([['act', 'keep'], ['act', 'keep']]);
		expect(all).toHaveLength(8);
	});

	it('leaves an Apple-only name unresolved until Apple is asked, through the admin op', async () => {
		const app = await seed();
		const find = (rows: CompoundRow[]) => rows.find((r) => r.name === 'Lowtide & Glass Rivers')!;
		const quiet = await adminOps(app.db, {}).compoundArtists({});
		expect(find(quiet.rows)).toMatchObject({ class: 'apple_line', decision: 'ask' });
		expect(find(quiet.rows).to).toBeUndefined();
		expect(quiet.appleAsked).toBe(0);
		const asked = await adminOps(app.db, { apple }).compoundArtists({ lookup: true });
		expect(find(asked.rows)).toMatchObject({ class: 'apple_line', decision: 'rename', to: 'Lowtide', credits: { tracks: 1, releases: 1 } });
		expect(asked.appleAsked).toBe(2);
		expect(asked.next).toBeNull();
	});

	it('renames back what a reviewed list says, only while the name is still the one read, each with its undo', async () => {
		const app = await seed();
		const ops = adminOps(app.db, { apple });
		const rows = (await ops.compoundArtists({ lookup: true })).rows.filter((r) => r.decision === 'rename');
		expect(rows.map((r) => [r.name, r.to]).sort()).toEqual([['Ilka Rane & Lowtide', 'Ilka Rane'], ['Lowtide & Glass Rivers', 'Lowtide'], ['Quiet Harbour & Kaske', 'Quiet Harbour']]);
		const renames = rows.map((r) => ({ id: r.id, from: r.name, to: r.to!, why: r.why }));
		await expect(ops.compoundRename({ renames, approved: false })).rejects.toThrow(/approved/);
		// A claim since renamed one: it is left as it is now.
		const quiet = rows.find((r) => r.name === 'Quiet Harbour & Kaske')!;
		await app.db.query(`update curator.catalog_object set name = 'Quiet Harbour (live)' where id = $1`, [quiet.id]);
		const r = await ops.compoundRename({ renames, approved: true, by: 'test' });
		expect(r.renamed.map((x) => x.to).sort()).toEqual(['Ilka Rane', 'Lowtide']);
		expect(r.skipped).toEqual([{ id: quiet.id, name: 'Quiet Harbour (live)', why: 'renamed since the scan' }]);
		const now = await app.db.query<{ name: string; name_fold: string }>(`select name, name_fold from curator.catalog_object where id = $1`, [rows.find((x) => x.to === 'Ilka Rane')!.id]);
		expect(now[0]).toEqual({ name: 'Ilka Rane', name_fold: 'ilka rane' });
		const items = await app.db.query<{ kind: string; status: string; undo: { op: string; args: { name: string } } }>(`select kind, status, undo from curator.catalog_inbox where kind = 'artist.rename' order by id`);
		expect(items).toHaveLength(2);
		expect(items.every((i) => i.status === 'logged' && i.undo.op === 'rename')).toBe(true);
		expect(items.map((i) => i.undo.args.name).sort()).toEqual(['Ilka Rane & Lowtide', 'Lowtide & Glass Rivers']);
		// Run again: nothing left to do.
		expect((await ops.compoundRename({ renames, approved: true })).renamed).toEqual([]);
	});

	it('asks for the whole name before its pieces decide', async () => {
		const page = (provider: string, name: string) => ({ provider, providerId: '1', name, weak: false });
		const base = { name: 'Sun & Moon', pages: [page('deezer', 'Sun & Moon')], tracks: { all: 0, some: 0 }, releases: { all: 0, some: 0 }, actTwin: false, credited: 3 };
		// Both names are Spotify artists of their own: so are a real duo's.
		expect(classifyCompound({ ...base, tokens: [3, 3] })).toMatchObject({ class: 'unsure' });
		expect(classifyCompound({ ...base, tokens: [3, 3], asked: { musicbrainz: null } })).toMatchObject({ class: 'unsure' });
		// Spotify holds no artist of the whole name: a credit, split.
		expect(classifyCompound({ ...base, tokens: [3, 3], asked: { spotify: null } })).toMatchObject({ class: 'tokens' });
		// A name in it no store knows as an artist: not settled by that.
		expect(classifyCompound({ ...base, tokens: [3, 2], asked: { spotify: null } })).toMatchObject({ class: 'unsure' });
		// The whole name is an artist outside: one act, whatever its pieces are.
		expect(classifyCompound({ ...base, tokens: [3, 3], asked: { spotify: { id: 's', name: 'Sun & Moon', followers: 9000 } } })).toMatchObject({ class: 'act' });
		expect(classifyCompound({ ...base, tokens: [3, 3], asked: { musicbrainz: { id: 'm', name: 'Sun & Moon', type: 'Group' }, spotify: null } })).toMatchObject({ class: 'act' });
		expect(classifyCompound({ ...base, tokens: [3, 3], asked: { musicbrainz: { id: 'm', name: 'Sun & Moon', type: 'Person' }, spotify: null } })).toMatchObject({ class: 'tokens' });

		// Through the catalogue: the answers kept by the lookups are read back.
		const app = await seed();
		const find = async (name: string) => (await compoundArtists(app.db)).rows.find((r) => r.name === name)!;
		expect(await find('Paper Mill, Quiet Harbour')).toMatchObject({ class: 'packed', decision: 'ask', tokens: [3, 3], asked: [] });
		const none: import('@curator/catalog-readers').SpotifyReader = { get: async <T>() => ({ artists: { items: [] } }) as T };
		await lookUpNames(app.db, { spotify: none }, { names: ['Paper Mill, Quiet Harbour'], source: 'spotify' });
		expect(await find('Paper Mill, Quiet Harbour')).toMatchObject({ class: 'tokens', decision: 'split', into: ['Paper Mill', 'Quiet Harbour'], asked: ['spotify'] });
		const group = async () => new Response(JSON.stringify({ artists: [{ id: 'mb-7', name: 'Sun & Moon', type: 'Group' }] }), { headers: { 'content-type': 'application/json' } });
		await lookUpNames(app.db, { fetch: group }, { names: ['Sun & Moon'], source: 'musicbrainz' });
		expect(await find('Sun & Moon')).toMatchObject({ class: 'act', decision: 'keep', asked: ['musicbrainz'], why: 'MusicBrainz lists it as a group' });
	});

	it('does not take a stray store page for an act', () => {
		const page = (provider: string, name: string) => ({ provider, providerId: '1', name, weak: false });
		// Spotify's own artist "Kaske vs. Lowtide": one track, both names artists
		// of their own.
		const stray = { name: 'Kaske vs. Lowtide', pages: [page('spotify', 'Kaske vs. Lowtide')], tracks: { all: 0, some: 0 }, releases: { all: 0, some: 0 }, actTwin: false, tokens: [3, 3], credited: 1 };
		expect(classifyCompound(stray)).toMatchObject({ class: 'unsure' });
		expect(classifyCompound({ ...stray, asked: { musicbrainz: null } })).toMatchObject({ class: 'unsure' });
		// Its two artists credited beside it do not split it by rule either.
		expect(classifyCompound({ ...stray, tracks: { all: 1, some: 0 }, asked: { musicbrainz: null } })).toMatchObject({ class: 'unsure' });
		// An act all the same: MusicBrainz lists it, the catalogue holds much of
		// it, a name in it is nobody's, or Spotify (asked) counts its followers.
		expect(classifyCompound({ ...stray, asked: { musicbrainz: { id: 'm', name: 'Kaske vs. Lowtide', type: 'Group' } } })).toMatchObject({ class: 'act' });
		expect(classifyCompound({ ...stray, credited: 40 })).toMatchObject({ class: 'act' });
		expect(classifyCompound({ ...stray, tokens: [3, 0] })).toMatchObject({ class: 'act' });
		expect(classifyCompound({ ...stray, pages: [page('deezer', 'Kaske vs. Lowtide')], asked: { spotify: { id: 's', name: 'Kaske vs. Lowtide', followers: 12 } } })).toMatchObject({ class: 'unsure' });
		expect(classifyCompound({ ...stray, pages: [page('deezer', 'Kaske vs. Lowtide')], asked: { spotify: { id: 's', name: 'Kaske vs. Lowtide', followers: 48000 } } })).toMatchObject({ class: 'act' });
	});

	it('keeps a known leading act whole when a name is split', () => {
		expect(splitInto('North & Vale & Kaske', 'North & Vale')).toEqual(['North & Vale', 'Kaske']);
		expect(splitInto('Lowtide, Kaske & Ilka Rane', 'Lowtide')).toEqual(['Lowtide', 'Kaske', 'Ilka Rane']);
		expect(splitInto('Lowtide, Kaske', 'Lowtide')).toEqual(['Lowtide', 'Kaske']);
		// A lead that only begins the first word, or reads otherwise (another
		// script), leads nothing: the pieces as written.
		expect(splitInto('Lowtide & Kaske', 'Low')).toEqual(['Lowtide', 'Kaske']);
		expect(splitInto('Lowtide & Kaske', 'לוטייד')).toEqual(['Lowtide', 'Kaske']);
	});

	it('lets the stores decide, and does not when they disagree', () => {
		const page = (provider: string, name: string) => ({ provider, providerId: '1', name, weak: false });
		const none = { tracks: { all: 0, some: 0 }, releases: { all: 0, some: 0 }, actTwin: false, tokens: [] as number[], credited: 0 };
		// A duo's Spotify page outweighs its two members credited beside it,
		// and an Apple page reading a longer credit line.
		expect(classifyCompound({ ...none, name: 'North & Vale', pages: [page('spotify', 'North & Vale')], tracks: { all: 2, some: 0 } }).class).toBe('act');
		expect(classifyCompound({ ...none, name: 'North & Vale', pages: [page('spotify', 'North & Vale'), page('apple', 'North & Vale & Kaske')] }).class).toBe('act');
		// An Apple page stored under another song's credit line is still only
		// Apple's: the id is asked about, not renamed to that line.
		expect(classifyCompound({ ...none, name: 'Sun, Kaske & Moon', pages: [page('apple', 'Sun & Lowtide')] })).toMatchObject({ class: 'apple_line' });
		expect(classifyCompound({ ...none, name: 'Sun, Kaske & Moon', pages: [page('apple', 'Sun & Lowtide')], appleName: 'Sun' })).toMatchObject({ class: 'apple_line', to: 'Sun' });
		// One store calls the object by one name, another by the compound.
		expect(classifyCompound({ ...none, name: 'Sun & Moon', pages: [page('spotify', 'Sun'), page('deezer', 'Sun & Moon')] }).class).toBe('unsure');
		// Apple itself holds a page of the compound name: no longer a reader's line.
		expect(classifyCompound({ ...none, name: 'Sun & Moon', pages: [page('apple', 'Sun & Moon')], appleName: 'Sun & Moon' }).class).toBe('unsure');
		// Members beside it on a release only, never on one track.
		expect(classifyCompound({ ...none, name: 'Sun & Moon', pages: [page('deezer', 'Sun & Moon')], releases: { all: 1, some: 0 } }).class).toBe('unsure');
	});

	it('renames only to a name the line lists: another is someone else’s page, and a question', () => {
		// The line's lead, written with its dots, keeps them; the others are told.
		expect(decideCompound('S.E.T., Paper Mill & Kaske', { class: 'apple_line', to: 'S.E.T.' })).toEqual({ decision: 'rename', also: ['Paper Mill', 'Kaske'] });
		expect(decideCompound('Lowtide & Glass Rivers', { class: 'renamed', to: 'Glass Rivers' })).toEqual({ decision: 'rename', also: ['Lowtide'] });
		// A Bandcamp account that is a label's, Apple's name in another script.
		expect(decideCompound('Paper Mill & Kaske', { class: 'renamed', to: 'Harbour Recordings' })).toMatchObject({ decision: 'ask', held: expect.stringContaining('Harbour Recordings') });
		expect(decideCompound('Lowtide & Kaske', { class: 'apple_line', to: 'לואוטייד' })).toMatchObject({ decision: 'ask' });
	});
});

describe('a credit line from Apple', () => {
	const names = async (app: Awaited<ReturnType<typeof createTestApp>>, provider: string, id: string) =>
		(await app.db.query<{ name: string }>(`select o.name from curator.catalog_object o join curator.catalog_source_object s on s.object_id = o.id where s.provider = $1 and s.provider_id = $2`, [provider, id]))[0]?.name;

	it('names a new artist but renames none: a real store still renames its own', async () => {
		const app = await createTestApp();
		const ingest = (claims: CatalogClaim[]) => withSystemTx(app.db, (tx) => ingestClaims(tx, claims, { reason: 'library_import' }));
		await ingest([artist('apple', '901', 'Ilka Rane')]);
		await ingest([artist('apple', '901', 'Ilka Rane, Lowtide & Sokko')]);
		expect(await names(app, 'apple', '901')).toBe('Ilka Rane');
		// Apple alone, first seen under a line: the line it is, until a store says otherwise.
		await ingest([artist('apple', '902', 'Marsh & Northfold')]);
		expect(await names(app, 'apple', '902')).toBe('Marsh & Northfold');
		await ingest([sp('Northfold')]);
		await ingest([artist('spotify', 'sp-Northfold', 'Northfold Collective')]);
		expect(await names(app, 'spotify', 'sp-Northfold')).toBe('Northfold Collective');
	});
});

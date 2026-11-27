// Artist and label pages on the phone: the header and the World list from the
// Global Catalog, laid out by the code the desktop's pages use
// (@curator/sync-core/entity/catalog-page). The phone's My Library side is
// Kotlin's own query over the library (data/ListQuery.kt), from the owned
// filter this hands back.
//
// Who a page is about is found only through ids, never through a name alone
// (namesakes): a catalogue id the surface holds, a catalog_ref row an earlier
// page wrote, an object the surface holds whose credits name it (`within`),
// the library import's `user local:<id>` claim, or a recording of one of the
// artist's own tracks whose credits name it. The phone holds no artist_link
// rows (they stay on the desktop), so it has no Spotify id of an artist; its
// tracks' claims are the way in, as js/track-pictures.ts finds pictures.
// Labels are the exception the library forces: a label IS its folded name.
//
// Read-only on the catalogue, except a follow (catalog.watch / unwatch: the
// account's watch list in the cloud, nothing at Spotify — decided
// 2026-11-26). Writes catalog_ref rows, the phone's own cache.

import type Database from 'better-sqlite3';
import type { CatalogBrowseResult, CloudService } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { searchFold, type EntityChip, type EntityHeader, type EntityKind, type EntityRef, type EntityTracksPage, type EntityWorldReason } from '@curator/shared';
import { applyBrowse, worldPage, worldProbes } from '@curator/sync-core/entity/catalog-page';
import { writeRefs } from '@curator/sync-core/entity/catalog-ref';
import { matchLibraryTracks } from '@curator/sync-core/entity/ownership';

export type EntityCatalog = Pick<CloudService['catalog'], 'resolve' | 'search' | 'browse' | 'tracks' | 'watch' | 'unwatch'>;

export type EntityDeps = {
	raw: Database.Database;
	// Null: no catalogue to ask (signed out, or a server without one), with why.
	catalog: { client: EntityCatalog; deviceId: string; pages: boolean } | { reason: EntityWorldReason };
	now: number;
};

type PageKind = Exclude<EntityKind, 'album'>;
export type PageAsk = { kind: PageKind; name: string; libraryId?: string | null; catalogId?: string | null; within?: { catalogId: string } | null };

// The phone's Owned: a file on some device of the account (its track rows'
// remote_source). Kotlin reads the filter's ids / folds, not this list.
const OWNED_SOURCES = ['local'];
// The artist's own tracks tried for a recording whose credits name it.
const EVIDENCE_TRACKS = 2;

const cachedObject = (raw: Database.Database, kind: PageKind, entityId: string): string | null =>
	(raw.prepare(`select object_id from catalog_ref where entity_kind = ? and entity_id = ?`).get(kind, entityId) as { object_id: string } | undefined)?.object_id ?? null;

const cachedArtist = (raw: Database.Database, objectId: string): string | null =>
	(raw.prepare(`select r.entity_id from catalog_ref r join artist a on a.id = r.entity_id and a.merged_into is null where r.entity_kind = 'artist' and r.object_id = ? limit 1`).get(objectId) as { entity_id: string } | undefined)?.entity_id ?? null;

function remember(raw: Database.Database, kind: PageKind, entityId: string, objectId: string, now: number): void {
	writeRefs(raw, [{ entityKind: kind, entityId, objectKind: kind, objectId, provider: null, providerId: null }], now);
}

// The credit an object names by this name (the one place a name is safe:
// inside an object the surface already holds).
function creditWithin(b: CatalogBrowseResult, kind: PageKind, name: string): string | null {
	const fold = nameFold(name);
	if (!fold) return null;
	const pool = kind === 'artist' ? (b.artists ?? []) : [...(b.labels ?? []), ...(b.releases ?? []).flatMap((r) => r.labels)];
	return pool.find((c) => nameFold(c.name) === fold)?.id ?? null;
}

type Found = { catalogId: string } | { reason: 'unknown' | 'ambiguous'; candidates?: EntityChip[] };

async function identify(d: EntityDeps, c: { client: EntityCatalog; deviceId: string }, ask: PageAsk): Promise<Found> {
	const { raw } = d;
	const { client, deviceId } = c;
	if (ask.catalogId) return { catalogId: ask.catalogId };
	const fold = nameFold(ask.name);
	const cacheKey = ask.kind === 'label' ? fold : (ask.libraryId ?? null);
	const cached = cacheKey ? cachedObject(raw, ask.kind, cacheKey) : null;
	if (cached) return { catalogId: cached };
	const found = (id: string): Found => {
		if (cacheKey) remember(raw, ask.kind, cacheKey, id, d.now);
		return { catalogId: id };
	};
	if (ask.within?.catalogId) {
		const hit = creditWithin(await client.browse({ deviceId, id: ask.within.catalogId, brief: true }), ask.kind, ask.name);
		if (hit) return found(hit);
	}
	if (ask.kind === 'label') {
		if (!fold) return { reason: 'unknown' };
		const [byName] = (await client.resolve({ deviceId, refs: [{ provider: 'user', kind: 'label', providerId: `name:${fold}` }] })).objects;
		if (byName) return found(byName.id);
		// A label no one followed by name: the catalogue's own labels of
		// exactly that fold. One is it; several are namesakes to choose from.
		const same = (await client.search({ deviceId, q: ask.name, kind: 'label', limit: 10 })).objects.filter((o) => nameFold(o.name) === fold);
		if (same.length === 1) return found(same[0]!.id);
		return same.length > 1 ? { reason: 'ambiguous', candidates: same.map((o) => ({ ref: { kind: 'label', name: o.name, catalogId: o.id } })) } : { reason: 'unknown' };
	}
	if (!ask.libraryId) return { reason: 'unknown' };
	// What a desktop's library import registered for the artist; its ids are
	// this phone's too for the artists the replica brought.
	const [imported] = (await client.resolve({ deviceId, refs: [{ provider: 'user', kind: 'artist', providerId: `local:${ask.libraryId}` }] })).objects;
	if (imported) return found(imported.id);
	const spotify = raw
		.prepare(
			`select c.source_track_id as id from track_artist ta
			join track t on t.id = ta.track_id and t.deleted_at is null
			join claim_link c on c.track_id = ta.track_id and c.source = 'spotify'
			where ta.artist_id = ? and ta.role is null
			group by ta.track_id order by min(c.rank) limit ?`,
		)
		.all(ask.libraryId, EVIDENCE_TRACKS) as { id: string }[];
	if (spotify.length === 0) return { reason: 'unknown' };
	const { objects } = await client.resolve({ deviceId, refs: spotify.map((s) => ({ provider: 'spotify' as const, kind: 'recording' as const, providerId: s.id })) });
	for (const rec of objects) {
		if (!rec) continue;
		const hit = creditWithin(await client.browse({ deviceId, id: rec.id, brief: true }), 'artist', ask.name);
		if (hit) return found(hit);
	}
	return { reason: 'unknown' };
}

function baseHeader(ref: EntityRef, world: EntityHeader['world']): EntityHeader {
	return {
		ref,
		imageUrl: null,
		coverTrackId: null,
		facts: {},
		genres: [],
		labels: [],
		artists: [],
		similar: [],
		collabs: [],
		activity: null,
		badges: [],
		reach: null,
		links: [],
		follow: null,
		owned: { count: 0, filter: ownedFilter(ref) },
		world,
	};
}

// What Kotlin lists for My Library: the library artist's tracks, or every
// track whose label folds alike. Its count is Kotlin's to read.
function ownedFilter(ref: EntityRef, extraFolds: string[] = []): EntityHeader['owned']['filter'] {
	if (ref.kind === 'label') {
		const folds = [...new Set([searchFold(ref.name), ...extraFolds].filter(Boolean))];
		return folds.length ? { labelFolds: folds, hasSource: OWNED_SOURCES } : null;
	}
	return ref.libraryId ? { artistIds: [ref.libraryId], hasSource: OWNED_SOURCES } : null;
}

const off = (reason: EntityWorldReason, candidates?: EntityChip[]): EntityHeader['world'] => ({ available: false, reason, releaseCount: null, trackCount: null, ...(candidates ? { candidates } : {}) });

export async function entityPage(d: EntityDeps, ask: PageAsk): Promise<EntityHeader> {
	const ref: EntityRef = { kind: ask.kind, name: ask.name, libraryId: ask.libraryId ?? null, catalogId: ask.catalogId ?? null };
	if (ref.kind === 'artist' && !ref.libraryId && ref.catalogId) ref.libraryId = cachedArtist(d.raw, ref.catalogId);
	if ('reason' in d.catalog) return baseHeader(ref, off(d.catalog.reason));
	const c = d.catalog;
	let found: Found;
	let b: CatalogBrowseResult;
	try {
		found = await identify(d, c, ask);
		if ('reason' in found) {
			const header = baseHeader(ref, off(found.reason, found.candidates));
			// Followable once the catalogue has an object; it has none yet.
			return header;
		}
		b = await c.client.browse({ deviceId: c.deviceId, id: found.catalogId, brief: c.pages });
	} catch (e) {
		console.warn('entity page: the catalogue did not answer', e instanceof Error ? e.message : String(e));
		return baseHeader(ref, off('server_off'));
	}
	ref.catalogId = b.object.id;
	if (ref.kind === 'artist') {
		ref.libraryId ??= cachedArtist(d.raw, b.object.id);
		// The library's spelling where the library has the artist.
		const lib = ref.libraryId ? (d.raw.prepare(`select name from artist where id = ?`).get(ref.libraryId) as { name: string } | undefined) : undefined;
		ref.name = lib?.name ?? b.object.name;
	} else if (!ref.name) ref.name = b.object.name;
	const header = baseHeader(ref, { available: c.pages, reason: c.pages ? 'ok' : 'old_server', releaseCount: b.releaseCount ?? null, trackCount: b.trackCount ?? null });
	// The catalogue's spelling may fold differently from the library's.
	if (ref.kind === 'label') header.owned.filter = ownedFilter(ref, [searchFold(b.object.name)]);
	return applyBrowse(header, b, d.now);
}

export type EntityTracksAnswer = Omit<EntityTracksPage, 'template'> & {
	// An artist page's library artist, found from the page's recordings the
	// library holds (their credits name it), when the header had none.
	libraryId: string | null;
};

export async function entityTracks(d: EntityDeps, ask: { kind: PageKind; catalogId: string; cursor?: string | null; libraryId?: string | null }): Promise<EntityTracksAnswer> {
	if ('reason' in d.catalog) throw new Error(d.catalog.reason);
	const c = d.catalog;
	const result = await c.client.tracks({ deviceId: c.deviceId, id: ask.catalogId, ...(ask.cursor ? { cursor: ask.cursor } : {}) });
	const probes = worldProbes(result);
	const page = worldPage(result, probes, matchLibraryTracks(d.raw, probes));
	let libraryId: string | null = null;
	if (ask.kind === 'artist' && !ask.libraryId) {
		libraryId = artistAmongOwned(d.raw, page, result.object.id);
		if (libraryId) remember(d.raw, 'artist', libraryId, result.object.id, d.now);
	}
	return { ...page, libraryId };
}

// The library artist a catalogue artist is, read off recordings the library
// holds: the library track's own credit spelled like the catalogue credit.
function artistAmongOwned(raw: Database.Database, page: Omit<EntityTracksPage, 'template'>, catalogId: string): string | null {
	const credits = raw.prepare(`select a.id, a.name from track_artist ta join artist a on a.id = ta.artist_id and a.merged_into is null where ta.track_id = ? and ta.role is null`);
	for (const t of page.tracks) {
		if (!t.libraryTrackId) continue;
		const credit = t.artists.find((a) => a.id === catalogId);
		if (!credit) continue;
		const fold = nameFold(credit.name);
		const hit = (credits.all(t.libraryTrackId) as { id: string; name: string }[]).find((a) => nameFold(a.name) === fold);
		if (hit) return hit.id;
	}
	return null;
}

export async function entityFollow(d: EntityDeps, ask: { catalogId: string; follow: boolean }): Promise<{ following: boolean }> {
	if ('reason' in d.catalog) throw new Error(d.catalog.reason);
	const { client, deviceId } = d.catalog;
	if (ask.follow) await client.watch({ deviceId, objectId: ask.catalogId, source: 'manual' });
	else await client.unwatch({ deviceId, objectId: ask.catalogId });
	return { following: ask.follow };
}

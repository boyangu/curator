// Artist and label pages on the phone: the header and the World list from the
// Global Catalog, laid out by the code the desktop's pages use
// (@curator/sync-core/entity/catalog-page). The phone's My Library side is
// Kotlin's own query over the library (data/ListQuery.kt), from the owned
// filter this hands back.
//
// Who a page is about is found by the ladder the desktop's pages use
// (@curator/sync-core/entity/identify): ids first — a catalogue id the
// surface holds, a catalog_ref row an earlier page wrote, the artist's own
// Spotify id (artist_link, derived here from the account's provider
// listings), the library import's `user local:<id>` claim — and a name only
// among one object's own credits. Labels are the exception the library
// forces: a label IS its folded name.
//
// Read-only on the catalogue, except a follow (catalog.watch / unwatch: the
// account's watch list in the cloud, nothing at Spotify — decided
// 2026-11-26). Writes catalog_ref rows, the phone's own cache.

import type Database from 'better-sqlite3';
import type { CatalogBrowseResult, CatalogTracksResult, CloudService } from '@curator/protocol';
import { parseStreamObjectId, streamObjectId, streamPage, type StreamingCatalog } from '@curator/catalog-work';
import { nameFold } from '@curator/library-logic';
import { searchFold, type EntityChip, type EntityHeader, type EntityKind, type EntityRef, type EntityTracksPage, type EntityWorldReason } from '@curator/shared';
import { applyBrowse, GENRES_MAX, mergeLinks, worldPage, worldProbes } from '@curator/sync-core/entity/catalog-page';
import { hintsOf, identifyLocal, identifyRemote, rememberObject, settleIds, type EntityIds, type IdentifyCatalog } from '@curator/sync-core/entity/identify';
import { matchLibraryTracks } from '@curator/sync-core/entity/ownership';
import type { PhoneWork } from './work.js';

export type EntityCatalog = Pick<CloudService['catalog'], 'resolve' | 'search' | 'browse' | 'tracks' | 'watch' | 'unwatch'>;

export type EntityDeps = {
	raw: Database.Database;
	// Null: no catalogue to ask (signed out, or a server without one), with why.
	catalog: { client: EntityCatalog; deviceId: string; pages: boolean } | { reason: EntityWorldReason };
	// The phone's store reading for the page in front (js/work.ts): asked what
	// to say with a page read, and handed the work the answer carried.
	work?: Pick<PhoneWork, 'ready' | 'profile' | 'read' | 'patchOf'>;
	// The account's Spotify read as a catalogue (@curator/catalog-work
	// streaming): an artist the catalogue does not know is shown from there.
	streaming?: StreamingCatalog | null;
	now: number;
};

type PageKind = Exclude<EntityKind, 'album'>;
export type PageAsk = { kind: PageKind; name: string; libraryId?: string | null; catalogId?: string | null; within?: { catalogId: string } | null };

// The phone's Owned: a file on some device of the account (its track rows'
// remote_source). Kotlin reads the filter's ids / folds, not this list.
const OWNED_SOURCES = ['local'];

// The ladder's catalogue (identify.ts) over the cloud API. A brief read
// only where the server offers pages (an older one refuses the key).
function identifyCatalog(c: { client: EntityCatalog; deviceId: string; pages: boolean }): IdentifyCatalog {
	return {
		resolve: async (refs) => (await c.client.resolve({ deviceId: c.deviceId, refs })).objects,
		browse: (id, opts) => c.client.browse({ deviceId: c.deviceId, id, ...(opts?.brief && c.pages ? { brief: true } : {}) }),
		find: async (q, kind, limit) => (await c.client.search({ deviceId: c.deviceId, q, kind, ...(limit ? { limit } : {}) })).objects,
	};
}

const refOf = (ids: EntityIds): EntityRef => ({ kind: ids.kind, name: ids.name, libraryId: ids.libraryId, catalogId: ids.catalogId, spotifyId: ids.spotifyId });

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
	const asked: EntityRef = { kind: ask.kind, name: ask.name, libraryId: ask.libraryId ?? null, catalogId: ask.catalogId ?? null, within: ask.within ?? null };
	let ids = identifyLocal(d.raw, asked);
	if ('reason' in d.catalog) return baseHeader(refOf(ids), off(d.catalog.reason));
	const c = d.catalog;
	const client = identifyCatalog(c);
	let b: CatalogBrowseResult | null = null;
	let found: Awaited<ReturnType<typeof identifyRemote>>;
	try {
		found = await identifyRemote(d.raw, client, ids, asked);
		if (!('reason' in found)) {
			try {
				b = await client.browse(found.catalogId, { brief: true });
			} catch (e) {
				// The object a catalog_ref row remembered is gone (the id was the
				// library's memory, not the surface's): ask again by the ids the
				// library holds, instead of failing on a stale row.
				if (asked.catalogId || !ids.catalogId) throw e;
				ids = { ...ids, catalogId: null };
				found = await identifyRemote(d.raw, client, ids, asked);
				if (!('reason' in found)) b = await client.browse(found.catalogId, { brief: true });
			}
		}
	} catch (e) {
		console.warn('entity page: the catalogue did not answer', e instanceof Error ? e.message : String(e));
		return baseHeader(refOf(ids), off('server_off'));
	}
	if ('reason' in found || !b) {
		const miss = 'reason' in found ? found : { reason: 'unknown' as const };
		// Nobody followed it: shown from Spotify meanwhile, and read for the
		// catalogue by the page's work (entityTracks).
		const streamed = miss.reason === 'unknown' ? await streamedHeader(d, ids) : null;
		// Followable once the catalogue has an object; it has none yet.
		return streamed ?? baseHeader(refOf(ids), off(miss.reason, miss.candidates));
	}
	const ref = refOf(settleIds(d.raw, ids, b, d.now));
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
	await d.work?.ready();
	// What this phone can read now goes with the read, when it is the page in
	// front; the answer's work is the engine's, not the page's.
	const profile = d.work?.profile(ask.catalogId) ?? null;
	const streamed = parseStreamObjectId(ask.catalogId);
	let result: CatalogTracksResult;
	if (streamed) {
		// A page shown from Spotify (streamedHeader): its releases as Spotify
		// lists them. Its first read asks the catalogue about the artist's page
		// with what this phone can read: the answer's work reads the page for
		// the catalogue, and the page moves there once it is kept.
		if (!d.streaming) throw new Error('Spotify is not connected');
		const page = await streamPage(d.streaming, { kind: 'artist', id: streamed.id, name: '', cursor: ask.cursor ?? null });
		if (!page) throw new Error('Spotify has no such artist');
		result = page;
		if (profile && !ask.cursor) {
			const self = { provider: 'spotify' as const, kind: 'artist' as const, providerId: streamed.id };
			const { work } = await c.client.resolve({ deviceId: c.deviceId, refs: [self], profile, hints: [self] });
			d.work?.read(ask.catalogId, { releases: [] }, work, [self]);
		}
	} else {
		// The Spotify page the library knows the artist by: the one the cloud
		// names for the work, among namesakes' pages.
		const hints = hintsOf(identifyLocal(d.raw, { kind: ask.kind, name: '', libraryId: ask.libraryId ?? null, catalogId: ask.catalogId }));
		const { work, ...read } = await c.client.tracks({ deviceId: c.deviceId, id: ask.catalogId, ...(ask.cursor ? { cursor: ask.cursor } : {}), ...(profile ? { profile, ...(hints.length ? { hints } : {}) } : {}) });
		result = read;
		d.work?.read(result.object.id, result, work, hints);
	}
	const probes = worldProbes(result);
	// A row the work already found facts for shows them before the catalogue does.
	const page = worldPage(result, probes, matchLibraryTracks(d.raw, probes), (id) => {
		const p = d.work?.patchOf(id);
		return p ? { recordingId: p.recordingId, ...(p.bpm ? { bpm: p.bpm } : {}), ...(p.keyCamelot ? { keyCamelot: p.keyCamelot } : {}), ...(p.genre ? { genre: p.genre } : {}), ...(p.label ? { label: p.label } : {}), ...(p.spotifyId ? { streamIds: { spotify: p.spotifyId } } : {}) } : undefined;
	});
	let libraryId: string | null = null;
	if (ask.kind === 'artist' && !ask.libraryId && !streamed) {
		libraryId = artistAmongOwned(d.raw, page, result.object.id);
		if (libraryId) rememberObject(d.raw, { kind: 'artist', name: '', libraryId, spotifyId: null, catalogId: null }, result.object.id, d.now);
	}
	return { ...page, libraryId };
}

// The header of an artist the catalogue does not know, from Spotify (the
// desktop's streamingHeader): it stands under its Spotify id where a
// catalogue id would be. Null when there is no Spotify id or no answer.
// Not followable: a follow names a catalogue object, and there is none yet.
async function streamedHeader(d: EntityDeps, ids: EntityIds): Promise<EntityHeader | null> {
	const stream = d.streaming;
	const id = ids.spotifyId;
	if (!stream || ids.kind !== 'artist' || !id) return null;
	try {
		const [artist, listing] = await Promise.all([stream.artist(id), stream.listing(id)]);
		if (!artist) return null;
		// The library's spelling where the library has the artist.
		const ref = refOf({ ...ids, name: ids.libraryId ? ids.name : artist.name, catalogId: streamObjectId(stream.service, id) });
		const header = baseHeader(ref, { available: true, reason: 'ok', releaseCount: listing.total, trackCount: null, via: stream.service });
		header.imageUrl = artist.imageUrl;
		header.genres = artist.genres.slice(0, GENRES_MAX).map((name) => ({ name }));
		header.links = mergeLinks(header.links, [{ source: stream.service, sourceId: id, url: artist.url }]);
		return header;
	} catch (e) {
		console.info('entity page: Spotify did not answer', e instanceof Error ? e.message : String(e));
		return null;
	}
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

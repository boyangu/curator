// Who an entity page is about, on both sides: the library's artist / album
// (labels are text there) and the Global Catalog's object.
//
// The two are joined only through an id one side already holds of the other
// — the Spotify id on the library's artist_link / album_link rows and on the
// catalogue's handles, or a catalog_ref row an earlier lookup wrote. Never
// through a name: an artist a surface knows by id is not swapped for the
// library's namesake (artist-pages.ts states the same rule). Labels are the
// exception the library forces — a label IS its folded name here — and a
// credit named inside one catalogue object (`within`) is read among that
// object's own credits.
//
// Reads curator.db; writes catalog_ref rows only (never artist_link: those
// feed identity, and a catalogue artist can hold a namesake's page).

import type Database from 'better-sqlite3';
import type { CatalogBrowseResult, CatalogObjectSummary } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { EntityChip, EntityKind, EntityRef, EntityWorldReason } from '@curator/shared';
import type { CatalogClient } from '../catalog-client/service.js';
import { writeRefs, type CatalogRefKind, type CatalogRefObjectKind } from '../catalog-client/catalog-refs.js';

type Raw = Database.Database;
export type EntityCatalog = Pick<CatalogClient, 'status' | 'resolve' | 'browse' | 'find' | 'offersPages' | 'tracks' | 'reportEnrichment'>;

export type EntityIds = {
	kind: EntityKind;
	name: string;
	libraryId: string | null;
	spotifyId: string | null;
	catalogId: string | null;
};

// Why the catalogue side is not known, when it is not.
export type RemoteMiss = { reason: Extract<EntityWorldReason, 'unknown' | 'ambiguous'>; candidates?: EntityChip[] };

const MAX_HOPS = 8;

export function liveArtist(raw: Raw, id: string): { id: string; name: string } | null {
	let cur = raw.prepare(`select id, name, merged_into from artist where id = ?`).get(id) as { id: string; name: string; merged_into: string | null } | undefined;
	for (let hops = 0; cur?.merged_into && hops < MAX_HOPS; hops++) {
		cur = raw.prepare(`select id, name, merged_into from artist where id = ?`).get(cur.merged_into) as typeof cur;
	}
	return cur ? { id: cur.id, name: cur.name } : null;
}

export function liveAlbum(raw: Raw, id: string): { id: string; name: string } | null {
	let cur = raw.prepare(`select id, title, merged_into from album where id = ?`).get(id) as { id: string; title: string; merged_into: string | null } | undefined;
	for (let hops = 0; cur?.merged_into && hops < MAX_HOPS; hops++) {
		cur = raw.prepare(`select id, title, merged_into from album where id = ?`).get(cur.merged_into) as typeof cur;
	}
	return cur ? { id: cur.id, name: cur.title } : null;
}

const live = (raw: Raw, kind: 'artist' | 'album', id: string) => (kind === 'artist' ? liveArtist(raw, id) : liveAlbum(raw, id));

function spotifyLinkOf(raw: Raw, kind: 'artist' | 'album', id: string): string | null {
	const row = (
		kind === 'artist'
			? raw.prepare(`select source_id from artist_link where artist_id = ? and source = 'spotify' order by fetched_at desc limit 1`).get(id)
			: raw.prepare(`select source_id from album_link where album_id = ? and source = 'spotify' limit 1`).get(id)
	) as { source_id: string } | undefined;
	return row?.source_id ?? null;
}

// The library's artist / album holding this Spotify id.
function bySpotifyId(raw: Raw, kind: 'artist' | 'album', spotifyId: string): string | null {
	const row = (
		kind === 'artist'
			? raw.prepare(`select artist_id as id from artist_link where source = 'spotify' and source_id = ?`).get(spotifyId)
			: raw.prepare(`select album_id as id from album_link where source = 'spotify' and source_id = ?`).get(spotifyId)
	) as { id: string } | undefined;
	return row?.id ?? null;
}

// catalog_ref, either way round. A row's age is not checked: catalogue
// objects merge, but a merged id still answers (browse follows it to the
// winner), and the caller rewrites the row with what came back.
const refEntity = (kind: EntityKind): CatalogRefKind => (kind === 'album' ? 'album' : kind);
const refObject = (kind: EntityKind): CatalogRefObjectKind => (kind === 'album' ? 'release' : kind);

function cachedObject(raw: Raw, kind: EntityKind, entityId: string): string | null {
	const row = raw.prepare(`select object_id from catalog_ref where entity_kind = ? and entity_id = ?`).get(refEntity(kind), entityId) as { object_id: string } | undefined;
	return row?.object_id ?? null;
}

function cachedEntity(raw: Raw, kind: 'artist' | 'album', objectId: string): string | null {
	const row = raw.prepare(`select entity_id from catalog_ref where object_id = ? and entity_kind = ? limit 1`).get(objectId, refEntity(kind)) as { entity_id: string } | undefined;
	return row?.entity_id ?? null;
}

// What the library alone says: no network.
export function identifyLocal(raw: Raw, ref: EntityRef): EntityIds {
	if (ref.kind === 'label') {
		const fold = nameFold(ref.name);
		return { kind: 'label', name: ref.name, libraryId: null, spotifyId: null, catalogId: ref.catalogId ?? (fold ? cachedObject(raw, 'label', fold) : null) };
	}
	const kind = ref.kind;
	let lib = ref.libraryId ? live(raw, kind, ref.libraryId) : null;
	const spotifyId = ref.spotifyId ?? (lib ? spotifyLinkOf(raw, kind, lib.id) : null);
	if (!lib && spotifyId) {
		const id = bySpotifyId(raw, kind, spotifyId);
		lib = id ? live(raw, kind, id) : null;
	}
	const catalogId = ref.catalogId ?? (lib ? cachedObject(raw, kind, lib.id) : null);
	if (!lib && catalogId) {
		const id = cachedEntity(raw, kind, catalogId);
		lib = id ? live(raw, kind, id) : null;
	}
	return { kind, name: lib?.name ?? ref.name, libraryId: lib?.id ?? null, spotifyId, catalogId };
}

// The credit a surface named inside a catalogue object it holds.
function creditWithin(b: CatalogBrowseResult, kind: EntityKind, name: string): string | null {
	const fold = nameFold(name);
	if (!fold) return null;
	const pool = kind === 'artist' ? (b.artists ?? []) : kind === 'label' ? [...(b.labels ?? []), ...(b.releases ?? []).flatMap((r) => r.labels)] : [];
	return pool.find((c) => nameFold(c.name) === fold)?.id ?? null;
}

const chipOf = (o: CatalogObjectSummary, kind: EntityKind): EntityChip => ({ ref: { kind, name: o.name, catalogId: o.id } });

// The catalogue's object for the entity, asked through an id the library
// holds; null with the reason when nothing safe names it.
export async function identifyRemote(client: EntityCatalog, ids: EntityIds, ref: EntityRef): Promise<{ catalogId: string } | RemoteMiss> {
	if (ids.catalogId) return { catalogId: ids.catalogId };
	if (ref.within?.catalogId && ids.kind !== 'album') {
		const hit = creditWithin(await client.browse(ref.within.catalogId), ids.kind, ids.name);
		if (hit) return { catalogId: hit };
	}
	if (ids.kind === 'label') {
		const fold = nameFold(ids.name);
		if (!fold) return { reason: 'unknown' };
		const [byName] = await client.resolve([{ provider: 'user', kind: 'label', providerId: `name:${fold}` }]);
		if (byName) return { catalogId: byName.id };
		// A label no one followed by name: the catalogue's own labels of
		// exactly that fold. One is it; several are namesakes to choose from.
		const same = (await client.find(ids.name, 'label', 10)).filter((o) => nameFold(o.name) === fold);
		if (same.length === 1) return { catalogId: same[0]!.id };
		return same.length > 1 ? { reason: 'ambiguous', candidates: same.map((o) => chipOf(o, 'label')) } : { reason: 'unknown' };
	}
	const kind = refObject(ids.kind);
	const refs = [
		...(ids.spotifyId ? [{ provider: 'spotify' as const, kind, providerId: ids.spotifyId }] : []),
		// What a library import registered for an entity without a Spotify id
		// (catalog-client/library-claims.ts).
		...(ids.libraryId ? [{ provider: 'user' as const, kind, providerId: ids.kind === 'artist' ? `local:${ids.libraryId}` : `album:${ids.libraryId}` }] : []),
	];
	if (!refs.length) return { reason: 'unknown' };
	const hit = (await client.resolve(refs)).find((o) => o !== null);
	return hit ? { catalogId: hit.id } : { reason: 'unknown' };
}

// The library's entity for a catalogue object the page reached first (a feed
// card's artist): by the Spotify id among the object's handles.
export function libraryForObject(raw: Raw, kind: 'artist' | 'album', object: CatalogObjectSummary): { id: string; name: string } | null {
	for (const h of object.handles) {
		if (h.provider !== 'spotify' || h.id.includes('/')) continue;
		const id = bySpotifyId(raw, kind, h.id);
		const hit = id ? live(raw, kind, id) : null;
		if (hit) return hit;
	}
	return null;
}

// Remember which catalogue object a library entity is, for the next page
// (and for refsForTrack, which reads the same rows).
export function rememberObject(raw: Raw, ids: EntityIds, objectId: string, now = Date.now()): void {
	const entityId = ids.kind === 'label' ? nameFold(ids.name) : ids.libraryId;
	if (!entityId) return;
	writeRefs(raw, [{ entityKind: refEntity(ids.kind), entityId, objectId, objectKind: refObject(ids.kind), provider: null, providerId: null }], now);
}

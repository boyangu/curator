// Who an entity page is about, on both sides: the library's artist / album
// (labels are text there) and the Global Catalog's object. One ladder for
// the desktop (apps/core entity/service.ts) and the phone (apps/mobile
// js/entity.ts): the same library rows name the same object on both.
//
// The two are joined only through an id one side already holds of the other
// — the Spotify id on the library's artist_link / album_link rows and on the
// catalogue's handles, or a catalog_ref row an earlier lookup wrote. Never
// through a name: an artist a surface knows by id is not swapped for the
// library's namesake (artist-pages.ts states the same rule). Labels are the
// exception the library forces — a label IS its folded name here — and a
// credit named inside one catalogue object (`within`, or a recording of the
// artist's own tracks) is read among that object's own credits.
//
// artist_link rows reach a phone too: derived from the account's provider
// listings (track_provider_ref, sync-log/remote-rows.ts) where the desktop
// derives them from its own payloads. The catalogue's name for an artist can
// differ from the library's (a credit line written on its id), so the id
// comes first and the name is the last resort.
//
// Reads the library; writes catalog_ref rows only (never artist_link: those
// feed identity, and a catalogue artist can hold a namesake's page).

import type Database from 'better-sqlite3';
import type { CatalogBrowseResult, CatalogKind, CatalogObjectSummary, CatalogRef } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { EntityChip, EntityKind, EntityRef, EntityWorldReason } from '@curator/shared';
import { writeRefs, type CatalogRefKind, type CatalogRefObjectKind } from './catalog-ref.js';

type Raw = Database.Database;

// What the ladder asks of the catalogue (the desktop's CatalogClient; a
// small adapter over the cloud API on the phone).
export type IdentifyCatalog = {
	resolve(refs: CatalogRef[]): Promise<(CatalogObjectSummary | null)[]>;
	browse(objectId: string, opts?: { brief?: boolean }): Promise<CatalogBrowseResult>;
	find(q: string, kind: CatalogKind, limit?: number): Promise<CatalogObjectSummary[]>;
};

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
// The artist's own tracks tried for a recording whose credits name it.
const EVIDENCE_TRACKS = 2;

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

// Spotify ids of the artist's own tracks (not a remix it is credited on):
// the device's own links or, where it holds none, what the account's claims
// name (claim_link: a phone's rows, a file another device bound).
function ownSpotifyRecordings(raw: Raw, artistId: string): string[] {
	return raw
		.prepare(
			// The bare l.id comes from the row min(l.rank) picked (SQLite).
			`select l.id, min(l.rank) as best from track_artist ta
			join track t on t.id = ta.track_id and t.deleted_at is null
			join (select track_id, source_track_id as id, 0 as rank from source_link where source = 'spotify'
				union all select track_id, source_track_id, 1 + rank from claim_link where source = 'spotify') l on l.track_id = ta.track_id
			where ta.artist_id = ? and ta.role is null
			group by ta.track_id order by best limit ?`,
		)
		.pluck()
		.all(artistId, EVIDENCE_TRACKS) as string[];
}

// The catalogue's object for the entity, asked through an id the library
// holds; null with the reason when nothing safe names it.
export async function identifyRemote(raw: Raw, client: IdentifyCatalog, ids: EntityIds, ref: Pick<EntityRef, 'within'>): Promise<{ catalogId: string } | RemoteMiss> {
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
		// (apps/core catalog-client/library-claims.ts).
		...(ids.libraryId ? [{ provider: 'user' as const, kind, providerId: ids.kind === 'artist' ? `local:${ids.libraryId}` : `album:${ids.libraryId}` }] : []),
	];
	const hit = refs.length ? (await client.resolve(refs)).find((o) => o !== null) : undefined;
	if (hit) return { catalogId: hit.id };
	// An artist the catalogue holds under no id the library has: a recording
	// of its own tracks, and its credit there by the library's name.
	if (ids.kind === 'artist' && ids.libraryId) {
		const recordings = ownSpotifyRecordings(raw, ids.libraryId);
		if (recordings.length) {
			for (const rec of await client.resolve(recordings.map((id) => ({ provider: 'spotify' as const, kind: 'recording' as const, providerId: id })))) {
				if (!rec) continue;
				const credit = creditWithin(await client.browse(rec.id, { brief: true }), 'artist', ids.name);
				if (credit) return { catalogId: credit };
			}
		}
	}
	return { reason: 'unknown' };
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

// The ids once the catalogue answered with its object, remembered for the
// next page. A catalogue entity the library holds under a Spotify id it did
// not name is found now that the object's handles are known. The name shown
// is the library's where the library has the entity (a label keeps the
// spelling the surface used: it is what Owned matches), else the catalogue's.
export function settleIds(raw: Raw, ids: EntityIds, b: CatalogBrowseResult, now = Date.now()): EntityIds {
	const full: EntityIds = { ...ids, catalogId: b.object.id };
	if (!full.libraryId && full.kind !== 'label') {
		const lib = libraryForObject(raw, full.kind, b.object);
		if (lib) Object.assign(full, { libraryId: lib.id, name: lib.name });
		else full.name = b.object.name;
	}
	if (!full.name) full.name = b.object.name;
	full.spotifyId ??= b.object.handles.find((h) => h.provider === 'spotify' && !h.id.includes('/'))?.id ?? null;
	rememberObject(raw, full, b.object.id, now);
	return full;
}

// The Spotify page the library knows an artist by: what the catalogue's
// planner names the artist's one page by (catalog-work.ts hints).
export function hintsOf(ids: Pick<EntityIds, 'kind' | 'spotifyId'>): CatalogRef[] {
	return ids.kind === 'artist' && ids.spotifyId ? [{ provider: 'spotify', kind: 'artist', providerId: ids.spotifyId }] : [];
}

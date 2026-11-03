// What a library track is in the Global Catalog: its recording, its release,
// its label, its artists — the bridge from the local library to the shared
// catalogue (browse a label's releases from the track playing, follow its
// artists). Kept in catalog_ref (schema.ts catalogRef): written by the
// collection import for albums and labels, resolved here for the rest on
// first ask through the provider refs the library already holds (Spotify
// track, album and artist ids; a label's folded name), and refreshed when old,
// because catalogue objects merge and the uuid is only a cache.
//
// Reads curator.db and writes catalog_ref rows only.

import type Database from 'better-sqlite3';
import type { CatalogObjectSummary, CatalogRef } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { CatalogClient } from './service.js';
import { isDistributor } from './library-claims.js';

export type CatalogRefKind = 'track' | 'album' | 'artist' | 'label';
export type CatalogRefObjectKind = 'recording' | 'release' | 'artist' | 'label';
export type CatalogRefRow = { entityKind: CatalogRefKind; entityId: string; objectId: string; objectKind: CatalogRefObjectKind; provider: string | null; providerId: string | null };
export type CatalogObjectRef = { objectId: string; name: string; provider: string | null; providerId: string | null };
export type TrackCatalogRefs = {
	recording: CatalogObjectRef | null;
	release: CatalogObjectRef | null;
	label: CatalogObjectRef | null;
	artists: (CatalogObjectRef & { artistId: string })[];
};

// A row older than this is resolved again (the object may have merged).
const STALE_MS = 7 * 86400_000;

export function writeRefs(raw: Database.Database, rows: CatalogRefRow[], now = Date.now()): void {
	const put = raw.prepare(
		`insert into catalog_ref (entity_kind, entity_id, object_id, object_kind, provider, provider_id, resolved_at) values (?, ?, ?, ?, ?, ?, ?)
		on conflict (entity_kind, entity_id) do update set object_id = excluded.object_id, object_kind = excluded.object_kind,
			provider = excluded.provider, provider_id = excluded.provider_id, resolved_at = excluded.resolved_at`,
	);
	raw.transaction(() => {
		for (const r of rows) put.run(r.entityKind, r.entityId, r.objectId, r.objectKind, r.provider, r.providerId, now);
	})();
}

type Wanted = { entityKind: CatalogRefKind; entityId: string; objectKind: CatalogRefObjectKind; ref: CatalogRef; artistId?: string };

export async function refsForTrack(raw: Database.Database, client: Pick<CatalogClient, 'resolve'>, trackId: string, now = Date.now()): Promise<TrackCatalogRefs> {
	const t = raw
		.prepare(
			`select t.id, t.album_id, coalesce(nullif(trim(al.label), ''), nullif(trim(t.label), '')) as label, t.isrc,
				(select s.source_track_id from source_link s where s.track_id = t.id and s.source = 'spotify' order by s.fetched_at desc limit 1) as spotify_track,
				(select l.source_id from album_link l where l.album_id = t.album_id and l.source = 'spotify' limit 1) as spotify_album
			from track t left join album al on al.id = t.album_id where t.id = ?`,
		)
		.get(trackId) as { id: string; album_id: string | null; label: string | null; isrc: string | null; spotify_track: string | null; spotify_album: string | null } | undefined;
	if (!t) throw new Error(`track ${trackId} not found`);
	const artists = raw
		.prepare(
			`select a.id, (select l.source_id from artist_link l where l.artist_id = a.id and l.source = 'spotify' order by l.fetched_at desc limit 1) as spotify_id
			from track_artist ta join artist a on a.id = ta.artist_id where ta.track_id = ? and (ta.role is null or ta.role <> 'remixer') order by ta.position`,
		)
		.all(trackId) as { id: string; spotify_id: string | null }[];

	// What can be asked of the catalogue, by the refs the library holds.
	const wanted: Wanted[] = [];
	if (t.spotify_track) wanted.push({ entityKind: 'track', entityId: t.id, objectKind: 'recording', ref: { provider: 'spotify', kind: 'recording', providerId: t.spotify_track } });
	if (t.album_id && t.spotify_album) wanted.push({ entityKind: 'album', entityId: t.album_id, objectKind: 'release', ref: { provider: 'spotify', kind: 'release', providerId: t.spotify_album } });
	const labelFold = t.label && !isDistributor(t.label) ? nameFold(t.label) : null;
	if (labelFold) wanted.push({ entityKind: 'label', entityId: labelFold, objectKind: 'label', ref: { provider: 'user', kind: 'label', providerId: `name:${labelFold}` } });
	for (const a of artists) if (a.spotify_id) wanted.push({ entityKind: 'artist', entityId: a.id, objectKind: 'artist', ref: { provider: 'spotify', kind: 'artist', providerId: a.spotify_id }, artistId: a.id });

	const cached = new Map<string, { object_id: string; provider: string | null; provider_id: string | null; resolved_at: number }>();
	const read = raw.prepare(`select object_id, provider, provider_id, resolved_at from catalog_ref where entity_kind = ? and entity_id = ?`);
	const keys: [CatalogRefKind, string][] = [['track', t.id], ...(t.album_id ? [['album', t.album_id] as [CatalogRefKind, string]] : []), ...(labelFold ? [['label', labelFold] as [CatalogRefKind, string]] : []), ...artists.map((a) => ['artist', a.id] as [CatalogRefKind, string])];
	for (const [kind, id] of keys) {
		const row = read.get(kind, id) as { object_id: string; provider: string | null; provider_id: string | null; resolved_at: number } | undefined;
		if (row) cached.set(`${kind}:${id}`, row);
	}

	// Ask for what is missing or stale; keep what the catalogue answers.
	const ask = wanted.filter((w) => {
		const c = cached.get(`${w.entityKind}:${w.entityId}`);
		return !c || now - c.resolved_at > STALE_MS;
	});
	const names = new Map<string, string>();
	if (ask.length) {
		const found = await client.resolve(ask.map((w) => w.ref));
		const rows: CatalogRefRow[] = [];
		ask.forEach((w, i) => {
			const o: CatalogObjectSummary | null = found[i] ?? null;
			if (!o) return;
			names.set(`${w.entityKind}:${w.entityId}`, o.name);
			rows.push({ entityKind: w.entityKind, entityId: w.entityId, objectId: o.id, objectKind: w.objectKind, provider: w.ref.provider, providerId: w.ref.providerId });
		});
		writeRefs(raw, rows, now);
		for (const r of rows) cached.set(`${r.entityKind}:${r.entityId}`, { object_id: r.objectId, provider: r.provider, provider_id: r.providerId, resolved_at: now });
	}

	const refOf = (kind: CatalogRefKind, id: string | null): CatalogObjectRef | null => {
		if (!id) return null;
		const c = cached.get(`${kind}:${id}`);
		return c ? { objectId: c.object_id, name: names.get(`${kind}:${id}`) ?? '', provider: c.provider, providerId: c.provider_id } : null;
	};
	return {
		recording: refOf('track', t.id),
		release: refOf('album', t.album_id),
		label: refOf('label', labelFold),
		artists: artists.flatMap((a) => {
			const r = refOf('artist', a.id);
			return r ? [{ ...r, artistId: a.id }] : [];
		}),
	};
}

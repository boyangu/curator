// The owner's library as a filter on the local catalogue's back office: which catalogue objects
// the tracks with local files (curator.db, membership 'local') are, and what they touch — the
// releases they are on, those releases' labels, the artists credited on them. A testing aid for
// the local catalogue only (cli/local.ts): it reads the desktop's curator.db read-only and keeps
// the result in a session temp table of the one PGlite connection, so nothing about one person's
// library is written to the shared catalogue. The deployed back office has no such table and no
// filter (browse.ts asks only when the host says the library is loaded).
//
// A track is found by what the library import keyed it by (core library-claims.ts): its Spotify
// track id, else `user` recording:<recording_id | id>; and by its ISRC. A release also by the
// album mapping the import left in curator.db (catalog_ref).

import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';

// node:sqlite by require: Vite (vitest) does not know it as a builtin yet and fails to resolve the import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof Sqlite;

export type LocalLibrary = { path: string; tracks: number; objects: Record<'label' | 'artist' | 'release' | 'recording', number>; loadedAt: number };

type TrackRow = { id: string; recording_id: string | null; isrc: string | null; album_id: string | null; spotify: string | null };

// What the desktop database says, read-only: never written from here (the live-data rule).
function readLibrary(path: string): { tracks: TrackRow[]; releases: string[] } {
	const sqlite = new DatabaseSync(path, { readOnly: true });
	try {
		const tracks = sqlite
			.prepare(
				`select t.id, t.recording_id, t.isrc, t.album_id,
					(select s.source_track_id from source_link s where s.track_id = t.id and s.source = 'spotify' order by s.fetched_at desc limit 1) as spotify
				from track t where t.deleted_at is null and t.membership = 'local'`,
			)
			.all() as unknown as TrackRow[];
		const albums = new Set(tracks.map((t) => t.album_id).filter((a): a is string => !!a));
		const refs = sqlite.prepare(`select entity_id, object_id from catalog_ref where entity_kind = 'album'`).all() as unknown as { entity_id: string; object_id: string }[];
		return { tracks, releases: refs.filter((r) => albums.has(r.entity_id)).map((r) => r.object_id) };
	} finally {
		sqlite.close();
	}
}

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function insertRows(tx: Queryable, table: string, cols: string[], rows: string[][]): Promise<void> {
	for (let i = 0; i < rows.length; i += 500) {
		const chunk = rows.slice(i, i + 500);
		const values = chunk.map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(', ')})`).join(', ');
		await tx.query(`insert into ${table} (${cols.join(', ')}) values ${values} on conflict do nothing`, chunk.flat());
	}
}

// (Re)builds pg_temp.local_library from curator.db. A session temp table: the local catalogue's
// PGlite has one connection, so it lives as long as the server and every request sees it.
export async function loadLocalLibrary(db: Db, path: string): Promise<LocalLibrary> {
	const { tracks, releases } = readLibrary(path);
	const keys: string[][] = [];
	for (const t of tracks) {
		if (t.spotify && /^[A-Za-z0-9]{22}$/.test(t.spotify)) keys.push(['spotify', t.spotify]);
		keys.push(['user', `recording:${t.recording_id ?? t.id}`]);
		const isrc = t.isrc?.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
		if (isrc && ISRC.test(isrc)) keys.push(['isrc', isrc]);
	}
	await db.begin(async (tx) => {
		await tx.query(`create temp table if not exists local_library_key (kind text not null, value text not null, primary key (kind, value))`);
		await tx.query(`create temp table if not exists local_library (object_id uuid primary key, kind text not null)`);
		await tx.query(`truncate pg_temp.local_library_key, pg_temp.local_library`);
		await insertRows(tx, 'pg_temp.local_library_key', ['kind', 'value'], keys);
		await insertRows(tx, 'pg_temp.local_library_key', ['kind', 'value'], releases.filter((r) => UUID.test(r)).map((r) => ['release', r]));
		// The tracks: by store id or the library's own id, and by ISRC.
		await tx.query(
			`insert into pg_temp.local_library (object_id, kind)
			select o.id, 'recording' from pg_temp.local_library_key k
			join curator.catalog_source_object so on so.provider = k.kind and so.kind = 'recording' and so.provider_id = k.value
			join curator.catalog_object o on o.id = so.object_id and o.merged_into is null
			where k.kind in ('spotify', 'user')
			union
			select o.id, 'recording' from pg_temp.local_library_key k
			join curator.catalog_identifier i on i.namespace = 'isrc' and i.value = k.value
			join curator.catalog_object o on o.id = i.object_id and o.kind = 'recording' and o.merged_into is null
			where k.kind = 'isrc'
			on conflict do nothing`,
		);
		// The releases they are on, and the albums the import mapped (a merged one by its survivor).
		await tx.query(
			`insert into pg_temp.local_library (object_id, kind)
			select r.id, 'release' from pg_temp.local_library l
			join curator.catalog_edge e on e.kind = 'release-recording' and e.dst = l.object_id
			join curator.catalog_object r on r.id = e.src and r.merged_into is null
			where l.kind = 'recording'
			union
			select coalesce(m.merged_into, m.id), 'release' from pg_temp.local_library_key k
			join curator.catalog_object m on m.id = k.value::uuid
			where k.kind = 'release'
			on conflict do nothing`,
		);
		await tx.query(
			`insert into pg_temp.local_library (object_id, kind)
			select o.id, 'label' from pg_temp.local_library l
			join curator.catalog_edge e on e.kind = 'release-label' and e.src = l.object_id
			join curator.catalog_object o on o.id = e.dst and o.merged_into is null
			where l.kind = 'release'
			on conflict do nothing`,
		);
		await tx.query(
			`insert into pg_temp.local_library (object_id, kind)
			select o.id, 'artist' from pg_temp.local_library l
			join curator.catalog_edge e on e.kind = 'recording-artist' and e.src = l.object_id
			join curator.catalog_object o on o.id = e.dst and o.merged_into is null
			where l.kind = 'recording'
			union
			select o.id, 'artist' from pg_temp.local_library l
			join curator.catalog_edge e on e.kind = 'artist-release' and e.dst = l.object_id
			join curator.catalog_object o on o.id = e.src and o.merged_into is null
			where l.kind = 'release'
			on conflict do nothing`,
		);
		// Each label's tracks in the library, counted once here rather than per
		// request: counting all 1,300 labels through the filter on every page
		// took 5–11 s (2026-11-01). A label with none is absent.
		await tx.query(`create temp table if not exists local_library_label (label_id uuid primary key, tracks integer not null)`);
		await tx.query(`truncate pg_temp.local_library_label`);
		await tx.query(
			`insert into pg_temp.local_library_label (label_id, tracks)
			select rl.dst, count(distinct coalesce((select min(i.value) from curator.catalog_identifier i where i.object_id = l.object_id and i.namespace = 'isrc'), l.object_id::text))
			from pg_temp.local_library l
			join curator.catalog_edge rr on rr.kind = 'release-recording' and rr.dst = l.object_id
			join curator.catalog_object r on r.id = rr.src and r.merged_into is null
			join curator.catalog_edge rl on rl.kind = 'release-label' and rl.src = r.id
			join curator.catalog_object lab on lab.id = rl.dst and lab.merged_into is null
			where l.kind = 'recording'
			group by rl.dst`,
		);
	});
	const counts = await db.query<{ kind: string; n: unknown }>(`select kind, count(*) as n from pg_temp.local_library group by kind`);
	const by = Object.fromEntries(counts.map((c) => [c.kind, num(c.n)]));
	return { path, tracks: tracks.length, objects: { label: by.label ?? 0, artist: by.artist ?? 0, release: by.release ?? 0, recording: by.recording ?? 0 }, loadedAt: Date.now() };
}

// Watches: which live objects a user follows, and the tracking they keep
// alive.
//
// A watch row is the user's (RLS, written as the user through
// SystemTx.asUser); the cursors it activates are the catalogue's. Tracking
// exists only while an object has watchers: the first watch creates a cursor
// per enabled tracker that can follow the object (it has a representation on
// that provider, or the tracker works by name), and the last unwatch removes
// them. A cursor starts `tracking_started_at` now, which is what keeps its
// first poll from announcing the object's back catalogue (events.ts).

import {
	CATALOG_MAX_WATCHES,
	isLiveKind,
	type CatalogProvider,
	type CatalogWatch,
	type CatalogWatchSource,
} from '@curator/protocol';
import type { Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import type { SystemTx } from '../db/system-tx.js';
import { CloudError } from '../errors.js';
import { follow } from './identity.js';
import { summaries } from './objects.js';

// Cursors for every enabled tracker that can follow the object, if anyone
// watches it. Idempotent; called on a watch and whenever ingestion gives a
// watched object a new representation. A tracker's `requires`: an id on its
// provider ('representation', the default), nothing ('name'), or — the
// Spotify label tracker — a catalogue playlist ('catalogue_playlist').
export async function ensureCursors(tx: Queryable, objectId: string): Promise<number> {
	const rows = await tx.query(
		`insert into curator.catalog_cursor (object_id, provider)
		select o.id, t.provider
		from curator.catalog_object o
		join curator.tracker t on t.kind = o.kind and t.enabled
		where o.id = $1 and o.watch_count > 0 and o.merged_into is null
			and (coalesce(t.config->>'requires', 'representation') = 'name'
				or (t.config->>'requires' = 'catalogue_playlist' and exists (
					select 1 from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.dst and so.provider = t.provider
					where e.src = o.id and e.kind = 'label-playlist' and e.role = 'catalogue'))
				or (coalesce(t.config->>'requires', 'representation') = 'representation'
					and exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = t.provider)))
		on conflict do nothing
		returning 1`,
		[objectId],
	);
	return rows.length;
}

// Tracking for objects nobody watches any more, and for merged-away ones.
export async function collectCursors(tx: Queryable): Promise<number> {
	const rows = await tx.query(
		`delete from curator.catalog_cursor c using curator.catalog_object o
		where o.id = c.object_id and (o.watch_count = 0 or o.merged_into is not null)
		returning 1`,
	);
	return rows.length;
}

export type LiveTarget = { id: string; kind: string };

// The live object a watch may name: merged ids follow to their winner, and a
// release or recording cannot be watched (it never changes).
export async function liveTarget(tx: Queryable, objectId: string): Promise<LiveTarget> {
	const id = await follow(tx, objectId);
	const [row] = await tx.query<{ id: string; kind: string }>(`select id, kind from curator.catalog_object where id = $1`, [id]);
	if (!row) throw new CloudError('NOT_FOUND', 'catalog_not_found');
	if (!isLiveKind(row.kind as never)) throw new CloudError('PRECONDITION_FAILED', 'catalog_claim_invalid');
	return row;
}

// Inserts the user's watch (as the user), keeping their total under the cap.
// A repeated watch unmutes rather than duplicates.
export async function addWatch(tx: SystemTx, userId: string, objectId: string, source: CatalogWatchSource): Promise<boolean> {
	const inserted = await tx.asUser(userId, async (q) => {
		const [count] = await q.query<{ n: unknown }>(`select count(*) as n from curator.catalog_watch`);
		const [has] = await q.query<{ muted: boolean }>(`select muted from curator.catalog_watch where object_id = $1`, [objectId]);
		if (has) {
			if (has.muted) await q.query(`update curator.catalog_watch set muted = false where object_id = $1`, [objectId]);
			return false;
		}
		if (num(count!.n) >= CATALOG_MAX_WATCHES) throw new CloudError('PRECONDITION_FAILED', 'catalog_watch_limit');
		await q.query(`insert into curator.catalog_watch (object_id, source) values ($1, $2)`, [objectId, source]);
		return true;
	});
	// A label's pages elsewhere are looked up once it is watched
	// (profile/label-profiler.ts); the trackers follow from what it finds.
	await tx.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider)
		select id, 'profile', 'catalog' from curator.catalog_object where id = $1 and kind = 'label'
		on conflict do nothing`,
		[objectId],
	);
	await ensureCursors(tx, objectId);
	return inserted;
}

export async function removeWatch(tx: SystemTx, userId: string, objectId: string): Promise<void> {
	await tx.asUser(userId, (q) => q.query(`delete from curator.catalog_watch where object_id = $1`, [objectId]));
	await tx.query(
		`delete from curator.catalog_cursor c using curator.catalog_object o where o.id = c.object_id and o.id = $1 and o.watch_count = 0`,
		[objectId],
	);
}

export async function setMuted(tx: SystemTx, userId: string, objectId: string, muted: boolean): Promise<void> {
	const rows = await tx.asUser(userId, (q) => q.query(`update curator.catalog_watch set muted = $2 where object_id = $1 returning 1`, [objectId, muted ? 'true' : 'false']));
	if (!rows.length) throw new CloudError('NOT_FOUND', 'catalog_not_found');
}

export async function listWatches(tx: SystemTx, userId: string, onlyObject?: string): Promise<CatalogWatch[]> {
	const rows = await tx.asUser(userId, (q) =>
		q.query<{ object_id: string; source: CatalogWatchSource; muted: boolean; created_ms: unknown }>(
			`select object_id, source, muted, extract(epoch from created_at) * 1000 as created_ms
			from curator.catalog_watch ${onlyObject ? 'where object_id = $1' : ''} order by created_at`,
			onlyObject ? [onlyObject] : [],
		),
	);
	if (!rows.length) return [];
	const ids = rows.map((r) => r.object_id);
	const objects = await summaries(tx, ids);
	const cursors = await tx.query<{ object_id: string; provider: string; last_ms: unknown; next_ms: unknown; fail_count: unknown }>(
		`select object_id, provider, extract(epoch from last_run_at) * 1000 as last_ms, extract(epoch from next_due_at) * 1000 as next_ms, fail_count
		from curator.catalog_cursor where object_id = any($1::uuid[]) order by provider`,
		[`{${ids.join(',')}}`],
	);
	return rows
		.filter((r) => objects.has(r.object_id))
		.map((r) => ({
			object: objects.get(r.object_id)!,
			source: r.source,
			muted: r.muted,
			createdAt: num(r.created_ms),
			tracking: cursors
				.filter((c) => c.object_id === r.object_id)
				.map((c) => ({ provider: c.provider as CatalogProvider, lastRunAt: numOrNull(c.last_ms), nextDueAt: numOrNull(c.next_ms), failing: num(c.fail_count) > 0 })),
		}));
}

// "Refresh now": the object's trackers are due at once, at most once an hour.
export async function refreshNow(tx: Queryable, objectId: string): Promise<number | null> {
	const rows = await tx.query<{ next_ms: unknown }>(
		`update curator.catalog_cursor set next_due_at = now()
		where object_id = $1 and (last_run_at is null or last_run_at < now() - interval '1 hour')
		returning extract(epoch from next_due_at) * 1000 as next_ms`,
		[objectId],
	);
	return rows.length ? num(rows[0]!.next_ms) : null;
}

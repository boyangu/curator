// Provider release metadata on the op log (protocol v4 `album.set-meta`; the
// 2026-10-21 zero-loss audit, item 14). The album fill (library/album-enrich.ts)
// asks Spotify about every release with a Spotify album id and writes the
// album artists, type, size, label, UPC and cover — data only a device with
// a Spotify token can fetch, so a second device grouped 28,517 albums where
// the master had 25,736 and showed no label or UPC on any. Each answer is
// now stated, keyed by the provider album id (`spotify:<id>`); a device that
// links the same release applies it (library/albums.ts
// applySyncedAlbumMetaRaw) instead of asking again.
//
// Emitted inline by the fill when the server reads v4 (features.ts), and
// once for every release filled before that (the v4 backfill below). Only by
// the master (role.ts): a secondary still fills its own rows, but its answer
// from the same provider would only race the master's under plain LWW (the
// second desktop's first sync queued 18,576 restatements, 478 of them values
// that would have overridden the master's).

import type Database from 'better-sqlite3';
import type { NewOp } from '@curator/protocol';
import { emitOps } from './outbox.js';
import { sourceRole } from './role.js';

type Raw = Database.Database;

export const ALBUM_META_BACKFILL_KEY = 'sync.backfill.album_meta_v4_at';

const http = (v: unknown): string | null => (typeof v === 'string' && v.length <= 2048 && /^https?:\/\//i.test(v) ? v : null);
const cut = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

export type AlbumMetaInput = {
	providerId: string;
	albumType: string | null;
	totalTracks: number | null;
	releaseDate: string | null;
	label: string | null;
	upc: string | null;
	coverUrl: string | null;
	artists: readonly string[];
	various: boolean;
};

export function albumMetaOp(source: 'spotify' | 'tidal', m: AlbumMetaInput): NewOp | null {
	if (!m.providerId || m.providerId.length > 128 || /[:\s]/.test(m.providerId)) return null;
	return {
		entity: 'album',
		entity_id: `${source}:${m.providerId}`,
		kind: 'set-meta',
		payload: {
			album_type: cut(m.albumType, 32),
			total_tracks: typeof m.totalTracks === 'number' && Number.isFinite(m.totalTracks) && m.totalTracks >= 0 ? Math.trunc(m.totalTracks) : null,
			release_date: cut(m.releaseDate, 32),
			label: cut(m.label, 1024),
			upc: cut(m.upc, 64),
			cover_url: http(m.coverUrl),
			artists: m.artists.map((a) => a.trim()).filter(Boolean).map((a) => a.slice(0, 512)).slice(0, 64),
			various: m.various,
		},
	};
}

// Inside the fill's transaction.
export function emitAlbumMeta(raw: Raw, source: 'spotify' | 'tidal', m: AlbumMetaInput): void {
	if (sourceRole(raw).speaks !== 'all') return;
	const op = albumMetaOp(source, m);
	if (op) emitOps(raw, [op]);
}

export function albumMetaBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(ALBUM_META_BACKFILL_KEY) === undefined;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Every release this device filled from Spotify, stated from the album row
// as the fill left it (once per Spotify id it carries), in pages — except a
// release the account already describes under ANY of its ids: that came
// from another device's fill (applySyncedAlbumMetaRaw writes the same
// columns, and a seam merge can carry a second id onto it), and restating it
// here would echo it back under a newer clock.
// `local`: the founder fold's form (outbox.ts EmitOptions.local).
export async function albumMetaBackfillAsync(raw: Raw, opts: { page?: number; local?: boolean } = {}): Promise<{ albums: number; emitted: number; maxSliceMs: number }> {
	const page = Math.max(1, opts.page ?? 300);
	const out = { albums: 0, emitted: 0, maxSliceMs: 0 };
	// A secondary only marks it done: a promotion to master re-runs it
	// (project.ts requestRestatement).
	if (sourceRole(raw).speaks === 'all') {
		const rows = raw.prepare(`SELECT a.rowid AS rid, a.id, a.album_type, a.total_tracks, a.release_date, a.label, a.upc, a.cover_url, a.artists_source
			FROM album a
			WHERE a.merged_into IS NULL AND a.enriched_at IS NOT NULL AND a.rowid > ?
				AND EXISTS (SELECT 1 FROM album_link al WHERE al.album_id = a.id AND al.source = 'spotify')
			ORDER BY a.rowid LIMIT ?`);
		// `+source`: with ORDER BY source_id SQLite otherwise walks the
		// (source, source_id) key over every Spotify link, ~18 ms per album on
		// the real library, instead of the album index; sorted here instead.
		const linksOf = raw.prepare(`SELECT source_id FROM album_link WHERE album_id = ? AND +source = 'spotify'`).pluck();
		const artistsOf = raw.prepare(`SELECT ar.name FROM album_artist aa JOIN artist ar ON ar.id = aa.artist_id WHERE aa.album_id = ? ORDER BY aa.position`).pluck();
		const known = raw.prepare(`SELECT 1 FROM sync_state WHERE map = 'albums' AND key = ?`).pluck();
		for (let after = 0; ;) {
			const t0 = performance.now();
			const batch = rows.all(after, page) as Array<{ rid: number; id: string; album_type: string | null; total_tracks: number | null; release_date: string | null; label: string | null; upc: string | null; cover_url: string | null; artists_source: string }>;
			if (batch.length === 0) break;
			after = batch[batch.length - 1]!.rid;
			raw.transaction(() => {
				const ops: NewOp[] = [];
				for (const a of batch) {
					const ids = (linksOf.all(a.id) as string[]).sort();
					if (ids.some((id) => known.get(`spotify:${id}`) !== undefined)) continue;
					const artists = a.artists_source === 'source' ? (artistsOf.all(a.id) as string[]) : [];
					for (const id of ids) {
						const op = albumMetaOp('spotify', {
							providerId: id, albumType: a.album_type, totalTracks: a.total_tracks, releaseDate: a.release_date, label: a.label, upc: a.upc,
							coverUrl: a.cover_url, artists, various: a.artists_source === 'various',
						});
						if (op) ops.push(op);
					}
				}
				// A one-time backlog: uploaded as a server batch (outbox.ts BATCH_LABELS).
				out.emitted += emitOps(raw, ops, { batchLabel: 'backfill', local: opts.local }).length;
			})();
			out.albums += batch.length;
			out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
			await yieldToLoop();
		}
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(ALBUM_META_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
	return out;
}

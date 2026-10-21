// Background Spotify album fill. Most stored Spotify payloads come from
// field-masked playlist reads that say only which album a track is on (id,
// name, date, images), so the album seam can only GUESS the album artists
// and knows no track positions. This walks every release with a Spotify
// album id that hasn't been fetched yet, 20 per `GET /albums?ids=`, and
// writes what the provider says: album artists (through the seam's
// setAlbumArtistsRaw, which merges releases whose identity now coincides),
// type, size, label, UPC, cover, and each member track's disc/track number.
//
// Paced and resumable: `album.enriched_at` marks done rows, so a restart
// picks up where it stopped. All HTTP goes through SpotifyClient's shared
// rate gate (one 429 backs off every caller). Disabled is a supported state:
// no Spotify connection, or CURATOR_DISABLE_ALBUM_ENRICH=1 — the loop idles.

import type Database from 'better-sqlite3';
import type { SpotifyClient, SpotifyFullAlbum } from '@curator/spotify';
import { upsertArtistRaw } from './artists.js';
import { setAlbumArtistsRaw } from './albums.js';
import { log } from '../log.js';
import { emitAlbumMeta } from '../sync-log/album-meta.js';
import { emitV4 } from '../sync-log/features.js';

const elog = log.for('album-enrich');

const BATCH = 20;
// Between batches — the background share of Spotify's rolling window.
const PACE_MS = 1500;
// After a failed batch (network / non-429 error) and after a quota ban.
const ERROR_BACKOFF_MS = 60_000;
const BAN_BACKOFF_MS = 10 * 60_000;

type Raw = Database.Database;

export interface AlbumEnricher {
	// Arm the loop (idempotent). It drains the backlog, then idles until kick().
	start(): void;
	// New releases may exist (after a sync) — wake an idle loop.
	kick(): void;
	stop(): void;
}

interface Pending { albumId: string; spotifyId: string }

function nextBatch(raw: Raw): Pending[] {
	return raw.prepare(`
		SELECT al.album_id AS albumId, al.source_id AS spotifyId
		FROM album_link al JOIN album a ON a.id = al.album_id
		WHERE al.source = 'spotify' AND a.merged_into IS NULL AND a.enriched_at IS NULL
		ORDER BY a.created_at, a.id
		LIMIT ?`).all(BATCH) as Pending[];
}

// Write one fetched release. Returns the surviving album id (a release whose
// provider artists match another's becomes one album).
export function applySpotifyAlbumRaw(raw: Raw, albumId: string, f: SpotifyFullAlbum, extraTracks: Array<{ id: string; track_number: number; disc_number: number }> = []): string {
	const live = raw.prepare(`SELECT id FROM album WHERE id = ? AND merged_into IS NULL`).get(albumId) as { id: string } | undefined;
	if (!live) return albumId;
	const artistIds = (f.artists ?? []).map((a) => a?.name?.trim()).filter((n): n is string => !!n).map((n) => upsertArtistRaw(raw, n).id);
	let id = albumId;
	// A provider-named single artist on a release we'd marked Various stays
	// Various only when Spotify agrees ("Various Artists" is an artist there).
	if (artistIds.length > 0) {
		const various = (f.artists ?? []).length === 1 && /^various artists$/i.test(f.artists[0]!.name.trim());
		id = setAlbumArtistsRaw(raw, albumId, various ? [] : artistIds, various ? 'various' : 'source');
	}
	raw.prepare(`
		UPDATE album SET
			album_type = coalesce(?, album_type),
			total_tracks = coalesce(?, total_tracks),
			release_date = coalesce(?, release_date),
			label = coalesce(?, label),
			upc = coalesce(?, upc),
			cover_url = coalesce(?, cover_url),
			enriched_at = ?,
			updated_at = ?
		WHERE id = ?`).run(
		f.album_type ?? null,
		Number.isFinite(f.total_tracks) ? f.total_tracks : null,
		f.release_date || null,
		f.label?.trim() || null,
		f.external_ids?.upc ?? null,
		f.images?.[0]?.url ?? null,
		Date.now(),
		Date.now(),
		id,
	);
	// Positions: only for tracks that are members of THIS release (a
	// Spotify id can be bound to a canonical row filed under another album
	// — the seam's title guard decided that, not us).
	const setPos = raw.prepare(`
		UPDATE track SET track_number = ?, disc_number = ?
		WHERE album_id = ? AND id IN (SELECT track_id FROM source_link WHERE source = 'spotify' AND source_track_id = ?)`);
	for (const t of [...(f.tracks?.items ?? []), ...extraTracks]) {
		if (!t?.id || !Number.isFinite(t.track_number)) continue;
		setPos.run(t.track_number, Number.isFinite(t.disc_number) ? t.disc_number : 1, id, t.id);
	}
	return id;
}

// Stamp releases the provider no longer serves (null in the batch answer)
// so the loop doesn't re-ask forever.
function markGone(raw: Raw, albumIds: readonly string[]): void {
	const stmt = raw.prepare(`UPDATE album SET enriched_at = ? WHERE id = ?`);
	for (const id of albumIds) stmt.run(Date.now(), id);
}

// Tracks past the first page of a big release: only fetched when one of the
// release's library members still lacks a position after page one.
function needsMorePages(raw: Raw, albumId: string, f: SpotifyFullAlbum): boolean {
	if (!f.tracks?.next) return false;
	const seen = new Set((f.tracks.items ?? []).map((t) => t.id));
	const members = raw.prepare(`
		SELECT sl.source_track_id AS sid FROM track t JOIN source_link sl ON sl.track_id = t.id AND sl.source = 'spotify'
		WHERE t.album_id = ? AND t.deleted_at IS NULL`).all(albumId) as Array<{ sid: string }>;
	return members.some((m) => !seen.has(m.sid));
}

export function createAlbumEnricher(deps: {
	raw: Raw;
	getClient: () => Promise<SpotifyClient | null>;
	disabled?: boolean;
}): AlbumEnricher {
	let running = false;
	let stopped = false;
	let wake: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
		timer = setTimeout(() => { timer = null; wake = null; resolve(); }, ms);
		wake = () => { if (timer) clearTimeout(timer); timer = null; wake = null; resolve(); };
	});
	// Idle until kicked (no timeout): the backlog is empty.
	const idle = (): Promise<void> => new Promise((resolve) => { wake = () => { wake = null; resolve(); }; });

	async function runBatch(client: SpotifyClient): Promise<number> {
		const batch = nextBatch(deps.raw);
		if (batch.length === 0) return 0;
		const byId = new Map(batch.map((b) => [b.spotifyId, b.albumId]));
		const albums = await client.getAlbums([...byId.keys()]);
		const extra = new Map<string, Array<{ id: string; track_number: number; disc_number: number }>>();
		for (const f of albums) {
			const albumId = byId.get(f.id);
			if (albumId && needsMorePages(deps.raw, albumId, f)) extra.set(f.id, await client.getAlbumTracks(f.id));
		}
		let merged = 0;
		deps.raw.transaction(() => {
			const answered = new Set<string>();
			const v4 = emitV4(deps.raw);
			for (const f of albums) {
				const albumId = byId.get(f.id);
				if (!albumId) continue;
				answered.add(f.id);
				if (applySpotifyAlbumRaw(deps.raw, albumId, f, extra.get(f.id)) !== albumId) merged++;
				// What the provider said, for every other device (protocol v4,
				// sync-log/album-meta.ts); before the server reads v4 the
				// backfill states it later.
				if (v4) {
					const names = (f.artists ?? []).map((a) => a?.name?.trim()).filter((n): n is string => !!n);
					const various = names.length === 1 && /^various artists$/i.test(names[0]!);
					emitAlbumMeta(deps.raw, 'spotify', {
						providerId: f.id, albumType: f.album_type ?? null, totalTracks: Number.isFinite(f.total_tracks) ? f.total_tracks : null,
						releaseDate: f.release_date || null, label: f.label?.trim() || null, upc: f.external_ids?.upc ?? null,
						coverUrl: f.images?.[0]?.url ?? null, artists: various ? [] : names, various,
					});
				}
			}
			markGone(deps.raw, batch.filter((b) => !answered.has(b.spotifyId)).map((b) => b.albumId));
		})();
		elog.debug('batch', { asked: batch.length, answered: albums.length, merged });
		return batch.length;
	}

	async function loop(): Promise<void> {
		let total = 0;
		while (!stopped) {
			const client = await deps.getClient().catch(() => null);
			if (!client) { await idle(); continue; }
			try {
				const n = await runBatch(client);
				if (n === 0) {
					if (total > 0) elog.info('album fill caught up', { albums: total });
					total = 0;
					await idle();
					continue;
				}
				total += n;
				await sleep(PACE_MS);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const banned = /quota ban|429/.test(msg);
				elog.warn('album fill batch failed — backing off', { error: msg, banned });
				await sleep(banned ? BAN_BACKOFF_MS : ERROR_BACKOFF_MS);
			}
		}
	}

	return {
		start() {
			if (deps.disabled || running) return;
			running = true;
			stopped = false;
			void loop().finally(() => { running = false; });
		},
		kick() { wake?.(); },
		stop() {
			stopped = true;
			wake?.();
		},
	};
}

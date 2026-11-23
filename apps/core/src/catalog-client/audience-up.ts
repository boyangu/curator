// Library artists up: once a month, the artists of this desktop's own files
// go to the Global Catalog by their store ids, to have their audience read
// for their Reach score (apps/cloud catalog/audience.ts). The cloud cannot
// see a library, and a DJ looks up the artists they play far more than the
// ones they follow.
//
// "Own files" is the Rekordbox tab's membership (rekordbox ∪ local), main
// credits only — not every remixer or featured name. Each goes by its Spotify
// artist id, else its Tidal one: never by name (a namesake would get its
// reads). The catalogue's artist each one lands on is remembered (catalog_ref),
// so the artist's page finds it without asking.
//
// Read-only on the library but for catalog_ref and its own app_setting.
// Signed out, or a server without 'catalog_audience': tried again later.

import type Database from 'better-sqlite3';
import { log } from '@curator/sync-core/log';
import { writeRefs } from './catalog-refs.js';
import type { CatalogArtistRef, CatalogClient } from './service.js';

const alog = log.for('catalog');

const SENT_KEY = 'catalog.audience_sent_at';
const EVERY_MS = 30 * 86_400_000;
const FIRST_AFTER_MS = 3 * 60_000;
const CHECK_EVERY_MS = 6 * 3600_000;
const OWNED_SOURCES = ['rekordbox', 'local'];

// The artists to send: main credits on live tracks with a file, by their
// store id (Spotify first).
export function libraryArtists(raw: Database.Database): CatalogArtistRef[] {
	const rows = raw
		.prepare(
			`with owned as (
				select distinct ta.artist_id as id from track_artist ta
				join track t on t.id = ta.track_id and t.deleted_at is null
				where ta.role is null and exists (select 1 from source_link sl where sl.track_id = t.id and sl.source in (${OWNED_SOURCES.map(() => '?').join(',')}))
			)
			select a.id, a.name,
				(select l.source_id from artist_link l where l.artist_id = a.id and l.source = 'spotify' order by l.source_id limit 1) as spotify,
				(select l.source_id from artist_link l where l.artist_id = a.id and l.source = 'tidal' order by l.source_id limit 1) as tidal
			from artist a join owned on owned.id = a.id
			where a.merged_into is null
			order by a.id`,
		)
		.all(...OWNED_SOURCES) as { id: string; name: string; spotify: string | null; tidal: string | null }[];
	return rows.flatMap((r): CatalogArtistRef[] =>
		r.spotify ? [{ artistId: r.id, name: r.name, provider: 'spotify', providerId: r.spotify }] : r.tidal ? [{ artistId: r.id, name: r.name, provider: 'tidal', providerId: r.tidal }] : [],
	);
}

export type AudienceUpDeps = { raw: Database.Database; client: () => CatalogClient | null; now?: () => number };

export function createAudienceUp(deps: AudienceUpDeps): { start(): void; stop(): void; sendNow(): Promise<boolean> } {
	const now = deps.now ?? Date.now;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running: Promise<boolean> | null = null;

	const sentAt = (): number => {
		const row = deps.raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(SENT_KEY) as { value: string } | undefined;
		const at = row ? Number(row.value) : 0;
		return Number.isFinite(at) ? at : 0;
	};

	// True when the artists went up.
	async function send(): Promise<boolean> {
		const client = deps.client();
		if (!client?.offersAudience()) return false;
		const artists = libraryArtists(deps.raw);
		if (artists.length) {
			const r = await client.enrichArtists(artists);
			const sent = new Map(artists.map((a) => [a.artistId, a]));
			writeRefs(
				deps.raw,
				r.objects.map((o) => ({ entityKind: 'artist', entityId: o.artistId, objectId: o.objectId, objectKind: 'artist', provider: sent.get(o.artistId)?.provider ?? null, providerId: sent.get(o.artistId)?.providerId ?? null })),
				now(),
			);
		}
		deps.raw
			.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(SENT_KEY, String(now()), now());
		return true;
	}

	function sendNow(): Promise<boolean> {
		running ??= send()
			.catch((e: unknown) => {
				alog.warn('library artists could not be sent to the catalogue', undefined, e);
				return false;
			})
			.finally(() => {
				running = null;
			});
		return running;
	}

	function schedule(ms: number): void {
		timer = setTimeout(() => {
			if (now() - sentAt() >= EVERY_MS) void sendNow();
			schedule(CHECK_EVERY_MS);
		}, ms);
		timer.unref?.();
	}

	return {
		start() {
			if (!timer) schedule(FIRST_AFTER_MS);
		},
		stop() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
		sendNow,
	};
}

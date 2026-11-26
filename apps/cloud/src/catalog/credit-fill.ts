// The worker's read for track credits only Deezer stated (credits.ts): the
// release's Spotify album, twenty a call, or its Beatport page, read in full
// and applied like any store's copy of a release (store-links.ts
// applyReleaseClaims) — its tracks placed on the ones held, its artists added
// by ingestion's rules. Deezer's credit stays; the store's joins it.
//
// A task whose release needs nothing any more (another read brought the
// credits, the release was merged away) is dropped without a call. A read
// that leaves a track Deezer's alone — the store lists another edition, or
// no longer lists the album — puts the task off for a month, then longer, so
// a device opening the page does not ask the store again each time. Spotify
// reads draw on the app's daily budget, shared with the resolver and the
// store linker.

import type { CatalogClaim } from '@curator/protocol';
import { fetchAlbums, TrackerRateLimitedError, type BeatportTracker, type SpotifyTracker } from '@curator/catalog-readers';
import type { Db } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { CREDIT_STORES, CREDITS_NEED, shortCreditsSql, type CreditStore } from './credits.js';
import { applyReleaseClaims } from './store-links.js';

// Releases a pass: Spotify's go twenty a call; Beatport's are a page each.
const BATCH: Record<CreditStore, number> = { spotify: 40, beatport: 5 };
const BEATPORT_PACE_MS = 1_500;
// A read that failed is tried again after these hours.
const RETRY_HOURS = [6, 24, 72];
// A read that settled nothing is repeated after these days.
const RECHECK_DAYS = [30, 90, 365];

export type CreditFillDeps = {
	db: Db;
	log: Logger;
	spotify?: SpotifyTracker | null;
	beatport?: BeatportTracker | null;
	batch?: number;
	perDay?: number;
	sleep?: (ms: number) => Promise<void>;
};
// `settled`: releases with no Deezer-only track left; `put off`: read, and one remains.
export type CreditFillReport = { attempted: number; settled: number; putOff: number; dropped: number; parked: CreditStore[] };

type Due = { id: string; attempts: number; pages: { id: string; url: string | null }[] };

export async function runCreditFill(deps: CreditFillDeps): Promise<CreditFillReport> {
	const report: CreditFillReport = { attempted: 0, settled: 0, putOff: 0, dropped: 0, parked: [] };
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const signal = AbortSignal.timeout(5 * 60_000);

	const drop = (id: string, store: CreditStore) => deps.db.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = $2 and provider = $3`, [id, CREDITS_NEED, store]);
	const later = (t: Due, store: CreditStore, hours: number, error: string) =>
		deps.db.query(
			`update curator.catalog_enrich_task set next_due_at = now() + make_interval(hours => $4::int), attempts = attempts + 1, last_error = $5
			where object_id = $1 and need = $2 and provider = $3`,
			[t.id, CREDITS_NEED, store, String(hours), error.slice(0, 200)],
		);
	const failed = (t: Due, store: CreditStore, e: unknown) => later(t, store, RETRY_HOURS[Math.min(t.attempts, RETRY_HOURS.length - 1)]!, e instanceof Error ? e.message : String(e));
	const putOff = async (t: Due, store: CreditStore, why: string) => {
		await later(t, store, 24 * RECHECK_DAYS[Math.min(t.attempts, RECHECK_DAYS.length - 1)]!, why);
		report.putOff++;
	};

	// The store's copies onto the release; true when a track is still Deezer's alone.
	const apply = (t: Due, store: CreditStore, claims: CatalogClaim[]): Promise<boolean> =>
		withSystemTx(deps.db, async (tx) => {
			await applyReleaseClaims(tx, t.id, claims, (c) => `${c.provider} release ${c.providerId} is on the other one; read for this one's track credits`);
			const [row] = await tx.query<{ short: boolean }>(`select ${shortCreditsSql('$1::uuid')} as short`, [t.id]);
			return row!.short === true;
		});
	const settle = async (t: Due, store: CreditStore, claims: CatalogClaim[]) => {
		try {
			if (!claims.length) await putOff(t, store, 'the store no longer lists it');
			else if (await apply(t, store, claims)) await putOff(t, store, 'read; a track is still credited by Deezer alone');
			else {
				await drop(t.id, store);
				report.settled++;
			}
		} catch (e) {
			await failed(t, store, e);
		}
	};

	for (const store of CREDIT_STORES) {
		if (!deps[store]) continue;
		const rows = await deps.db.query<{ id: string; attempts: unknown; wanted: boolean; pages: string | null }>(
			`select et.object_id as id, et.attempts,
				(r.kind = 'release' and r.merged_into is null and ${shortCreditsSql('r.id')}) as wanted,
				(select string_agg(so.provider_id || chr(31) || coalesce(so.url, ''), chr(30) order by so.first_seen_at)
					from curator.catalog_source_object so where so.object_id = r.id and so.kind = 'release' and so.provider = et.provider) as pages
			from curator.catalog_enrich_task et join curator.catalog_object r on r.id = et.object_id
			where et.need = $1 and et.provider = $2 and et.next_due_at <= now()
			order by et.next_due_at
			limit $3::int`,
			[CREDITS_NEED, store, String(deps.batch ?? BATCH[store])],
		);
		const due: Due[] = [];
		for (const r of rows) {
			const pages = (r.pages ?? '').split('\u001e').filter(Boolean).map((p) => p.split('\u001f')).map(([id, url]) => ({ id: id!, url: url || null }));
			if (r.wanted !== true || !pages.length) {
				await drop(r.id, store);
				report.dropped++;
			} else due.push({ id: r.id, attempts: num(r.attempts), pages });
		}
		if (!due.length) continue;

		if (store === 'spotify') {
			const ids = due.flatMap((t) => t.pages.map((p) => p.id));
			const calls = Math.ceil(ids.length / 20);
			const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls('spotify', $1::int, $2::int) as n`, [String(calls), String(deps.perDay ?? 20_000)]);
			if (num(g!.n) < calls) {
				report.parked.push(store);
				continue;
			}
			let albums: Map<string, CatalogClaim>;
			try {
				albums = (await fetchAlbums(deps.spotify!, ids, signal)).claims;
			} catch (e) {
				// Spotify's limit: the tasks stay due for the next pass.
				if (e instanceof TrackerRateLimitedError) report.parked.push(store);
				else for (const t of due) await failed(t, store, e);
				continue;
			}
			for (const t of due) {
				report.attempted++;
				await settle(t, store, t.pages.map((p) => albums.get(p.id)).filter((c): c is CatalogClaim => !!c));
			}
			continue;
		}

		for (const t of due) {
			report.attempted++;
			try {
				const claims: CatalogClaim[] = [];
				for (const p of t.pages) {
					claims.push(await deps.beatport!.fetchRelease(p.id, p.url, signal));
					await sleep(BEATPORT_PACE_MS);
				}
				await settle(t, store, claims);
			} catch (e) {
				// A Cloudflare challenge reads as rate limited (beatport-pages.ts):
				// Beatport is left alone for the rest of the pass.
				if (e instanceof TrackerRateLimitedError) {
					report.attempted--;
					report.parked.push(store);
					break;
				}
				await failed(t, store, e);
			}
		}
	}
	if (report.attempted || report.dropped) deps.log.info('credit_fill_pass', report);
	return report;
}

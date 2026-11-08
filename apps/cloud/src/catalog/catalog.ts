// The 'global_catalog' procedures' domain functions (router.ts stays thin).
// Each runs in one system transaction (db/system-tx.ts): the shared catalogue
// as curator_api, the caller's own rows (device gate, watches) as the caller.

import {
	CATALOG_MAX_CLAIMS,
	ZCatalogClaim,
	type CatalogClaim,
	type CatalogClientReason,
	type CatalogImportInput,
	type CatalogImportResult,
	type CatalogIngestInput,
	type CatalogIngestResult,
	type CatalogObjectDetail,
	type CatalogResolveInput,
	type CatalogResolveResult,
	type CatalogSearchInput,
	type CatalogSearchResult,
	type CatalogWatch,
	type CatalogWatchInput,
	type CatalogWatchResult,
	type FeedEventsInput,
	type FeedEventsResult,
	type FeedRecentInput,
	type FeedRecentResult,
	isLiveKind,
} from '@curator/protocol';
import type { CatalogBrowseInput, CatalogBrowseResult, CatalogEnrichInput, CatalogEnrichResult } from '@curator/protocol';
import { gateDevice, type Caller } from '../account/device-gate.js';
import type { AuditEmit } from '../audit.js';
import type { Db, Queryable } from '../db/db.js';
import { browseForClient } from './browse.js';
import { withSystemTx, type SystemTx } from '../db/system-tx.js';
import { CloudError } from '../errors.js';
import { eventsFor, recentFor, recentForUser } from './events.js';
import { ingestClaims, Ingester, type IngestOutcome } from './ingest.js';
import { detail, resolveRefs, search } from './objects.js';
import { addWatch, liveTarget, listWatches, refreshNow, removeWatch, setMuted } from './watches.js';

export type CatalogDeps = { db: Db; audit: AuditEmit };

export async function gated<T>(deps: CatalogDeps, userId: string, caller: Caller, deviceId: string, fn: (tx: SystemTx) => Promise<T>): Promise<T> {
	return withSystemTx(deps.db, async (tx) => {
		await tx.asUser(userId, (q) => gateDevice(q, caller, deviceId));
		return fn(tx);
	});
}

// What a library import asks of the catalogue once its claims are in: every
// release it named read in full from its stores (release-fill.ts
// runReleaseFiller) — made now or held already, a library's copy names only
// the tracks its owner has — and, when asked, every label it named profiled
// (its pages, then its releases). Arrival order is the order they are worked:
// tasks come due as they are queued, and a library sends its biggest labels
// first.
export async function queueLibraryFollowUps(tx: Queryable, outcomes: { objectId: string; kind: string }[], opts: { profileLabels: boolean }): Promise<{ fills: number; profiles: number }> {
	const ids = (kind: string) => [...new Set(outcomes.filter((o) => o.kind === kind).map((o) => o.objectId))];
	const releases = ids('release');
	const labels = opts.profileLabels ? ids('label') : [];
	const fills = releases.length
		? (
				await tx.query(
					`insert into curator.catalog_enrich_task (object_id, need, provider)
					select r, 'fill', 'catalog' from unnest($1::uuid[]) with ordinality as t(r, n) order by n
					on conflict do nothing returning 1`,
					[`{${releases.join(',')}}`],
				)
			).length
		: 0;
	const profiles = labels.length
		? (
				await tx.query(
					`insert into curator.catalog_enrich_task (object_id, need, provider)
					select o.id, 'profile', 'catalog' from curator.catalog_object o
					where o.id = any($1::uuid[]) and o.kind = 'label' and o.merged_into is null
					and not exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider <> 'user')
					on conflict do nothing returning 1`,
					[`{${labels.join(',')}}`],
				)
			).length
		: 0;
	return { fills, profiles };
}

// Claims are validated one by one, like ops in a push: one malformed claim is
// refused alone and the rest are ingested.
export function parseClaims(raw: unknown[]): { claims: CatalogClaim[]; index: number[]; rejected: Map<number, string> } {
	if (raw.length > CATALOG_MAX_CLAIMS) throw new CloudError('PAYLOAD_TOO_LARGE', 'batch_too_large');
	const claims: CatalogClaim[] = [];
	const index: number[] = [];
	const rejected = new Map<number, string>();
	raw.forEach((c, i) => {
		const r = ZCatalogClaim.safeParse(c);
		if (r.success) {
			claims.push(r.data);
			index.push(i);
		} else rejected.set(i, r.error.issues[0]?.path.join('.') || 'invalid');
	});
	return { claims, index, rejected };
}

// The first answer to a (producer, key) pair, if this batch was ingested
// before: a device retrying after a lost response gets the same result and
// nothing is ingested twice.
export async function priorBatch<T>(tx: SystemTx, producer: string, key: string): Promise<T | null> {
	const [row] = await tx.query<{ result: string }>(`select result::text as result from curator.catalog_ingest_batch where producer = $1 and idempotency_key = $2`, [producer, key]);
	return row ? (JSON.parse(row.result) as T) : null;
}

export async function recordBatch(tx: SystemTx, producer: string, key: string, reason: string, claims: number, created: number, attached: number, result: unknown): Promise<void> {
	await tx.query(
		`insert into curator.catalog_ingest_batch (producer, idempotency_key, reason, claims, created, attached, result)
		values ($1, $2, $3, $4::int, $5::int, $6::int, $7::text::jsonb) on conflict do nothing`,
		[producer, key, reason, String(claims), String(created), String(attached), JSON.stringify(result)],
	);
}

// A device's facts-up (reason 'enrichment'): what its Beatport / Traxsource
// lookups found for a card — bpm, key, genre, label text — and the Spotify
// ids its lazy match found for a release and its tracks, attached to the
// objects the catalogue already holds (by the provider's id, the UPC or ISRC
// with the length guard, or the title / artist / date rules: identity.ts),
// so every device's card carries them and none re-searches what another
// found. Never creates an object, never an event, never a follow-up task; a
// claim naming nothing known is `unknown` (an undefined outcome) and the
// device moves on.
async function attachFacts(tx: SystemTx, claims: CatalogClaim[]): Promise<{ outcomes: (IngestOutcome | undefined)[]; created: number; attached: number }> {
	const ingester = new Ingester(tx, { reason: 'enrichment' });
	const outcomes: (IngestOutcome | undefined)[] = [];
	for (const c of claims) {
		const known = c.kind === 'recording' ? await ingester.attachIfKnown(c, { genres: true }) : c.kind === 'release' ? await ingester.attachIfKnown(c) : null;
		outcomes.push(known ?? undefined);
	}
	return { outcomes, created: 0, attached: ingester.stats.attached };
}

export async function ingest(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogIngestInput): Promise<CatalogIngestResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		const producer = `user:${userId}`;
		const prior = await priorBatch<CatalogIngestResult>(tx, producer, input.idempotencyKey);
		if (prior) return { ...prior, duplicate: true };
		const { claims, index, rejected } = parseClaims(input.claims);
		const r = input.reason === 'enrichment' ? await attachFacts(tx, claims) : await ingestClaims(tx, claims, { reason: input.reason satisfies CatalogClientReason });
		const results: CatalogIngestResult['results'] = input.claims.map((_, i) => {
			const at = index.indexOf(i);
			if (at === -1) return { rejected: rejected.get(i) ?? 'invalid' };
			const o = r.outcomes[at];
			return o ? { objectId: o.objectId, created: o.created } : { rejected: 'unknown' };
		});
		const result: CatalogIngestResult = { results, created: r.created, attached: r.attached, duplicate: false };
		if (input.reason === 'library_import') await queueLibraryFollowUps(tx, r.outcomes.filter((o): o is IngestOutcome => o !== undefined), { profileLabels: false });
		await recordBatch(tx, producer, input.idempotencyKey, input.reason, claims.length, r.created, r.attached, result);
		deps.audit('catalog_ingested', { reason: input.reason, claims: claims.length, rejected: rejected.size, created: r.created, attached: r.attached });
		return result;
	});
}

export function resolve(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogResolveInput): Promise<CatalogResolveResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => ({ objects: await resolveRefs(tx, input.refs) }));
}

export function searchObjects(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogSearchInput): Promise<CatalogSearchResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => ({ objects: await search(tx, input.q, input.kind, input.limit ?? 10) }));
}

export function get(deps: CatalogDeps, userId: string, caller: Caller, input: { deviceId: string; id: string }): Promise<CatalogObjectDetail> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		const d = await detail(tx, input.id);
		if (!d) throw new CloudError('NOT_FOUND', 'catalog_not_found');
		return d;
	});
}

export function browse(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogBrowseInput): Promise<CatalogBrowseResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		const v = await browseForClient(tx, input.id);
		if (!v) throw new CloudError('NOT_FOUND', 'catalog_not_found');
		return v;
	});
}

// A watch names an object found by search, or a claim for one found at a
// provider (ingested first, as a registration: no events).
export async function watch(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogWatchInput): Promise<CatalogWatchResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		let objectId = input.objectId;
		if (input.claim !== undefined) {
			const parsed = ZCatalogClaim.safeParse(input.claim);
			if (!parsed.success || !isLiveKind(parsed.data.kind)) throw new CloudError('PRECONDITION_FAILED', 'catalog_claim_invalid');
			const r = await ingestClaims(tx, [parsed.data], { reason: 'manual_registration' });
			objectId = r.outcomes[0]!.objectId;
		}
		const target = await liveTarget(tx, objectId!);
		const added = await addWatch(tx, userId, target.id, input.source);
		const [w] = await listWatches(tx, userId, target.id);
		deps.audit('catalog_watch_set', { kind: target.kind, added, source: input.source });
		return { watch: w!, recent: await recentFor(tx, target.id) };
	});
}

export function unwatch(deps: CatalogDeps, userId: string, caller: Caller, input: { deviceId: string; objectId: string }): Promise<{ ok: true }> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		await removeWatch(tx, userId, input.objectId);
		return { ok: true };
	});
}

// A device asks the catalogue to profile labels it holds and read their
// releases once (profile/label-profiler.ts, trackers/backfill.ts): no watch,
// no events. Only labels; other kinds are ignored, as are unknown ids.
export function enrich(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogEnrichInput): Promise<CatalogEnrichResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		const rows = await tx.query(
			`insert into curator.catalog_enrich_task (object_id, need, provider)
			select o.id, 'profile', 'catalog' from curator.catalog_object o
			where o.id = any($1::uuid[]) and o.kind = 'label' and o.merged_into is null
			on conflict do nothing returning 1`,
			[`{${input.objectIds.join(',')}}`],
		);
		deps.audit('catalog_enrich_requested', { labels: input.objectIds.length, queued: rows.length });
		return { queued: rows.length };
	});
}

export function mute(deps: CatalogDeps, userId: string, caller: Caller, input: { deviceId: string; objectId: string; muted: boolean }): Promise<{ ok: true }> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		await setMuted(tx, userId, input.objectId, input.muted);
		return { ok: true };
	});
}

export function watches(deps: CatalogDeps, userId: string, caller: Caller, input: { deviceId: string }): Promise<CatalogWatch[]> {
	return gated(deps, userId, caller, input.deviceId, (tx) => listWatches(tx, userId));
}

// Bulk watches from a device (the follows it already had at a provider):
// claims ingested as registrations, then each live one watched.
export async function importWatches(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogImportInput): Promise<CatalogImportResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		const producer = `import:${userId}`;
		const prior = await priorBatch<CatalogImportResult>(tx, producer, input.idempotencyKey);
		if (prior) return { ...prior, duplicate: true };
		const { claims, rejected } = parseClaims(input.claims);
		const live = claims.filter((c) => isLiveKind(c.kind));
		const r = await ingestClaims(tx, live, { reason: 'manual_registration' });
		let watched = 0;
		for (const o of r.outcomes) if (await addWatch(tx, userId, o.objectId, input.source)) watched++;
		const result: CatalogImportResult = {
			created: r.created,
			existing: r.outcomes.length - r.outcomes.filter((o) => o.created).length,
			watched,
			rejected: rejected.size + (claims.length - live.length),
			duplicate: false,
		};
		await recordBatch(tx, producer, input.idempotencyKey, 'manual_registration', live.length, r.created, r.attached, result);
		deps.audit('catalog_import', { claims: input.claims.length, created: result.created, watched, rejected: result.rejected });
		return result;
	});
}

export function refresh(deps: CatalogDeps, userId: string, caller: Caller, input: { deviceId: string; objectId: string }): Promise<{ dueAt: number | null }> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		// Only an object the caller watches.
		const mine = await tx.asUser(userId, (q) => q.query(`select 1 from curator.catalog_watch where object_id = $1`, [input.objectId]));
		if (!mine.length) throw new CloudError('NOT_FOUND', 'catalog_not_found');
		const dueAt = await refreshNow(tx, input.objectId);
		deps.audit('catalog_refresh_requested', { accepted: dueAt !== null });
		return { dueAt };
	});
}

export function events(deps: CatalogDeps, userId: string, caller: Caller, input: FeedEventsInput): Promise<FeedEventsResult> {
	return gated(deps, userId, caller, input.deviceId, (tx) => eventsFor(tx, userId, input.afterSeq, input.limit ?? 100));
}

export function recent(deps: CatalogDeps, userId: string, caller: Caller, input: FeedRecentInput): Promise<FeedRecentResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => ({ events: await recentForUser(tx, userId, input.days) }));
}

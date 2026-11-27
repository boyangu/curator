// What a device read for the work it was handed ('catalog_device_work',
// catalog.workReport): checked, saved, remembered, and answered with any
// follow-up work.
//
// A report is evidence, never an instruction, and a job id in it is a name:
// every result is judged against what the catalogue would hand out now.
//   find     only a page the cloud names for that object (naming.ts, judged
//            again here), so a device cannot read a namesake's page into an
//            artist. A probe's listing must agree with the label's other page
//            before anything of it is kept; one that does not is never read
//            again and the operator is told. A page the catalogue did not
//            hold ("new") must be named by its own listing, and one it holds
//            after all is judged as any other. What is kept is ingested as a
//            tracker's poll would be, and a new release of an artist or label
//            someone follows is announced at once (Guy, 2026-11-26) — the
//            weekly reading's own memory (catalog_cursor) is never touched,
//            so a release a visit found is still the weekly reading's to
//            announce when nobody followed it at the time.
//   release  a page the release already has is its tracklist, kept — taken
//            first, so what is found elsewhere is compared with it. A page on
//            another store is the same release only if the cloud's own,
//            strict comparison of the two tracklists says so (library-logic
//            confirmRelease); what it cannot confirm is not linked. A check
//            is taken only of a page the release has; one that "differs" is
//            compared again here, and where the cloud agrees the link stays
//            and the operator is asked.
//   facts    only onto the track of the release the row names, from the
//            store's own page of it, and only when that store's track agrees
//            with it (catalog.ts agrees).
// Every answer is remembered (catalog_work_state) — found, not there, not
// confirmed, held by another, the page gone or empty, the store failing — so
// no device is asked the same thing before its age passes. Everything a
// result put into the catalogue or found against it is recorded with the
// account, device and job (catalog_work_item) — not what a listing only
// showed again.
//
// One transaction a report, a savepoint a result (db.ts Tx: each result runs
// on its savepoint's own handle): a result the cloud fails to save is
// answered `failed` and the rest stands. Nothing is leased, so two devices
// report one page or one release at the same moment as a matter of course:
// a report takes its turn on every page and release it is about before it
// judges any of them — all at once and in one order, so two reports naming
// the same ones in another order cannot hold each other up — and waits for
// another's turn a few seconds at most (the device sends it again).

import {
	CATALOG_WORK_STORES,
	parseWorkResult,
	type CatalogClaim,
	type CatalogDeviceProfile,
	type CatalogJob,
	type CatalogRef,
	type CatalogTrackerPoll,
	type CatalogWork,
	type CatalogWorkOutcome,
	type CatalogWorkReportResult,
	type CatalogWorkResult,
	type CatalogWorkStore,
} from '@curator/protocol';
import { confirmRelease, isDistributor, listingsAgree, normalizeIsrc } from '@curator/library-logic';
import type { Caller } from '../../account/device-gate.js';
import type { Queryable } from '../../db/db.js';
import { numOrNull } from '../../db/db.js';
import type { SystemTx } from '../../db/system-tx.js';
import { attachFacts, gated, type CatalogDeps } from '../catalog.js';
import { raiseReleaseEvents } from '../events.js';
import { findRepresentation, findRepresentations, follow } from '../identity.js';
import { raise } from '../inbox.js';
import { ingestClaims } from '../ingest.js';
import { pageTracks } from '../pages.js';
import { applyReleaseClaims } from '../store-links.js';
import { deviceHolder } from '../trackers/sweep.js';
import { releaseLeases } from './background.js';
import { forgetPages, labelTitlesByStore, namedPages, ownId, pageKey, WORK_ACTOR } from './naming.js';
import { FIND_STORES, NEW_PAGES, parseJobId, planPage, planSafely, scopeOf, type JobRef } from './plan.js';
import { loadPlanInputs, type PlanInputs } from './settings.js';

// A release a device found is announced to followers inside this window, as
// the trackers' own reads are (trackers/sweep.ts eventWindowDays).
const EVENT_WINDOW_DAYS = 14;

// The store calls a report may put against the day: what its results could
// have taken and no more, whatever it states. The count is shared with the
// cloud's own reading (provider_budget), so one device's word must not be
// able to spend everyone's day.
const CALLS_BASE = 10;
const CALLS_PER_JOB = 30;
const CALLS_PER_FACT = 3;
// And never more than this a store, whatever the report holds.
const CALLS_MAX = 600;
// How long a report waits for another's turn on a page or a release.
const REPORT_LOCK_WAIT = '5s';

export type WorkReportInput = { deviceId: string; idempotencyKey: string; profile: CatalogDeviceProfile; hints?: CatalogRef[]; results: unknown[]; calls?: Partial<Record<CatalogWorkStore, number>> };

type Outcome = { jobId: string; outcome: CatalogWorkOutcome; note?: string };
// `lookups`: the store lookups a facts result is taken to have made — the
// report's own count, never sent back.
type Judged = Outcome & { lookups?: number };
type Item = { jobId: string; objectId: string | null; provider: string; kind: string; providerId: string; outcome: string };
type StateRow = { objectId: string; job: string; provider: string; providerId?: string; outcome: string; cursor?: unknown; evidence?: unknown };

type Ctx = {
	tx: SystemTx;
	userId: string;
	deviceId: string;
	hints: readonly CatalogRef[];
	items: Item[];
	changed: Set<string>;
	// Objects whose listing was read: their page is planned again for the follow-up.
	listed: Set<string>;
};

const WORK_STORES: ReadonlySet<string> = new Set(CATALOG_WORK_STORES);

// What was learned, in one statement; of two rows for one key the later stands.
async function remember(c: Ctx, rows: readonly StateRow[]): Promise<void> {
	const last = new Map<string, StateRow>();
	for (const r of rows) last.set(`${r.objectId}|${r.job}|${r.provider}|${r.providerId ?? ''}`, r);
	if (!last.size) return;
	await c.tx.query(
		`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome, cursor, evidence, user_id, device_id)
		select x.object_id, x.job, x.provider, x.provider_id, x.outcome, x.cursor, x.evidence, $2::uuid, $3
		from jsonb_to_recordset($1::text::jsonb) as x(object_id uuid, job text, provider text, provider_id text, outcome text, cursor jsonb, evidence jsonb)
		on conflict (object_id, job, provider, provider_id) do update set outcome = excluded.outcome, answered_at = now(),
			cursor = coalesce(excluded.cursor, curator.catalog_work_state.cursor), evidence = excluded.evidence, user_id = excluded.user_id, device_id = excluded.device_id`,
		[JSON.stringify([...last.values()].map((r) => ({ object_id: r.objectId, job: r.job, provider: r.provider, provider_id: r.providerId ?? '', outcome: r.outcome, cursor: r.cursor ?? null, evidence: r.evidence ?? null }))), c.userId, c.deviceId],
	);
}

// One at a time per page or release, to the end of the report's transaction.
const turn = (tx: Queryable, key: string): Promise<unknown> => tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [key]);

async function objectOf(tx: Queryable, id: string): Promise<{ id: string; kind: string; name: string } | null> {
	const [o] = await tx.query<{ id: string; kind: string; name: string }>(`select id, kind, name from curator.catalog_object where id = $1`, [await follow(tx, id)]);
	return o ?? null;
}

// ── find ────────────────────────────────────────────────────────────────────

// What the listing itself says the page is: the page's own claim, or a
// release on it crediting the page.
function namedBy(poll: CatalogTrackerPoll, ref: { provider: string; providerId: string }): 'artist' | 'label' | null {
	const is = (c: CatalogClaim | null | undefined): boolean => c?.provider === ref.provider && c.providerId === ref.providerId;
	if (poll.self) return is(poll.self) && (poll.self.kind === 'artist' || poll.self.kind === 'label') ? poll.self.kind : null;
	if (poll.children.some((ch) => is(ch.label))) return 'label';
	return poll.children.some((ch) => ch.artists?.some(is)) ? 'artist' : null;
}

// A probe whose reference page has no reading yet: taken again once the rest
// of the report is in (the reference's own listing is often in it).
const WAITS = 'its other page is read first';

// The releases a listing may bring: the page's own store's, crediting the
// page. Anything else a device put in a listing is not that page's word —
// and would be announced to the page's followers as if it were.
function listed(poll: CatalogTrackerPoll, ref: { provider: string; providerId: string }, kind: 'artist' | 'label'): CatalogClaim[] {
	const is = (c: CatalogClaim | null | undefined): boolean => c?.provider === ref.provider && c.providerId === ref.providerId;
	return poll.children.filter((ch) => ch.kind === 'release' && ch.provider === ref.provider && (kind === 'label' ? is(ch.label) : !!ch.artists?.some(is)));
}

async function applyFind(c: Ctx, ref: Extract<JobRef, { kind: 'find' }>, r: Extract<CatalogWorkResult, { kind: 'find' }>): Promise<Outcome> {
	const jobId = r.jobId;
	if (!WORK_STORES.has(ref.provider)) return { jobId, outcome: 'refused', note: 'not a store devices read' };
	const poll = r.poll;
	if (!poll) return { jobId, outcome: 'refused', note: 'no listing' };
	const { tx } = c;
	await turn(tx, `work.page:${pageKey(ref)}`);
	// A listing is of the page it was read from, or of nothing.
	const says = namedBy(poll, ref);
	if (poll.self && !says) return { jobId, outcome: 'refused', note: 'the listing is of another page' };

	let object = ref.objectId ? await objectOf(tx, ref.objectId) : null;
	if (ref.objectId && !object) return { jobId, outcome: 'refused', note: 'not an artist or a label' };
	const fresh = !object;
	if (!object) {
		// A page the catalogue did not hold when it asked: the device named it,
		// and only its own listing can say what it is.
		if (!says || !(NEW_PAGES[says] as string[]).includes(ref.provider) || !ownId(ref.provider, ref.providerId)) return { jobId, outcome: 'refused', note: 'the listing does not name the page' };
		// A distributor's page is not a label's (naming.ts).
		if (says === 'label' && poll.self && isDistributor(poll.self.name)) return { jobId, outcome: 'refused', note: 'a distributor, not a label' };
		const blocked = await tx.query(`select 1 from curator.catalog_source_block where provider = $1 and kind = $2 and provider_id = $3`, [ref.provider, says, ref.providerId]);
		if (blocked.length) return { jobId, outcome: 'refused', note: 'blocked page' };
		// Held after all (another device brought it in meanwhile, or it never
		// was unknown): judged as any page of that object.
		const holder = await findRepresentation(tx, { provider: ref.provider as CatalogClaim['provider'], kind: says, providerId: ref.providerId });
		object = holder ? await objectOf(tx, holder) : null;
	}

	let probing = false;
	if (object) {
		if (object.kind !== 'artist' && object.kind !== 'label') return { jobId, outcome: 'refused', note: 'not an artist or a label' };
		// Only a page the cloud names: never a page the device chose.
		const page = (await namedPages(tx, { id: object.id, kind: object.kind, name: object.name }, c.hints)).find((p) => pageKey(p) === pageKey(ref));
		if (!page) return { jobId, outcome: 'refused', note: 'not a page the catalogue asked for' };
		// Compared with a listing or not at all: its reference is read first.
		if (page.awaits) return { jobId, outcome: 'kept', note: WAITS };
		probing = page.probe;
	}
	const kind = (object?.kind ?? says) as 'artist' | 'label';
	if (says && says !== kind) return { jobId, outcome: 'refused', note: 'the listing is of another page' };
	const children = listed(poll, ref, kind);
	if (poll.children.length && !children.length) return { jobId, outcome: 'refused', note: 'the listing is of another page' };

	// A page never read before is compared with the label's other page first
	// (library-logic listingsAgree). A listing with nothing on it, or a
	// reference that lists nothing, says nothing either way.
	if (probing && object && children.length) {
		const other = ref.provider === 'beatport' ? 'bandcamp' : 'beatport';
		const anchor = (await labelTitlesByStore(tx, object.id, [other])).get(other) ?? [];
		const verdict = listingsAgree(anchor, children.map((ch) => ch.name));
		if (anchor.length && !verdict.agrees) {
			await remember(c, [{ objectId: object.id, job: 'find', provider: ref.provider, providerId: ref.providerId, outcome: 'disagrees', evidence: { shared: verdict.shared, listed: children.length } }]);
			await forgetPages(tx, object.id);
			await raise(tx, {
				kind: 'work.pages',
				severity: 'notice',
				title: `A ${ref.provider} page attached to this label lists ${children.length} releases, ${verdict.shared} of them on its other page — not kept, and not read again for three months. Is it theirs?`,
				subjects: [object.id],
				evidence: { page: { provider: ref.provider, id: ref.providerId }, shared: verdict.shared, titles: children.slice(0, 20).map((ch) => ch.name) },
				actor: WORK_ACTOR,
				key: `probe:${ref.provider}:${ref.providerId}`,
			});
			c.items.push({ jobId, objectId: object.id, provider: ref.provider, kind, providerId: ref.providerId, outcome: 'disagrees' });
			return { jobId, outcome: 'kept', note: 'the page does not list what the label holds' };
		}
	}

	// Ingested as a tracker's poll is. The page's own claim goes first only
	// where the catalogue did not hold the page — a new artist or label is
	// created by it. One it holds is not renamed or given a picture or a link
	// by what a device says its page says: that is the weekly reading's.
	const lead = poll.self && !object ? 1 : 0;
	const claims = lead ? [poll.self!, ...children] : children;
	const r1 = await ingestClaims(tx, claims, { reason: 'tracker' });
	const outcomes = r1.outcomes.slice(lead);
	const objectId = object?.id ?? (await findRepresentation(tx, { provider: ref.provider as CatalogClaim['provider'], kind, providerId: ref.providerId }));
	// namedBy saw the page credited, so ingestion made it; a listing that got
	// past both is not kept (the result's savepoint takes what it brought).
	if (!objectId) throw new Error('the listing did not bring its page');

	const more = poll.listingHash.startsWith('pending:');
	await remember(c, [{ objectId, job: 'find', provider: ref.provider, providerId: ref.providerId, outcome: more ? 'more' : 'ok', cursor: poll.cursor }]);
	// What the catalogue holds of the label changed: its pages are compared anew.
	if (kind === 'label') await forgetPages(tx, objectId);
	c.listed.add(objectId);
	if (fresh) c.changed.add(objectId);
	// Recorded: what this report put into the catalogue — the page itself
	// when it was not held, and each release it had not seen. What it only
	// listed again is no one's doing (and would be a row per release per visit).
	if (!object) c.items.push({ jobId, objectId, provider: ref.provider, kind, providerId: ref.providerId, outcome: 'created' });
	const releases = outcomes.filter((o) => o.kind === 'release');
	for (const [i, o] of outcomes.entries()) {
		if (!o.created) continue;
		const ch = claims[i + lead]!;
		c.items.push({ jobId, objectId, provider: ch.provider, kind: ch.kind, providerId: ch.providerId, outcome: 'created' });
		c.changed.add(o.objectId);
		c.changed.add(objectId);
	}

	// A new release of something someone follows is announced now.
	const [w] = await tx.query<{ watched: boolean }>(`select watch_count > 0 as watched from curator.catalog_object where id = $1`, [objectId]);
	if (w?.watched && releases.length) {
		await raiseReleaseEvents(
			tx,
			releases.map((o) => ({ releaseId: o.objectId, trackedId: objectId, publishedAt: claims[outcomes.indexOf(o) + lead]?.publishedAt ?? null, windowDays: EVENT_WINDOW_DAYS })),
			{ nowMs: tx.nowMs, by: deviceHolder(c.deviceId) },
		);
	}
	return { jobId, outcome: 'saved' };
}

// ── release ─────────────────────────────────────────────────────────────────

type Held = { title: string; durationSec: number | null; isrc: string | null };

async function heldWithCodes(tx: Queryable, releaseId: string): Promise<Held[]> {
	const rows = await tx.query<{ name: string; duration_sec: unknown; isrc: string | null }>(
		`select o.name, o.duration_sec, (select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc
		from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst and o.merged_into is null
		where e.src = $1 and e.kind = 'release-recording' order by e.position nulls last, o.id`,
		[releaseId],
	);
	return rows.map((r) => ({ title: r.name, durationSec: numOrNull(r.duration_sec), isrc: r.isrc }));
}

// Who a release is by is not Deezer's to say: its artist pages file every act
// of a name together, so a credit read there hands one artist the others'
// releases. Its page is taken for the tracklist, the codes and the facts —
// here, whatever the device left on the claim.
function withoutCredits(c: CatalogClaim): CatalogClaim {
	const bare = (x: CatalogClaim): CatalogClaim => {
		const { artists: _artists, ...rest } = x;
		return rest;
	};
	return { ...bare(c), ...(c.recordings ? { recordings: c.recordings.map(bare) } : {}) };
}

const tracksOf = (c: CatalogClaim): Held[] =>
	(c.recordings ?? []).map((r) => ({ title: r.name, durationSec: r.facts?.durationSec ?? null, isrc: normalizeIsrc(r.identifiers?.find((i) => i.namespace === 'isrc')?.value) }));

async function applyRelease(c: Ctx, ref: Extract<JobRef, { kind: 'release' }>, r: Extract<CatalogWorkResult, { kind: 'release' }>): Promise<Outcome> {
	const { tx } = c;
	const jobId = r.jobId;
	const release = await objectOf(tx, ref.releaseId);
	if (release?.kind !== 'release') return { jobId, outcome: 'refused', note: 'not a release' };
	const releaseId = release.id;
	await turn(tx, `work.release:${releaseId}`);
	const pages = await tx.query<{ provider: string; provider_id: string }>(`select provider, provider_id from curator.catalog_source_object where object_id = $1 and kind = 'release'`, [releaseId]);
	const on = new Set(pages.map((p) => p.provider));
	const notes: string[] = [];
	const state: StateRow[] = [];
	let saved = 0;
	let unconfirmed = 0;

	// The release's own pages first, whatever order the device sent: what it
	// found elsewhere is compared with the tracklist they bring.
	const holders = await findRepresentations(tx, r.found.map((f) => f.claim));
	const own = (cl: CatalogClaim): boolean => holders.get(`${cl.provider}|${cl.kind}|${cl.providerId}`) === releaseId;
	const found = [...r.found].sort((a, b) => Number(own(b.claim)) - Number(own(a.claim)));
	let held = await heldWithCodes(tx, releaseId);
	for (const f of found) {
		const mine = own(f.claim);
		const claim = f.claim.provider === 'deezer' ? withoutCredits(f.claim) : f.claim;
		if (claim.kind !== 'release' || !WORK_STORES.has(claim.provider)) {
			notes.push(`${claim.provider}: not a release page a device reads`);
			continue;
		}
		if (mine) {
			// Its own page, read in full: its tracklist — or the word that the
			// page has none, so it is not read at every visit.
			if (!claim.recordings?.length) {
				state.push({ objectId: releaseId, job: 'check', provider: claim.provider, providerId: claim.providerId, outcome: 'empty' });
				c.items.push({ jobId, objectId: releaseId, provider: claim.provider, kind: 'release', providerId: claim.providerId, outcome: 'empty' });
				continue;
			}
			// Onto a tracklist the release already has, only as the same
			// release: a page that reads as another is not laid over it. The
			// link stays, and the operator is asked.
			if (held.length && !confirmRelease(held, tracksOf(claim), { strict: true })) {
				unconfirmed++;
				state.push({ objectId: releaseId, job: 'check', provider: claim.provider, providerId: claim.providerId, outcome: 'disagrees' });
				await raise(tx, {
					kind: 'work.link',
					severity: 'notice',
					title: `A device read the ${claim.provider} page of this release and found another tracklist — the link stays. Is the page this release?`,
					subjects: [releaseId],
					evidence: { page: { provider: claim.provider, id: claim.providerId, url: claim.url ?? null }, theirs: tracksOf(claim).map((t) => t.title), held: held.map((t) => t.title) },
					actor: WORK_ACTOR,
					key: `check:${claim.provider}:${claim.providerId}`,
				});
				c.items.push({ jobId, objectId: releaseId, provider: claim.provider, kind: 'release', providerId: claim.providerId, outcome: 'differs' });
				continue;
			}
		} else {
			if (!(FIND_STORES as string[]).includes(claim.provider) || on.has(claim.provider)) {
				notes.push(`${claim.provider}: not a store this release is looked for at`);
				continue;
			}
			const pairs = held.length ? confirmRelease(held, tracksOf(claim), { strict: true }) : null;
			if (!pairs) {
				unconfirmed++;
				state.push({ objectId: releaseId, job: 'release', provider: claim.provider, outcome: 'unconfirmed', evidence: { page: claim.providerId, how: f.how, held: held.length, theirs: claim.recordings?.length ?? 0 } });
				c.items.push({ jobId, objectId: releaseId, provider: claim.provider, kind: 'release', providerId: claim.providerId, outcome: 'unconfirmed' });
				continue;
			}
		}
		const applied = await applyReleaseClaims(tx, releaseId, [claim], (x) => `a device found ${x.provider} release ${x.providerId} for this one (${f.how}); it is held by the other`);
		if (applied.conflicts.length) {
			notes.push(`${claim.provider}: held by another release, sent for review`);
			state.push({ objectId: releaseId, job: 'release', provider: claim.provider, outcome: 'conflict', evidence: { page: claim.providerId, heldBy: applied.conflicts[0]!.heldBy } });
		} else {
			saved++;
			c.changed.add(releaseId);
			on.add(claim.provider);
			if (mine) held = await heldWithCodes(tx, releaseId);
			// Read in full: not again until its confirmation is due (plan.ts).
			state.push({ objectId: releaseId, job: 'check', provider: claim.provider, providerId: claim.providerId, outcome: 'read' });
			// Tidal and Apple are the cloud's to ask next (followup.ts), by the
			// codes the page brought.
			await tx.query(`insert into curator.catalog_work_followup (release_id) values ($1) on conflict do nothing`, [releaseId]);
		}
		c.items.push({ jobId, objectId: releaseId, provider: claim.provider, kind: 'release', providerId: claim.providerId, outcome: applied.conflicts.length ? 'conflict' : mine ? 'tracklist' : 'linked' });
	}
	// "Not there" only of a store it would be looked for at.
	for (const store of new Set(r.notFound)) {
		if (!(FIND_STORES as string[]).includes(store) || on.has(store)) continue;
		state.push({ objectId: releaseId, job: 'release', provider: store, outcome: 'not_found' });
		c.items.push({ jobId, objectId: releaseId, provider: store, kind: 'release', providerId: '', outcome: 'not_found' });
	}
	// A page of the release the device was told to read and the store no
	// longer has: remembered, so it is not read at every visit. Nothing else
	// is taken of a check until the catalogue asks for them (the 90-day
	// confirmation is not planned yet): a volunteered verdict is no evidence.
	let unasked = 0;
	for (const check of r.checks) {
		if (check.verdict !== 'gone' || !pages.some((p) => p.provider === check.handle.provider && p.provider_id === check.handle.id)) {
			unasked++;
			continue;
		}
		state.push({ objectId: releaseId, job: 'check', provider: check.handle.provider, providerId: check.handle.id, outcome: 'gone' });
		c.items.push({ jobId, objectId: releaseId, provider: check.handle.provider, kind: 'release', providerId: check.handle.id, outcome: 'gone' });
	}
	if (unasked) notes.push(`${unasked} checks the catalogue did not ask for`);
	await remember(c, state);
	if (notes.length) return { jobId, outcome: saved ? 'saved' : 'kept', note: notes.join('; ').slice(0, 300) };
	return { jobId, outcome: saved ? 'saved' : unconfirmed ? 'unconfirmed' : 'kept' };
}

// ── facts ───────────────────────────────────────────────────────────────────

const FACT_HOSTS: Record<string, RegExp> = { beatport: /(^|\.)beatport\.com$/, traxsource: /(^|\.)traxsource\.com$/ };

// The store's own page of the track, as the row's evidence.
function storePage(provider: string, url: string | null | undefined): boolean {
	const host = FACT_HOSTS[provider];
	if (!host || !url) return false;
	try {
		const u = new URL(url);
		return u.protocol === 'https:' && host.test(u.hostname);
	} catch {
		return false;
	}
}

async function applyFacts(c: Ctx, ref: Extract<JobRef, { kind: 'facts' }>, r: Extract<CatalogWorkResult, { kind: 'facts' }>): Promise<Judged> {
	const { tx } = c;
	const jobId = r.jobId;
	const release = await objectOf(tx, ref.releaseId);
	if (release?.kind !== 'release') return { jobId, outcome: 'refused', note: 'not a release' };
	const releaseId = release.id;
	const onRelease = new Set(
		(await tx.query<{ id: string }>(`select dst as id from curator.catalog_edge where src = $1 and kind = 'release-recording'`, [releaseId])).map((x) => x.id),
	);
	// Only tracks of the release named, from the store's own track page — and
	// a store id the catalogue already holds must be that track's: the row's
	// recording is the device's word, the id is where the facts would land.
	const holders = await findRepresentations(tx, r.rows.map((x) => x.claim));
	const state: StateRow[] = [];
	const rows = r.rows.filter((x) => {
		if (!onRelease.has(x.recordingId) || x.claim.kind !== 'recording' || !storePage(x.claim.provider, x.claim.url)) return false;
		const holder = holders.get(`${x.claim.provider}|${x.claim.kind}|${x.claim.providerId}`);
		if (!holder || holder === x.recordingId) return true;
		// The store's track is another recording's here (a twin): answered,
		// so the same lookup is not handed out at every visit.
		state.push({ objectId: x.recordingId, job: 'facts', provider: x.claim.provider, outcome: 'unplaced' });
		return false;
	});
	let attached = 0;
	if (rows.length) {
		const out = await attachFacts(tx, rows.map((x) => ({ ...x.claim, about: x.recordingId })));
		for (const [i, o] of out.outcomes.entries()) {
			const x = rows[i]!;
			const placed = o?.objectId === x.recordingId;
			c.items.push({ jobId, objectId: x.recordingId, provider: x.claim.provider, kind: 'recording', providerId: x.claim.providerId, outcome: placed ? 'attached' : 'unplaced' });
			// Answered either way: the store is not asked for this track again
			// before its retry age, whatever it left unfilled.
			state.push({ objectId: x.recordingId, job: 'facts', provider: x.claim.provider, outcome: placed ? 'ok' : 'unplaced' });
			if (placed) {
				attached++;
				c.changed.add(x.recordingId);
			}
		}
	}
	for (const n of r.notFound) {
		if (onRelease.has(n.recordingId) && n.store in FACT_HOSTS) state.push({ objectId: n.recordingId, job: 'facts', provider: n.store, outcome: 'not_found' });
	}
	await remember(c, state);
	if (attached) c.changed.add(releaseId);
	const refused = r.rows.length - rows.length;
	// The lookups it is believed to have made: one per track and store it
	// answered for, of this release's tracks — whatever it listed, and
	// however many times.
	const lookups = new Set(state.map((s) => `${s.objectId}|${s.provider}`)).size;
	return { jobId, outcome: attached ? 'saved' : 'kept', lookups, ...(refused ? { note: `${refused} rows not of this release, or not from the store's own page of the track` } : {}) };
}

// ── a store that did not answer ─────────────────────────────────────────────

// Nothing was learned of the catalogue, but the job is not handed out again
// at every visit: the store rests for it a day (plan.ts). A rate limit is the
// device's to wait out (its profile says so), and is not remembered here.
async function applyError(c: Ctx, ref: JobRef, r: Extract<CatalogWorkResult, { kind: 'error' }>): Promise<Outcome> {
	const out: Outcome = { jobId: r.jobId, outcome: 'failed', note: `${r.store}: ${r.message}`.slice(0, 300) };
	const refused: Outcome = { jobId: r.jobId, outcome: 'refused', note: 'not a job the catalogue hands out' };
	if (ref.kind === 'find') {
		if (!ref.objectId) return ref.provider === r.store ? out : refused;
		// Only of a page the object has.
		const o = ref.provider === r.store ? await objectOf(c.tx, ref.objectId) : null;
		const [has] = o ? await c.tx.query(`select 1 from curator.catalog_source_object where object_id = $1 and provider = $2 and provider_id = $3`, [o.id, ref.provider, ref.providerId]) : [];
		if (!o || !has) return refused;
		if (r.rateLimitedSec === null) await remember(c, [{ objectId: o.id, job: 'check', provider: ref.provider, providerId: ref.providerId, outcome: 'error' }]);
		return out;
	}
	const o = await objectOf(c.tx, ref.releaseId);
	if (o?.kind !== 'release' || (ref.kind === 'facts' && !(r.store in FACT_HOSTS))) return refused;
	if (r.rateLimitedSec === null) await remember(c, [{ objectId: o.id, job: ref.kind, provider: r.store, outcome: 'error' }]);
	return out;
}

// ── the report ──────────────────────────────────────────────────────────────

// One result behind its own savepoint, on the savepoint's handle: what it
// wrote goes with it when it fails, and so does what it noted for the report.
async function isolated(deps: CatalogDeps, c: Ctx, jobId: string, fn: (c: Ctx) => Promise<Judged>): Promise<Judged> {
	const mark = { items: c.items.length, changed: new Set(c.changed), listed: new Set(c.listed) };
	try {
		return await c.tx.savepoint((tx) => fn({ ...c, tx }));
	} catch (e) {
		c.items.length = mark.items;
		for (const id of c.changed) if (!mark.changed.has(id)) c.changed.delete(id);
		for (const id of c.listed) if (!mark.listed.has(id)) c.listed.delete(id);
		deps.audit('catalog_work_result_failed', { job: jobId.slice(0, 80), error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
		return { jobId, outcome: 'failed', note: 'could not be saved' };
	}
}

// The store calls a result is believed to have taken: none for one the
// catalogue refused, a facts result by the lookups it answered for, anything
// else — a failure too: the calls were made — a job's worth.
const callsOf = (r: CatalogWorkResult, out: Judged): number => (out.outcome === 'refused' ? 0 : r.kind === 'facts' && out.lookups !== undefined ? CALLS_PER_FACT * out.lookups : CALLS_PER_JOB);

export async function workReport(deps: CatalogDeps, userId: string, caller: Caller, input: WorkReportInput): Promise<CatalogWorkReportResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		// One statement: the settings, the day's counts the follow-up is planned
		// by, and how long this report waits for another's turn.
		const inputs = await loadPlanInputs(tx, userId, REPORT_LOCK_WAIT);
		const parsed = input.results.map(parseWorkResult);
		// Off (or a reader too old to be asked): nothing is taken, and nothing
		// written — not the report either.
		if (!inputs.settings.enabled || input.profile.reader < inputs.settings.minReader) {
			return { results: parsed.map((p) => (p.ok ? { jobId: p.result.jobId, outcome: 'refused', note: 'device work is off' } : { jobId: p.jobId ?? '', outcome: 'refused', note: p.note })), changed: [] };
		}
		// A resend gets the first answer — one that arrives while the first is
		// still being saved waits on the insert, then finds it.
		const [rep] = await tx.query<{ id: string }>(
			`insert into curator.catalog_work_report (user_id, device_id, idempotency_key, profile, calls) values ($1, $2, $3, $4::text::jsonb, $5::text::jsonb)
			on conflict (user_id, idempotency_key) do nothing returning id::text`,
			[userId, input.deviceId, input.idempotencyKey, JSON.stringify(input.profile), JSON.stringify(input.calls ?? {})],
		);
		if (!rep) {
			const [prior] = await tx.query<{ result: string | null }>(`select result::text as result from curator.catalog_work_report where user_id = $1 and idempotency_key = $2`, [userId, input.idempotencyKey]);
			return prior?.result ? (JSON.parse(prior.result) as CatalogWorkReportResult) : { results: [], changed: [] };
		}

		// What each result names. One answer a job, and one failure a store of
		// it (a release's stores fail one by one, beside what the others found):
		// the same thing sent twice is judged once.
		const results: Outcome[] = [];
		const valid: { at: number; r: CatalogWorkResult; ref: JobRef }[] = [];
		const sent = new Set<string>();
		for (const [at, p] of parsed.entries()) {
			if (!p.ok) {
				results[at] = { jobId: p.jobId ?? '', outcome: 'refused', note: p.note };
				continue;
			}
			const r = p.result;
			const ref = parseJobId(r.jobId);
			const key = `${r.jobId}|${r.kind === 'error' ? r.store : ''}`;
			if (!ref || (r.kind !== 'error' && ref.kind !== r.kind)) results[at] = { jobId: r.jobId, outcome: 'refused', note: 'not a job the catalogue hands out' };
			else if (sent.has(key)) results[at] = { jobId: r.jobId, outcome: 'refused', note: 'sent twice' };
			else {
				sent.add(key);
				valid.push({ at, r, ref });
			}
		}
		// Its turn on every page and release it is about, taken before any is
		// judged and in one order whatever order the device sent them in.
		const turns = [...new Set(valid.flatMap(({ r, ref }) => (r.kind === 'error' ? [] : ref.kind === 'find' ? [`work.page:${pageKey(ref)}`] : ref.kind === 'release' ? [`work.release:${ref.releaseId}`] : [])))];
		if (turns.length) await tx.query(`select pg_advisory_xact_lock(hashtext(s.k)) from (select t.k from jsonb_array_elements_text($1::text::jsonb) as t(k) order by t.k) s`, [JSON.stringify(turns)]);

		const c: Ctx = { tx, userId, deviceId: input.deviceId, hints: input.hints ?? [], items: [], changed: new Set(), listed: new Set() };
		let allowance = CALLS_BASE;
		const apply = async (r: CatalogWorkResult, ref: JobRef): Promise<Outcome> => {
			const judged = await isolated(deps, c, r.jobId, (cx) => {
				if (r.kind === 'error') return applyError(cx, ref, r);
				if (ref.kind === 'find' && r.kind === 'find') return applyFind(cx, ref, r);
				if (ref.kind === 'release' && r.kind === 'release') return applyRelease(cx, ref, r);
				if (ref.kind === 'facts' && r.kind === 'facts') return applyFacts(cx, ref, r);
				return Promise.resolve<Outcome>({ jobId: r.jobId, outcome: 'refused', note: 'not a job the catalogue hands out' });
			});
			const { lookups: _lookups, ...out } = judged;
			// Only what the catalogue took counts toward the calls it will believe.
			if (out.note !== WAITS) allowance += callsOf(r, judged);
			return out;
		};
		// Results a first pass could not take yet: a probe whose reference page
		// came later in the same report.
		const waiting: typeof valid = [];
		for (const v of valid) {
			const out = await apply(v.r, v.ref);
			if (out.note === WAITS) waiting.push(v);
			results[v.at] = out;
		}
		for (const w of waiting) results[w.at] = await apply(w.r, w.ref);
		// Background jobs this device was holding (background.ts): reported,
		// whatever became of them.
		await releaseLeases(tx, userId, input.deviceId, valid.map((v) => v.r.jobId));

		if (c.items.length) {
			await tx.query(
				`insert into curator.catalog_work_item (report_id, job_id, object_id, provider, kind, provider_id, outcome)
				select $1::bigint, x.job_id, x.object_id, x.provider, x.kind, x.provider_id, x.outcome
				from jsonb_to_recordset($2::text::jsonb) as x(job_id text, object_id uuid, provider text, kind text, provider_id text, outcome text)
				on conflict do nothing`,
				[rep.id, JSON.stringify(c.items.map((i) => ({ job_id: i.jobId, object_id: i.objectId, provider: i.provider, kind: i.kind, provider_id: i.providerId, outcome: i.outcome })))],
			);
		}

		// The calls the work made count against the day, like the trackers'
		// own — of the stores the device reads (one that began to rest during
		// the visit made its calls too), and up to what the results could have
		// taken.
		const debit = new Map<CatalogWorkStore, number>();
		for (const store of new Set([...input.profile.stores, ...(input.profile.resting ?? []).map((x) => x.store)])) {
			const n = Math.min(input.calls?.[store] ?? 0, allowance, CALLS_MAX);
			if (n > 0) debit.set(store, n);
		}

		// A listing read: its new releases are completed next, while the visit's rounds last.
		// Fenced like a read's planner: a plan that fails costs the answer its
		// follow-up, not what the report saved. Planned by the day's counts
		// with this report's own added — written only after, so the day's rows,
		// which every report and every tracker writes, are held the shortest.
		const counted: PlanInputs = { settings: inputs.settings, used: { ...inputs.used } };
		for (const [store, n] of debit) counted.used[store] = (counted.used[store] ?? 0) + n;
		const work = await planSafely(tx, (e) => deps.audit('catalog_work_plan_failed', { read: 'report', error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) }), (fenced) => followUp(fenced, userId, counted, input.profile, c.hints, c.listed));
		// In one order always: two reports must not take the day's rows crosswise.
		for (const store of [...debit.keys()].sort()) {
			await tx.query(
				`insert into curator.provider_budget (provider, day, units_used) values ($1, (now() at time zone 'utc')::date, $2::int)
				on conflict (provider, day) do update set units_used = curator.provider_budget.units_used + excluded.units_used`,
				[store, String(debit.get(store))],
			);
		}
		const result: CatalogWorkReportResult = { results, changed: [...c.changed], ...(work ? { work } : {}) };
		await tx.query(`update curator.catalog_work_report set result = $2::text::jsonb where id = $1::bigint`, [rep.id, JSON.stringify(result)]);
		deps.audit('catalog_work_reported', { results: results.length, saved: results.filter((r) => r.outcome === 'saved').length, items: c.items.length, followUp: work?.jobs.length ?? 0 });
		return result;
	});
}

// The work for what a report's listings brought, planned once for all of
// them from the settings and counts the report already read.
async function followUp(tx: SystemTx, userId: string, inputs: PlanInputs, profile: CatalogDeviceProfile, hints: readonly CatalogRef[], listed: ReadonlySet<string>): Promise<CatalogWork | undefined> {
	if (!listed.size) return undefined;
	const next: CatalogDeviceProfile = { ...profile, visit: { id: profile.visit?.id ?? 'visit', round: (profile.visit?.round ?? 0) + 1, taken: profile.visit?.taken ?? 0 } };
	const scope = scopeOf(inputs, next, tx.nowMs);
	if (!scope) return undefined;
	const jobs: CatalogJob[] = [];
	let limits: CatalogWork['limits'] | undefined;
	for (const id of listed) {
		const page = await pageTracks(tx, id);
		if (!page) continue;
		const w = await planPage(tx, { userId, profile: next, hints, object: page.object, releases: page.releases, first: true, nowMs: tx.nowMs, scope });
		if (!w) continue;
		limits = w.limits;
		for (const j of w.jobs) if (!jobs.some((x) => x.id === j.id)) jobs.push(j);
	}
	return jobs.length && limits ? { jobs, limits } : undefined;
}

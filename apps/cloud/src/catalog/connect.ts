// "Help us connect the dots" ('catalog_connect'): users map store pages onto
// the catalogue's artists, labels and albums for the stores it has not mapped.
//
// connectQueue says what to ask: the caller's follows (or exactly the objects
// a device names) that lack a store, with the candidates the catalogue's own
// finders left undecided (open reviews). The device searches the store for the
// rest and sends back the user's answers.
//
// connectAnswer keeps every answer as that user's vote, then decides:
//
//   attached  the cloud can back it — a trusted account (admin_user), or the
//             page's own releases, read here, overlapping the object's by the
//             finder's rule (two titles). Logged with an undo.
//   waiting   it cannot: an approval in the operator's inbox, one click.
//             Further users saying the same add to the item; they never
//             attach on their own.
//   conflict  the page is another object's, was ruled out, or is blocked: a
//             notice for the operator (often a twin to merge), nothing moved.
//
// What a device says the page lists rides along as evidence for the operator
// and is never the reason to attach: the client is not trusted. Store pages
// are read between two transactions, never inside one (PGlite has one
// connection; a slow store must not hold it).

import {
	CATALOG_CONNECT_QUEUE_MAX,
	CATALOG_CONNECT_STORES,
	isConnectKind,
	pageRef,
	type CatalogConnectAnswer,
	type CatalogConnectAnswerInput,
	type CatalogConnectAnswerResult,
	type CatalogConnectCandidate,
	type CatalogConnectItem,
	type CatalogConnectOutcome,
	type CatalogConnectQueueInput,
	type CatalogConnectQueueResult,
	type CatalogConnectSearchInput,
	type CatalogConnectSearchResult,
	type CatalogProvider,
	type PageKind,
} from '@curator/protocol';
import { beatportPageReleases, type FetchLike, type SoundCloudTracker } from '@curator/catalog-readers';
import { nameFold } from '@curator/library-logic';
import type { Caller } from '../account/device-gate.js';
import { withSystemTx, type SystemTx } from '../db/system-tx.js';
import { num } from '../db/db.js';
import { objectReleases, ruledNotSame, type ReviewCandidate } from './admin.js';
import { candidateReleases } from './admin-evidence.js';
import { gated, type CatalogDeps } from './catalog.js';
import { attachConnected, ruleOutPage, type ConnectPage } from './connect-apply.js';
import { findRepresentation, follow, WEAK_SQL } from './identity.js';
import { raise } from './inbox.js';
import { objectFacts, reversiblePolicy } from './inbox-policy.js';
import { pairViews, summaries } from './objects.js';
import { resolveBandcampBand, resolveSoundcloudUser } from './profile/label-profiler.js';

export type ConnectDeps = CatalogDeps & { fetch?: FetchLike };

const QUEUE_DEFAULT = 20;
// Titles shown with an object, and how many of its releases an answer is checked against.
const TITLES_SHOWN = 12;
const TITLES_COMPARED = 200;
// "None of these" is asked again after this long: stores gain pages.
const NONE_HIDES_DAYS = 90;
// The finder's rule (planner.ts confirm): two shared titles make a page the object's.
const BACKED_MIN_SHARED = 2;
const READ_TIMEOUT_MS = 8_000;

const uuids = (ids: string[]): string => `{${[...new Set(ids)].join(',')}}`;

// ── the queue ───────────────────────────────────────────────────────────────

export function connectQueue(deps: CatalogDeps, userId: string, caller: Caller, input: CatalogConnectQueueInput): Promise<CatalogConnectQueueResult> {
	return gated(deps, userId, caller, input.deviceId, async (tx) => {
		const explicit = input.objectIds !== undefined;
		const asked = explicit
			? await Promise.all(input.objectIds!.map((id) => follow(tx, id)))
			: (await tx.asUser(userId, (q) => q.query<{ object_id: string }>(`select object_id from curator.catalog_watch where not muted`))).map((r) => r.object_id);
		if (!asked.length) return { items: [], total: 0 };
		const list = uuids(asked);
		// Albums are asked about only when a device names one: there is no
		// queue of every release a followed label ever put out.
		const objects = await tx.query<{ id: string; kind: PageKind; name: string }>(
			`select id, kind, name from curator.catalog_object
			where id = any($1::uuid[]) and merged_into is null and kind = any($2::text[])
			order by watch_count desc, name`,
			[list, explicit ? '{artist,label,release}' : '{artist,label}'],
		);
		const held = new Set(
			(await tx.query<{ k: string }>(`select distinct s.object_id || '|' || s.provider as k from curator.catalog_source_object s where s.object_id = any($1::uuid[]) and not ${WEAK_SQL}`, [list])).map((r) => r.k),
		);
		const votes = await tx.query<{ object_id: string; provider: string; provider_id: string; verdict: string; fresh: boolean }>(
			`select object_id, provider, provider_id, verdict, at > now() - make_interval(days => ${NONE_HIDES_DAYS}) as fresh
			from curator.catalog_connect_vote where user_id = $1 and object_id = any($2::uuid[])`,
			[userId, list],
		);
		// Answered: the user named a page (attached since, or with the operator),
		// or said lately that none fits. Naming an object asks again past a "none".
		const answered = new Set(votes.filter((v) => v.verdict === 'is' || (v.verdict === 'none' && v.fresh && !explicit)).map((v) => `${v.object_id}|${v.provider}`));
		const refused = new Set(votes.filter((v) => v.verdict === 'not').map((v) => `${v.object_id}|${v.provider}|${v.provider_id}`));
		const queue = objects
			.map((o) => ({ ...o, missing: CATALOG_CONNECT_STORES[o.kind].filter((p) => !held.has(`${o.id}|${p}`) && !answered.has(`${o.id}|${p}`)) as CatalogProvider[] }))
			.filter((o) => o.missing.length);
		const page = queue.slice(0, Math.min(input.limit ?? QUEUE_DEFAULT, CATALOG_CONNECT_QUEUE_MAX));
		if (!page.length) return { items: [], total: queue.length };

		const ids = page.map((o) => o.id);
		const [objectSummaries, releaseViews, reviews] = await Promise.all([
			summaries(tx, ids),
			pairViews(tx, page.filter((o) => o.kind === 'release').map((o) => o.id)),
			tx.query<{ object_id: string; candidates: string }>(
				`select object_id, candidates::text as candidates from curator.catalog_review
				where object_id = any($1::uuid[]) and status in ('open', 'escalated') and kind in ('artist_link', 'label_page') order by id`,
				[uuids(ids)],
			),
		]);
		const offered = new Map<string, CatalogConnectCandidate[]>();
		for (const r of reviews) {
			for (const c of JSON.parse(r.candidates) as ReviewCandidate[]) {
				if (!c.provider || !c.providerId || !c.url || refused.has(`${r.object_id}|${c.provider}|${c.providerId}`)) continue;
				const key = `${r.object_id}|${c.provider}`;
				const l = offered.get(key) ?? [];
				if (!l.some((x) => x.providerId === c.providerId)) l.push({ provider: c.provider, providerId: c.providerId, name: c.name, url: c.url, releases: (c.releases ?? []).slice(0, 8), source: 'cloud' });
				offered.set(key, l);
			}
		}
		const items: CatalogConnectItem[] = [];
		for (const o of page) {
			const object = objectSummaries.get(o.id);
			if (!object) continue;
			const view = releaseViews.get(o.id);
			items.push({
				object,
				titles: o.kind === 'release' ? await trackTitles(tx, o.id) : (await objectReleases(tx, o.id, TITLES_SHOWN)).map((r) => r.title),
				detail: view ? [view.artists?.join(', '), view.date].filter(Boolean).join(' · ') || null : null,
				missing: o.missing.map((provider) => ({ provider, candidates: offered.get(`${o.id}|${provider}`) ?? [] })),
			});
		}
		return { items, total: queue.length };
	});
}

async function trackTitles(tx: SystemTx, releaseId: string): Promise<string[]> {
	const rows = await tx.query<{ name: string }>(
		`select r.name from curator.catalog_edge e join curator.catalog_object r on r.id = e.dst and r.merged_into is null
		where e.src = $1 and e.kind = 'release-recording' order by e.position nulls last, r.name limit ${TITLES_SHOWN}`,
		[releaseId],
	);
	return rows.map((r) => r.name);
}

// ── the cloud's own store search ────────────────────────────────────────────

// SoundCloud's profiles of that name, read with the app's credentials (a
// device has none). Candidates only: the user picks, connectAnswer decides.
export async function connectSearch(deps: CatalogDeps & { soundcloud: Pick<SoundCloudTracker, 'searchUsers'> | null }, userId: string, caller: Caller, input: CatalogConnectSearchInput): Promise<CatalogConnectSearchResult> {
	await gated(deps, userId, caller, input.deviceId, async () => undefined);
	if (!deps.soundcloud) return { candidates: [], searched: false };
	const users = await deps.soundcloud.searchUsers(input.name, AbortSignal.timeout(READ_TIMEOUT_MS));
	return {
		searched: true,
		candidates: users
			.filter((u) => u.permalink_url || u.permalink)
			.map((u) => ({
				provider: 'soundcloud' as const,
				providerId: String(u.id),
				name: u.username,
				url: u.permalink_url ?? `https://soundcloud.com/${u.permalink}`,
				imageUrl: u.avatar_url ?? null,
				followers: u.followers_count ?? null,
				detail: [[u.city, u.country].filter(Boolean).join(', '), u.track_count ? `${u.track_count} tracks` : null].filter(Boolean).join(' · ') || null,
				source: 'search' as const,
			})),
	};
}

// ── answers ─────────────────────────────────────────────────────────────────

type Target = { id: string; kind: PageKind; name: string };
type Prepared = {
	answer: CatalogConnectAnswer;
	invalid: string | null;
	target: Target | null;
	page: { provider: CatalogProvider; id: string; url: string } | null;
	// The object's own release titles, folded.
	known: Set<string>;
	// The id the store's API takes, when the link carried a slug and the page answered.
	resolvedId: string | null;
	// What the cloud read on the page itself; null when it could not.
	pageTitles: string[] | null;
};

export async function connectAnswer(deps: ConnectDeps, userId: string, caller: Caller, input: CatalogConnectAnswerInput): Promise<CatalogConnectAnswerResult> {
	const { trusted, prepared } = await gated(deps, userId, caller, input.deviceId, async (tx) => {
		const trusted = (await tx.query(`select 1 from curator.admin_user where user_id = $1`, [userId])).length > 0;
		const prepared: Prepared[] = [];
		for (const answer of input.answers) prepared.push(await prepare(tx, answer));
		return { trusted, prepared };
	});
	const fetchFn = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
	await Promise.all(prepared.filter((p) => !p.invalid && p.answer.verdict === 'is').map((p) => readStore(fetchFn, p, trusted)));
	const results = await withSystemTx(deps.db, async (tx) => {
		const out: CatalogConnectAnswerResult['results'] = [];
		for (const p of prepared) out.push(p.invalid ? { outcome: 'invalid', reason: p.invalid } : await apply(tx, userId, input.deviceId, trusted, p));
		return out;
	});
	const count = (o: CatalogConnectOutcome) => results.filter((r) => r.outcome === o).length;
	deps.audit('catalog_connect_answered', { answers: results.length, attached: count('attached'), waiting: count('waiting'), conflicts: count('conflict'), invalid: count('invalid') });
	return { results };
}

async function prepare(tx: SystemTx, answer: CatalogConnectAnswer): Promise<Prepared> {
	const p: Prepared = { answer, invalid: null, target: null, page: null, known: new Set(), resolvedId: null, pageTitles: null };
	const [o] = await tx.query<{ id: string; kind: string; name: string }>(`select id, kind, name from curator.catalog_object where id = $1`, [await follow(tx, answer.objectId)]);
	if (!o || !isConnectKind(o.kind as never)) return { ...p, invalid: 'unknown_object' };
	const target: Target = { id: o.id, kind: o.kind as PageKind, name: o.name };
	if (!(CATALOG_CONNECT_STORES[target.kind] as readonly string[]).includes(answer.provider)) return { ...p, invalid: 'store_not_asked' };
	if (answer.verdict === 'none') return { ...p, target };
	const ref = answer.url ? pageRef(answer.url) : null;
	if (!ref || ref.provider !== answer.provider) return { ...p, invalid: 'not_a_page_of_that_store' };
	if (!ref.kinds.includes(target.kind)) return { ...p, invalid: `that_is_a_${ref.kinds[0]}_page` };
	const known = target.kind === 'release' || answer.verdict !== 'is' ? new Set<string>() : new Set((await objectReleases(tx, target.id, TITLES_COMPARED)).map((r) => nameFold(r.title)));
	return { ...p, target, page: { provider: ref.provider, id: ref.id, url: ref.url }, known };
}

// The store's own word, read outside any transaction. A failed read leaves
// the answer unbacked (it waits for the operator); it never fails the call.
async function readStore(fetchFn: FetchLike, p: Prepared, trusted: boolean): Promise<void> {
	const page = p.page!;
	const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
	if (!/^\d+$/.test(page.id)) {
		p.resolvedId =
			page.provider === 'bandcamp' ? ((await resolveBandcampBand(fetchFn, page.url, signal).catch(() => null))?.id ?? null)
			: page.provider === 'soundcloud' ? await resolveSoundcloudUser(fetchFn, page.url, signal).catch(() => null)
			: null;
	}
	// A trusted account's word stands; an album has no release list to compare.
	if (trusted || p.target!.kind === 'release' || !p.known.size) return;
	p.pageTitles = await pageReleases(fetchFn, p.target!.kind, page.provider, p.resolvedId ?? page.id).catch(() => null);
}

// The releases a page lists, for the stores the API server can read without
// an app token (Spotify and Tidal answers wait for the operator).
async function pageReleases(fetchFn: FetchLike, kind: PageKind, provider: CatalogProvider, id: string): Promise<string[] | null> {
	if (provider === 'beatport' && kind !== 'release') return beatportPageReleases(fetchFn, kind, id, AbortSignal.timeout(READ_TIMEOUT_MS));
	const readable = (provider === 'deezer' && kind === 'artist') || (provider === 'bandcamp' && /^\d+$/.test(id));
	return readable ? candidateReleases({ fetch: fetchFn }, { provider, providerId: id, name: '' }) : null;
}

async function apply(tx: SystemTx, userId: string, deviceId: string, trusted: boolean, p: Prepared): Promise<CatalogConnectAnswerResult['results'][number]> {
	const target = p.target!;
	const a = p.answer;
	const vote = (providerId: string, outcome: CatalogConnectOutcome, evidence: Record<string, unknown> = {}) =>
		tx.query(
			`insert into curator.catalog_connect_vote (user_id, device_id, object_id, provider, kind, provider_id, url, name, verdict, source, evidence, outcome)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12)
			on conflict (user_id, object_id, provider, provider_id) do update
				set device_id = excluded.device_id, url = excluded.url, name = excluded.name, verdict = excluded.verdict, source = excluded.source, evidence = excluded.evidence, outcome = excluded.outcome, at = now()`,
			[userId, deviceId, target.id, a.provider, target.kind, providerId, p.page?.url ?? null, a.name ?? null, a.verdict, a.source ?? null, JSON.stringify(evidence), outcome],
		);
	if (a.verdict === 'none') {
		await vote('', 'noted');
		return { outcome: 'noted' };
	}
	const providerId = p.resolvedId ?? p.page!.id;
	const page: ConnectPage = { provider: a.provider, providerId, name: a.name?.trim() || target.name, url: p.page!.url };
	if (a.verdict === 'not') {
		// A trusted account's "not this one" is a ruling; anyone else's keeps
		// the page from being offered to them again.
		if (trusted) await ruleOutPage(tx, { objectId: target.id, kind: target.kind, page }, `user:${userId}`, 'connect the dots');
		await vote(providerId, 'noted');
		return { outcome: 'noted' };
	}

	const shared = (p.pageTitles ?? []).filter((t) => p.known.has(nameFold(t)));
	const evidence = { url: page.url, pageName: a.name ?? null, source: a.source ?? null, deviceRead: (a.releases ?? []).slice(0, 15), cloudRead: p.pageTitles?.slice(0, 25) ?? null, shared, trusted, userId };
	const holds = async (id: string) => findRepresentation(tx, { provider: a.provider, kind: target.kind, providerId: id });
	const owner = (await holds(providerId)) ?? (providerId !== p.page!.id ? await holds(p.page!.id) : null);
	if (owner === target.id) {
		await vote(providerId, 'already');
		return { outcome: 'already' };
	}
	const blocked = (await tx.query(`select 1 from curator.catalog_source_block where provider = $1 and kind = $2 and provider_id = $3`, [a.provider, target.kind, providerId])).length > 0;
	const ruled = target.kind !== 'release' && (await ruledNotSame(tx, target.id, page));
	const title = `${a.provider}:${providerId}`;
	if (owner || blocked || ruled) {
		const reason = owner ? 'held_by_another' : blocked ? 'blocked' : 'ruled_out';
		await vote(providerId, 'conflict', { ...evidence, reason, owner });
		await raise(tx, {
			kind: 'connect.conflict',
			severity: 'notice',
			title: owner ? `A user says ${title} is «${target.name}», but it is another ${target.kind}'s page` : `A user says ${title} is «${target.name}», a page ${blocked ? 'blocked for every object' : 'ruled not theirs'}`,
			subjects: owner ? [target.id, owner] : [target.id],
			evidence: { ...evidence, reason },
			actor: 'user',
			key: title,
		});
		return { outcome: 'conflict', reason };
	}
	// A second id of one store on one object is the store's word that these
	// are two people (the ELIF and Greene buckets, 2026-11-09): the operator's.
	const sibling = (await tx.query(`select 1 from curator.catalog_source_object s where s.object_id = $1 and s.provider = $2 and s.kind = $3 and not ${WEAK_SQL} limit 1`, [target.id, a.provider, target.kind])).length > 0;
	const args = { objectId: target.id, kind: target.kind, page };
	if (!sibling && (trusted || shared.length >= BACKED_MIN_SHARED)) {
		await attachConnected(tx, args);
		await vote(providerId, 'attached', evidence);
		const facts = await objectFacts(tx, [target.id]);
		await raise(tx, {
			kind: 'connect.attach',
			severity: reversiblePolicy(facts.get(target.id)),
			title: `Connected ${title} to «${target.name}» (${trusted ? 'a trusted account' : `${shared.length} shared releases`})`,
			subjects: [target.id],
			evidence,
			undo: target.kind === 'release' ? null : { op: 'unlinkPage', args: { objectId: target.id, kind: target.kind, page: { provider: a.provider, id: providerId, url: page.url }, note: 'undone: connect the dots' } },
			actor: 'user',
		});
		return { outcome: 'attached' };
	}
	await vote(providerId, 'waiting', evidence);
	const [n] = await tx.query<{ n: unknown }>(
		`select count(distinct user_id) as n from curator.catalog_connect_vote where object_id = $1 and provider = $2 and provider_id = $3 and verdict = 'is'`,
		[target.id, a.provider, providerId],
	);
	const votes = num(n!.n);
	const raised = await raise(tx, {
		kind: 'connect.link',
		severity: 'approval',
		title: `Connect ${title} to «${target.name}»?`,
		subjects: [target.id],
		evidence: { ...evidence, votes, sibling },
		apply: { op: 'connectAttach', args },
		actor: 'user',
		key: title,
	});
	// The same page named again by someone else: the open item counts them.
	if (raised === null) {
		await tx.query(
			`update curator.catalog_inbox set evidence = jsonb_set(evidence, '{votes}', to_jsonb($4::int))
			where kind = 'connect.link' and status = 'open' and $1::uuid = any(subjects) and apply->'args'->'page'->>'provider' = $2 and apply->'args'->'page'->>'providerId' = $3`,
			[target.id, a.provider, providerId, String(votes)],
		);
	}
	return { outcome: 'waiting' };
}

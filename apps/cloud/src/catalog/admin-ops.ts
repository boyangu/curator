// The back office's calls, as plain functions over JSON: the catalog CLI
// (cli/catalog.ts) runs them on a database it opens itself, or sends them to
// a running local server (cli/local.ts serves them on the loopback `/admin`
// path, nothing else does). One shape, so a session with Claude Code reads
// the same answers either way: the review queue, and a label's standing —
// registered, profiled (its pages), backfilled (its releases), tracked.

import type { CatalogKind, CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { clearInbox, decideInbox, failInbox, getInbox, inboxCounts, listInbox, OPERATOR, raise, snoozeInbox, type InboxChoice, type InboxFilter, type InboxOp, type InboxRow } from './inbox.js';
import { mergePolicy, objectFacts, reversiblePolicy } from './inbox-policy.js';
import { attachPage, decideReview, getReview, holdReview, listReviews, mergeObjects, mergeOverruling, objectReleases, renameObject, scanDuplicates, unlinkPage, type ReviewStatus, type ObjectRelease, type Review, type ReviewCandidate, type ReviewDecision, type ReviewKind } from './admin.js';
import { candidateReleases, type EvidenceDeps } from './admin-evidence.js';
import { agentImport, type AgentImport, type AgentImportReport } from './agent-import.js';
import { CASE_KINDS, caseCounts, enqueueCase, getCase, listCases, type AgentCase, type AgentCaseKind, type AgentCaseStatus } from './agent/cases.js';
import type { AgentReasonerConfig } from './agent/config.js';
import { exportEvalCases, type EvalCase } from './agent/evals.js';
import { bucketCandidates, detectBuckets, detectCredits, type BucketCandidate } from './inbox-detectors.js';
import type { EvidencePack } from './agent/pack.js';
import type { ModelCall } from './agent/model.js';
import { reasonCase, runAgentReasoner, type ReasonerReport } from './agent/reasoner.js';

export type AgentAdvice = { inbox: number; kind: string; title: string; pairs: { i: number; keep: string; fold: string; verdict: string | null }[]; confidence: number | null; rationale: string | null; citations: string[]; searches: number; error: string | null };
import { findRepresentation } from './identity.js';
import { addInsight, insightsOf, retireInsight, type Insight } from './insights.js';
import { ingestClaims } from './ingest.js';
import { search, summaries } from './objects.js';
import { acceptCataloguePlaylist, queueCataloguePlaylists } from './profile/catalogue-playlists.js';
import { BACKFILL_PROVIDERS, repointRepresentation, resolveBandcampBand, resolveSoundcloudUser } from './profile/label-profiler.js';
import { classifyUrl, labelClaimFromPage, websiteLink } from './profile/links.js';
import { libraryImport, type LibraryImportResult } from './library-import.js';
import { openRelatedPair, queueLabelDedupe, scanRelatedLabels } from './label-related.js';
import { artistTwins, type ArtistTwinReport } from './artist-twins.js';
import { recreditOn, repairCredits, type CreditRepairReport } from './repair-credits.js';
import { repairPreviews, type PreviewRepairReport } from './repair-previews.js';
import { dedupeTracks, fillReleases, linkReleasePage, releaseStubs, type DedupeReport, type FillReport, type ReleaseStub } from './release-fill.js';
import { AppleLookup } from './trackers/apple.js';
import { BandcampTracker } from './trackers/bandcamp.js';
import { BeatportTracker } from './trackers/beatport.js';
import { DeezerTracker } from './trackers/deezer.js';
import { fetchPlaylistMeta } from './trackers/spotify-app.js';

export type ReviewView = Review & {
	object: { name: string; kind: string; handles: { provider: string; id: string; url: string | null }[] } | null;
	// The object's own releases, and per candidate the overlap with what the
	// candidate lists (fetched live when the opener did not carry it).
	releases: { title: string; artists: string[]; date: string | null; providers: string[] }[];
	candidateViews: { index: number; candidate: ReviewCandidate; releases: string[]; overlap: number }[];
};

// The pages a label is expected to have once profiled; a missing one is a gap
// the reviewer may fill by hand (label add <url>, or a review).
const EXPECTED_PAGES: readonly CatalogProvider[] = ['beatport', 'bandcamp', 'soundcloud', 'youtube', 'website'];

export type LabelView = {
	id: string;
	name: string;
	watchers: number;
	pages: { provider: string; id: string; url: string | null }[];
	// Spotify playlists listing the label's releases (catalogue-playlists.ts).
	cataloguePlaylists: { id: string; name: string; url: string | null }[];
	// Of `releases`, how many have a Spotify id (what Discover can play).
	onSpotify: number;
	identifiers: { namespace: string; value: string }[];
	tracking: { provider: string; lastRunAt: number | null; nextDueAt: number | null; failCount: number; lastError: string | null }[];
	tasks: { need: string; provider: string; nextDueAt: number | null; attempts: number; lastError: string | null }[];
	releases: number;
	latest: ObjectRelease[];
	roster: number;
	reviews: { id: number; kind: ReviewKind }[];
	// What is still missing, in words.
	gaps: string[];
};

export type VerifyRow = { id: string; name: string; watchers: number; pages: string[]; releases: number; gaps: string[] };

export type AdminOps = {
	list(args: { status?: ReviewStatus; kind?: ReviewKind; limit?: number; evidence?: boolean; related?: boolean }): Promise<ReviewView[]>;
	get(args: { id: number; evidence?: boolean }): Promise<ReviewView | null>;
	// A merge the policy holds (inbox-policy.ts) comes back with `held`: the
	// inbox item waiting for the operator, the review out of the queue until then.
	// `approved`: the operator already said yes in chat — logged, not asked.
	decide(args: { id: number; decision: ReviewDecision; by: string; note?: string | null; approved?: boolean }): Promise<{ review: Review; merge?: unknown; held?: number | null }>;
	// The operator's inbox (inbox.ts): what waits for Guy, and the activity log.
	inboxList(args: InboxFilter): Promise<{ total: number; rows: InboxRow[] }>;
	inboxCounts(args: Record<string, never>): Promise<{ approval: number; notice: number; snoozed: number }>;
	inboxGet(args: { id: number }): Promise<InboxRow | null>;
	// `except`: a twins item's pairs (by index) ruled not twins while the rest merge.
	inboxDecide(args: { id: number; action: 'approve' | 'reject'; choice?: InboxChoice; except?: number[]; note?: string | null; by?: string }): Promise<InboxRow>;
	inboxSnooze(args: { id: number; days?: number; until?: string | null }): Promise<InboxRow>;
	// Look-alikes: artists by folded name; labels by name, shared releases and
	// roster (label-related.ts), for the labels named or every live one.
	scan(args: { kind?: 'artist' | 'label'; limit?: number; labels?: string[] }): Promise<{ opened: number; checked?: number }>;
	// A pair of labels a reviewer names as maybe one, put to review with the evidence.
	reviewOpen(args: { a: string; b: string }): Promise<{ id: number | null; keep: string }>;
	// A wrong page taken off a label, and ruled not its page (admin.ts unlinkPage).
	labelUnlink(args: { q: string; url: string; by?: string; note?: string | null; approved?: boolean }): Promise<{ provider: string; providerId: string; edges: number; identifiers: number; review: number | null }>;
	// Two labels merged, overruling a "not the same": held for the operator
	// (`held` = the inbox item) unless `approved` — the operator said so in chat.
	labelMerge(args: { from: string; into: string; by?: string; note: string; approved?: boolean }): Promise<{ from: string; into: string; name: string; moved?: Record<string, number>; held?: number | null }>;
	labelRename(args: { q: string; name: string; by?: string; approved?: boolean }): Promise<{ id: string; name: string }>;
	search(args: { q: string; kind?: CatalogKind; limit?: number }): Promise<{ id: string; kind: string; name: string; watchers: number; pages: string[] }[]>;
	// A label by name or by its Beatport / Bandcamp page: registered (no
	// watch) and queued for its profile; an existing one is just shown.
	labelAdd(args: { q: string }): Promise<LabelView>;
	labelShow(args: { q: string }): Promise<LabelView>;
	// A page attached to an existing label by hand (a reviewer found it): the
	// identity rules are the reviewer's. Refused when another label owns it.
	// A Spotify playlist URL makes it the label's catalogue playlist, read in
	// full on the next pass.
	labelLink(args: { q: string; url: string; by?: string; approved?: boolean }): Promise<LabelView>;
	// Releases an agent gathered by browsing (agent-import.ts).
	labelImport(args: { q: string; data: AgentImport; dry?: boolean; by?: string }): Promise<AgentImportReport>;
	// An agent read the label's pages for new releases and found nothing to
	// import: the scan is recorded all the same (`scanned_at`, the back office's
	// "last scanned"). An import records its own.
	labelScanned(args: { q: string; note?: string | null; by?: string }): Promise<{ id: string; name: string; scannedAt: number }>;
	labelVerify(args: { limit?: number; watchedOnly?: boolean }): Promise<VerifyRow[]>;
	// Reads the label's releases again now: due cursors for a watched label,
	// backfill tasks for one nobody watches; the profile too when it never ran.
	labelRefresh(args: { q: string }): Promise<{ cursors: number; backfills: number; profile: boolean }>;
	labelReleases(args: { q: string; limit?: number }): Promise<ObjectRelease[]>;
	// Runs the worker's pass now (profiler, backfill, trackers) instead of
	// waiting for its minute; the local server only.
	pass(args: Record<string, never>): Promise<{ ran: boolean }>;
	// Releases holding fewer tracks than their providers said, in a label's or
	// an artist's catalogue (or everywhere), with the store ids a fill reads.
	releaseStubs(args: { label?: string; artist?: string; limit?: number }): Promise<{ total: number; rows: ReleaseStub[] }>;
	// Reads those stubs' tracklists from their stores and ingests them
	// (release-fill.ts); `ids` names releases outright.
	releaseFill(args: { ids?: string[]; label?: string; artist?: string; limit?: number; dry?: boolean; by?: string }): Promise<FillReport>;
	// A store page the agent found for a release, for the next fill to read.
	releaseLink(args: { id: string; url: string; by?: string }): Promise<{ provider: string; id: string; conflict: string | null }>;
	// What the back office concluded about an object (insights.ts), on the
	// object (an id, or a label by name or page); logged with an undo.
	insightAdd(args: { q: string; topic: string; body: string; evidence?: Record<string, unknown>; by?: string; approved?: boolean }): Promise<Insight>;
	insightRetire(args: { id: number; by?: string; note?: string | null }): Promise<Insight>;
	insightList(args: { q: string; retired?: boolean }): Promise<{ id: string; name: string; kind: string; insights: Insight[] }>;
	// Tracks a release holds twice (one slot, two stores) merged into one.
	releaseDedupe(args: { ids?: string[]; label?: string; artist?: string; dry?: boolean; by?: string }): Promise<DedupeReport>;
	// SoundCloud preview copies (0:30, credited to the label) undone and
	// merged into the store recording they are (repair-previews.ts).
	repairPreviews(args: { label?: string; dry?: boolean; by?: string }): Promise<PreviewRepairReport>;
	// Artists the SoundCloud/Bandcamp splitter cut out of a credit, folded
	// into the artists they were cut from (repair-credits.ts).
	repairCredits(args: { dry?: boolean; by?: string }): Promise<CreditRepairReport>;
	// Same-name artists on one release merged, unless one store holds both
	// (then put to the operator; mergeOnly: not) — artist-twins.ts.
	repairArtistTwins(args: { dry?: boolean; by?: string; mergeOnly?: boolean }): Promise<ArtistTwinReport>;
	// One artist into another by hand (ids): held for the operator unless
	// approved — the same apply a twins approval runs.
	artistMerge(args: { from: string; into: string; note: string; by?: string; approved?: boolean }): Promise<{ moved?: Record<string, number>; held?: number | null }>;
	// An artist's credits on one release given to another (Guy's word: approved).
	artistRecredit(args: { artist: string; release: string; to: string; note: string; by?: string; approved?: boolean }): Promise<{ credits: number }>;
	// A library's labels and releases (with the owner's tracks), ≤ 100 claims
	// a batch, each release queued for a fill (library-import.ts).
	libraryImport(args: { claims: unknown[]; key: string; by?: string; dry?: boolean }): Promise<LibraryImportResult>;
	// The reasoner's cases (catalog/agent): what waits, what was decided and
	// at what cost; a run now (dry: the verdict without a write); a question
	// put by hand.
	agentCases(args: { status?: AgentCaseStatus | 'live'; kind?: AgentCaseKind; limit?: number }): Promise<{ counts: Record<string, number>; cases: AgentCase[]; enabled: boolean }>;
	agentCase(args: { id: number }): Promise<(AgentCase & { pack: EvidencePack | null }) | null>;
	agentSweep(args: { days: number; kinds?: ('bucket' | 'credit')[]; limit?: number; dry?: boolean }): Promise<{ buckets: number; credits: number; candidates?: (BucketCandidate & { name: string })[] }>;
	agentDrop(args: { ids: number[]; reason: string }): Promise<{ dropped: number[]; cleared: number[] }>;
	agentEvalExport(args: { since?: string }): Promise<{ cases: EvalCase[]; skipped: { inbox: number; why: string }[] }>;
	agentRun(args: { id?: number; dry?: boolean; batch?: number; by?: string }): Promise<ReasonerReport>;
	agentAdvise(args: { inbox: number; research?: boolean }): Promise<AgentAdvice>;
	agentAsk(args: { kind: AgentCaseKind; ids: string[]; source?: { provider: string; providerId: string }; creditText?: string }): Promise<{ id: number | null }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A label named by id, by its page's URL, or by name (an exact fold, else
// the one live label whose fold contains it).
async function findLabel(tx: Queryable, q: string): Promise<string | null> {
	if (UUID_RE.test(q.trim())) {
		const [r] = await tx.query<{ id: string }>(`select id from curator.catalog_object where id = $1 and kind = 'label' and merged_into is null`, [q.trim()]);
		return r?.id ?? null;
	}
	const page = classifyUrl(q);
	if (page?.kind === 'label') {
		const [r] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = $1 and kind = 'label' and provider_id = $2`, [page.provider, page.id]);
		return r?.object_id ?? null;
	}
	const fold = nameFold(q);
	const exact = await tx.query<{ id: string }>(`select id from curator.catalog_object where kind = 'label' and merged_into is null and name_fold = $1 order by watch_count desc limit 2`, [fold]);
	if (exact.length) return exact[0]!.id;
	const near = await tx.query<{ id: string }>(`select id from curator.catalog_object where kind = 'label' and merged_into is null and name_fold like $1 order by watch_count desc limit 2`, [`%${fold}%`]);
	return near.length === 1 ? near[0]!.id : null;
}

// An artist by id, or by a name only one live artist carries (artists are
// never told apart by name: namesakes are common).
async function findArtist(tx: Queryable, q: string): Promise<string | null> {
	if (UUID_RE.test(q.trim())) {
		const [r] = await tx.query<{ id: string }>(`select id from curator.catalog_object where id = $1 and kind = 'artist' and merged_into is null`, [q.trim()]);
		return r?.id ?? null;
	}
	const rows = await tx.query<{ id: string }>(`select id from curator.catalog_object where kind = 'artist' and merged_into is null and name_fold = $1 limit 2`, [nameFold(q)]);
	return rows.length === 1 ? rows[0]!.id : null;
}

async function labelView(tx: Queryable, id: string): Promise<LabelView> {
	const s = (await summaries(tx, [id])).get(id);
	if (!s) throw new Error(`label ${id} not found`);
	const identifiers = await tx.query<{ namespace: string; value: string }>(`select namespace, value from curator.catalog_identifier where object_id = $1 order by namespace`, [id]);
	const tracking = (
		await tx.query<{ provider: string; last_ms: unknown; due_ms: unknown; fail_count: unknown; last_error: string | null }>(
			`select provider, extract(epoch from last_run_at) * 1000 as last_ms, extract(epoch from next_due_at) * 1000 as due_ms, fail_count, last_error from curator.catalog_cursor where object_id = $1 order by provider`,
			[id],
		)
	).map((c) => ({ provider: c.provider, lastRunAt: numOrNull(c.last_ms), nextDueAt: numOrNull(c.due_ms), failCount: num(c.fail_count), lastError: c.last_error }));
	const tasks = (
		await tx.query<{ need: string; provider: string; due_ms: unknown; attempts: unknown; last_error: string | null }>(
			`select need, provider, extract(epoch from next_due_at) * 1000 as due_ms, attempts, last_error from curator.catalog_enrich_task where object_id = $1 order by need, provider`,
			[id],
		)
	).map((t) => ({ need: t.need, provider: t.provider, nextDueAt: numOrNull(t.due_ms), attempts: num(t.attempts), lastError: t.last_error }));
	const [counts] = await tx.query<{ releases: unknown; roster: unknown; on_spotify: unknown }>(
		`select (select count(*) from curator.catalog_edge e where e.kind = 'release-label' and e.dst = $1) as releases,
			(select count(*) from curator.catalog_edge e where e.kind = 'label-artist' and e.src = $1) as roster,
			(select count(*) from curator.catalog_edge e where e.kind = 'release-label' and e.dst = $1
				and exists (select 1 from curator.catalog_source_object so where so.object_id = e.src and so.provider = 'spotify')) as on_spotify`,
		[id],
	);
	const catalogue = await tx.query<{ name: string; provider_id: string; url: string | null }>(
		`select p.name, so.provider_id, so.url from curator.catalog_edge e join curator.catalog_object p on p.id = e.dst
		join curator.catalog_source_object so on so.object_id = p.id and so.provider = 'spotify'
		where e.src = $1 and e.kind = 'label-playlist' and e.role = 'catalogue' order by p.name`,
		[id],
	);
	const reviews = (await tx.query<{ id: unknown; kind: ReviewKind }>(`select id, kind from curator.catalog_review where object_id = $1 and status = 'open' order by id`, [id])).map((r) => ({ id: num(r.id), kind: r.kind }));
	const latest = await objectReleases(tx, id, 10);
	const pages = s.handles.filter((h) => h.provider !== 'user');
	const gaps: string[] = [];
	const profile = tasks.find((t) => t.need === 'profile');
	if (profile) gaps.push(profile.attempts ? `profile failed ${profile.attempts}×: ${profile.lastError ?? ''}`.trim() : 'profile pending');
	else if (!pages.length) gaps.push('no pages found (profile ran): add one by URL or search the reviews');
	for (const p of EXPECTED_PAGES) if (!pages.some((h) => h.provider === p)) gaps.push(`no ${p} page`);
	for (const t of tasks.filter((t) => t.need === 'backfill')) gaps.push(t.attempts ? `backfill ${t.provider} failed ${t.attempts}×: ${t.lastError ?? ''}`.trim() : `backfill ${t.provider} pending`);
	if (num(counts!.releases) === 0 && !tasks.some((t) => t.need === 'backfill' || t.need === 'profile')) gaps.push('no releases');
	const cp = tasks.find((t) => t.need === 'catalogue_playlists');
	if (cp) gaps.push(cp.attempts ? `catalogue playlists failed ${cp.attempts}×: ${cp.lastError ?? ''}`.trim() : 'catalogue playlists pending (after the backfills)');
	else if (!catalogue.length && !profile) gaps.push('no Spotify catalogue playlist found');
	for (const c of tracking) if (c.failCount > 0) gaps.push(`tracker ${c.provider} failing (${c.failCount}×): ${c.lastError ?? ''}`.trim());
	for (const r of reviews) gaps.push(`review #${r.id} open (${r.kind})`);
	return {
		id,
		name: s.name,
		watchers: s.watchCount,
		pages: pages.map((h) => ({ provider: h.provider, id: h.id, url: h.url })),
		cataloguePlaylists: catalogue.map((c) => ({ id: c.provider_id, name: c.name, url: c.url })),
		onSpotify: num(counts!.on_spotify),
		identifiers,
		tracking,
		tasks,
		releases: num(counts!.releases),
		latest,
		roster: num(counts!.roster),
		reviews,
		gaps,
	};
}

export function adminOps(db: Db, evidence: EvidenceDeps, hooks: { pass?: () => Promise<void>; agent?: { model: ModelCall; cfg: AgentReasonerConfig } | null } = {}): AdminOps {
	async function view(r: Review, withEvidence: boolean): Promise<ReviewView> {
		return withSystemTx(db, async (tx) => {
			const obj = (await summaries(tx, [r.objectId])).get(r.objectId) ?? null;
			const releases = await objectReleases(tx, r.objectId, 25);
			const mine = new Set(releases.map((x) => nameFold(x.title)));
			const candidateViews: ReviewView['candidateViews'] = [];
			for (const [index, candidate] of r.candidates.entries()) {
				let titles = candidate.releases ?? [];
				if (!titles.length && withEvidence) {
					titles = candidate.objectId ? (await objectReleases(tx, candidate.objectId, 25)).map((x) => x.title) : await candidateReleases(evidence, candidate).catch(() => []);
				}
				candidateViews.push({ index, candidate, releases: titles.slice(0, 25), overlap: titles.filter((t) => mine.has(nameFold(t))).length });
			}
			return {
				...r,
				object: obj ? { name: obj.name, kind: obj.kind, handles: obj.handles } : null,
				releases: releases.map((x) => ({ title: x.title, artists: x.artists, date: x.date, providers: x.providers })),
				candidateViews,
			};
		});
	}
	const label = (q: string) =>
		withSystemTx(db, async (tx) => {
			const id = await findLabel(tx, q);
			if (!id) throw new Error(`no label matches "${q}" (try: search)`);
			return id;
		});
	const artist = (q: string) =>
		withSystemTx(db, async (tx) => {
			const id = await findArtist(tx, q);
			if (!id) throw new Error(`no single artist matches "${q}" (try: search <name> --kind artist, then the id)`);
			return id;
		});
	// Any object by its id; a label also by name or page.
	const objectRef = async (q: string) => (UUID_RE.test(q.trim()) ? q.trim() : label(q));
	const scope = async (a: { ids?: string[]; label?: string; artist?: string }) =>
		a.ids?.length ? { ids: a.ids } : a.label ? { labelId: await label(a.label) } : a.artist ? { artistId: await artist(a.artist) } : {};
	// What happened, for the activity log (inbox.ts): release work and imports
	// are never asked about, only recorded.
	const audit = (title: string, kind: string, subjects: string[], ev: Record<string, unknown>, by?: string) =>
		withSystemTx(db, (tx) => raise(tx, { kind, severity: 'audit', title, subjects, evidence: ev, actor: by ?? 'claude-code' }));
	const fetchFn = evidence.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
	const fetchers = {
		spotify: evidence.spotify ?? null,
		tidal: evidence.tidal ?? null,
		apple: evidence.apple === undefined ? new AppleLookup(fetchFn) : evidence.apple,
		deezer: new DeezerTracker(fetchFn),
		beatport: new BeatportTracker(fetchFn),
		bandcamp: new BandcampTracker(fetchFn),
	};
	return {
		async releaseStubs(args) {
			const s = await scope(args);
			return withSystemTx(db, (tx) => releaseStubs(tx, s, args.limit ?? 50));
		},
		async releaseFill(args) {
			for (const id of args.ids ?? []) if (!UUID_RE.test(id)) throw new Error(`"${id}" is not a release id`);
			const s = await scope(args);
			const r = await fillReleases(db, fetchers, s, { limit: args.limit, dry: args.dry });
			if (!r.dry && r.filled) await audit(`Filled ${r.filled} of ${r.stubs} release tracklist(s)${args.label ? ` on ${args.label}` : ''}`, 'release.fill', s.labelId ? [s.labelId] : [], { filled: r.filled, stubs: r.stubs, parked: r.parked }, args.by);
			return r;
		},
		async releaseDedupe(args) {
			for (const id of args.ids ?? []) if (!UUID_RE.test(id)) throw new Error(`"${id}" is not a release id`);
			const s = await scope(args);
			if (!s.ids && !s.labelId && !s.artistId) throw new Error('release dedupe needs release ids, --label or --artist');
			const r = await dedupeTracks(db, s, { dry: args.dry, by: args.by });
			if (!r.dry && r.merged.length) await audit(`Merged ${r.merged.length} duplicate track(s) across ${r.releases} release(s)`, 'release.dedupe', s.labelId ? [s.labelId] : [], { merged: r.merged.slice(0, 50) }, args.by);
			return r;
		},
		async agentCases(args) {
			return withSystemTx(db, async (tx) => ({ counts: await caseCounts(tx), cases: await listCases(tx, { status: args.status, kind: args.kind, limit: args.limit ?? 50 }), enabled: !!hooks.agent }));
		},
		agentCase(args) {
			return withSystemTx(db, async (tx) => {
				const c = await getCase(tx, args.id);
				if (!c) return null;
				const [p] = await tx.query<{ pack: string | null }>(`select pack::text as pack from curator.catalog_agent_case where id = $1::bigint`, [String(args.id)]);
				return { ...c, pack: p?.pack ? (JSON.parse(p.pack) as EvidencePack) : null };
			});
		},
		// The backlog the pass's two-day window never reaches: bucket ids and cut
		// credits over the last `days`, queued for the reasoner like the pass would.
		async agentSweep(args) {
			const days = Math.max(1, Math.min(args.days, 3650));
			// Dry: the bucket candidates with their numbers, nothing queued (to tune the rule).
			if (args.dry) {
				return withSystemTx(db, async (tx) => {
					const cands = await bucketCandidates(tx, { days });
					const names = await summaries(tx, cands.map((c) => c.artist));
					return { buckets: cands.filter((c) => c.suspect).length, credits: 0, candidates: cands.map((c) => ({ ...c, name: names.get(c.artist)?.name ?? c.artist })) };
				});
			}
			if (!hooks.agent) throw new Error('the reasoner is off: nothing would answer the cases');
			const kinds = args.kinds?.length ? args.kinds : ['bucket', 'credit'];
			return {
				buckets: kinds.includes('bucket') ? await withSystemTx(db, (tx) => detectBuckets(tx, { days, limit: args.limit ?? 25 })) : 0,
				credits: kinds.includes('credit') ? await withSystemTx(db, (tx) => detectCredits(tx, { days, limit: args.limit ?? 25 })) : 0,
			};
		},
		// Withdraws cases (a detector asked the wrong question, or asked twice):
		// moot, with why. A case that already proposed takes its open proposals
		// with it — cleared, not rejected, so no ruling is recorded.
		async agentDrop(args) {
			if (!args.ids.length) throw new Error('agent drop <case id…> --reason "…"');
			const why = `dropped: ${args.reason}`.slice(0, 500);
			return withSystemTx(db, async (tx) => {
				const rows = await tx.query<{ id: unknown }>(
					`update curator.catalog_agent_case set status = 'moot', last_error = $2, lease_holder = null, lease_until = null where id = any($1::bigint[]) and status in ('queued', 'leased', 'proposed') returning id`,
					[`{${args.ids.join(',')}}`, why],
				);
				const dropped = rows.map((r) => num(r.id));
				const items = await tx.query<{ id: unknown }>(
					`select id from curator.catalog_inbox where status = 'open' and actor = 'agent' and (evidence->>'case')::bigint = any($1::bigint[])`,
					[`{${dropped.join(',') || '0'}}`],
				);
				for (const i of items) await clearInbox(tx, num(i.id), why);
				return { dropped, cleared: items.map((i) => num(i.id)) };
			});
		},
		agentEvalExport(args) {
			const since = args.since ? Date.parse(args.since) : undefined;
			if (since !== undefined && Number.isNaN(since)) throw new Error(`--since: not a date: ${args.since}`);
			return withSystemTx(db, (tx) => exportEvalCases(tx, { since }));
		},
		async agentRun(args) {
			if (!hooks.agent) throw new Error('the reasoner is off: set CURATOR_ANTHROPIC_API_KEY, or CURATOR_AGENT_BACKEND=claude-code for the Claude Code subscription (apps/cloud/.env.example), and restart');
			const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, for: () => log } as unknown as Parameters<typeof runAgentReasoner>[0]['log'];
			return runAgentReasoner({ db, log, model: hooks.agent.model, cfg: hooks.agent.cfg, holder: 'admin', batch: args.batch, by: args.by ?? 'agent' }, { only: args.id, dry: args.dry });
		},
		// The reasoner's opinion on an open twins item the operator holds (raised
		// before the reasoner was on, or by hand): the same pack and prompt a case
		// would get, nothing written — the operator decides the item as before.
		async agentAdvise(args) {
			if (!hooks.agent) throw new Error('the reasoner is off: nothing to ask');
			const item = await withSystemTx(db, (tx) => getInbox(tx, args.inbox));
			if (!item) throw new Error(`no inbox item ${args.inbox}`);
			if (item.status !== 'open' || !item.apply || !['mergeReleases', 'mergeArtists'].includes(item.apply.op)) throw new Error(`#${item.id} is not an open twins item`);
			const pairs = item.apply.args.pairs as { keep: string; fold: string }[];
			const views = (item.evidence.pairs as { keep: { title?: string }; fold: { title?: string }; on?: string[] }[] | undefined) ?? [];
			const kind = item.apply.op === 'mergeReleases' ? 'release_twin' : 'artist_twin';
			const input =
				kind === 'release_twin'
					? { pairs, label: { id: item.subjects[0]!, name: item.subjectNames[0]?.name ?? 'unknown' } }
					: { pairs, on: [...new Set(views.flatMap((v) => v.on ?? []))].slice(0, 8) };
			const c: AgentCase = { id: 0, kind, subjects: pairs.flatMap((p) => [p.keep, p.fold]), input, status: 'leased', attempts: 0, lastError: null, verdict: null, confidence: null, model: null, promptHash: null, usage: null, costUsd: null, inboxId: item.id, createdAt: Date.now(), decidedAt: null, nextDueAt: Date.now() };
			const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, for: () => quiet } as unknown as Parameters<typeof runAgentReasoner>[0]['log'];
			const r = await reasonCase({ db, log: quiet, model: hooks.agent.model, cfg: hooks.agent.cfg, holder: 'advise' }, c, { dry: true, research: args.research });
			const v = r.verdict as { pairs?: { keep: string; fold: string; verdict: string }[]; confidence?: number; rationale?: string } | null;
			return {
				inbox: item.id,
				kind,
				title: item.title,
				pairs: pairs.map((p, i) => ({ i, keep: views[i]?.keep?.title ?? p.keep, fold: views[i]?.fold?.title ?? p.fold, verdict: v?.pairs?.find((q) => q.keep === p.keep && q.fold === p.fold)?.verdict ?? null })),
				confidence: v?.confidence ?? null,
				rationale: v?.rationale ?? null,
				citations: (r.verdict as { citations?: string[] } | null)?.citations ?? [],
				searches: r.answer?.usage.webSearches ?? 0,
				error: r.error,
			};
		},
		async agentAsk(args) {
			if (!CASE_KINDS.includes(args.kind)) throw new Error(`agent ask: kind is one of ${CASE_KINDS.join(', ')}`);
			return withSystemTx(db, async (tx) => {
				const ids = args.ids;
				const names = new Map((await summaries(tx, ids)).entries());
				for (const id of ids) if (!names.has(id)) throw new Error(`no catalogue object ${id}`);
				const gone = await tx.query<{ id: string; into: string }>(`select id, merged_into as into from curator.catalog_object where id = any($1::uuid[]) and merged_into is not null`, [`{${ids.join(',')}}`]);
				if (gone.length) throw new Error(`merged away: ${gone.map((g) => `${g.id} → ${g.into}`).join(', ')} — ask about the live object`);
				switch (args.kind) {
					case 'release_twin':
					case 'artist_twin': {
						if (ids.length < 2) throw new Error('two ids at least: the one to keep, then the copies');
						const pairs = ids.slice(1).map((fold) => ({ keep: ids[0]!, fold }));
						const key = ids.slice(1).sort().join(',');
						if (args.kind === 'release_twin') {
							const [label] = await tx.query<{ id: string; name: string }>(
								`select l.id, l.name from curator.catalog_edge e join curator.catalog_object l on l.id = e.dst and l.merged_into is null where e.src = $1 and e.kind = 'release-label' limit 1`,
								[ids[0]!],
							);
							return { id: await enqueueCase(tx, { kind: 'release_twin', subjects: ids, input: { pairs, label: label ?? { id: ids[0]!, name: names.get(ids[0]!)!.name } }, key }) };
						}
						return { id: await enqueueCase(tx, { kind: 'artist_twin', subjects: ids, input: { pairs, on: [] }, key }) };
					}
					case 'artist_bucket': {
						if (!args.source) throw new Error('artist_bucket needs --source <provider>:<id>');
						return { id: await enqueueCase(tx, { kind: 'artist_bucket', subjects: [ids[0]!], input: { artist: ids[0]!, source: args.source }, key: `${args.source.provider}:${args.source.providerId}` }) };
					}
					case 'credit': {
						if (ids.length < 3) throw new Error('credit: the release id, then two or more artist ids (the pieces)');
						return { id: await enqueueCase(tx, { kind: 'credit', subjects: ids, input: { release: ids[0]!, creditText: args.creditText ?? null, pieces: ids.slice(1), provider: 'user' }, key: args.creditText ?? ids.slice(1).sort().join(',') }) };
					}
					case 'label_pages': {
						const reviews = (await listReviews(tx, { status: 'open', kind: 'label_page', limit: 200 })).filter((r) => r.objectId === ids[0]).map((r) => r.id);
						if (!reviews.length) throw new Error('no open label_page review on this label');
						return { id: await enqueueCase(tx, { kind: 'label_pages', subjects: [ids[0]!], input: { label: ids[0]!, reviews }, key: reviews.join(',') }) };
					}
				}
			});
		},
		async libraryImport(args) {
			const r = await libraryImport(db, { claims: args.claims, key: args.key, by: args.by ?? 'claude-code', dry: args.dry });
			if (!r.dry && !r.duplicate) await audit(`Library import: ${args.claims.length} claim(s) — ${r.created} created, ${r.attached} attached, ${r.fills} fill(s) queued`, 'library.import', [], { key: args.key, created: r.created, attached: r.attached, fills: r.fills, profiles: r.profiles }, args.by);
			return r;
		},
		async repairPreviews(args) {
			const labelId = args.label ? await label(args.label) : null;
			const r = await repairPreviews(db, { labelId, dry: args.dry, by: args.by });
			if (!r.dry && (r.merged.length || r.lengthsCleared || r.creditsDropped)) await audit(`Repaired ${r.recordings} SoundCloud preview copies: ${r.merged.length} merged, ${r.lengthsCleared} lengths cleared, ${r.creditsDropped} credits dropped`, 'repair.previews', labelId ? [labelId] : [], { merged: r.merged.slice(0, 50) }, args.by);
			return r;
		},
		async repairArtistTwins(args) {
			return artistTwins(db, { dry: args.dry, by: args.by, ...(args.mergeOnly ? { proposeLimit: 0 } : {}) });
		},
		async repairCredits(args) {
			const r = await repairCredits(db, { dry: args.dry, by: args.by });
			if (!r.dry && (r.fixed.length || r.renamed.length)) await audit(`Repaired ${r.fixed.length} split artist credit(s), renamed ${r.renamed.length} back`, 'repair.credits', [...r.fixed.map((f) => f.id), ...r.renamed.map((n) => n.id)], { renamed: r.renamed.slice(0, 50), fixed: r.fixed.slice(0, 50).map((f) => ({ name: f.name, into: f.into, minted: f.minted })) }, args.by);
			return r;
		},
		async artistMerge(args) {
			if (!args.note?.trim()) throw new Error('artist merge needs --note (why they are one)');
			const by = args.by ?? 'claude-code';
			return withSystemTx(db, async (tx) => {
				const names = new Map((await tx.query<{ id: string; name: string; kind: string }>(`select id, name, kind from curator.catalog_object where id = any($1::uuid[]) and merged_into is null`, [`{${args.from},${args.into}}`])).map((r) => [r.id, r]));
				const [f, i] = [names.get(args.from), names.get(args.into)];
				if (!f || !i || f.kind !== 'artist' || i.kind !== 'artist') throw new Error('artist merge takes the ids of two live artists');
				if (!args.approved) {
					const held = await raise(tx, { kind: 'artist.merge', severity: 'approval', title: `Merge artist «${f.name}» into «${i.name}»`, subjects: [i.id, f.id], evidence: { note: args.note }, apply: { op: 'mergeArtists', args: { pairs: [{ keep: i.id, fold: f.id }] } }, actor: by, key: `${f.id}>${i.id}` });
					return { held };
				}
				const r = await mergeObjects(tx, f.id, i.id, by, args.note, { manual: true });
				await raise(tx, { kind: 'artist.merge', severity: 'audit', title: `Merged artist «${f.name}» into «${i.name}»`, subjects: [i.id], evidence: { note: args.note, from: f.id }, actor: by });
				return { moved: r.moved };
			});
		},
		async artistRecredit(args) {
			if (!args.approved) throw new Error('artist recredit changes credits: pass --approved only when Guy said so in chat');
			if (!args.note?.trim()) throw new Error('artist recredit needs --note (why)');
			const by = args.by ?? 'claude-code';
			return withSystemTx(db, async (tx) => {
				const credits = await recreditOn(tx, args.artist, args.release, args.to);
				if (credits) await raise(tx, { kind: 'artist.recredit', severity: 'audit', title: `Moved ${credits} credit(s) on a release to another artist`, subjects: [args.to, args.artist, args.release], evidence: { note: args.note, from: args.artist, release: args.release }, actor: by });
				return { credits };
			});
		},
		async insightAdd(args) {
			const id = await objectRef(args.q);
			return withSystemTx(db, async (tx) => {
				const by = args.by ?? 'claude-code';
				const insight = await addInsight(tx, { objectId: id, topic: args.topic, body: args.body, evidence: args.evidence, actor: by });
				const facts = await objectFacts(tx, [insight.objectId]);
				await raise(tx, {
					kind: 'insight.add',
					severity: reversiblePolicy(facts.get(insight.objectId), { approved: args.approved }),
					title: `Noted on «${facts.get(insight.objectId)?.name ?? insight.objectId}» (${insight.topic}): ${insight.body}`.slice(0, 300),
					subjects: [insight.objectId],
					evidence: { insight: insight.id, topic: insight.topic, body: insight.body, ...(args.evidence ? { basis: args.evidence } : {}) },
					undo: { op: 'retireInsight', args: { id: insight.id } },
					actor: by,
					approvedBy: args.approved ? OPERATOR : null,
				});
				return insight;
			});
		},
		insightRetire(args) {
			return withSystemTx(db, async (tx) => {
				const by = args.by ?? 'claude-code';
				const insight = await retireInsight(tx, args.id, by);
				const facts = await objectFacts(tx, [insight.objectId]);
				await raise(tx, {
					kind: 'insight.retire',
					severity: 'audit',
					title: `Retired a note on «${facts.get(insight.objectId)?.name ?? insight.objectId}» (${insight.topic}): ${insight.body}`.slice(0, 300),
					subjects: [insight.objectId],
					evidence: { insight: insight.id, note: args.note ?? null },
					undo: { op: 'restoreInsight', args: { id: insight.id } },
					actor: by,
				});
				return insight;
			});
		},
		async insightList(args) {
			const id = await objectRef(args.q);
			return withSystemTx(db, async (tx) => {
				const [o] = await tx.query<{ id: string; name: string; kind: string }>(`select id, name, kind from curator.catalog_object where id = $1`, [id]);
				return { ...o!, insights: (await insightsOf(tx, [id], { retired: args.retired })).get(id) ?? [] };
			});
		},
		async releaseLink(args) {
			if (!UUID_RE.test(args.id)) throw new Error(`"${args.id}" is not a release id`);
			const r = await linkReleasePage(db, args.id, args.url);
			await audit(`Linked ${r.provider}:${r.id} to a release${r.conflict ? ` (held by another: ${r.conflict})` : ''}`, 'release.link', [args.id], { url: args.url, conflict: r.conflict }, args.by);
			return r;
		},
		async list(args) {
			const rows = await withSystemTx(db, (tx) => listReviews(tx, args));
			const out: ReviewView[] = [];
			for (const r of rows) out.push(await view(r, args.evidence ?? false));
			return out;
		},
		async get(args) {
			const r = await withSystemTx(db, (tx) => getReview(tx, args.id));
			return r ? view(r, args.evidence ?? true) : null;
		},
		async decide(args) {
			const by = args.by || 'claude-code';
			const note = args.note ?? null;
			return withSystemTx(db, async (tx) => {
				const review = await getReview(tx, args.id);
				if (!review) throw new Error(`review ${args.id} not found`);
				const candidate = args.decision.candidate === undefined ? null : review.candidates[args.decision.candidate] ?? null;
				const subjects = [review.objectId, ...(candidate?.objectId ? [candidate.objectId] : [])];
				const facts = await objectFacts(tx, subjects);
				const q = (id: string) => `«${facts.get(id)?.name ?? id}»`;
				const evidence = {
					review: args.id,
					reviewKind: review.kind,
					decision: args.decision,
					note,
					candidate: candidate ? { name: candidate.name, objectId: candidate.objectId ?? null, provider: candidate.provider ?? null, providerId: candidate.providerId ?? null, url: candidate.url ?? null, evidence: candidate.evidence ?? null } : null,
				};
				if (args.decision.action === 'merge' && candidate?.objectId && review.status === 'open') {
					const severity = mergePolicy(facts.get(candidate.objectId), facts.get(review.objectId), { approved: args.approved });
					const title = `Merge ${q(candidate.objectId)} into ${q(review.objectId)}`;
					if (severity === 'approval') {
						await holdReview(tx, args.id, args.decision, by, note);
						const held = await raise(tx, { kind: 'review.merge', severity, title, subjects, evidence, apply: { op: 'decideReview', args: { id: args.id, decision: args.decision, by, note } }, actor: by, reviewId: args.id, key: `review:${args.id}` });
						return { review: (await getReview(tx, args.id))!, held };
					}
					const r = await decideReview(tx, args.id, args.decision, by, note);
					await raise(tx, { kind: 'review.merge', severity, title, subjects, evidence: { ...evidence, merged: r.merge ?? null }, actor: by, approvedBy: args.approved ? OPERATOR : null, reviewId: args.id });
					return r;
				}
				const r = await decideReview(tx, args.id, args.decision, by, note, { operator: by === OPERATOR });
				if (r.review.status === 'escalated') {
					await raise(tx, {
						kind: 'review.escalated',
						severity: 'approval',
						title: `Review #${args.id} left for you: ${review.kind.replace('_', ' ')} on ${q(review.objectId)}`,
						subjects: [review.objectId, ...review.candidates.map((c) => c.objectId).filter((id): id is string => !!id)],
						evidence: { review: args.id, reviewKind: review.kind, candidates: review.candidates, reviewEvidence: review.evidence, note },
						apply: { op: 'decideReview', args: { id: args.id } },
						actor: by,
						reviewId: args.id,
						key: `review:${args.id}`,
					});
					return r;
				}
				if (args.decision.action === 'skip') return r;
				// A ruling or a page attached: done, and undoable while the label matters.
				const severity = reversiblePolicy(facts.get(review.objectId), { approved: args.approved });
				const undo: InboxOp | null =
					args.decision.action === 'not_same' && candidate?.objectId
						? { op: 'dropNotSame', args: { a: review.objectId, b: candidate.objectId, reviewId: args.id } }
						: args.decision.action === 'attach' && candidate?.provider && candidate.providerId && review.kind !== 'label_playlist'
							? { op: 'unlinkPage', args: { objectId: review.objectId, page: { provider: candidate.provider, id: candidate.providerId, url: candidate.url ?? null }, note: `undone: review #${args.id} attach` } }
							: null;
				const title =
					args.decision.action === 'not_same'
						? `Ruled ${q(review.objectId)} and ${candidate?.objectId ? q(candidate.objectId) : `${candidate?.provider ?? ''}:${candidate?.providerId ?? ''}`} not the same`
						: `Attached ${candidate?.provider ?? 'page'}:${candidate?.providerId ?? ''} to ${q(review.objectId)}`;
				await raise(tx, { kind: `review.${args.decision.action}`, severity, title, subjects, evidence, undo, actor: by, approvedBy: args.approved ? OPERATOR : null, reviewId: args.id });
				return r;
			});
		},
		inboxList(args) {
			return withSystemTx(db, (tx) => listInbox(tx, args));
		},
		inboxCounts() {
			return withSystemTx(db, (tx) => inboxCounts(tx));
		},
		inboxGet(args) {
			return withSystemTx(db, (tx) => getInbox(tx, args.id));
		},
		async inboxDecide(args) {
			const by = args.by || OPERATOR;
			try {
				return await withSystemTx(db, (tx) => decideInbox(tx, args.id, { action: args.action, choice: args.choice, except: args.except, note: args.note ?? null, by }));
			} catch (e) {
				// The transaction rolled back; the item says why it is still open.
				await withSystemTx(db, (tx) => failInbox(tx, args.id, e instanceof Error ? e.message : String(e))).catch(() => {});
				throw e;
			}
		},
		inboxSnooze(args) {
			const until = args.until ? new Date(args.until) : args.days === 0 ? null : new Date(Date.now() + (args.days ?? 7) * 86400_000);
			if (until && Number.isNaN(until.getTime())) throw new Error(`"${args.until}" is not a date`);
			return withSystemTx(db, (tx) => snoozeInbox(tx, args.id, until));
		},
		async scan(args) {
			if (args.kind === 'label') {
				const labels = args.labels?.length ? await Promise.all(args.labels.map((q) => label(q))) : undefined;
				return withSystemTx(db, (tx) => scanRelatedLabels(tx, { labels, limit: args.limit }));
			}
			return { opened: await withSystemTx(db, (tx) => scanDuplicates(tx, args)) };
		},
		async reviewOpen(args) {
			const [a, b] = await Promise.all([label(args.a), label(args.b)]);
			if (a === b) throw new Error('both name the same label');
			return withSystemTx(db, (tx) => openRelatedPair(tx, a, b));
		},
		async labelUnlink(args) {
			const id = await label(args.q);
			// A link it classifies; else `provider:id` as `label show` prints it, or any URL the label holds.
			const page = classifyUrl(args.url);
			const ref = !page && !/^https?:/i.test(args.url) ? /^([a-z]+):(.+)$/.exec(args.url.trim()) : null;
			const target = page
				? { provider: page.provider, id: page.id, url: args.url }
				: ref
					? { provider: ref[1] as CatalogProvider, id: ref[2]!, url: null }
					: { provider: null, id: null, url: args.url };
			const by = args.by ?? 'claude-code';
			return withSystemTx(db, async (tx) => {
				const facts = await objectFacts(tx, [id]);
				const r = await unlinkPage(tx, id, target, by, args.note ?? null);
				await raise(tx, {
					kind: 'label.unlink',
					severity: reversiblePolicy(facts.get(id), { approved: args.approved }),
					title: `Unlinked ${r.provider}:${r.providerId} from «${facts.get(id)?.name ?? id}»`,
					subjects: [id],
					evidence: { url: r.undo.source.url, edges: r.edges, identifiers: r.identifiers, note: args.note ?? null },
					undo: { op: 'relinkPage', args: { objectId: id, undo: r.undo } },
					actor: by,
					approvedBy: args.approved ? OPERATOR : null,
					reviewId: r.review,
				});
				const { undo: _undo, ...out } = r;
				return out;
			});
		},
		async labelMerge(args) {
			if (!args.note?.trim()) throw new Error('label merge needs --note (why they are one)');
			const [from, into] = await Promise.all([label(args.from), label(args.into)]);
			if (from === into) throw new Error('both name the same label');
			const by = args.by ?? 'claude-code';
			return withSystemTx(db, async (tx) => {
				const facts = await objectFacts(tx, [from, into]);
				const title = `Merge «${facts.get(from)?.name ?? from}» into «${facts.get(into)?.name ?? into}», overruling any ruling apart`;
				const evidence = { note: args.note, from: facts.get(from) ?? null, into: facts.get(into) ?? null };
				if (!args.approved) {
					const held = await raise(tx, { kind: 'label.merge', severity: 'approval', title, subjects: [into, from], evidence, apply: { op: 'mergeLabels', args: { from, into, by, note: args.note, overruling: true } }, actor: by, key: `${from}>${into}` });
					return { from, into, name: facts.get(into)?.name ?? '', held };
				}
				const r = await mergeOverruling(tx, from, into, by, args.note);
				const [o] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [into]);
				await raise(tx, { kind: 'label.merge', severity: 'audit', title, subjects: [into, from], evidence: { ...evidence, moved: r.moved }, actor: by, approvedBy: OPERATOR });
				return { ...r, name: o!.name };
			});
		},
		async labelRename(args) {
			const id = await label(args.q);
			const by = args.by ?? 'claude-code';
			return withSystemTx(db, async (tx) => {
				const facts = await objectFacts(tx, [id]);
				const was = await renameObject(tx, id, args.name);
				await raise(tx, {
					kind: 'label.rename',
					severity: reversiblePolicy(facts.get(id), { approved: args.approved }),
					title: `Renamed «${was}» to «${args.name.trim()}»`,
					subjects: [id],
					evidence: { from: was, to: args.name.trim() },
					undo: { op: 'rename', args: { objectId: id, name: was } },
					actor: by,
					approvedBy: args.approved ? OPERATOR : null,
				});
				return { id, name: args.name.trim() };
			});
		},
		async labelScanned(args) {
			const id = await label(args.q);
			return withSystemTx(db, async (tx) => {
				const [o] = await tx.query<{ name: string; at_ms: unknown }>(
					`update curator.catalog_object set scanned_at = now() where id = $1 returning name, extract(epoch from scanned_at) * 1000 as at_ms`,
					[id],
				);
				await raise(tx, {
					kind: 'label.scanned',
					severity: 'audit',
					title: `Scanned «${o!.name}» for new releases${args.note ? `: ${args.note}` : ''}`,
					subjects: [id],
					evidence: { note: args.note ?? null },
					actor: args.by ?? 'claude-code',
				});
				return { id, name: o!.name, scannedAt: num(o!.at_ms) };
			});
		},
		async search(args) {
			const rows = await withSystemTx(db, (tx) => search(tx, args.q, args.kind, args.limit ?? 10));
			return rows.map((o) => ({ id: o.id, kind: o.kind, name: o.name, watchers: o.watchCount, pages: o.handles.map((h) => `${h.provider}:${h.id}`) }));
		},
		async labelAdd(args) {
			return withSystemTx(db, async (tx) => {
				let id = await findLabel(tx, args.q);
				let fresh = false;
				if (!id) {
					const page = classifyUrl(args.q);
					const claim = page?.kind === 'label' ? labelClaimFromPage(page) : { provider: 'user' as const, kind: 'label' as const, providerId: `name:${nameFold(args.q)}`, name: args.q.trim() };
					if (!claim) throw new Error(`"${args.q}" is neither a label name nor a Beatport / Bandcamp label page`);
					id = (await ingestClaims(tx, [claim], { reason: 'manual_registration' })).outcomes[0]!.objectId;
					fresh = true;
				}
				// A label already known keeps its profile; one that never got a
				// page (or is new) is profiled. `label refresh` re-reads releases.
				const [pages] = await tx.query<{ n: unknown }>(`select count(*) as n from curator.catalog_source_object where object_id = $1 and provider not in ('user')`, [id]);
				if (fresh || num(pages!.n) <= (classifyUrl(args.q) ? 1 : 0)) {
					await tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'profile', 'catalog') on conflict do nothing`, [id]);
				}
				return labelView(tx, id);
			});
		},
		async labelShow(args) {
			const id = await label(args.q);
			return withSystemTx(db, (tx) => labelView(tx, id));
		},
		async labelImport(args) {
			const id = await label(args.q);
			if (!args.data || !Array.isArray(args.data.releases)) throw new Error('import file needs { source, releases: [...] }');
			for (const r of args.data.releases) {
				if (!r.title || !Array.isArray(r.artists) || !r.url) throw new Error(`every release needs title, artists[] and url (the page it was read on): ${JSON.stringify(r).slice(0, 120)}`);
			}
			const report = await agentImport(db, id, args.data, { dry: args.dry });
			if (!args.dry) {
				await withSystemTx(db, async (tx) => {
					// Releases arrived: the evidence for a look-alike is there now.
					await queueLabelDedupe(tx, id);
					const facts = await objectFacts(tx, [id]);
					let host = args.data.source;
					try {
						host = new URL(args.data.source).hostname.replace(/^www\./, '');
					} catch {
						/* a name, not a URL */
					}
					await raise(tx, {
						kind: 'label.import',
						severity: 'audit',
						title: `Imported ${report.releases} release(s) into «${facts.get(id)?.name ?? id}» from ${host}: ${report.matched} matched, ${report.created} new, ${report.storeIds} store id(s)`,
						subjects: [id],
						evidence: { source: args.data.source, releases: report.releases, matched: report.matched, created: report.created, storeIds: report.storeIds, conflicts: report.conflicts.length, unread: report.unread.length },
						actor: args.by ?? 'claude-code',
					});
				});
			}
			return report;
		},
		async labelLink(args) {
			const id = await label(args.q);
			const page = classifyUrl(args.url) ?? websiteLink(args.url);
			if (!page) throw new Error(`"${args.url}" is not a label page I know how to read`);
			if (page.kind === 'playlist') {
				// Its name and keeper from Spotify when the ops have the app;
				// a placeholder otherwise, which the fill does not need.
				const meta = evidence.spotify ? await fetchPlaylistMeta(evidence.spotify, page.id, AbortSignal.timeout(20_000)).catch(() => null) : null;
				return withSystemTx(db, async (tx) => {
					const [owner] = await tx.query<{ label: string }>(
						`select e.src as label from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.dst and so.provider = 'spotify' and so.kind = 'playlist'
						where so.provider_id = $1 and e.kind = 'label-playlist' and e.role = 'catalogue' and e.src <> $2 limit 1`,
						[page.id, id],
					);
					if (owner) throw new Error(`spotify playlist ${page.id} is already the catalogue of label ${owner.label}`);
					await acceptCataloguePlaylist(tx, id, { id: page.id, name: meta?.name || `Spotify playlist ${page.id}`, url: page.url });
					await queueCataloguePlaylists(tx, id);
					const facts = await objectFacts(tx, [id]);
					await raise(tx, { kind: 'label.link', severity: 'audit', title: `Made spotify playlist ${page.id} the catalogue of «${facts.get(id)?.name ?? id}»`, subjects: [id], evidence: { url: page.url, name: meta?.name ?? null }, actor: args.by ?? 'claude-code', approvedBy: args.approved ? OPERATOR : null });
					return labelView(tx, id);
				});
			}
			// A Bandcamp subdomain or SoundCloud permalink is resolved to the id
			// its API takes here, not left for a profile pass another source
			// may be parking; the slug stays when the page does not answer.
			const signal = AbortSignal.timeout(20_000);
			const slug = !/^\d+$/.test(page.id);
			const resolved = slug && page.provider === 'bandcamp' ? (await resolveBandcampBand(fetchFn, page.url, signal))?.id ?? null
				: slug && page.provider === 'soundcloud' ? await resolveSoundcloudUser(fetchFn, page.url, signal)
				: null;
			const providerId = resolved ?? page.id;
			return withSystemTx(db, async (tx) => {
				const owner = await findRepresentation(tx, { provider: page.provider, kind: 'label', providerId });
				if (owner && owner !== id) throw new Error(`${page.provider}:${providerId} already belongs to label ${owner}`);
				const [o] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [id]);
				// The slug the label may already carry becomes the id.
				if (resolved) await repointRepresentation(tx, id, { provider: page.provider, from: page.id, to: resolved, url: page.url });
				await attachPage(tx, id, { provider: page.provider, providerId, name: o!.name, url: page.url }, 'label');
				// Its releases from that page, once (trackers/backfill.ts).
				if ((BACKFILL_PROVIDERS as readonly string[]).includes(page.provider)) {
					await tx.query(
						`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'backfill', $2)
						on conflict (object_id, need, provider) do update set next_due_at = now(), attempts = 0, last_error = null`,
						[id, page.provider],
					);
				}
				const facts = await objectFacts(tx, [id]);
				await raise(tx, {
					kind: 'label.link',
					severity: reversiblePolicy(facts.get(id), { approved: args.approved }),
					title: `Linked ${page.provider}:${providerId} to «${o!.name}»`,
					subjects: [id],
					evidence: { url: page.url },
					undo: { op: 'unlinkPage', args: { objectId: id, page: { provider: page.provider, id: providerId, url: page.url }, note: 'undone: label link' } },
					actor: args.by ?? 'claude-code',
					approvedBy: args.approved ? OPERATOR : null,
				});
				return labelView(tx, id);
			});
		},
		async labelVerify(args) {
			const ids = await withSystemTx(db, (tx) =>
				tx.query<{ id: string }>(
					`select id from curator.catalog_object where kind = 'label' and merged_into is null and ($1::bool is false or watch_count > 0)
					order by watch_count desc, name limit $2::int`,
					[args.watchedOnly ? 'true' : 'false', String(args.limit ?? 100)],
				),
			);
			const out: VerifyRow[] = [];
			for (const { id } of ids) {
				const v = await withSystemTx(db, (tx) => labelView(tx, id));
				out.push({ id, name: v.name, watchers: v.watchers, pages: v.pages.map((p) => p.provider), releases: v.releases, gaps: v.gaps });
			}
			return out;
		},
		async labelRefresh(args) {
			const id = await label(args.q);
			return withSystemTx(db, async (tx) => {
				const cursors = (await tx.query(`update curator.catalog_cursor set next_due_at = now(), lease_holder = null, lease_until = null where object_id = $1 returning 1`, [id])).length;
				const pages = await tx.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1 and provider <> 'user'`, [id]);
				const profile = pages.length === 0;
				if (profile) await tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'profile', 'catalog') on conflict (object_id, need, provider) do update set next_due_at = now()`, [id]);
				const backfills = cursors
					? 0
					: (
							await tx.query(
								`insert into curator.catalog_enrich_task (object_id, need, provider)
								select $1, 'backfill', p from unnest($2::text[]) as p
								where p = 'deezer' or exists (select 1 from curator.catalog_source_object so where so.object_id = $1 and so.provider = p)
								on conflict (object_id, need, provider) do update set next_due_at = now(), attempts = 0, last_error = null returning 1`,
								[id, `{${BACKFILL_PROVIDERS.join(',')}}`],
							)
						).length;
				// And its catalogue playlists again (new ones found, every one read
				// in full: the back catalogue's Spotify ids).
				await queueCataloguePlaylists(tx, id);
				// Asked for by name: all of this label's queued work goes ahead of
				// the queue (a migration may have queued a thousand labels).
				await tx.query(`update curator.catalog_enrich_task set next_due_at = now() - interval '1 day', attempts = 0, last_error = null, lease_holder = null, lease_until = null where object_id = $1`, [id]);
				return { cursors, backfills, profile };
			});
		},
		async labelReleases(args) {
			const id = await label(args.q);
			return withSystemTx(db, (tx) => objectReleases(tx, id, args.limit ?? 50));
		},
		async pass() {
			if (!hooks.pass) return { ran: false };
			await hooks.pass();
			return { ran: true };
		},
	};
}

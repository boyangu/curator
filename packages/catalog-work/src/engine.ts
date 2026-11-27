// The device side of 'catalog_device_work' (packages/protocol catalog-work.ts):
// the cloud hands a device work with what it read, and this does it — the
// one reading engine the desktop and the phone both run, so the two read the
// stores alike and report alike.
//
// It decides nothing about what to read: the cloud named every page and
// every store (apps/cloud catalog/work/plan.ts). What it owns is how:
//   - a listing is read to its end here (a reader holds releases back for its
//     next poll; up to LISTING_POLLS polls in a row) and reported once, not a
//     round trip to the cloud per poll — the user is waiting on the page;
//   - a release is looked for at another store by ISRC, then UPC, then title
//     and artist, and kept only when the tracklists confirm it by the same
//     strict rule the cloud applies (library-logic confirmRelease), so what
//     the page shows at once is what the cloud will keep;
//   - a track's facts are asked of the stores in the job's order, a later
//     store only for what an earlier left;
//   - every store call goes through its lane (lanes.ts): paced, timed out,
//     counted, stopped while the store rests.
// What it finds is told to the page as it is found (events), and reported in
// batches; the cloud's answer may carry follow-up work, run while the
// visit's rounds last.
//
// A visit is the engine's: one per page open, however many times the page is
// read in it (its next page of releases, a reload after a save). Its reports
// are numbered across all of them — the number is the report's idempotency
// key, and a key used twice is a resend to the cloud, which answers with the
// first report's answer — and its count of releases taken, the jobs done and
// the facts asked are kept across them too. Runs of one visit go one at a time.

import { artistsOverlap, confirmRelease, nameFold, normalizeIsrc, type MatchTrack } from '@curator/library-logic';
import type {
	CatalogClaim,
	CatalogDeviceForm,
	CatalogDeviceProfile,
	CatalogFactsJob,
	CatalogFindJob,
	CatalogJob,
	CatalogRef,
	CatalogReleaseJob,
	CatalogWork,
	CatalogWorkOutcome,
	CatalogWorkReportInput,
	CatalogWorkReportResult,
	CatalogWorkResult,
	CatalogWorkStore,
	CatalogWorkTrack,
} from '@curator/protocol';
import { CATALOG_MAX_NESTED, CATALOG_POLL_MAX_CHILDREN, CATALOG_WORK_STORES } from '@curator/protocol';
import { keyToCamelot } from '@curator/sync-core/enrich/keys';
import type { FetchLike, TrackerPoll } from '@curator/catalog-readers';
import { defaultSleep, Lanes, STORE_GAP_MS, type ClassifyFailure, type Sleep } from './lanes.js';
import { defaultReaders, type FactHit, type WorkReaders } from './readers.js';

// The version of this reading code, in every profile: the cloud stops asking
// a build that reads wrongly by raising its oldest reader past it
// (catalog_setting work.min_reader). Raise it with any change to what is read
// or how a find is confirmed.
export const CATALOG_WORK_READER = 1;

// Polls of one listing in a row, while the reader holds releases back.
const LISTING_POLLS = 3;
// Results a report carries before it goes up: the cloud's write bucket
// refills at one every two seconds, so a page's work goes up in a few.
const REPORT_EVERY = 10;
// A report's size, in characters of JSON, before it goes up: under the
// API's 1.5 MiB body with room for text that is not ASCII.
const REPORT_MAX_CHARS = 600_000;
// A report the cloud did not take is sent again (same key, same body) after
// these waits, then given up: what it found was shown, and the cloud hands
// the same work out again.
const REPORT_RETRY_MS = [1000, 4000];
// Codes tried per store, at most.
const CODES_TRIED = 2;
// Visits remembered: a host opens one per page, and only the last few are
// ever read again.
const VISITS_KEPT = 20;

// A page visit, as the host holds it: the engine keeps the rest.
export type WorkVisit = { readonly id: string };

// What a row of the page gains as the work finds it. `from`: the store that
// stated it — Beatport's genre stands over the row's, every other fact only
// fills what the row lacks (the host applies that).
export type WorkRowPatch = {
	recordingId: string;
	from: CatalogWorkStore;
	bpm?: number;
	keyCamelot?: string;
	genre?: string;
	label?: string;
	streamIds?: { spotify?: string };
};

export type WorkPhase = 'listing' | 'tracklists' | 'details';
export type WorkEvent =
	| { type: 'progress'; phase: WorkPhase; store: CatalogWorkStore | null; done: number; total: number }
	// The releases a listing brought, as the store gave them: shown at once,
	// before the cloud has them. `objectId`: null for an entity it does not hold.
	| { type: 'found'; objectId: string | null; claims: CatalogClaim[] }
	| { type: 'rows'; rows: WorkRowPatch[] }
	// The cloud kept what was reported: these objects are to be read again.
	| { type: 'saved'; changed: string[] }
	// Results the cloud would not take, or failed to save: the host logs them.
	| { type: 'refused'; results: { jobId: string; outcome: CatalogWorkOutcome; note?: string }[] }
	// A report could not be sent (after its retries).
	| { type: 'unsent'; results: number; error: string }
	| { type: 'idle' };

export type WorkEngineDeps = {
	form: CatalogDeviceForm;
	// The user's switch: off, the profile says it reads nothing.
	enabled(): boolean;
	// A store the user and the host allow now (checked in Settings, signed in).
	allowed?(store: CatalogWorkStore): boolean;
	// The stores' fetch. Spotify's is the host's own paced client (the
	// desktop's gate the player and the feed share); Beatport and Traxsource
	// need a browser's (net.fetch, FlareSolverr, a WebView) and, without one,
	// are not read.
	fetch: FetchLike;
	spotifyFetch?: FetchLike;
	beatportFetch?: FetchLike;
	traxsourceFetch?: FetchLike;
	// Spotify's bearer token, null while there is none; absent, no Spotify.
	spotifyToken?(): Promise<string | null>;
	// The host's word on failures only it can read (its gate's ban, its
	// sign-in): lanes.ts ClassifyFailure.
	classify?: ClassifyFailure;
	// catalog.workReport, with the device id the host adds.
	report(input: Omit<CatalogWorkReportInput, 'deviceId'>): Promise<CatalogWorkReportResult>;
	now?: () => number;
	sleep?: Sleep;
	// Tests: gaps of their own (0), readers of their own, a timeout of their own.
	gaps?: Partial<Record<CatalogWorkStore, number>>;
	readers?: Partial<WorkReaders>;
	callTimeoutMs?: number;
};

export type WorkRun = {
	visit: WorkVisit;
	// What the read that handed the work carried, sent back with each report.
	hints?: CatalogRef[];
	signal: AbortSignal;
	onEvent(e: WorkEvent): void;
};

export interface WorkEngine {
	// What the device says of itself with a catalogue read: with a visit, the
	// releases it has taken so far.
	profile(visit?: WorkVisit): CatalogDeviceProfile;
	// A new page visit.
	visit(): WorkVisit;
	// Does the work and its follow-ups; resolves when nothing is left or the
	// signal is called off (what was found by then still goes up). A visit's
	// runs go one after another.
	run(work: CatalogWork, run: WorkRun): Promise<void>;
}

const LISTING_STORES: ReadonlySet<CatalogWorkStore> = new Set(['spotify', 'beatport', 'bandcamp']);

type Track = MatchTrack & { id: string };
type Theirs = MatchTrack & { rec: CatalogClaim };

type VisitState = {
	seq: number;
	taken: Set<string>;
	done: Set<string>;
	// A store's answer for a recording, once per visit: a track on two of the
	// page's releases is looked up once.
	facts: Map<string, FactHit | null>;
	queue: Promise<void>;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// A claim cut to what the wire takes of its nested lists.
const clamp = (c: CatalogClaim): CatalogClaim => ({
	...c,
	...(c.recordings ? { recordings: c.recordings.slice(0, CATALOG_MAX_NESTED).map(clamp) } : {}),
	...(c.artists ? { artists: c.artists.slice(0, CATALOG_MAX_NESTED) } : {}),
});

const claimKey = (c: Pick<CatalogClaim, 'provider' | 'kind' | 'providerId'>): string => `${c.provider}|${c.kind}|${c.providerId}`;

const theirTracks = (c: CatalogClaim): Theirs[] =>
	(c.recordings ?? []).map((r) => ({ title: r.name, durationSec: r.facts?.durationSec ?? null, isrc: normalizeIsrc(r.identifiers?.find((i) => i.namespace === 'isrc')?.value), rec: r }));

const asTrack = (t: CatalogWorkTrack): Track => ({ id: t.id, title: t.title, durationSec: t.durationSec, isrc: t.isrc });

// Artists by name only: the store's ids for them are not the device's to state.
const nameClaims = (names: readonly string[]): CatalogClaim[] =>
	names.filter((n) => n.trim()).map((n) => ({ provider: 'user', kind: 'artist', providerId: `name:${nameFold(n)}`, name: n }));

// A job as done: the same id handed again with other content (a release's
// page now read, a listing's next cursor) is other work.
const jobKey = (j: CatalogJob): string =>
	j.kind === 'find'
		? `${j.id}|${JSON.stringify(j.page?.cursor ?? {})}`
		: j.kind === 'release'
			? `${j.id}|${j.read.map((h) => `${h.provider}:${h.id}`).join(',')}|${j.find.join(',')}`
			: `${j.id}|${j.stores.join(',')}|${j.tracks.map((t) => t.id).join(',')}`;
const releaseOf = (j: CatalogJob): string | null => (j.kind === 'release' ? j.objectId : j.kind === 'facts' ? j.id.slice('facts:'.length) : null);

// A listing's children in parts the wire takes: no more than a poll may
// carry, nor more text than a report. Each part but the last says more is to
// come and keeps the cursor the listing was read from, so a part lost on the
// way leaves the page due again rather than read.
function listingParts(poll: TrackerPoll, children: CatalogClaim[], from: TrackerPoll['cursor']): TrackerPoll[] {
	const parts: CatalogClaim[][] = [[]];
	let size = 0;
	for (const c of children) {
		const n = JSON.stringify(c).length;
		const part = parts[parts.length - 1]!;
		if (part.length && (part.length >= CATALOG_POLL_MAX_CHILDREN || size + n > REPORT_MAX_CHARS / 2)) {
			parts.push([c]);
			size = n;
		} else {
			part.push(c);
			size += n;
		}
	}
	return parts.map((part, i) =>
		i === parts.length - 1
			? { ...poll, children: part }
			: { ...poll, children: part, listingHash: poll.listingHash.startsWith('pending:') ? poll.listingHash : `pending:${poll.listingHash}`.slice(0, 200), cursor: from, calls: 0 },
	);
}

export function createWorkEngine(deps: WorkEngineDeps): WorkEngine {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const lanes = new Lanes(now, sleep, { ...STORE_GAP_MS, ...deps.gaps }, { timeoutMs: deps.callTimeoutMs, classify: deps.classify });
	const baseFor = (store: CatalogWorkStore): FetchLike =>
		store === 'spotify' ? deps.spotifyFetch ?? deps.fetch : store === 'beatport' ? deps.beatportFetch ?? deps.fetch : store === 'traxsource' ? deps.traxsourceFetch ?? deps.fetch : deps.fetch;
	const fetchFor = (store: CatalogWorkStore): FetchLike => lanes.fetchFor(store, baseFor(store));
	const readers: WorkReaders = { ...defaultReaders({ fetchFor, spotifyToken: deps.spotifyToken, now }), ...deps.readers };
	// A host's own release reader reads its own way: the default's batch
	// would fetch pages it never asks for.
	if (deps.readers?.release && !deps.readers.prefetch) delete readers.prefetch;
	const hostFacts = !!deps.readers?.facts;
	const visits = new Map<string, VisitState>();
	let opened = 0;

	const stateOf = (v: WorkVisit): VisitState => {
		let s = visits.get(v.id);
		if (!s) {
			s = { seq: 0, taken: new Set(), done: new Set(), facts: new Map(), queue: Promise.resolve() };
			visits.set(v.id, s);
			while (visits.size > VISITS_KEPT) visits.delete(visits.keys().next().value!);
		}
		return s;
	};

	// A store this device can read at all: allowed, and with what it needs.
	const reads = (store: CatalogWorkStore): boolean =>
		(deps.allowed?.(store) ?? true) &&
		(store !== 'beatport' || !!deps.beatportFetch) &&
		(store !== 'traxsource' || !!deps.traxsourceFetch) &&
		(store !== 'spotify' || !!deps.spotifyToken);
	const usable = (store: CatalogWorkStore): boolean => deps.enabled() && reads(store) && !lanes.resting(store);

	// The profile, in a visit's round (a read is round 0; each answer's
	// follow-up the next).
	function profileAt(visit: WorkVisit | undefined, round: number): CatalogDeviceProfile {
		const resting = lanes.restingList();
		return {
			form: deps.form,
			reader: CATALOG_WORK_READER,
			stores: deps.enabled() ? CATALOG_WORK_STORES.filter((s) => reads(s) && !lanes.resting(s)) : [],
			...(resting.length ? { resting } : {}),
			...(visit ? { visit: { id: visit.id, round, taken: stateOf(visit).taken.size } } : {}),
		};
	}

	// A failed call as the report states it — or not at all: the work was
	// called off (leaving a page is not a store failing), or the trouble is
	// the device's own (lanes.ts).
	const failure = (jobId: string, store: CatalogWorkStore, e: unknown, run: WorkRun): CatalogWorkResult | null => {
		if (run.signal.aborted) return null;
		const f = lanes.failed(store, e, readers.blockedUntil(store));
		return f.report ? { jobId, kind: 'error', store, message: message(e), rateLimitedSec: f.rateLimitedSec } : null;
	};

	// ── find ──────────────────────────────────────────────────────────────

	async function find(job: CatalogFindJob, run: WorkRun): Promise<CatalogWorkResult[]> {
		const page = job.page;
		if (!page || !LISTING_STORES.has(page.provider) || !usable(page.provider)) return [];
		const children = new Map<string, CatalogClaim>();
		let cursor = page.cursor;
		let last: TrackerPoll | null = null;
		let calls = 0;
		let failed: CatalogWorkResult | null = null;
		try {
			for (let i = 0; i < LISTING_POLLS && !run.signal.aborted; i++) {
				const poll = await readers.listing(page.provider, { object: { id: job.objectId ?? '', kind: job.of, name: job.name }, representation: { providerId: page.providerId, url: page.url }, cursor }, run.signal);
				for (const c of poll.children) children.set(claimKey(c), clamp(c));
				cursor = poll.cursor;
				calls += poll.calls;
				last = poll;
				if (!poll.listingHash.startsWith('pending:')) break;
			}
		} catch (e) {
			failed = failure(job.id, page.provider, e, run);
			// Nothing read: the failure is the answer (if it is one).
			if (!last) return failed ? [failed] : [];
			// What the polls before it read goes up with the cursor that read
			// it, alone: its "more to come" leaves the page due again.
		}
		if (!last) return [];
		const all = [...children.values()];
		const releases = all.filter((c) => c.kind === 'release');
		if (releases.length) run.onEvent({ type: 'found', objectId: job.objectId, claims: releases });
		const read: TrackerPoll = { ...last, children: all, calls, ...(last.self ? { self: clamp(last.self) } : {}) };
		return listingParts(read, all, page.cursor).map((poll) => ({ jobId: job.id, kind: 'find', poll }));
	}

	// ── release ───────────────────────────────────────────────────────────

	// A store's page of the release, paired with its tracks: what each row
	// gains from it.
	function patchesOf(store: CatalogWorkStore, pairs: Map<Track, Theirs> | null): WorkRowPatch[] {
		if (!pairs) return [];
		const out: WorkRowPatch[] = [];
		for (const [ours, theirs] of pairs) {
			const r = theirs.rec;
			if (store === 'spotify') out.push({ recordingId: ours.id, from: store, streamIds: { spotify: r.providerId } });
			else if (store === 'beatport') {
				const p: WorkRowPatch = { recordingId: ours.id, from: store };
				if (r.facts?.bpm) p.bpm = r.facts.bpm;
				const key = keyToCamelot(r.facts?.key ?? null);
				if (key) p.keyCamelot = key;
				if (r.genres?.[0]) p.genre = r.genres[0];
				if (Object.keys(p).length > 2) out.push(p);
			}
		}
		return out;
	}

	// The release at a store it is not on: by a track's ISRC, then its UPC,
	// then its title and artist — each kept only when the tracklists confirm,
	// compared as the cloud will see them (cut to the wire's length). A page
	// one rung offered and the comparison refused is not compared again.
	// Undefined: there was nothing to look it up by, so nothing was asked.
	async function lookFor(store: CatalogWorkStore, job: CatalogReleaseJob, ours: Track[], signal: AbortSignal): Promise<{ how: 'isrc' | 'upc' | 'tracklist'; claim: CatalogClaim; pairs: Map<Track, Theirs> } | null | undefined> {
		const tried = new Set<string>();
		const confirmed = (raw: CatalogClaim | null): { claim: CatalogClaim; pairs: Map<Track, Theirs> } | null => {
			if (raw?.kind !== 'release' || tried.has(claimKey(raw))) return null;
			tried.add(claimKey(raw));
			const claim = clamp(raw);
			const pairs = confirmRelease(ours, theirTracks(claim), { strict: true });
			return pairs ? { claim, pairs } : null;
		};
		const isrcs = [...new Set(ours.map((t) => normalizeIsrc(t.isrc)).filter((x): x is string => !!x))].slice(0, CODES_TRIED);
		const upcs = job.release.upcs.slice(0, CODES_TRIED);
		const artist = job.release.artists[0];
		if (!isrcs.length && !upcs.length && !artist) return undefined;
		for (const isrc of isrcs) {
			const hit = confirmed(await readers.byIsrc(store, isrc, signal));
			if (hit) return { how: 'isrc', ...hit };
		}
		for (const upc of upcs) {
			const hit = confirmed(await readers.byUpc(store, upc, signal));
			if (hit) return { how: 'upc', ...hit };
		}
		if (!artist) return null;
		for (const candidate of await readers.byName(store, job.release.title, artist, signal)) {
			const hit = confirmed(await candidate());
			if (hit && artistsOverlap(job.release.artists, hit.claim.artists ?? [])) return { how: 'tracklist', ...hit };
		}
		return null;
	}

	async function release(job: CatalogReleaseJob, run: WorkRun): Promise<CatalogWorkResult[]> {
		const found: { how: 'id' | 'isrc' | 'upc' | 'tracklist'; claim: CatalogClaim }[] = [];
		const notFound: CatalogWorkStore[] = [];
		const checks: { handle: CatalogReleaseJob['read'][number]; verdict: 'gone' }[] = [];
		// One failure a store: the cloud takes one of a job.
		const failures = new Map<CatalogWorkStore, CatalogWorkResult>();
		const rows: WorkRowPatch[] = [];
		const held = job.release.tracks.map(asTrack);
		const failed = (store: CatalogWorkStore, e: unknown): void => {
			const f = failure(job.id, store, e, run);
			if (f && !failures.has(store)) failures.set(store, f);
		};
		// What a find elsewhere is compared with: the tracklist held, or the
		// one its own page brings now (ids it has none of yet: nothing to patch).
		let compareWith: Track[] = held;
		for (const h of job.read) {
			const store = h.provider as CatalogWorkStore;
			if (run.signal.aborted || !usable(store)) continue;
			try {
				const raw = await readers.release(h, run.signal);
				// Left meanwhile: a null now is the page leaving, not the store's word.
				if (run.signal.aborted) break;
				if (!raw) {
					checks.push({ handle: h, verdict: 'gone' });
					continue;
				}
				const claim = clamp(raw);
				found.push({ how: 'id', claim });
				if (held.length) rows.push(...patchesOf(store, confirmRelease(held, theirTracks(claim), { strict: true })));
				else if (!compareWith.length) compareWith = theirTracks(claim).map((t, i) => ({ ...t, id: `read:${i}` }));
			} catch (e) {
				failed(store, e);
			}
		}
		for (const store of job.find) {
			if (run.signal.aborted || !compareWith.length) break;
			if (!usable(store)) continue;
			try {
				const hit = await lookFor(store, job, compareWith, run.signal);
				if (run.signal.aborted) break;
				if (hit === undefined) continue;
				if (!hit) {
					notFound.push(store);
					continue;
				}
				found.push({ how: hit.how, claim: hit.claim });
				if (held.length) rows.push(...patchesOf(store, hit.pairs));
			} catch (e) {
				failed(store, e);
			}
		}
		if (rows.length) run.onEvent({ type: 'rows', rows });
		const result: CatalogWorkResult[] = found.length || notFound.length || checks.length ? [{ jobId: job.id, kind: 'release', found, notFound, checks }] : [];
		return [...result, ...failures.values()];
	}

	// ── facts ─────────────────────────────────────────────────────────────

	// The store's track as the store states it: its codes and length are its
	// own, never the catalogue's — the cloud places a row by comparing them.
	const factClaim = (store: CatalogWorkStore, hit: FactHit, t: CatalogWorkTrack): CatalogClaim => {
		const isrc = normalizeIsrc(hit.isrc);
		return {
			provider: store,
			kind: 'recording',
			providerId: hit.id,
			name: hit.title,
			url: hit.url,
			identifiers: isrc ? [{ namespace: 'isrc', value: isrc }] : [],
			artists: nameClaims(hit.artists.length ? hit.artists : t.artists),
			facts: {
				...(hit.durationSec ? { durationSec: hit.durationSec } : {}),
				...(hit.bpm ? { bpm: hit.bpm } : {}),
				...(hit.key ? { key: hit.key } : {}),
				...(hit.label ? { labelText: hit.label } : {}),
			},
			...(hit.genre ? { genres: [hit.genre] } : {}),
		};
	};

	async function facts(job: CatalogFactsJob, run: WorkRun, visit: VisitState): Promise<CatalogWorkResult[]> {
		const rows: { recordingId: string; claim: CatalogClaim }[] = [];
		const notFound: { recordingId: string; store: CatalogWorkStore }[] = [];
		const failures = new Map<CatalogWorkStore, CatalogWorkResult>();
		// A store that failed once is not asked for the job's other tracks.
		const skip = new Set<CatalogWorkStore>();
		for (const t of job.tracks) {
			if (run.signal.aborted) break;
			if (!t.artists.length) continue;
			const patch: WorkRowPatch = { recordingId: t.id, from: job.stores[0] ?? 'beatport' };
			for (const store of job.stores) {
				if (patch.bpm && patch.keyCamelot && patch.genre) break;
				if (skip.has(store) || !usable(store)) continue;
				const memo = `${store}|${t.id}`;
				let hit: FactHit | null;
				try {
					if (visit.facts.has(memo)) hit = visit.facts.get(memo)!;
					else {
						hit = await readers.facts(store, { title: t.title, artists: t.artists, durationSec: t.durationSec, isrc: t.isrc }, run.signal);
						// A host's own lookups do not go through the lanes' fetch: counted here.
						if (hostFacts) lanes.count(store);
					}
				} catch (e) {
					skip.add(store);
					const f = failure(job.id, store, e, run);
					if (f) failures.set(store, f);
					continue;
				}
				if (run.signal.aborted) break;
				visit.facts.set(memo, hit);
				if (!hit) {
					notFound.push({ recordingId: t.id, store });
					continue;
				}
				rows.push({ recordingId: t.id, claim: factClaim(store, hit, t) });
				const key = keyToCamelot(hit.key);
				if (!patch.bpm && hit.bpm) patch.bpm = hit.bpm;
				if (!patch.keyCamelot && key) patch.keyCamelot = key;
				// Beatport's genre stands over any other store's.
				if (hit.genre && (!patch.genre || store === 'beatport')) {
					patch.genre = hit.genre;
					patch.from = store;
				}
				if (!t.label && !patch.label && hit.label) patch.label = hit.label;
			}
			if (Object.keys(patch).length > 2) run.onEvent({ type: 'rows', rows: [patch] });
		}
		const result: CatalogWorkResult[] = rows.length || notFound.length ? [{ jobId: job.id, kind: 'facts', rows, notFound }] : [];
		return [...result, ...failures.values()];
	}

	// ── the visit ─────────────────────────────────────────────────────────

	async function send(input: Omit<CatalogWorkReportInput, 'deviceId'>, run: WorkRun): Promise<CatalogWorkReportResult | null> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await deps.report(input);
			} catch (e) {
				const wait = REPORT_RETRY_MS[attempt];
				if (wait === undefined) {
					run.onEvent({ type: 'unsent', results: input.results.length, error: message(e) });
					return null;
				}
				// Not cut short by leaving the page: what was found still goes up.
				await sleep(wait);
			}
		}
	}

	async function runWork(work: CatalogWork, run: WorkRun, visit: VisitState): Promise<void> {
		const say = (e: WorkEvent): void => {
			try {
				run.onEvent(e);
			} catch {
				// A listener's failure is the listener's.
			}
		};
		const quiet: WorkRun = { ...run, onEvent: say };
		let jobs = work.jobs;
		let round = 0;
		while (jobs.length && round < work.limits.rounds && !run.signal.aborted) {
			const next: CatalogJob[] = [];
			// Listings first, the page a probe is compared with before the probe
			// (the cloud judges the probe by it); then the releases from the top.
			const finds = jobs.filter((j): j is CatalogFindJob => j.kind === 'find').sort((a, b) => Number(!!a.page?.probe) - Number(!!b.page?.probe));
			const batch: CatalogJob[] = [];
			for (const j of [...finds, ...jobs.filter((j) => j.kind !== 'find')]) {
				const key = jobKey(j);
				if (visit.done.has(key)) continue;
				visit.done.add(key);
				batch.push(j);
			}
			// Counted before the first report goes up: the follow-up it brings
			// is planned with what is left of the visit's room.
			for (const j of batch) {
				const rid = releaseOf(j);
				if (rid) visit.taken.add(rid);
			}
			const spotifyPages = batch.flatMap((j) => (j.kind === 'release' ? j.read.filter((h) => h.provider === 'spotify') : []));
			if (spotifyPages.length && usable('spotify') && readers.prefetch) {
				try {
					await readers.prefetch(spotifyPages, run.signal);
				} catch {
					// Each page is read again on its own and its failure judged there:
					// counted here too, one outage would rest the store twice as fast.
				}
			}
			const pending: CatalogWorkResult[] = [];
			let chars = 0;
			const flush = async (): Promise<void> => {
				if (!pending.length) return;
				const results = pending.splice(0);
				chars = 0;
				const answer = await send(
					{ idempotencyKey: `${run.visit.id}:${visit.seq++}`, profile: profileAt(run.visit, round), ...(run.hints?.length ? { hints: run.hints } : {}), results, calls: lanes.takeCalls() },
					quiet,
				);
				if (!answer) return;
				const refused = answer.results.filter((r) => r.outcome === 'refused' || r.outcome === 'failed');
				if (refused.length) say({ type: 'refused', results: refused });
				if (answer.changed.length) say({ type: 'saved', changed: answer.changed });
				next.push(...(answer.work?.jobs ?? []));
			};
			// One job's results a report, where it has several of one kind (a
			// listing in parts): the cloud takes a job once a report.
			const add = async (results: CatalogWorkResult[]): Promise<void> => {
				for (const r of results) {
					const n = JSON.stringify(r).length;
					if (pending.some((p) => p.jobId === r.jobId && p.kind === r.kind) || (pending.length && chars + n > REPORT_MAX_CHARS)) await flush();
					pending.push(r);
					chars += n;
				}
			};
			for (const [i, job] of batch.entries()) {
				if (run.signal.aborted) break;
				const phase: WorkPhase = job.kind === 'find' ? 'listing' : job.kind === 'release' ? 'tracklists' : 'details';
				const store = job.kind === 'find' ? job.page?.provider ?? null : job.kind === 'facts' ? job.stores[0] ?? null : (job.read[0]?.provider as CatalogWorkStore | undefined) ?? job.find[0] ?? null;
				say({ type: 'progress', phase, store, done: i, total: batch.length });
				await add(job.kind === 'find' ? await find(job, quiet) : job.kind === 'release' ? await release(job, quiet) : await facts(job, quiet, visit));
				// A label's pages go up together (the cloud compares a probe with
				// the page beside it); the rest every few results.
				const findsDone = job.kind === 'find' && batch[i + 1]?.kind !== 'find';
				if (findsDone || pending.length >= REPORT_EVERY) await flush();
			}
			await flush();
			jobs = next;
			round++;
		}
		say({ type: 'idle' });
	}

	return {
		profile: (visit) => profileAt(visit, 0),
		visit: () => {
			const v: WorkVisit = { id: `v${now().toString(36)}${(opened++).toString(36)}${Math.random().toString(36).slice(2, 8)}`.padEnd(8, '0').slice(0, 64) };
			stateOf(v);
			return v;
		},
		run(work, run) {
			const visit = stateOf(run.visit);
			const turn = visit.queue.then(() => runWork(work, run, visit));
			visit.queue = turn.catch(() => {});
			return turn;
		},
	};
}

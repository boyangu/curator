// The planner of device work ('catalog_device_work'): given what a device
// just fetched and what it can read, the store reads the catalogue wants of
// it. Called by the reads themselves (catalog.ts tracks / resolve) after the
// data is in hand, so a job is always about something on the device's screen.
//
// Nothing is leased and a read writes no job state: what was last learned is
// in catalog_work_state, moved only by a report (report.ts). The same job
// goes to every device that asks until one answers — whatever the answer:
// found, not there, the page gone, the store failing — and the ages then keep
// it quiet (settings.ts). So the planner is a function of the page, the
// profile and that table: a handful of small statements by primary key,
// never a walk of the catalogue (but for a label's two listings, compared
// once a day: naming.ts).
//
// It runs inside the read that hands its work out, so the read fences it
// (planRead): a planner that fails or waits costs the answer its work, never
// the page. What the fence costs a read is counted in round trips: one
// statement while the switch is off (the settings), and the savepoint's two
// more around the planner's own when it is on.

import {
	CATALOG_FACTS_STORES,
	type CatalogDeviceProfile,
	type CatalogFactsJob,
	type CatalogFindJob,
	type CatalogHandle,
	type CatalogJob,
	type CatalogKind,
	type CatalogObjectSummary,
	type CatalogPageRelease,
	type CatalogRef,
	type CatalogReleaseJob,
	type CatalogWork,
	type CatalogWorkStore,
	type CatalogWorkTrack,
} from '@curator/protocol';
import type { Queryable } from '../../db/db.js';
import { num } from '../../db/db.js';
import type { SystemTx } from '../../db/system-tx.js';
import { isPageKind, namedPages, ownId, PAGE_STORES } from './naming.js';
import { loadPlanInputs, spentOf, type PlanInputs, type WorkSettings } from './settings.js';

// The pages of a release a device reads, in the order it reads them. Beatport
// first: its release page carries BPM, key and genre with the tracklist, so
// one read there saves a lookup per track. Not Bandcamp: its release is read
// under the band id of the account it is listed on, which the job does not
// carry (the back office's fill reads those, release-fill.ts).
const READ_ORDER: CatalogWorkStore[] = ['beatport', 'spotify', 'deezer'];
// A release that has its page on one of these but none of its tracks' is read
// there once, by the page it already has — never searched for again: the
// match stands, and what is missing is its tracks' own ids (Spotify's make
// the rows playable; Beatport's bring the facts).
const PAIR_STORES: CatalogWorkStore[] = ['beatport', 'spotify'];
// The stores a release can be looked for at (Bandcamp has no lookup by code).
export const FIND_STORES: CatalogWorkStore[] = ['spotify', 'deezer', 'beatport'];
// A store that did not answer is asked again after this, not the retry age:
// nothing was learned.
const ERROR_RETRY_DAYS = 1;
// Pages the catalogue does not hold, read for one resolve.
const NEW_MAX = 5;

// How long a read's planner waits for a row a report is writing.
const READ_LOCK_WAIT = '2s';

// The fence around a planner: a savepoint (db.ts Tx — the planner runs on the
// savepoint's own handle), so a statement that fails takes the plan with it
// and not the transaction it runs in.
export async function planSafely<T>(tx: SystemTx, onError: (e: unknown) => void, fn: (tx: SystemTx) => Promise<T | undefined>): Promise<T | undefined> {
	try {
		return await tx.savepoint(fn);
	} catch (e) {
		onError(e);
		return undefined;
	}
}

// A read's planner, fenced — and not begun at all for a device that is
// handed nothing: no profile, nothing it can read, the switch off, its rounds
// run. The settings are read before the fence, by the one statement a read
// pays while the switch is off (catalog_setting and provider_budget are
// tables the boot's migration gate and roles.sql answer for, as for every
// table the read itself just used); it also sets the wait for a row lock,
// which holds to the end of the read's transaction — nothing follows the
// planner in one.
export async function planRead<T>(
	tx: SystemTx,
	who: { userId: string; profile: CatalogDeviceProfile | undefined },
	onError: (e: unknown) => void,
	fn: (tx: SystemTx, scope: PlanScope) => Promise<T | undefined>,
): Promise<T | undefined> {
	if (!who.profile?.stores.length) return undefined;
	const scope = scopeOf(await loadPlanInputs(tx, who.userId, READ_LOCK_WAIT), who.profile, tx.nowMs);
	return scope ? planSafely(tx, onError, (fenced) => fn(fenced, scope)) : undefined;
}

export const findJobId = (objectId: string | null, provider: string, providerId: string): string => `find:${objectId ?? 'new'}:${provider}:${providerId}`;
export const releaseJobId = (releaseId: string): string => `release:${releaseId}`;
export const factsJobId = (releaseId: string): string => `facts:${releaseId}`;

export type JobRef =
	| { kind: 'find'; objectId: string | null; provider: string; providerId: string }
	| { kind: 'release'; releaseId: string }
	| { kind: 'facts'; releaseId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What a job id names. An id is the device's to hand back and so is read as
// a name only: report.ts decides again whether the catalogue wants it.
export function parseJobId(id: string): JobRef | null {
	const [kind, a, provider, ...rest] = id.split(':');
	if (kind === 'find') {
		const providerId = rest.join(':');
		if (!a || !provider || !providerId || (a !== 'new' && !UUID.test(a))) return null;
		return { kind, objectId: a === 'new' ? null : a, provider, providerId };
	}
	if ((kind === 'release' || kind === 'facts') && a && UUID.test(a) && provider === undefined) return { kind, releaseId: a };
	return null;
}

type State = { outcome: string; ageDays: number; cursor: Record<string, unknown> | null };
const stateKey = (objectId: string, job: string, provider: string, providerId = ''): string => `${objectId}|${job}|${provider}|${providerId}`;

async function loadState(tx: Queryable, ids: readonly string[]): Promise<Map<string, State>> {
	const out = new Map<string, State>();
	if (!ids.length) return out;
	const rows = await tx.query<{ object_id: string; job: string; provider: string; provider_id: string; outcome: string; age_days: unknown; cursor: string | null }>(
		`select object_id, job, provider, provider_id, outcome, extract(epoch from now() - answered_at) / 86400 as age_days, cursor::text as cursor
		from curator.catalog_work_state where object_id = any($1::uuid[]) and job <> 'page'`,
		[`{${[...new Set(ids)].join(',')}}`],
	);
	for (const r of rows) out.set(stateKey(r.object_id, r.job, r.provider, r.provider_id), { outcome: r.outcome, ageDays: num(r.age_days), cursor: r.cursor ? (JSON.parse(r.cursor) as Record<string, unknown>) : null });
	return out;
}

export type PlanScope = { settings: WorkSettings; stores: CatalogWorkStore[]; room: number };

// What this device may be handed at all: nothing while the switch is off,
// the visit's rounds are run, or it can read nothing. `stores`: what it can
// read now, less the stores resting on its side and those whose day is spent.
export function scopeOf(inputs: PlanInputs, profile: CatalogDeviceProfile | undefined, nowMs: number): PlanScope | null {
	if (!profile || !profile.stores.length) return null;
	const { settings } = inputs;
	if (!settings.enabled || profile.reader < settings.minReader) return null;
	if ((profile.visit?.round ?? 0) >= settings.rounds) return null;
	const resting = new Set((profile.resting ?? []).filter((r) => r.until > nowMs).map((r) => r.store));
	const spent = spentOf(inputs);
	const stores = [...new Set(profile.stores)].filter((s) => !resting.has(s) && !spent.has(s));
	const room = settings.releases[profile.form] - (profile.visit?.taken ?? 0);
	return stores.length ? { settings, stores, room } : null;
}

// For a caller that has not read the settings yet (planRead and the report
// have, and hand their scope in).
async function planScope(tx: Queryable, userId: string, profile: CatalogDeviceProfile | undefined, nowMs: number): Promise<PlanScope | null> {
	if (!profile || !profile.stores.length) return null;
	return scopeOf(await loadPlanInputs(tx, userId, READ_LOCK_WAIT), profile, nowMs);
}

const workOf = (jobs: CatalogJob[], s: WorkSettings, profile: CatalogDeviceProfile): CatalogWork | undefined =>
	jobs.length ? { jobs, limits: { rounds: s.rounds, releases: s.releases[profile.form] } } : undefined;

const storeHandle = (h: CatalogHandle): boolean => !h.id.includes('/');

export type PagePlan = {
	userId: string;
	profile: CatalogDeviceProfile | undefined;
	hints?: readonly CatalogRef[];
	object: { id: string; kind: CatalogKind; name: string };
	releases: readonly CatalogPageRelease[];
	// The first page of the object's list: where its own store pages are read.
	first: boolean;
	nowMs: number;
	// What the device may be handed, when the caller already worked it out
	// (null: nothing); absent, it is read here.
	scope?: PlanScope | null;
};

// The work for a page of releases a device just read (catalog.tracks): the
// entity's listing, when this is its first page; then, release by release
// from the top, what each lacks — a tracklist, a store, its tracks' facts.
export async function planPage(tx: Queryable, p: PagePlan): Promise<CatalogWork | undefined> {
	const scope = p.scope !== undefined ? p.scope : await planScope(tx, p.userId, p.profile, p.nowMs);
	if (!scope) return undefined;
	const { settings, stores } = scope;
	const can = (s: string): s is CatalogWorkStore => (stores as string[]).includes(s);
	const jobs: CatalogJob[] = [];

	const lacksFacts = (t: CatalogPageRelease['tracks'][number]): boolean => t.bpm === null || t.key === null || !t.genres.length;
	const needy = p.releases.flatMap((r) => r.tracks.filter(lacksFacts).map((t) => t.id));
	const state = await loadState(tx, [p.object.id, ...p.releases.map((r) => r.id), ...needy]);
	const due = (objectId: string, job: string, provider: string, providerId: string, days: number): boolean => {
		const s = state.get(stateKey(objectId, job, provider, providerId));
		return !s || s.outcome === 'more' || s.ageDays >= (s.outcome === 'error' ? Math.min(days, ERROR_RETRY_DAYS) : days);
	};
	// A page of the release: one read in full, or confirmed, is read again
	// only when its confirmation is due; one found gone or empty, after the
	// retry age; a store that failed for the release, after a day.
	const pageDue = (releaseId: string, h: CatalogHandle): boolean => {
		const s = state.get(stateKey(releaseId, 'check', h.provider, h.id));
		const days = s && (s.outcome === 'read' || s.outcome === 'agrees' || s.outcome === 'disagrees') ? settings.checkDays : settings.retryDays;
		return due(releaseId, 'check', h.provider, h.id, days) && due(releaseId, 'release', h.provider, '', settings.retryDays);
	};

	// Its own pages are named only for a device that reads one of their stores:
	// naming a label's walks what the catalogue holds of it (naming.ts), and a
	// phone that reads Spotify alone would be handed neither.
	if (p.first && isPageKind(p.object.kind) && PAGE_STORES[p.object.kind].some(can)) {
		// The page a probe is compared with goes first, and a probe whose
		// reference is still unread goes only with it: compared with nothing,
		// its reading would be thrown away.
		const named = [...(await namedPages(tx, p.object, p.hints ?? []))].sort((x, y) => Number(x.probe) - Number(y.probe));
		const handed = new Set<string>();
		for (const page of named) {
			if (!can(page.provider) || !due(p.object.id, 'find', page.provider, page.providerId, settings.findDays)) continue;
			// The page failed a device lately (report.ts): not at every visit.
			if (!due(p.object.id, 'check', page.provider, page.providerId, settings.retryDays)) continue;
			if (page.awaits && !handed.has(page.awaits)) continue;
			handed.add(page.provider);
			const cursor = state.get(stateKey(p.object.id, 'find', page.provider, page.providerId))?.cursor ?? {};
			const job: CatalogFindJob = {
				id: findJobId(p.object.id, page.provider, page.providerId),
				kind: 'find',
				objectId: p.object.id,
				of: p.object.kind,
				name: p.object.name,
				page: { provider: page.provider, providerId: page.providerId, url: page.url, cursor, ...(page.probe ? { probe: true } : {}) },
			};
			jobs.push(job);
		}
	}

	const factStores = CATALOG_FACTS_STORES.filter(can);
	const picked: { release: CatalogPageRelease; job: CatalogReleaseJob | null; facts: CatalogFactsJob | null }[] = [];
	let room = scope.room;
	for (const r of p.releases) {
		if (room <= 0) break;
		const handles = r.handles.filter(storeHandle);
		const on = new Set(handles.map((h) => h.provider as string));
		// No tracklist: read it where the release has a page this device reads.
		// With one: the page of a store none of its tracks is on yet — Spotify's
		// for the rows to play, Beatport's while a track lacks its facts.
		const unpaired = (s: CatalogWorkStore): boolean =>
			PAIR_STORES.includes(s) && r.tracks.length > 0 && !r.tracks.some((t) => t.handles.some((h) => h.provider === s)) && (s !== 'beatport' || r.tracks.some(lacksFacts));
		const wanted = (s: CatalogWorkStore): boolean => can(s) && (r.trackCount === 0 || unpaired(s));
		const read = READ_ORDER.flatMap((s) => (wanted(s) ? handles.filter((h) => h.provider === s && pageDue(r.id, h)) : []));
		// Looked for where it is not, once it has a tracklist to be compared by
		// (its own, or the one the read brings). An appearance lists only the
		// page artist's tracks: its own page is where it is completed.
		const comparable = !r.appearance && (r.tracks.length > 0 || read.length > 0);
		const find = comparable ? FIND_STORES.filter((s) => can(s) && !on.has(s) && due(r.id, 'release', s, '', settings.retryDays)) : [];
		// A store answers for a track once per retry age, whatever it said: a
		// track it has without a key would otherwise be asked for at every visit.
		const factsDue = (t: { id: string }, s: CatalogWorkStore): boolean => due(t.id, 'facts', s, '', settings.retryDays) && due(r.id, 'facts', s, '', settings.retryDays);
		// Its Beatport page is about to be read: that one read answers for
		// every track, so the lookups wait for what it leaves unfilled.
		const pageFirst = read.some((h) => h.provider === 'beatport');
		const tracks = factStores.length && !pageFirst ? r.tracks.filter((t) => lacksFacts(t) && factStores.some((s) => factsDue(t, s))) : [];
		if (!read.length && !find.length && !tracks.length) continue;
		room--;
		const asTrack = (t: CatalogPageRelease['tracks'][number]): CatalogWorkTrack => ({ id: t.id, title: t.title, artists: t.artists.map((a) => a.name), durationSec: t.durationSec, isrc: t.isrc, position: t.position });
		const artists = r.artists.map((a) => a.name);
		picked.push({
			release: r,
			job: read.length || find.length
				? { id: releaseJobId(r.id), kind: 'release', objectId: r.id, release: { title: r.title, artists, date: r.date, upcs: [], tracks: r.tracks.map(asTrack) }, read, find, check: [] }
				: null,
			facts: tracks.length
				? {
						id: factsJobId(r.id),
						kind: 'facts',
						stores: factStores.filter((s) => tracks.some((t) => factsDue(t, s))),
						// A track nobody credited (a tracklist only Deezer gave: its
						// credits are not kept) is looked up by the release's artists.
						tracks: tracks.map((t) => ({ ...asTrack(t), ...(t.artists.length ? {} : { artists }), label: r.labels[0]?.name ?? r.labelText })),
					}
				: null,
		});
	}
	// The codes a release is looked for by.
	const finding = picked.filter((x) => x.job?.find.length).map((x) => x.release.id);
	if (finding.length) {
		const upcs = await tx.query<{ object_id: string; value: string }>(`select object_id, value from curator.catalog_identifier where namespace = 'upc' and object_id = any($1::uuid[]) order by at`, [`{${finding.join(',')}}`]);
		for (const u of upcs) picked.find((x) => x.release.id === u.object_id)!.job!.release.upcs.push(u.value);
	}
	for (const x of picked) {
		if (x.job) jobs.push(x.job);
		if (x.facts) jobs.push(x.facts);
	}
	return workOf(jobs, settings, p.profile!);
}

// The work for refs a device asked about that the catalogue does not hold
// (catalog.resolve): an artist's or a label's own store page, named by the
// device, read so the catalogue comes to know it. The one case a page is the
// device's to name — there is no object for a wrong page to be attached to.
// A handful a resolve: a library's worth of unknown artists asked about at
// once is not a reason to read fifty listings.
export const NEW_PAGES: Record<'artist' | 'label', CatalogWorkStore[]> = { artist: ['spotify'], label: ['beatport', 'bandcamp'] };
// The refs of a resolve that are such pages, each once. Asked before any
// planning: a resolve of things the catalogue holds plans nothing, and pays
// nothing for it.
export function unknownPages(refs: readonly CatalogRef[], objects: readonly (CatalogObjectSummary | null)[]): CatalogRef[] {
	const seen = new Set<string>();
	return refs.filter((r, i) => {
		if (objects[i] !== null || !isPageKind(r.kind) || !(NEW_PAGES[r.kind] as string[]).includes(r.provider) || !ownId(r.provider, r.providerId)) return false;
		const key = `${r.provider}:${r.providerId}`;
		return !seen.has(key) && !!seen.add(key);
	});
}

export async function planUnknown(
	tx: Queryable,
	p: { userId: string; profile: CatalogDeviceProfile | undefined; refs: readonly CatalogRef[]; objects: readonly (CatalogObjectSummary | null)[]; nowMs: number; scope?: PlanScope | null },
): Promise<CatalogWork | undefined> {
	const unknown = unknownPages(p.refs, p.objects);
	if (!unknown.length) return undefined;
	const scope = p.scope !== undefined ? p.scope : await planScope(tx, p.userId, p.profile, p.nowMs);
	if (!scope) return undefined;
	// A page under a block is not read whoever names it.
	const blocked = await tx.query<{ provider: string; provider_id: string }>(
		`select provider, provider_id from curator.catalog_source_block where (provider, kind, provider_id) in (select x.p, x.k, x.i from jsonb_to_recordset($1::text::jsonb) as x(p text, k text, i text))`,
		[JSON.stringify(unknown.map((r) => ({ p: r.provider, k: r.kind, i: r.providerId })))],
	);
	const jobs: CatalogJob[] = [];
	const most = Math.min(NEW_MAX, scope.room);
	for (const r of unknown) {
		if (jobs.length >= most) break;
		const provider = r.provider as CatalogWorkStore;
		if (!scope.stores.includes(provider) || blocked.some((b) => b.provider === r.provider && b.provider_id === r.providerId)) continue;
		jobs.push({ id: findJobId(null, provider, r.providerId), kind: 'find', objectId: null, of: r.kind as 'artist' | 'label', name: '', page: { provider, providerId: r.providerId, url: null, cursor: {} } });
	}
	return workOf(jobs, scope.settings, p.profile!);
}

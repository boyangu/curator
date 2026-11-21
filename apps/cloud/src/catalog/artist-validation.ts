// Is a store's artist page one artist? The page validation.
//
// A store's artist id is taken as the store's word on who someone is: its
// listing is read as the artist's releases, and a credit under it joins the
// artist. Deezer breaks that word. It files every artist of one name under a
// single id — its "Fade" (465319) held 238 albums of German rap, J-pop, rock
// and techno on 2026-11-18 — and such a page, attached to one of them, hands
// that artist everyone's catalogue and bridges the namesakes into one
// (artist-twins.ts merges two same-name credits on one track, and the bucket
// is credited beside each namesake's real page).
//
// So a page is checked before it is believed, with the two stores that
// between them can tell:
//   - Deezer says what the page holds: one call lists its albums, each with
//     Deezer's genre for it. Three kinds of music on one page, or two full
//     bodies of work, are several acts ('mixed').
//   - Beatport says what the artist is. Its artist ids are one person each
//     and its catalogue is electronic music: an artist the catalogue knows
//     from Beatport is an electronic artist, and a page with none of it is a
//     namesake's ('foreign').
//
// The verdict is kept per page (catalog_page_check) and, where the page is
// not one artist, put to the operator with the block the reasoner's bucket
// verdict would propose (agent/apply.ts): nothing is unlinked without a yes.
//
// What it cannot see. Genres tell acts of different music apart: two techno
// producers of one name on one page look coherent here, and so does a pop
// singer's page on a producer (Deezer's Pop says nothing) — those are still
// the reasoner's questions (inbox-detectors.ts bucketCandidates). And the
// rules are set to leave real artists alone rather than to catch every
// bucket: read against forty-odd real pages on 2026-11-18, a producer with
// rap collaborations (Kaytranada: 6 of 42) or a stray tag stays coherent.

import type { DeezerListedAlbum, DeezerTracker } from '@curator/catalog-readers';
import { TrackerRateLimitedError } from '@curator/catalog-readers';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { WEAK_SQL } from './identity.js';
import { raise } from './inbox.js';

// What kind of music, coarsely: the families one act rarely spans three of.
// A genre that says little about who made it has none: Deezer's Pop,
// Alternative, R&B, Soul & Funk and Films/Games sit on every kind of artist's
// albums, and its regional ones (Asian, African, Latin, Brazilian, Indian
// Music) say where an act is from, not what it plays — an afro house
// producer's page is "African Music" throughout.
export type GenreFamily = 'electronic' | 'hiphop' | 'rock' | 'classical' | 'jazz' | 'reggae' | 'folk' | 'kids';

const DEEZER_FAMILY: Readonly<Record<string, GenreFamily | null>> = {
	electro: 'electronic',
	dance: 'electronic',
	'rap/hip hop': 'hiphop',
	rock: 'rock',
	metal: 'rock',
	'asian music': null,
	'indian music': null,
	'african music': null,
	'latin music': null,
	'brazilian music': null,
	classical: 'classical',
	jazz: 'jazz',
	blues: 'jazz',
	reggae: 'reggae',
	folk: 'folk',
	kids: 'kids',
	pop: null,
	alternative: null,
	'r&b': null,
	'soul & funk': null,
	'films/games': null,
};

// Beatport's genres are electronic music but for its few open-format ones.
const BEATPORT_OTHER: Readonly<Record<string, GenreFamily | null>> = {
	'hip-hop': 'hiphop',
	'hip hop': 'hiphop',
	african: null,
	caribbean: null,
	latin: null,
	pop: null,
	'r&b': null,
	'dance / pop': null,
};

export function familyOf(provider: 'deezer' | 'beatport', genre: string): GenreFamily | null {
	const g = genre.trim().toLowerCase();
	if (provider === 'deezer') return DEEZER_FAMILY[g] ?? null;
	return g in BEATPORT_OTHER ? BEATPORT_OTHER[g]! : 'electronic';
}

// What a store page lists, by genre and by family.
export type PageProfile = {
	provider: 'deezer';
	providerId: string;
	// Albums read (the first hundred) and the page's own count.
	listed: number;
	total: number | null;
	genres: Record<string, number>;
	families: Partial<Record<GenreFamily, number>>;
};

export function profileOf(providerId: string, page: { total: number | null; albums: readonly DeezerListedAlbum[] }): PageProfile {
	const genres: Record<string, number> = {};
	const families: Partial<Record<GenreFamily, number>> = {};
	for (const a of page.albums) {
		if (!a.genre) continue;
		genres[a.genre] = (genres[a.genre] ?? 0) + 1;
		const f = familyOf('deezer', a.genre);
		if (f) families[f] = (families[f] ?? 0) + 1;
	}
	return { provider: 'deezer', providerId, listed: page.albums.length, total: page.total, genres, families };
}

// What Beatport says the artist is: the releases it credits them on (or a
// track of), and the families of Beatport's genres for those.
export type BeatportAnchor = { releases: number; families: Partial<Record<GenreFamily, number>>; titles: string[] };

export async function beatportAnchor(tx: Queryable, artistId: string): Promise<BeatportAnchor> {
	const rows = await tx.query<{ name: string; genres: string | null }>(
		`with rel as (
			select e.dst as id from curator.catalog_edge e where e.kind = 'artist-release' and e.src = $1
			union
			select rr.src from curator.catalog_edge ra
			join curator.catalog_edge rr on rr.dst = ra.src and rr.kind = 'release-recording'
			where ra.kind = 'recording-artist' and ra.dst = $1
		)
		select o.name, (select f.value::text from curator.catalog_fact f where f.object_id = o.id and f.field = 'genres' and f.source = 'beatport') as genres
		from rel r join curator.catalog_object o on o.id = r.id and o.merged_into is null
		where exists (select 1 from curator.catalog_source_object s where s.object_id = o.id and s.provider = 'beatport' and s.kind = 'release')
		limit 300`,
		[artistId],
	);
	const families: Partial<Record<GenreFamily, number>> = {};
	for (const r of rows) {
		// A Beatport release with no genre on record is still a Beatport
		// release: electronic, like its catalogue.
		const names = r.genres ? (JSON.parse(r.genres) as string[]) : [];
		const found = new Set(names.map((g) => familyOf('beatport', g)).filter((f): f is GenreFamily => f !== null));
		if (!names.length) found.add('electronic');
		for (const f of found) families[f] = (families[f] ?? 0) + 1;
	}
	return { releases: rows.length, families, titles: rows.map((r) => nameFold(r.name)) };
}

export type PageVerdict = 'mixed' | 'foreign' | 'coherent' | 'thin';
export type PageCheck = {
	verdict: PageVerdict;
	// The rule that decided, in words the operator reads.
	reason: string;
	// The page's families, largest first, and the albums in a family other
	// than its largest (a foreign page: other than electronic).
	families: [GenreFamily, number][];
	foreign: number;
};

// The numbers a page is judged by. Below `minAlbums` nothing is said. A kind
// of music counts with `kindMin` albums (one is a stray tag), and `kinds` of
// them on one page are several acts — one act's catalogue does not hold
// electronic, rap and rock releases each more than once. Two kinds alone can
// be one act (a producer who raps, an electronic rock band): only when the
// second is a body of work of its own, `bodyMin` albums and `bodyShare` of
// everything the page lists, is the page two acts' (of the whole page, not
// of its telling albums: Gorillaz is 56 Alternative, 17 rap and 12 dance).
export const PAGE_RULES = { minAlbums: 8, kinds: 3, kindMin: 2, bodyMin: 5, bodyShare: 0.3 };

export function judgePage(page: PageProfile, anchor: BeatportAnchor | null): PageCheck {
	const families = (Object.entries(page.families) as [GenreFamily, number][]).sort((a, b) => b[1] - a[1]);
	const telling = families.reduce((n, [, c]) => n + c, 0);
	const say = (verdict: PageVerdict, reason: string, foreign = 0): PageCheck => ({ verdict, reason, families, foreign });
	if (page.listed < PAGE_RULES.minAlbums) return say('thin', `only ${page.listed} album(s) listed`);
	const names = (fs: [GenreFamily, number][]) => fs.map(([f, n]) => `${f} ${n}`).join(', ');
	const rest = families.slice(1).reduce((n, [, c]) => n + c, 0);

	const kinds = families.filter(([, n]) => n >= PAGE_RULES.kindMin);
	if (kinds.length >= PAGE_RULES.kinds) return say('mixed', `${kinds.length} kinds of music on one page: ${names(kinds)} among ${page.listed}`, rest);
	const [, second] = families;
	if (second && second[1] >= PAGE_RULES.bodyMin && second[1] / page.listed >= PAGE_RULES.bodyShare) {
		return say('mixed', `two bodies of work on one page: ${names(families.slice(0, 2))} among ${page.listed}`, rest);
	}
	// One kind of music — but Beatport knows the artist as an electronic one,
	// and the page holds next to none of it: a namesake's page.
	const own = page.families.electronic ?? 0;
	if ((anchor?.families.electronic ?? 0) > 0 && telling >= PAGE_RULES.minAlbums && own < PAGE_RULES.kindMin) {
		return say('foreign', `Beatport knows the artist as electronic (${anchor!.releases} release(s)); the page is ${names(families.slice(0, 2))} with ${own} electronic among ${page.listed}`, telling - own);
	}
	return say('coherent', families.length ? `one kind of music: ${names(families.slice(0, 2))} among ${page.listed}` : `no telling genres among ${page.listed}`);
}

// ── checks: read a page, judge it, keep the verdict ───────────────────────────────────────

export type PageReader = Pick<DeezerTracker, 'artistAlbums'>;

export type CheckedPage = { artist: string; name: string; provider: 'deezer'; providerId: string; profile: PageProfile; anchor: BeatportAnchor; check: PageCheck; inbox: number | null };

const ACTOR = 'page-validation';
// How long a verdict stands before the page is read again.
const RECHECK_DAYS = 30;

async function keep(tx: Queryable, c: Omit<CheckedPage, 'inbox'>): Promise<void> {
	await tx.query(
		`insert into curator.catalog_page_check (provider, kind, provider_id, object_id, verdict, evidence)
		values ($1, 'artist', $2, $3, $4, $5::text::jsonb)
		on conflict (provider, kind, provider_id) do update set object_id = excluded.object_id, verdict = excluded.verdict, evidence = excluded.evidence, checked_at = now()`,
		[c.provider, c.providerId, c.artist, c.check.verdict, JSON.stringify({ reason: c.check.reason, listed: c.profile.listed, total: c.profile.total, genres: c.profile.genres, families: c.check.families, foreign: c.check.foreign, beatport: { releases: c.anchor.releases, families: c.anchor.families } })],
	);
}

// A page that is not one artist goes to the operator: a mixed page with the
// block the reasoner's bucket verdict proposes (unlinked, and ruled out for
// every object); a foreign one as a notice — it is a real act's own page, to
// be split off with its releases (`catalog artist unlink … --as namesake`),
// which needs the operator's word on who that act is.
async function propose(tx: Queryable, c: Omit<CheckedPage, 'inbox'>): Promise<number | null> {
	const what = `${c.provider}:${c.providerId}`;
	const evidence = { page: c.profile, beatport: { releases: c.anchor.releases, families: c.anchor.families }, verdict: c.check.verdict, reason: c.check.reason };
	if (c.check.verdict === 'mixed') {
		return raise(tx, {
			kind: 'artist.page',
			severity: 'approval',
			title: `Block ${what}: several acts on one page, not «${c.name}» alone — ${c.check.reason}`,
			subjects: [c.artist],
			evidence,
			apply: { op: 'blockSource', args: { objectId: c.artist, provider: c.provider, kind: 'artist', providerId: c.providerId, reason: c.check.reason, note: 'page validation' } },
			actor: ACTOR,
			key: what,
		});
	}
	if (c.check.verdict === 'foreign') {
		return raise(tx, { kind: 'artist.page', severity: 'notice', title: `${what} may be a namesake's page, not «${c.name}»'s — ${c.check.reason}`, subjects: [c.artist], evidence, actor: ACTOR, key: what });
	}
	return null;
}

// Every Deezer page an artist holds, read and judged now. `propose`: a page
// that is not one artist is put to the operator (once per page).
export async function validateArtist(db: Db, reader: PageReader, artistId: string, opts: { propose?: boolean; signal?: AbortSignal } = {}): Promise<CheckedPage[]> {
	const pages = await db.query<{ id: string; name: string; provider_id: string }>(
		`select o.id, o.name, s.provider_id from curator.catalog_object o
		join curator.catalog_source_object s on s.object_id = o.id and s.provider = 'deezer' and s.kind = 'artist' and not ${WEAK_SQL}
		where o.id = $1 and o.kind = 'artist' and o.merged_into is null
			and not exists (select 1 from curator.catalog_source_block b where b.provider = s.provider and b.kind = s.kind and b.provider_id = s.provider_id)
		order by s.provider_id`,
		[artistId],
	);
	const out: CheckedPage[] = [];
	for (const p of pages) {
		// The store is read before the transaction: none is held across a call out.
		const profile = profileOf(p.provider_id, await reader.artistAlbums(p.provider_id, opts.signal ?? AbortSignal.timeout(20_000)));
		out.push(
			await withSystemTx(db, async (tx) => {
				const anchor = await beatportAnchor(tx, p.id);
				const checked = { artist: p.id, name: p.name, provider: 'deezer' as const, providerId: p.provider_id, profile, anchor, check: judgePage(profile, anchor) };
				await keep(tx, checked);
				return { ...checked, inbox: opts.propose ? await propose(tx, checked) : null };
			}),
		);
	}
	return out;
}

// ── the pass ──────────────────────────────────────────────────────────────────────────────

export const VALIDATE_NEED = 'validate';
const SEED_EVERY_MS = 10 * 60_000;
const SEED_LIMIT = 50;
const seedDue = new WeakMap<Db, number>();

// An artist whose page should be checked soon: someone opened their page
// (catalog.ts tracks), or a Deezer page was just attached to them. Nothing to
// do for one with no unchecked Deezer page.
export async function queueValidation(tx: Queryable, artistId: string): Promise<void> {
	await tx.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider)
		select o.id, $2, 'deezer' from curator.catalog_object o
		where o.id = $1 and o.kind = 'artist' and o.merged_into is null and exists (
			select 1 from curator.catalog_source_object s
			where s.object_id = o.id and s.provider = 'deezer' and s.kind = 'artist' and not ${WEAK_SQL}
				and not exists (select 1 from curator.catalog_page_check c where c.provider = s.provider and c.kind = s.kind and c.provider_id = s.provider_id))
		on conflict do nothing`,
		[artistId, VALIDATE_NEED],
	);
}

// Followed artists with a Deezer page never checked, a few at a time: the
// ones whose pages the tracker is reading.
async function seed(db: Db): Promise<void> {
	await db.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider)
		select distinct o.id, $1, 'deezer' from curator.catalog_object o
		join curator.catalog_source_object s on s.object_id = o.id and s.provider = 'deezer' and s.kind = 'artist' and not ${WEAK_SQL}
		where o.kind = 'artist' and o.watch_count > 0 and o.merged_into is null
			and not exists (select 1 from curator.catalog_page_check c where c.provider = s.provider and c.kind = s.kind and c.provider_id = s.provider_id)
			and not exists (select 1 from curator.catalog_source_block b where b.provider = s.provider and b.kind = s.kind and b.provider_id = s.provider_id)
		limit ${SEED_LIMIT}
		on conflict do nothing`,
		[VALIDATE_NEED],
	);
}

export type PageValidationDeps = { db: Db; log: Logger; reader: PageReader | null; batch?: number; now?: () => number };

// A pass: the artists queued for a check, each page read once (one call) and
// judged; what is not one artist is proposed. An artist stays queued for the
// next reading a month on.
export async function runPageValidation(deps: PageValidationDeps): Promise<{ checked: number; mixed: number; foreign: number }> {
	const report = { checked: 0, mixed: 0, foreign: 0 };
	if (!deps.reader) return report;
	const now = (deps.now ?? Date.now)();
	if (now >= (seedDue.get(deps.db) ?? 0)) {
		seedDue.set(deps.db, now + SEED_EVERY_MS);
		await seed(deps.db);
	}
	const due = await deps.db.query<{ object_id: string; attempts: unknown }>(
		`select object_id, attempts from curator.catalog_enrich_task where need = $1 and provider = 'deezer' and next_due_at <= now() order by next_due_at limit $2::int`,
		[VALIDATE_NEED, String(deps.batch ?? 10)],
	);
	for (const t of due) {
		try {
			const pages = await validateArtist(deps.db, deps.reader, t.object_id, { propose: true });
			for (const p of pages) {
				report.checked++;
				if (p.check.verdict === 'mixed') report.mixed++;
				if (p.check.verdict === 'foreign') report.foreign++;
			}
			await deps.db.query(`update curator.catalog_enrich_task set next_due_at = now() + make_interval(days => $3::int), attempts = 0, last_error = null where object_id = $1 and need = $2 and provider = 'deezer'`, [t.object_id, VALIDATE_NEED, String(RECHECK_DAYS)]);
		} catch (e) {
			// Deezer's quota: the rest waits for the next pass. Anything else: a day on.
			const limited = e instanceof TrackerRateLimitedError;
			await deps.db.query(
				`update curator.catalog_enrich_task set next_due_at = now() + make_interval(mins => $3::int), attempts = attempts + 1, last_error = $4 where object_id = $1 and need = $2 and provider = 'deezer'`,
				[t.object_id, VALIDATE_NEED, String(limited ? 5 : 24 * 60), e instanceof Error ? e.message.slice(0, 200) : 'error'],
			);
			if (limited) break;
		}
	}
	if (report.checked) deps.log.info('page_validation_pass', report);
	return report;
}

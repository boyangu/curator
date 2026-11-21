// Whether a source outside the catalogue holds an artist of exactly this name
// (sql/0033): the whole-name check the compound detector needs beside its own
// evidence. "Frankey & Sandrino" splits into two names that are each a
// Spotify artist of their own — so do a quarter of all real duos — and only
// the whole name's own page tells the duo from a credit line.
//
//   - MusicBrainz first: free, one call a second, and it files a
//     collaboration under its members, not as an artist.
//   - Spotify after: the cleanest answer (every artist of a track has their
//     own page there), but its calls share the app's pace and daily budget
//     with every tracker (spotify-pace.ts), so it is asked last and capped.
//
// An answer is kept per folded name and source and never asked again; a call
// that failed or was refused leaves no row and ends the batch, so the caller
// comes back later.

import { nameFold } from '@curator/library-logic';
import { getJson, ProviderHttpError, TrackerRateLimitedError, type FetchLike, type SpotifyReader } from '@curator/catalog-readers';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';

export const NAME_SOURCES = ['musicbrainz', 'spotify'] as const;
export type NameSource = (typeof NAME_SOURCES)[number];
// The source's artist of that exact name. `type`: MusicBrainz's (Group,
// Person, Orchestra…); `followers`: Spotify's, to tell an act from a stray
// profile a distributor's typo made.
export type NameFound = { id: string; name: string; type?: string | null; followers?: number | null };
// undefined: not asked; null: asked, no artist of that name.
export type NameAnswers = Partial<Record<NameSource, NameFound | null>>;

export type NameLookupDeps = { fetch?: FetchLike; spotify?: SpotifyReader | null; sleep?: (ms: number) => Promise<void> };

const UA = 'curator-catalog/0.1 (+https://github.com/boyangu/curator)';
// MusicBrainz asks for one call a second and answers 503 past it — and when
// its search is busy, whoever asks (2026-11-19: minutes of 503 at a call
// every thirty seconds). A 503 is waited out a few times before the batch
// gives up.
const MB_GAP_MS = 1_100;
const MB_RETRY_MS = [3_000, 10_000, 30_000];
// The provider's calls today past which a lookup takes no more (curator
// .catalog_reserve_calls counts every reader's): under the 20,000 the
// trackers, the resolver and the linker stop at, so lookups stop first. A
// cap of 3,000 never ran: an ordinary day's trackers had passed it.
const DAILY_CAP: Record<NameSource, number> = { musicbrainz: 6_000, spotify: 15_000 };
export const NAME_LOOKUP_BATCH = 30;
// A call answers within this, done or not, so the caller's request does not
// time out while a slow source is waited on; the caller sends the rest again.
const CALL_MS = 150_000;

const quoted = (name: string) => name.replace(/["\\]/g, ' ');

async function askMusicbrainz(fetchFn: FetchLike, name: string, signal: AbortSignal): Promise<NameFound | null> {
	const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:"${quoted(name)}"`)}&limit=10&fmt=json`;
	const r = await getJson<{ artists?: { id: string; name: string; type?: string }[] }>(fetchFn, 'musicbrainz', url, { headers: { 'user-agent': UA }, signal, logPath: '/ws/2/artist' });
	const want = nameFold(name);
	const hit = (r.artists ?? []).find((a) => nameFold(a.name) === want);
	return hit ? { id: hit.id, name: hit.name, type: hit.type ?? null } : null;
}

async function askSpotify(app: SpotifyReader, name: string, signal: AbortSignal): Promise<NameFound | null> {
	// Search is capped at 10 results for Development Mode apps.
	const r = await app.get<{ artists?: { items: { id: string; name: string; followers?: { total?: number } }[] } }>(`/search?type=artist&limit=10&q=${encodeURIComponent(name)}`, signal);
	const want = nameFold(name);
	const hits = (r.artists?.items ?? []).filter((a) => nameFold(a.name) === want).sort((a, b) => (b.followers?.total ?? 0) - (a.followers?.total ?? 0));
	return hits[0] ? { id: hits[0].id, name: hits[0].name, followers: hits[0].followers?.total ?? null } : null;
}

// What the sources already answered for these folded names.
export async function nameAnswers(tx: Queryable, folds: string[]): Promise<Map<string, NameAnswers>> {
	const out = new Map<string, NameAnswers>();
	if (!folds.length) return out;
	// nameFold leaves letters, digits and single spaces: nothing to escape.
	const rows = await tx.query<{ name_fold: string; source: NameSource; found: string | null }>(
		`select name_fold, source, found::text as found from curator.catalog_name_lookup where name_fold = any($1::text[])`,
		[`{${folds.map((f) => `"${f}"`).join(',')}}`],
	);
	for (const r of rows) {
		const a = out.get(r.name_fold) ?? {};
		a[r.source] = r.found === null ? null : (JSON.parse(r.found) as NameFound);
		out.set(r.name_fold, a);
	}
	return out;
}

export type NameLookupReport = {
	// Names a source was asked about and answered for in this call.
	asked: number;
	// Names it had answered before.
	known: number;
	// Why the batch ended early: the day's calls are spent, the source refused
	// (429, MusicBrainz's 503), or it is not configured here.
	stopped: 'budget' | 'refused' | 'unavailable' | null;
	// Seconds the source asked to wait, when it said.
	retryAfterSec?: number;
	// What failed, when it was not a stated wall.
	error?: string;
};

// Asks one source about each name it has not answered yet: one call a name,
// outside any transaction. At most NAME_LOOKUP_BATCH names a call and
// CALL_MS of waiting, so the caller's request stays short: `asked + known`
// short of the names given, with nothing `stopped`, means "send them again".
export async function lookUpNames(db: Db, deps: NameLookupDeps, args: { names: string[]; source: NameSource }): Promise<NameLookupReport> {
	const report: NameLookupReport = { asked: 0, known: 0, stopped: null };
	const started = Date.now();
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const fetchFn = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
	if (args.source === 'spotify' && !deps.spotify) return { ...report, stopped: 'unavailable' };
	// One spelling a folded name: the first given.
	const byFold = new Map<string, string>();
	for (const n of args.names.slice(0, NAME_LOOKUP_BATCH)) {
		const f = nameFold(n);
		if (f && !byFold.has(f)) byFold.set(f, n);
	}
	const have = await nameAnswers(db, [...byFold.keys()]);
	for (const [fold, name] of byFold) {
		if (have.get(fold)?.[args.source] !== undefined) {
			report.known++;
			continue;
		}
		if (Date.now() - started > CALL_MS) return report;
		const [g] = await db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, 1, $2::int) as n`, [args.source, String(DAILY_CAP[args.source])]);
		if (num(g!.n) < 1) return { ...report, stopped: 'budget' };
		let found: NameFound | null;
		try {
			if (args.source === 'spotify') found = await askSpotify(deps.spotify!, name, AbortSignal.timeout(20_000));
			else {
				if (report.asked) await sleep(MB_GAP_MS);
				for (let tries = 0; ; tries++) {
					try {
						found = await askMusicbrainz(fetchFn, name, AbortSignal.timeout(20_000));
						break;
					} catch (e) {
						if (!(e instanceof ProviderHttpError && e.status === 503) || tries >= MB_RETRY_MS.length) throw e;
						await sleep(MB_RETRY_MS[tries]!);
					}
				}
			}
		} catch (e) {
			// A wall, a timeout, the network down: whatever it was, nothing is kept
			// and the batch ends here with what it had; the caller comes back.
			if (e instanceof TrackerRateLimitedError) return { ...report, stopped: 'refused', retryAfterSec: e.retryAfterSec };
			return { ...report, stopped: 'refused', error: e instanceof Error ? e.message : String(e) };
		}
		await db.query(
			`insert into curator.catalog_name_lookup (name_fold, source, found) values ($1, $2, $3::text::jsonb)
			on conflict (name_fold, source) do update set found = excluded.found, asked_at = now()`,
			[fold, args.source, found === null ? null : JSON.stringify(found)],
		);
		report.asked++;
	}
	return report;
}

// The catalogue's back office from a terminal — in practice a session with
// Claude Code (the `catalog` skill), which runs these, reads what they print,
// looks further where it must, and decides. No model is called from here.
//
//   pnpm --filter @curator/cloud catalog search <q> [--kind label|artist]
//   pnpm --filter @curator/cloud catalog label add <name | beatport/bandcamp url>
//   pnpm --filter @curator/cloud catalog label show <name | id | url>
//   pnpm --filter @curator/cloud catalog label link <name | id> <page url | spotify playlist url>   (attach a page, or a catalogue playlist, by hand)
//   pnpm --filter @curator/cloud catalog label import <name | id> --file releases.json [--dry]   (releases an agent gathered by browsing)
//   pnpm --filter @curator/cloud catalog label scanned <name | id> [--note "…"]   (its pages read for new releases, nothing to import)
//   pnpm --filter @curator/cloud catalog label verify [--watched] [--limit 100] [--gaps]
//   pnpm --filter @curator/cloud catalog label refresh <name | id>
//   pnpm --filter @curator/cloud catalog label releases <name | id> [--limit 50]
//   pnpm --filter @curator/cloud catalog review scan [--kind artist|label] [--labels "a,b" | --labels @file]   (labels: related by name, shared releases, roster)
//   pnpm --filter @curator/cloud catalog label unlink <name | id> <page url> --note "…"   (a wrong page off a label; never re-attached)
//   pnpm --filter @curator/cloud catalog label merge <from> <into> --note "…"   (on the owner's word; overrules a not-same)
//   pnpm --filter @curator/cloud catalog label rename <name | id> "<new name>"
//   pnpm --filter @curator/cloud catalog review open <label a> <label b>   (a pair you suspect, put to review with the evidence)
//   pnpm --filter @curator/cloud catalog review list [--kind label_page|artist_link|duplicate|label_playlist] [--limit 20] [--evidence] [--decided] [--related]
//   pnpm --filter @curator/cloud catalog review show <id>
//   pnpm --filter @curator/cloud catalog review decide <id> attach:<n> | merge:<n> | not-same[:<n>] | skip [--by claude-code] [--note "…"]
//   pnpm --filter @curator/cloud catalog release stubs [--label <q> | --artist <q>] [--limit 50]
//   pnpm --filter @curator/cloud catalog release fill <release id…> | --label <q> | --artist <q> [--limit 20] [--dry]
//   pnpm --filter @curator/cloud catalog release link <release id> <store release url>
//   pnpm --filter @curator/cloud catalog release dedupe <release id…> | --label <q> | --artist <q> | --shared-slots [--since-days N] [--dry]   (two recordings on one slot → one)
//   pnpm --filter @curator/cloud catalog library import --file claims.json [--dry]   (a library's labels + releases; fills queued)
//   pnpm --filter @curator/cloud catalog repair previews [--label <q>] [--dry]   (SoundCloud 0:30 preview copies → their store recordings)
//   pnpm --filter @curator/cloud catalog repair dj-sets [--dry] [--limit 500]   (long mixed sessions only SoundCloud holds, and releases of nothing else: removed, not undoable)
//   pnpm --filter @curator/cloud catalog repair credits [--dry]   (artists the SoundCloud/Bandcamp splitter cut out of a credit → the artists they were cut from)
//   pnpm --filter @curator/cloud catalog repair compound-artists --dry [--lookup] [--stores musicbrainz,spotify] [--max 800] [--class <c>] [--show 15] [--out rows.json]   (--stores asks outside for the whole name, Spotify for at most --max names a run;artists named like several, "A & B", each decided by what the stores say: keep one act, rename an artist a credit line was written on, split a store's page for a credit, or ask; reads only)
//   pnpm --filter @curator/cloud catalog repair artist-twins [--dry] [--all] [--merge-only]   (same-name artists on one release merged; one store holding both under two ids → an artist.twins inbox item)
//   pnpm --filter @curator/cloud catalog artist merge <from id> <into id> --note "…" [--approved]   (held for the operator unless approved)
//   pnpm --filter @curator/cloud catalog artist validate <artist id> [--propose]   (is each Deezer page of the artist one artist: its genres against what Beatport says the artist is; --propose puts a page of several acts to the inbox)
//   pnpm --filter @curator/cloud catalog artist unlink <artist id> <provider:id> --note "…" [--as namesake|bucket] [--approved]   (a namesake's own page split off with its releases; a store's bucket of namesakes blocked)
//   pnpm --filter @curator/cloud catalog release merge <from id> <into id> --note "…" [--approved]   (two copies of one release the twins detector did not pair; held unless approved)
//   pnpm --filter @curator/cloud catalog artist recredit <artist id> <release id> <to artist id> --note "…" --approved   (an artist's credits on one release given to another)
//   pnpm --filter @curator/cloud catalog agent cases [--status queued|decided|applied|proposed|failed|moot|live] [--kind …] [--limit 50]   (the reasoner's queue and log)
//   pnpm --filter @curator/cloud catalog agent show <case id>
//   pnpm --filter @curator/cloud catalog agent run [<case id>] [--dry] [--batch 5]   (reason about queued cases now; --dry prints the verdict, writes nothing)
//   pnpm --filter @curator/cloud catalog agent ask release_twin|artist_twin <keep id> <fold id…> | artist_bucket <artist id> --source deezer:<id> | credit <release id> <piece id…> [--credit "…"] | label_pages <label id>
//   pnpm --filter @curator/cloud catalog agent sweep [--days 30] [--kind bucket|credit] [--limit 25] [--dry]   (queue the backlog the pass's two-day window misses; --dry lists bucket candidates with their numbers)
//   pnpm --filter @curator/cloud catalog agent drop <case id…> --reason "…"   (withdraw queued cases)
//   pnpm --filter @curator/cloud catalog agent advise <inbox id…> [--research]   (the reasoner's opinion on open twins items; writes nothing; --research = web on)
//   pnpm --filter @curator/cloud catalog agent evals export [--since 2026-11-01] [--size 80 | --all] [--out evals/catalog/twins.jsonl] [--verbose]   (the operator's twin decisions as the regression set; run it with `pnpm --filter @curator/cloud eval`)
//   pnpm --filter @curator/cloud catalog pass            (run the worker's pass now; local server)
//   pnpm --filter @curator/cloud catalog tracking        (per source: checked, due, failing, paused until when)
//   pnpm --filter @curator/cloud catalog tracking check all|artists|labels|playlists|genres|<object id> [--provider beatport]   (due now; a provider's pause and anything read within the hour are left alone)
//   pnpm --filter @curator/cloud catalog inbox [<kind>] [--all] [--actor agent] [--limit 30]      (the operator's inbox: what waits for Guy; --all = the activity log)
//   pnpm --filter @curator/cloud catalog inbox show <id>
//   pnpm --filter @curator/cloud catalog inbox approve|reject <id> [--choice attach:<n>|merge:<n>|not-same:<n>] [--except 1,16] [--leave 3,7] --note "…" --by guy   (twin pairs by index: --except ruled not twins, --leave stay open on the item, the rest merged)
//   pnpm --filter @curator/cloud catalog insight add <object id | label> --topic edition|partial|note "<text>"   (what you concluded, on the object)
//   pnpm --filter @curator/cloud catalog insight list <object id | label> [--retired]
//   pnpm --filter @curator/cloud catalog insight retire <insight id> [--note "…"]
//   pnpm --filter @curator/cloud catalog inbox snooze <id> [--days 7]
//   … any write: --approved   (Guy said yes in chat for this very action: done and logged, not put to the inbox)
//   … any command: --json
//
// With DATABASE_URL set, it opens that database (the cloud's). Otherwise it
// talks to the running local catalogue (cli/local.ts) on its loopback
// `/admin` path, since PGlite is single-process.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { adminOps, type AdminOps, type LabelView, type ReviewView } from '../catalog/admin-ops.js';
import { coreSet } from '../catalog/agent/evals.js';
import type { AgentCase } from '../catalog/agent/cases.js';
import type { ArtistPairView } from '../catalog/artist-twins.js';
import { COMPOUND_CLASSES, type CompoundRow } from '../catalog/compound-artists.js';
import { nameFold } from '@curator/library-logic';
import { NAME_LOOKUP_BATCH, NAME_SOURCES } from '../catalog/name-lookup.js';
import type { AgentImport } from '../catalog/agent-import.js';
import type { RelatedEvidence } from '../catalog/label-related.js';
import type { InboxRow } from '../catalog/inbox.js';
import type { ReviewCandidate } from '../catalog/admin.js';
import { SpotifyTracker } from '@curator/catalog-readers';
import { TidalApp } from '../catalog/trackers/tidal-app.js';
import type { CheckScope, TrackingKind } from '../catalog/tracking.js';
import { tidalCredentials } from '../config.js';
import { assertConnectionString, createPostgresDb } from '../db/db.js';
import { createLogger } from '../log.js';

import { appCredentialsToken } from '../catalog/spotify-app-token.js';
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const flag = (name: string): boolean => argv.includes(name);
// Positional words: everything that is not a flag or a flag's value.
const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--') && !['--json', '--evidence', '--decided', '--watched', '--gaps', '--dry', '--related', '--approved', '--all', '--retired', '--merge-only', '--shared-slots', '--lookup'].includes(argv[i - 1]!)));

async function ops(): Promise<AdminOps> {
	const url = process.env.DATABASE_URL?.trim();
	if (url) {
		assertConnectionString(url);
		const db = createPostgresDb(url, { max: 2 });
		const id = process.env.CURATOR_SPOTIFY_APP_CLIENT_ID?.trim() || process.env.CURATOR_SPOTIFY_CLIENT_ID?.trim();
		const secret = process.env.CURATOR_SPOTIFY_APP_CLIENT_SECRET?.trim();
		const tidal = tidalCredentials(process.env);
		return adminOps(db, { spotify: id && secret ? new SpotifyTracker({ token: appCredentialsToken({ clientId: id, clientSecret: secret }) }) : null, tidal: tidal ? new TidalApp(tidal) : null });
	}
	const base = `http://127.0.0.1:${process.env.CURATOR_LOCAL_CLOUD_PORT ?? '8787'}/admin`;
	const call = async <T>(op: string, args: unknown): Promise<T> => {
		let res: Response;
		try {
			res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) });
		} catch {
			throw new Error('no local catalogue answers on 127.0.0.1:8787 — start it with `pnpm --filter @curator/cloud local`, or set DATABASE_URL');
		}
		const text = await res.text();
		let body: { ok: boolean; result?: T; error?: string };
		try {
			body = JSON.parse(text) as typeof body;
		} catch {
			// A server started before this path existed answers "not found".
			throw new Error(`the running local catalogue does not serve /admin (HTTP ${res.status}): restart it with \`pnpm --filter @curator/cloud local\``);
		}
		if (!res.ok || !body.ok) throw new Error(body.error ?? `admin ${op}: HTTP ${res.status}`);
		return body.result as T;
	};
	return {
		list: (a) => call('list', a),
		get: (a) => call('get', a),
		decide: (a) => call('decide', a),
		scan: (a) => call('scan', a),
		reviewOpen: (a) => call('reviewOpen', a),
		labelUnlink: (a) => call('labelUnlink', a),
		labelMerge: (a) => call('labelMerge', a),
		labelRename: (a) => call('labelRename', a),
		search: (a) => call('search', a),
		labelAdd: (a) => call('labelAdd', a),
		labelShow: (a) => call('labelShow', a),
		labelLink: (a) => call('labelLink', a),
		labelImport: (a) => call('labelImport', a),
		labelScanned: (a) => call('labelScanned', a),
		labelVerify: (a) => call('labelVerify', a),
		labelRefresh: (a) => call('labelRefresh', a),
		labelReleases: (a) => call('labelReleases', a),
		pass: (a) => call('pass', a),
		trackingOverview: (a) => call('trackingOverview', a),
		trackingCheck: (a) => call('trackingCheck', a),
		releaseStubs: (a) => call('releaseStubs', a),
		releaseFill: (a) => call('releaseFill', a),
		releaseLink: (a) => call('releaseLink', a),
		insightAdd: (a) => call('insightAdd', a),
		insightRetire: (a) => call('insightRetire', a),
		insightList: (a) => call('insightList', a),
		releaseDedupe: (a) => call('releaseDedupe', a),
		repairPreviews: (a) => call('repairPreviews', a),
		repairDjSets: (a) => call('repairDjSets', a),
		repairCredits: (a) => call('repairCredits', a),
		compoundArtists: (a) => call('compoundArtists', a),
		nameLookup: (a) => call('nameLookup', a),
		repairArtistTwins: (a) => call('repairArtistTwins', a),
		artistMerge: (a) => call('artistMerge', a),
		artistUnlink: (a) => call('artistUnlink', a),
		artistValidate: (a) => call('artistValidate', a),
		releaseMerge: (a) => call('releaseMerge', a),
		artistRecredit: (a) => call('artistRecredit', a),
		libraryImport: (a) => call('libraryImport', a),
		inboxList: (a) => call('inboxList', a),
		inboxCounts: (a) => call('inboxCounts', a),
		inboxGet: (a) => call('inboxGet', a),
		inboxDecide: (a) => call('inboxDecide', a),
		inboxSnooze: (a) => call('inboxSnooze', a),
		agentCases: (a) => call('agentCases', a),
		agentCase: (a) => call('agentCase', a),
		agentRun: (a) => call('agentRun', a),
		agentAsk: (a) => call('agentAsk', a),
		agentEvalExport: (a) => call('agentEvalExport', a),
		agentSweep: (a) => call('agentSweep', a),
		agentDrop: (a) => call('agentDrop', a),
		agentAdvise: (a) => call('agentAdvise', a),
	};
}

function printCase(c: AgentCase, full: boolean): void {
	console.log(`\n#${c.id}  ${c.kind}  ${c.status}${c.confidence !== null ? ` · ${Math.round(c.confidence * 100)}%` : ''}${c.costUsd !== null ? ` · $${c.costUsd.toFixed(4)}` : ''}${c.model ? ` · ${c.model}` : ''} · ${when(c.createdAt)}${c.inboxId !== null ? ` · inbox #${c.inboxId}` : ''}`);
	if (c.lastError) console.log(`  last error: ${c.lastError}`);
	if (!full) return;
	console.log(`  subjects: ${c.subjects.join(', ')}`);
	console.log(`  input: ${JSON.stringify(c.input).slice(0, 800)}`);
	if (c.verdict) console.log(`  verdict: ${JSON.stringify(c.verdict, null, 1).slice(0, 2000)}`);
	if (c.usage) console.log(`  usage: ${JSON.stringify(c.usage)}`);
}

const when = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

// A catalogue-playlist candidate's measurements (catalogue-playlists.ts), one line.
function measured(e: Record<string, unknown>): string {
	const pct = (k: string) => (typeof e[k] === 'number' ? `${Math.round((e[k] as number) * 100)}%` : '?');
	const newest = typeof e.newestAddedAt === 'string' ? e.newestAddedAt.slice(0, 10) : 'never';
	return `label ${pct('labelShare')} · artists ${pct('artistShare')} · overlap ${String(e.overlap ?? '?')} · sampled ${String(e.sampled ?? '?')}/${String(e.total ?? '?')} · newest ${newest}${e.fresh === false ? ' (stale)' : ''} · owner ${String(e.owner ?? '?')}`;
}

// A related-label candidate's evidence (label-related.ts): side 0 is the
// review's object (the one merge:0 keeps), side 1 the candidate.
function printRelated(e: RelatedEvidence): void {
	const pct = (x: number) => `${Math.round(x * 100)}%`;
	console.log(`      name ${e.name ?? 'unrelated'} · shared releases ${e.sharedReleases} · shared artists ${e.sharedArtists} (${pct(e.rosterShare[0])} of keep, ${pct(e.rosterShare[1])} of candidate)`);
	for (const [i, s] of e.sides.entries()) {
		console.log(`      ${i === 0 ? 'keep' : 'cand'}: "${s.name}" ${s.releases} releases ${s.span[0] ?? '?'}…${s.span[1] ?? '?'} · roster ${s.roster} · watchers ${s.watchers}${s.fromLibrary ? ' · in library' : ''} · pages ${s.pages.join(',') || '—'}`);
	}
	if (e.sharedReleaseExamples.length) console.log(`      both hold: ${e.sharedReleaseExamples.join(' | ')}`);
	if (e.sharedArtistExamples.length) console.log(`      both put out: ${e.sharedArtistExamples.join(', ')}`);
}

// An inbox item: what it is, who did it, what it rests on; `full` adds the evidence.
function printInbox(r: InboxRow, full: boolean): void {
	const mark = r.severity === 'approval' ? '●' : r.severity === 'notice' ? '○' : '·';
	const state = r.status === 'open' ? (r.snoozedUntil && r.snoozedUntil > Date.now() ? `snoozed until ${when(r.snoozedUntil)}` : r.apply ? 'needs approval' : r.undo ? 'done, undoable' : 'notice') : `${r.status}${r.resolution ? ` (${r.resolution})` : ''}${r.resolvedBy ? ` by ${r.resolvedBy}` : ''}`;
	console.log(`\n${mark} #${r.id}  ${r.kind}  ${r.title}`);
	console.log(`  ${r.actor} · ${when(r.raisedAt)} · ${state}${r.approvedBy ? ` · approved in chat by ${r.approvedBy}` : ''}${r.reviewId !== null ? ` · review #${r.reviewId}` : ''}`);
	if (r.subjectNames.length) console.log(`  about: ${r.subjectNames.map((s) => `${s.name} (${s.id})`).join(', ')}`);
	if (r.lastError) console.log(`  last error: ${r.lastError}`);
	if (r.note) console.log(`  note: ${r.note}`);
	if (!full) return;
	const e = r.evidence;
	// The reasoner's items carry why it decided (catalog/agent/apply.ts).
	if (typeof e.rationale === 'string') console.log(`  why: ${e.rationale}${typeof e.confidence === 'number' ? ` (${Math.round(e.confidence * 100)}% sure` : ''}${typeof e.model === 'string' ? `, ${e.model}` : ''}${typeof e.costUsd === 'number' ? `, $${e.costUsd.toFixed(4)}` : ''}${typeof e.confidence === 'number' ? ')' : ''}${typeof e.case === 'number' ? ` · case #${e.case}` : ''}`);
	if (Array.isArray(e.citations) && e.citations.length) console.log(`  read: ${(e.citations as string[]).join(' ')}`);
	if (e.candidate && (e.candidate as { evidence?: { kind?: string } }).evidence?.kind === 'related_label') printRelated((e.candidate as { evidence: RelatedEvidence }).evidence);
	if (Array.isArray(e.candidates)) for (const [i, c] of (e.candidates as ReviewCandidate[]).entries()) console.log(`  [${i}] ${c.name}  ${c.objectId ? `object ${c.objectId}` : `${c.provider}:${c.providerId}`}${c.url ? `  ${c.url}` : ''}${c.releases?.length ? `\n      lists: ${c.releases.slice(0, 12).join(' | ')}` : ''}`);
	// Artist sides carry no artists list (objects.ts PairView), release sides do.
	const artistPairs = Array.isArray(e.pairs) && (e.pairs as { keep?: { artists?: unknown } }[])[0]?.keep?.artists === undefined;
	if (Array.isArray(e.verdicts)) console.log(`  model said, per pair: ${(e.verdicts as string[]).map((v, i) => `[${i}] ${v}`).join('  ')}`);
	if (artistPairs) {
		for (const [i, p] of (e.pairs as ArtistPairView[]).entries()) console.log(`  [${i}] keep: ${p.keep.title} ${p.keep.id} [${p.keep.providers.join(',')}] ${p.keep.tracks} credit(s)  ⇐ fold: ${p.fold.title} ${p.fold.id} [${p.fold.providers.join(',')}] ${p.fold.tracks} credit(s)
      both on: ${(p.on ?? []).join(' | ')}`);
	} else if (Array.isArray(e.pairs)) for (const [i, p] of (e.pairs as { keep: { title: string; artists: string[]; date: string | null; providers: string[] }; fold: { title: string; artists: string[]; date: string | null; providers: string[] } }[]).entries()) console.log(`  [${i}] keep: ${p.keep.title} — ${p.keep.artists.join(', ')} (${p.keep.date ?? '?'}) [${p.keep.providers.join(',')}]  ⇐ fold: ${p.fold.title} — ${p.fold.artists.join(', ')} (${p.fold.date ?? '?'}) [${p.fold.providers.join(',')}]`);
	const rest = Object.fromEntries(Object.entries(e).filter(([k]) => !['candidate', 'candidates', 'pairs', 'reviewEvidence', 'rationale', 'citations', 'confidence', 'model', 'costUsd', 'case', 'verdicts', 'on'].includes(k)));
	if (Object.keys(rest).length) console.log(`  ${JSON.stringify(rest).slice(0, 600)}`);
}

function printReview(r: ReviewView): void {
	const o = r.object;
	console.log(`\n#${r.id}  ${r.kind}  ${o ? `${o.kind} "${o.name}"` : r.objectId}  (${r.status}${r.decidedBy ? ` by ${r.decidedBy}` : ''})`);
	if (o?.handles.length) console.log(`  pages: ${o.handles.map((h) => `${h.provider}:${h.id}`).join(', ')}`);
	if (r.evidence.reason) console.log(`  why: ${String(r.evidence.reason)}`);
	console.log(`  catalogue releases (${r.releases.length}): ${r.releases.slice(0, 12).map((x) => `${x.title}${x.artists.length ? ` — ${x.artists.join(', ')}` : ''}${x.date ? ` (${x.date})` : ''}`).join(' | ') || '—'}`);
	for (const c of r.candidateViews) {
		const where = c.candidate.objectId ? `object ${c.candidate.objectId}` : `${c.candidate.provider}:${c.candidate.providerId}`;
		console.log(`  [${c.index}] ${c.candidate.name}  ${where}${c.candidate.url ? `  ${c.candidate.url}` : ''}  overlap ${c.overlap}/${c.releases.length}`);
		if (c.candidate.evidence?.kind === 'related_label') printRelated(c.candidate.evidence as unknown as RelatedEvidence);
		else if (c.candidate.evidence) console.log(`      ${measured(c.candidate.evidence)}`);
		if (c.releases.length) console.log(`      lists: ${c.releases.slice(0, 12).join(' | ')}`);
	}
	if (r.decision) console.log(`  decision: ${JSON.stringify(r.decision)}${r.note ? `  — ${r.note}` : ''}`);
}

function printLabel(v: LabelView): void {
	console.log(`\n${v.name}  ${v.id}  watchers ${v.watchers}  releases ${v.releases}  roster ${v.roster}`);
	console.log(`  pages: ${v.pages.map((p) => `${p.provider}:${p.id}${p.url ? ` <${p.url}>` : ''}`).join('  ') || '—'}`);
	console.log(`  spotify: ${v.onSpotify} of ${v.releases} releases have a Spotify id; catalogue playlists: ${v.cataloguePlaylists.map((c) => `"${c.name}" spotify:${c.id}`).join(', ') || '—'}`);
	if (v.identifiers.length) console.log(`  ids: ${v.identifiers.map((i) => `${i.namespace}=${i.value}`).join('  ')}`);
	if (v.tracking.length) console.log(`  tracking: ${v.tracking.map((t) => `${t.provider} last ${when(t.lastRunAt)} next ${when(t.nextDueAt)}${t.failCount ? ` FAILING ${t.failCount}× ${t.lastError ?? ''}` : ''}`).join('  |  ')}`);
	if (v.tasks.length) console.log(`  queued: ${v.tasks.map((t) => `${t.need}/${t.provider} due ${when(t.nextDueAt)}${t.attempts ? ` (${t.attempts} failed: ${t.lastError ?? ''})` : ''}`).join('  |  ')}`);
	if (v.latest.length) console.log(`  latest: ${v.latest.map((r) => `${r.title}${r.edition ? ` {${r.edition}}` : ''}${r.artists.length ? ` — ${r.artists.join(', ')}` : ''}${r.date ? ` (${r.date})` : ''} [${r.providers.join(',')}]`).join(' | ')}`);
	console.log(`  gaps: ${v.gaps.length ? v.gaps.join('; ') : 'none'}`);
}

const log = createLogger();
const api = await ops();
const json = flag('--json');
try {
	const [group, sub, ...rest] = words;
	const q = rest.join(' ');
	if (group === 'search') {
		const rows = await api.search({ q: [sub, ...rest].filter(Boolean).join(' '), kind: arg('--kind') as 'label' | 'artist' | undefined });
		if (json) console.log(JSON.stringify(rows, null, 2));
		else for (const r of rows) console.log(`${r.kind.padEnd(7)} ${r.name}  ${r.id}  watchers ${r.watchers}  ${r.pages.join(' ')}`);
	} else if (group === 'label' && sub === 'add') {
		const v = await api.labelAdd({ q });
		if (json) console.log(JSON.stringify(v, null, 2));
		else printLabel(v);
	} else if (group === 'label' && sub === 'show') {
		const v = await api.labelShow({ q });
		if (json) console.log(JSON.stringify(v, null, 2));
		else printLabel(v);
	} else if (group === 'label' && sub === 'link') {
		const url = rest[rest.length - 1]!;
		const v = await api.labelLink({ q: rest.slice(0, -1).join(' '), url, by: arg('--by') ?? 'claude-code', approved: flag('--approved') });
		if (json) console.log(JSON.stringify(v, null, 2));
		else printLabel(v);
	} else if (group === 'label' && sub === 'unlink') {
		const url = rest[rest.length - 1]!;
		const r = await api.labelUnlink({ q: rest.slice(0, -1).join(' '), url, by: arg('--by') ?? 'claude-code', note: arg('--note') ?? null, approved: flag('--approved') });
		console.log(`unlinked ${r.provider}:${r.providerId} — ${r.edges} edge(s) and ${r.identifiers} identifier(s) it alone brought removed; ruled not this label's page${r.review !== null ? ` (review #${r.review})` : ''}`);
	} else if (group === 'label' && sub === 'merge') {
		if (rest.length !== 2) throw new Error('label merge <from> <into> --note "why they are one" [--approved]   (ids or quoted names)');
		const r = await api.labelMerge({ from: rest[0]!, into: rest[1]!, by: arg('--by') ?? 'claude-code', note: arg('--note') ?? '', approved: flag('--approved') });
		if (r.moved) console.log(`merged ${r.from} into ${r.into} ("${r.name}"): ${JSON.stringify(r.moved)}`);
		else console.log(`held for the operator${r.held !== null && r.held !== undefined ? ` as inbox #${r.held}` : ' (already waiting in the inbox)'}: nothing merged yet — pass --approved only when Guy said so in chat`);
	} else if (group === 'artist' && sub === 'merge') {
		if (rest.length !== 2) throw new Error('artist merge <from id> <into id> --note "why they are one" [--approved]');
		const r = await api.artistMerge({ from: rest[0]!, into: rest[1]!, note: arg('--note') ?? '', by: arg('--by') ?? 'claude-code', approved: flag('--approved') });
		if (r.moved) console.log(`merged ${rest[0]} into ${rest[1]}: ${JSON.stringify(r.moved)}`);
		else console.log(`held for the operator${r.held !== null && r.held !== undefined ? ` as inbox #${r.held}` : ' (already waiting in the inbox)'}: nothing merged yet — pass --approved only when Guy said so in chat`);
	} else if (group === 'release' && sub === 'merge') {
		if (rest.length !== 2) throw new Error('release merge <from id> <into id> --note "why they are one" [--approved]');
		const r = await api.releaseMerge({ from: rest[0]!, into: rest[1]!, note: arg('--note') ?? '', by: arg('--by') ?? 'claude-code', approved: flag('--approved') });
		if (r.moved) console.log(`merged ${rest[0]} into ${rest[1]}: ${JSON.stringify(r.moved)}`);
		else console.log(`held for the operator${r.held !== null && r.held !== undefined ? ` as inbox #${r.held}` : ' (already waiting in the inbox)'}: nothing merged yet — pass --approved only when Guy said so in chat`);
	} else if (group === 'artist' && sub === 'recredit') {
		if (rest.length !== 3) throw new Error('artist recredit <artist id> <release id> <to artist id> --note "why" --approved');
		const r = await api.artistRecredit({ artist: rest[0]!, release: rest[1]!, to: rest[2]!, note: arg('--note') ?? '', by: arg('--by') ?? 'claude-code', approved: flag('--approved') });
		console.log(`moved ${r.credits} credit(s)`);
	} else if (group === 'label' && sub === 'rename') {
		if (rest.length !== 2) throw new Error('label rename <label> "<new name>"');
		const r = await api.labelRename({ q: rest[0]!, name: rest[1]!, by: arg('--by') ?? 'claude-code', approved: flag('--approved') });
		console.log(`renamed ${r.id} to "${r.name}"`);
	} else if (group === 'inbox') {
		const id = Number(rest[0]);
		if (sub === 'show') {
			const r = await api.inboxGet({ id });
			if (!r) throw new Error(`inbox item ${rest[0]} not found`);
			if (json) console.log(JSON.stringify(r, null, 2));
			else printInbox(r, true);
		} else if (sub === 'approve' || sub === 'reject') {
			if (!id) throw new Error(`inbox ${sub} <id> [--choice attach:<n>|merge:<n>|not-same:<n>] [--except 1,16] [--leave 3,7] --note "…" --by guy`);
			if (arg('--by') !== 'guy') throw new Error('the inbox is the operator\'s: resolve it from the back office, or with --by guy on Guy\'s explicit word in chat');
			const c = arg('--choice') ? /^(attach|merge|not-same):(\d+)$/.exec(arg('--choice')!) : null;
			if (arg('--choice') && !c) throw new Error('--choice attach:<n> | merge:<n> | not-same:<n>');
			const ex = arg('--except');
			if (ex !== undefined && !/^\d+(,\d+)*$/.test(ex)) throw new Error('--except <pair>,<pair>… (the [n] of `inbox show`)');
			const lv = arg('--leave');
			if (lv !== undefined && !/^\d+(,\d+)*$/.test(lv)) throw new Error('--leave <pair>,<pair>… (the [n] of `inbox show`)');
			const r = await api.inboxDecide({ id, action: sub, choice: c ? { action: c[1]!.replace('-', '_') as 'attach' | 'merge' | 'not_same', candidate: Number(c[2]) } : undefined, except: ex?.split(',').map(Number), leave: lv?.split(',').map(Number), note: arg('--note') ?? null, by: 'guy' });
			console.log(r.status === 'open' ? `#${r.id} still open: ${r.note}` : `#${r.id} ${r.status}: ${r.resolution}`);
		} else if (sub === 'snooze') {
			if (!id) throw new Error('inbox snooze <id> [--days 7]');
			const r = await api.inboxSnooze({ id, days: Number(arg('--days') ?? 7) });
			console.log(`#${r.id} snoozed until ${when(r.snoozedUntil)}`);
		} else {
			const kind = sub && !sub.startsWith('--') ? sub : arg('--kind');
			const rows = await api.inboxList({ status: flag('--all') ? 'all' : 'open', kind, ...(arg('--actor') ? { actor: arg('--actor') } : {}), limit: Number(arg('--limit') ?? 30) });
			const counts = await api.inboxCounts({});
			if (json) console.log(JSON.stringify(rows, null, 2));
			else {
				console.log(`${counts.approval} waiting for approval, ${counts.notice} notice(s), ${counts.snoozed} snoozed — showing ${rows.rows.length} of ${rows.total}${flag('--all') ? ' (all activity)' : ''}`);
				for (const r of rows.rows) printInbox(r, false);
			}
		}
	} else if (group === 'label' && sub === 'import') {
		const file = arg('--file');
		if (!file) throw new Error('label import <label> --file releases.json [--dry]');
		const data = JSON.parse(readFileSync(file, 'utf8')) as AgentImport;
		const r = await api.labelImport({ q, data, dry: flag('--dry'), by: arg('--by') ?? 'claude-code' });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.dry ? '[dry run, nothing written] ' : ''}${r.releases} release(s): ${r.matched} matched, ${r.created} new, ${r.storeIds} store id(s) attached`);
			for (const c of r.conflicts) console.log(`  conflict: ${c.release} — ${c.store}:${c.id} is on ${c.heldBy} (duplicate review opened)`);
			for (const u of r.unread.slice(0, 20)) console.log(`  not a store page I can key: ${u.release} — ${u.link}`);
		}
	} else if (group === 'label' && sub === 'scanned') {
		const r = await api.labelScanned({ q, note: arg('--note') ?? null, by: arg('--by') ?? 'claude-code' });
		console.log(`${r.name}: scanned ${when(r.scannedAt)}`);
	} else if (group === 'label' && sub === 'verify') {
		const rows = await api.labelVerify({ limit: Number(arg('--limit') ?? 100), watchedOnly: flag('--watched') });
		const shown = flag('--gaps') ? rows.filter((r) => r.gaps.length) : rows;
		if (json) console.log(JSON.stringify(shown, null, 2));
		else {
			console.log(`${rows.length} label(s), ${rows.filter((r) => r.gaps.length).length} with gaps`);
			for (const r of shown) console.log(`${r.name.padEnd(32).slice(0, 32)} w${r.watchers} rel ${String(r.releases).padStart(4)}  ${r.pages.join(',').padEnd(40).slice(0, 40)}  ${r.gaps.join('; ')}`);
		}
	} else if (group === 'label' && sub === 'refresh') {
		console.log(JSON.stringify(await api.labelRefresh({ q })));
	} else if (group === 'label' && sub === 'releases') {
		const rows = await api.labelReleases({ q, limit: Number(arg('--limit') ?? 50) });
		if (json) console.log(JSON.stringify(rows, null, 2));
		else for (const r of rows) console.log(`${r.date ?? '----------'}  ${r.title}${r.edition ? ` {${r.edition}}` : ''}${r.artists.length ? ` — ${r.artists.join(', ')}` : ''}  [${r.providers.join(',')}]`);
	} else if (group === 'review' && sub === 'scan') {
		const kind = arg('--kind') as 'artist' | 'label' | undefined;
		// --labels "Afterlife,REBA" or a file of names/ids, one a line.
		const named = arg('--labels');
		const labels = named ? (named.startsWith('@') ? readFileSync(named.slice(1), 'utf8').split(/\r?\n/) : named.split(',')).map((s) => s.trim()).filter(Boolean) : undefined;
		const r = await api.scan({ kind, limit: Number(arg('--limit') ?? (kind === 'label' && !labels ? 5000 : 200)), labels });
		console.log(`${r.checked !== undefined ? `checked ${r.checked} label(s), ` : ''}opened ${r.opened} duplicate review(s)`);
	} else if (group === 'review' && sub === 'open') {
		if (rest.length !== 2) throw new Error('review open <label a> <label b>   (ids or names; quote names with spaces)');
		const r = await api.reviewOpen({ a: rest[0]!, b: rest[1]! });
		console.log(r.id === null ? 'that pair was asked before' : `opened review #${r.id} (merge:0 keeps ${r.keep})`);
	} else if (group === 'review' && sub === 'list') {
		const rows = await api.list({ status: flag('--decided') ? 'decided' : 'open', kind: arg('--kind') as ReviewView['kind'] | undefined, limit: Number(arg('--limit') ?? 20), evidence: flag('--evidence'), related: flag('--related') });
		if (json) console.log(JSON.stringify(rows, null, 2));
		else {
			console.log(`${rows.length} review(s)`);
			for (const r of rows) printReview(r);
		}
	} else if (group === 'review' && sub === 'show') {
		const r = await api.get({ id: Number(rest[0]), evidence: true });
		if (!r) throw new Error(`review ${rest[0]} not found`);
		if (json) console.log(JSON.stringify(r, null, 2));
		else printReview(r);
	} else if (group === 'review' && sub === 'decide') {
		const id = Number(rest[0]);
		const m = /^(attach|merge|not-same|skip)(?::(\d+))?$/.exec(rest[1] ?? '');
		if (!id || !m) throw new Error('review decide <id> attach:<n> | merge:<n> | not-same[:<n>] | skip');
		const action = m[1]!.replace('-', '_') as 'attach' | 'merge' | 'not_same' | 'skip';
		const r = await api.decide({ id, decision: { action, ...(m[2] !== undefined ? { candidate: Number(m[2]) } : {}) }, by: arg('--by') ?? 'claude-code', note: arg('--note') ?? null, approved: flag('--approved') });
		if (r.review.status === 'held') console.log(`#${id} merge [${m[2]}] held for the operator${r.held !== null && r.held !== undefined ? ` as inbox #${r.held}` : ' (already waiting in the inbox)'}: nothing merged yet`);
		else if (r.review.status === 'escalated') console.log(`#${id} left for the operator (escalated to the inbox)`);
		else console.log(`#${id} ${action}${m[2] !== undefined ? ` [${m[2]}]` : ''} by ${r.review.decidedBy}${r.merge ? `  merged: ${JSON.stringify(r.merge)}` : ''}`);
	} else if (group === 'release' && sub === 'stubs') {
		const r = await api.releaseStubs({ label: arg('--label'), artist: arg('--artist'), limit: Number(arg('--limit') ?? 50) });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.total} release(s) short of their tracklist${r.rows.length < r.total ? ` (showing ${r.rows.length})` : ''}`);
			for (const x of r.rows) {
				console.log(`${x.date ?? '----------'}  ${x.title}${x.artists.length ? ` — ${x.artists.join(', ')}` : ''}  ${x.id}`);
				console.log(`    tracks ${x.have}/${x.expected ?? '?'}  stores: ${x.handles.map((h) => `${h.provider}:${h.id}`).join(' ') || '—'}${x.upc ? `  upc ${x.upc}` : ''}${x.labels.length ? `  label: ${x.labels.map((l) => l.name).join(', ')}` : ''}`);
			}
		}
	} else if (group === 'release' && sub === 'fill') {
		const ids = rest.filter((w) => /^[0-9a-f-]{36}$/i.test(w));
		if (!ids.length && !arg('--label') && !arg('--artist')) throw new Error('release fill <release id…> | --label <q> | --artist <q> [--limit 20] [--dry]');
		const r = await api.releaseFill({ ids, label: arg('--label'), artist: arg('--artist'), limit: Number(arg('--limit') ?? 20), dry: flag('--dry') });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.dry ? '[dry run, nothing written] ' : ''}${r.filled} of ${r.stubs} release(s) gained tracks${r.parked.length ? `; parked: ${r.parked.join(', ')}` : ''}`);
			for (const o of r.outcomes) {
				console.log(`${o.after > o.before ? '+' : ' '} ${o.title}  ${o.id}  tracks ${o.before} → ${o.after}${o.expected !== null ? ` of ${o.expected}` : ''}`);
				for (const s of o.sources) console.log(`    ${s.provider}: ${s.tracks === null ? '' : `${s.tracks} track(s)`}${s.note ? `${s.tracks === null ? '' : ' — '}${s.note}` : ''}`);
				for (const c of o.conflicts) console.log(`    conflict: ${c.provider}:${c.id} is on ${c.heldBy} (duplicate review opened)`);
				for (const c of o.candidates) console.log(`    candidate: ${c.provider} "${c.title}"${c.artist ? ` — ${c.artist}` : ''}${c.tracks !== null ? `, ${c.tracks} track(s)` : ''}  ${c.url}  (check, then: release link ${o.id} ${c.url})`);
				if (!o.sources.length) console.log('    no store to read it from: find it on Spotify / Deezer / Beatport and `release link` it');
			}
		}
	} else if (group === 'release' && sub === 'dedupe') {
		const ids = rest.filter((w) => /^[0-9a-f-]{36}$/i.test(w));
		const since = arg('--since-days');
		const sharedSlots = flag('--shared-slots') ? { sinceDays: since === undefined ? undefined : Number(since) } : undefined;
		const r = await api.releaseDedupe({ ids, label: arg('--label'), artist: arg('--artist'), sharedSlots, dry: flag('--dry'), by: arg('--by') ?? 'claude-code' });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.dry ? '[dry run, nothing written] ' : ''}${r.merged.length} duplicate track(s) merged across ${r.releases} release(s)`);
			for (const m of r.merged) console.log(`  ${m.release}: "${m.from}" → "${m.into}"`);
		}
	} else if (group === 'insight' && sub === 'add') {
		const text = rest.at(-1);
		const target = rest.slice(0, -1).join(' ');
		if (!target || !text || !arg('--topic')) throw new Error('insight add <object id | label> --topic edition|partial|note "<text>"');
		const i = await api.insightAdd({ q: target, topic: arg('--topic')!, body: text, by: arg('--by') ?? 'claude-code', approved: flag('--approved') });
		console.log(json ? JSON.stringify(i, null, 2) : `insight #${i.id} on ${i.objectId} (${i.topic}): ${i.body}`);
	} else if (group === 'insight' && sub === 'list') {
		const r = await api.insightList({ q, retired: flag('--retired') });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.kind} "${r.name}"  ${r.id}`);
			for (const i of r.insights) console.log(`  #${i.id} [${i.topic}] ${i.body}  — ${i.actor} ${when(i.createdAt)}${i.retiredAt ? `  (retired ${when(i.retiredAt)} by ${i.retiredBy})` : ''}`);
			if (!r.insights.length) console.log('  no insights');
		}
	} else if (group === 'insight' && sub === 'retire') {
		const id = Number(rest[0]);
		if (!Number.isInteger(id)) throw new Error('insight retire <insight id> [--note "…"]');
		const i = await api.insightRetire({ id, by: arg('--by') ?? 'claude-code', note: arg('--note') ?? null });
		console.log(`insight #${i.id} retired`);
	} else if (group === 'artist' && sub === 'validate') {
		if (rest.length !== 1) throw new Error('artist validate <artist id> [--propose]');
		const pages = await api.artistValidate({ id: rest[0]!, propose: flag('--propose') });
		if (!pages.length) console.log('no Deezer page to validate on that artist (none attached, or blocked already)');
		for (const p of pages) {
			console.log(`${p.provider}:${p.providerId} «${p.name}» — ${p.verdict}: ${p.reason}`);
			console.log(`  listed ${p.listed}${p.total !== null ? ` of ${p.total}` : ''}: ${Object.entries(p.genres).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(', ') || 'no genres'}; Beatport releases: ${p.beatport}`);
			if (p.inbox !== null) console.log(`  held for approval: inbox #${p.inbox}`);
		}
	} else if (group === 'artist' && sub === 'unlink') {
		if (rest.length !== 2) throw new Error('artist unlink <artist id> <provider:id> --note "whose page it is" [--approved]');
		const as = arg('--as') ?? 'namesake';
		if (as !== 'namesake' && as !== 'bucket') throw new Error('--as takes namesake (their own page, split off with its releases) or bucket (a store page of several acts, blocked)');
		const r = await api.artistUnlink({ id: rest[0]!, source: rest[1]!, by: arg('--by') ?? 'claude-code', note: arg('--note') ?? '', approved: flag('--approved'), as });
		if (r.held !== null) console.log(`${r.provider}:${r.providerId} «${r.name}» lists ${r.releases} release(s) the catalogue holds — held for approval: inbox #${r.held}`);
		else if (r.result?.into) console.log(`split ${r.provider}:${r.providerId} «${r.name}» off as ${r.result.into} with ${r.result.recredited} credit(s) on ${r.releases} release(s)`);
		else console.log(`blocked ${r.provider}:${r.providerId} — ${r.result?.uncredited ?? 0} credit(s) taken off, ${r.result?.kept ?? 0} release(s) another store or page holds kept`);
	} else if (group === 'release' && sub === 'link') {
		const r = await api.releaseLink({ id: rest[0] ?? '', url: rest[1] ?? '' });
		console.log(r.conflict ? `${r.provider}:${r.id} already belongs to ${r.conflict}: duplicate review opened` : `linked ${r.provider}:${r.id}; run release fill ${rest[0]}`);
	} else if (group === 'library' && sub === 'import') {
		// A file of claims as core's releaseCandidates builds them; the
		// headless script (apps/core catalog:import) is the usual caller.
		const file = arg('--file');
		if (!file) throw new Error('library import --file claims.json [--dry]');
		const claims = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
		const out = { created: 0, attached: 0, fills: 0, profiles: 0, rejected: 0 };
		for (let i = 0; i < claims.length; i += 100) {
			const batch = claims.slice(i, i + 100);
			const r = await api.libraryImport({ claims: batch, key: `library:${file.replace(/\W+/g, '_').slice(-60)}:${i}`, by: arg('--by') ?? 'claude-code', dry: flag('--dry') });
			out.created += r.created;
			out.attached += r.attached;
			out.fills += r.fills;
			out.profiles += r.profiles;
			out.rejected += r.results.filter((x) => 'rejected' in x).length;
		}
		console.log(`${flag('--dry') ? '[dry run, nothing written] ' : ''}${claims.length} claim(s): ${out.created} created, ${out.attached} joined, ${out.rejected} rejected; ${out.fills} release fill(s) and ${out.profiles} label profile(s) queued`);
	} else if (group === 'repair' && sub === 'previews') {
		const r = await api.repairPreviews({ label: arg('--label'), dry: flag('--dry'), by: arg('--by') ?? 'claude-code' });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.dry ? '[dry run, nothing written] ' : ''}${r.recordings} recording(s) with a preview length: ${r.lengthsCleared} cleared, ${r.creditsDropped} label-named credit(s) dropped, ${r.merged.length} merged`);
			for (const m of r.merged) console.log(`  "${m.title}" → ${m.into} (on "${m.intoRelease}")`);
			for (const u of r.unmatched) console.log(`  left: "${u.title}" ${u.id} — ${u.why}`);
		}
	} else if (group === 'repair' && sub === 'dj-sets') {
		const r = await api.repairDjSets({ dry: flag('--dry'), limit: arg('--limit') ? Number(arg('--limit')) : undefined, by: arg('--by') ?? 'claude-code' });
		console.log(`${r.dry ? '[dry run, nothing removed] ' : ''}${r.recordings} DJ set(s) and ${r.releases} release(s) of nothing else ${r.dry ? 'would go' : 'removed'}, ${r.events} event(s) with them; ${r.trimmed.length} release(s) keep their other tracks${r.more ? ' — more left: run again' : ''}`);
		for (const g of r.gone) console.log(`  - ${g.kind} ${g.name}${g.minutes !== null ? ` (${g.minutes} min)` : ''}  ${g.pages.join(' ')}`);
		for (const t of r.trimmed) console.log(`  trimmed: ${t.release} loses "${t.set}"`);
		if (r.watched.length) console.log(`  left, watched: ${r.watched.join(' | ')}`);
		if (r.elsewhere.count) console.log(`  not touched: ${r.elsewhere.count} long recording(s) another store holds (${r.elsewhere.sample.join(' | ')})`);
	} else if (group === 'repair' && sub === 'artist-twins') {
		// --all: call after call (each one bounded) until nothing is left.
		for (;;) {
			const r = await api.repairArtistTwins({ dry: flag('--dry'), mergeOnly: flag('--merge-only'), by: arg('--by') ?? 'claude-code' });
			if (json) console.log(JSON.stringify(r, null, 2));
			else {
				const folded = r.merged.reduce((n, m) => n + m.folds.length, 0);
				console.log(`found ${r.found.track} same-track and ${r.found.release} same-release group(s)${r.more ? ' — more to do' : ''}`);
				console.log(`${r.dry ? '[dry run, nothing written] ' : ''}${folded} copies merged into ${r.merged.length} artist(s); ${r.proposed.length} put to the inbox (one store, two ids)`);
				for (const m of r.merged) console.log(`  merged: "${m.name}" ×${m.folds.length + 1} (same ${m.on}, ${m.shared} shared)`);
				for (const x of r.proposed) console.log(`  inbox${x.item === null ? '' : ` #${x.item}`}: "${x.name}" (${x.pairs} pair(s))`);
			}
			if (!r.more || !flag('--all') || r.dry) break;
		}
	} else if (group === 'repair' && sub === 'compound-artists') {
		if (!flag('--dry')) throw new Error('repair compound-artists reads only so far: run it with --dry (the repair itself is not built)');
		const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
		// Page after page, each a short read: the whole catalogue in one report.
		const scan = async (lookup: boolean): Promise<{ rows: CompoundRow[]; asked: number }> => {
			const rows: CompoundRow[] = [];
			let after: string | null = null;
			let asked = 0;
			for (;;) {
				const r = await api.compoundArtists({ after, lookup });
				rows.push(...r.rows);
				asked += r.appleAsked;
				if (!r.next) return { rows, asked };
				after = r.next;
				// Apple's lookup refuses bursts: one call a page, paced.
				if (r.appleAsked) await wait(3_500);
			}
		};
		let { rows, asked } = await scan(flag('--lookup'));
		// --stores: the whole name asked outside the catalogue, for the names no
		// rule settled and the ones a rule would split. MusicBrainz first; then
		// Spotify for what is still open, the names its answer decides (each
		// name in them an artist of its own) first, and no more than --max a run:
		// its calls are the trackers' too.
		const stores = (arg('--stores') ?? '').split(/[\s,]+/).filter(Boolean);
		const unknown = stores.filter((s) => !(NAME_SOURCES as readonly string[]).includes(s));
		if (unknown.length) throw new Error(`--stores takes ${NAME_SOURCES.join(', ')} — not "${unknown.join('", "')}"`);
		const looked: string[] = [];
		for (const source of NAME_SOURCES) {
			if (!stores.includes(source)) continue;
			let need = rows.filter((r) => (r.decision === 'ask' || r.decision === 'split') && !r.asked.includes(source));
			if (source === 'spotify') {
				// A name whose Spotify page the catalogue holds needs no asking.
				need = need.filter((r) => !r.pages.some((x) => x.startsWith('spotify:')));
				const decides = (r: CompoundRow) => (r.tokens.length >= 2 && r.tokens.every((l) => l >= 3) ? 1 : 0);
				need = need.sort((a, b) => decides(b) - decides(a) || b.credits.tracks + b.credits.releases - (a.credits.tracks + a.credits.releases)).slice(0, Number(arg('--max') ?? 800));
			}
			// One spelling a folded name, as the lookup counts them.
			const names = [...new Map(need.map((r) => [nameFold(r.name), r.name] as const)).values()];
			let done = 0;
			let refused = 0;
			let why: string | null = null;
			for (let i = 0; i < names.length; ) {
				// A failed call (the source timing out) is a refusal like any other:
				// what it answered before is kept, the batch is asked again.
				const batch = names.slice(i, i + NAME_LOOKUP_BATCH);
				const r = await api.nameLookup({ names: batch, source }).catch((): Awaited<ReturnType<AdminOps['nameLookup']>> => ({ asked: 0, known: 0, stopped: 'refused' }));
				done += r.asked;
				if (r.stopped === 'budget' || r.stopped === 'unavailable') {
					why = r.stopped === 'budget' ? "today's calls are spent" : 'not configured here';
					break;
				}
				if (r.stopped === 'refused') {
					// A long wall is a ban in the making: leave it, the answers so far are kept.
					if ((r.retryAfterSec ?? 30) > 120 || ++refused > 12) {
						why = `it refused${r.retryAfterSec ? ` (wait ${r.retryAfterSec}s)` : ''}`;
						break;
					}
					await wait((r.retryAfterSec ?? 60) * 1000);
					continue;
				}
				refused = 0;
				// Cut short by its own time limit (a slow source): the rest again.
				if (r.asked + r.known < batch.length) continue;
				i += NAME_LOOKUP_BATCH;
				if (!json && i % (NAME_LOOKUP_BATCH * 10) === 0) console.error(`  ${source}: ${Math.min(i, names.length)} of ${names.length} name(s)`);
			}
			looked.push(`${source}: ${done} of ${names.length} name(s) asked${why ? `, stopped: ${why}` : ''}`);
			if (!done) continue;
			// Read again with the answers; Apple's names are kept from the first read.
			const first = new Map(rows.map((r) => [r.id, r]));
			rows = (await scan(false)).rows.map((r) => (first.get(r.id)?.class === 'apple_line' ? first.get(r.id)! : r));
		}
		const out = arg('--out');
		if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
		if (json) console.log(JSON.stringify(rows, null, 2));
		else {
			const only = arg('--class');
			const show = Number(arg('--show') ?? 15);
			const weight = (r: CompoundRow) => r.credits.tracks + r.credits.releases;
			console.log(`[dry run, nothing written] ${rows.length} artist(s) named like several${flag('--lookup') ? `, ${asked} Apple id(s) asked` : ''}${out ? ` — rows in ${out}` : ''}`);
			for (const l of looked) console.log(`  ${l}`);
			console.log(`  ${(['keep', 'rename', 'split', 'ask'] as const).map((d) => `${d} ${rows.filter((r) => r.decision === d).length}`).join(' · ')}`);
			for (const c of COMPOUND_CLASSES) {
				const of = rows.filter((r) => r.class === c).sort((a, b) => weight(b) - weight(a));
				console.log(`${String(of.length).padStart(6)} ${c.padEnd(10)} ${of.reduce((n, r) => n + r.credits.tracks, 0)} track credit(s), ${of.reduce((n, r) => n + r.credits.releases, 0)} release credit(s)`);
				if (only && only !== c) continue;
				for (const r of of.slice(0, only ? Math.max(show, 50) : show)) console.log(`         ${r.decision.padEnd(6)} "${r.name}"${r.into ? ` → ${r.into.map((n) => `"${n}"`).join(' + ')}` : r.to ? ` → "${r.to}"` : ''}  ${r.id}  [${[...new Set(r.pages.map((x) => x.split(':')[0]))].join(',') || 'no page'}]  ${r.why}`);
			}
		}
	} else if (group === 'repair' && sub === 'credits') {
		const r = await api.repairCredits({ dry: flag('--dry'), by: arg('--by') ?? 'claude-code' });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.dry ? '[dry run, nothing written] ' : ''}${r.fixed.length} split credit(s) repaired, ${r.renamed.length} store artist(s) renamed back, ${r.left.length} left`);
			for (const n of r.renamed) console.log(`  renamed: "${n.from}" → "${n.to}"`);
			for (const f of r.fixed) console.log(`  "${f.name}" → ${f.into.map((t) => `"${t}"`).join(' + ')} (${f.credits} credit(s))${f.minted.length ? ` — new: ${f.minted.join(', ')}` : ''}`);
			for (const l of r.left) console.log(`  left: "${l.name}" ${l.id} — ${l.why}`);
		}
	} else if (group === 'agent' && (sub === 'cases' || sub === undefined)) {
		const r = await api.agentCases({ status: arg('--status') as never, kind: arg('--kind') as never, limit: Number(arg('--limit') ?? 50) });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`reasoner ${r.enabled ? 'on' : 'off (no CURATOR_ANTHROPIC_API_KEY, no CURATOR_AGENT_BACKEND=claude-code)'} · ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no cases'}`);
			for (const c of r.cases) printCase(c, false);
		}
	} else if (group === 'agent' && sub === 'show') {
		const c = await api.agentCase({ id: Number(words[2]) });
		if (!c) throw new Error(`no case ${words[2]}`);
		if (json) console.log(JSON.stringify(c, null, 2));
		else {
			printCase(c, true);
			if (c.pack) console.log(`  pack: ${c.pack.question}\n        ${JSON.stringify(c.pack.evidence).length.toLocaleString()} chars of evidence${c.pack.research ? ', research allowed' : ''}`);
		}
	} else if (group === 'agent' && sub === 'sweep') {
		const kind = arg('--kind');
		const r = await api.agentSweep({ days: Number(arg('--days') ?? 30), dry: flag('--dry'), ...(kind ? { kinds: [kind as 'bucket' | 'credit'] } : {}), ...(arg('--limit') ? { limit: Number(arg('--limit')) } : {}) });
		if (r.candidates) {
			if (json) console.log(JSON.stringify(r.candidates, null, 2));
			else {
				console.log(`[dry] ${r.candidates.length} store id(s) over the floor, ${r.buckets} the rule would ask about:`);
				for (const c of r.candidates.sort((a, b) => a.stats.shared / a.stats.releases - b.stats.shared / b.stats.releases)) console.log(`  ${c.suspect ? '?' : ' '} ${c.name} ${c.provider}:${c.providerId}  ${c.stats.releases} rel, ${c.stats.labels} labels, ${c.stats.yearSpan} y, shared ${c.stats.shared} (${Math.round((100 * c.stats.shared) / c.stats.releases)}%), others-only ${c.stats.others}, labels shared ${c.stats.labelsShared}/${c.stats.labels} (elsewhere ${c.stats.labelsElsewhere})`);
			}
		} else console.log(`queued ${r.buckets} bucket case(s), ${r.credits} credit case(s); the pass reasons about them a few at a time (catalog agent cases)`);
	} else if (group === 'agent' && sub === 'advise') {
		// The reasoner's opinion on open twins items, nothing written.
		for (const w of words.slice(2)) {
			const a = await api.agentAdvise({ inbox: Number(w), ...(flag('--research') ? { research: true } : {}) });
			if (json) console.log(JSON.stringify(a));
			else {
				console.log(`\n#${a.inbox}  ${a.title}${a.confidence !== null ? `  (${Math.round(a.confidence * 100)}% sure)` : ''}`);
				for (const p of a.pairs) console.log(`  [${p.i}] ${p.verdict ?? '?'}  ${p.keep} ⇐ ${p.fold}`);
				if (a.rationale) console.log(`  why: ${a.rationale}`);
				if (a.error) console.log(`  error: ${a.error}`);
			}
		}
	} else if (group === 'agent' && sub === 'drop') {
		const r = await api.agentDrop({ ids: words.slice(2).map(Number).filter(Number.isInteger), reason: arg('--reason') ?? 'withdrawn by hand' });
		console.log(`dropped ${r.dropped.length} case(s)${r.dropped.length ? `: ${r.dropped.join(', ')}` : ''}${r.cleared.length ? `; cleared their open proposal(s): ${r.cleared.join(', ')}` : ''}`);
	} else if (group === 'agent' && sub === 'evals' && words[2] === 'export') {
		// The regression set (agent/evals.ts) as promptfoo test lines (apps/cloud/evals).
		const r = await api.agentEvalExport({ since: arg('--since') });
		const out = arg('--out') ?? 'evals/catalog/twins.jsonl';
		// The core set by default (agent/evals.ts coreSet); --all replays the whole log.
		// promptfoo reads an array var as a matrix of runs and refuses objects: the
		// pack and the labels travel as JSON strings (evals/provider.ts, agree.mjs).
		const picked = flag('--all') ? r.cases : coreSet(r.cases, Number(arg('--size') ?? 80));
		const lines = picked.map((c) => JSON.stringify({ description: `${c.id} ${c.kind} (${c.packSource})`, vars: { id: c.id, kind: c.kind, pack: JSON.stringify(c.pack), expected: JSON.stringify(c.expected), modelSaid: JSON.stringify(c.modelSaid) } }));
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, lines.length ? `${lines.join('\n')}\n` : '');
		const pairs = picked.flatMap((c) => c.expected.filter((e) => e !== null));
		console.log(`${picked.length} case(s)${picked.length < r.cases.length ? ` of ${r.cases.length}` : ''}, ${pairs.length} decided pair(s): ${pairs.filter((e) => e === 'same').length} same, ${pairs.filter((e) => e === 'different').length} different → ${out}${r.skipped.length ? ` · ${r.skipped.length} item(s) skipped` : ''}`);
		if (flag('--verbose')) for (const k of r.skipped) console.log(`  skipped inbox #${k.inbox}: ${k.why}`);
	} else if (group === 'agent' && sub === 'run') {
		const id = words[2] ? Number(words[2]) : undefined;
		const r = await api.agentRun({ id, dry: flag('--dry'), batch: arg('--batch') ? Number(arg('--batch')) : undefined, by: arg('--by') });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${flag('--dry') ? '[dry run, nothing written] ' : ''}${r.leased} case(s) taken${r.moot ? `, ${r.moot} moot` : ''}${r.parked ? ` — parked: ${r.parked}` : ''}`);
			for (const x of r.results) {
				console.log(`\n#${x.id}  ${x.kind}  → ${x.status}${x.answer ? ` · $${x.answer.costUsd.toFixed(4)} · ${x.answer.model} · ${x.answer.usage.inputTokens}+${x.answer.usage.outputTokens} tokens (${x.answer.usage.cacheReadTokens} cached, ${x.answer.usage.webSearches} searches)` : ''}`);
				if (x.verdict) console.log(`  ${JSON.stringify(x.verdict, null, 1).slice(0, 2500)}`);
				if (x.outcome) for (const line of [...x.outcome.applied.map((a) => `  done: ${a}`), ...x.outcome.proposed.map((p) => `  proposed: ${p}`)]) console.log(line);
				if (x.error) console.log(`  error: ${x.error}`);
			}
		}
	} else if (group === 'agent' && sub === 'ask') {
		const kind = words[2] as never;
		const ids = words.slice(3);
		const src = arg('--source');
		const [provider, ...rest] = (src ?? '').split(':');
		const r = await api.agentAsk({ kind, ids, ...(src ? { source: { provider: provider!, providerId: rest.join(':') } } : {}), ...(arg('--credit') ? { creditText: arg('--credit')! } : {}) });
		console.log(r.id === null ? 'that question is already queued' : `queued as case #${r.id}`);
	} else if (group === 'pass') {
		console.log(JSON.stringify(await api.pass({})));
	} else if (group === 'tracking' && sub === 'check') {
		const target = rest[0] ?? '';
		const kinds: Record<string, TrackingKind> = { artists: 'artist', labels: 'label', playlists: 'playlist', genres: 'genre' };
		const scope: CheckScope = target === 'all' ? { all: true } : kinds[target] ? { kind: kinds[target] } : { id: target };
		const r = await api.trackingCheck({ ...scope, ...(arg('--provider') ? { provider: arg('--provider')! } : {}) });
		if (json) console.log(JSON.stringify(r, null, 2));
		else {
			console.log(`${r.queued} queued${r.started ? ', pass started' : ''}`);
			for (const p of r.byProvider) console.log(`${p.provider.padEnd(11)} queued ${p.queued}  already due ${p.alreadyDue}  read within the hour ${p.recent}  reading ${p.reading}  paused ${p.paused}`);
			for (const p of r.pauses) console.log(`${p.provider} paused until ${when(p.until)} UTC: ${p.error}`);
		}
	} else if (group === 'tracking') {
		const o = await api.trackingOverview({});
		if (json) console.log(JSON.stringify(o, null, 2));
		else {
			console.log(o.kinds.map((k) => `${k.kind} ${k.tracked}/${k.followed} tracked`).join(' · '));
			for (const w of o.workers) console.log(`${w.live ? 'WORKER ' : 'worker (silent) '}${w.name} [${w.deviceId}] can read ${w.providers.join(', ')} · checked ${w.trackers === null ? 'everything' : w.trackers.join(', ') || 'nothing'} · checked in ${when(w.checkedInAt)} UTC · week of ${w.weekOf}`);
			for (const p of o.pauses) console.log(`${p.provider} PAUSED until ${when(p.until)} UTC: ${p.error}`);
			for (const t of o.trackers.filter((x) => x.cursors > 0)) {
				console.log(`${t.kind.padEnd(9)}${t.provider.padEnd(11)} ${String(t.cursors).padStart(5)} followed${t.unwanted ? ` (${t.unwanted} switched off)` : ''}  ${String(t.checkedDay).padStart(5)} read in 24h  ${String(t.due).padStart(5)} due  ${String(t.failing).padStart(4)} failing  last ${when(t.lastCheckedAt)}  next ${when(t.nextDueAt)}  calls ${t.callsToday}/${t.callsPerDay ?? '?'}`);
			}
		}
	} else {
		console.log('catalog search | label add|show|link|unlink|merge|rename|import|verify|refresh|releases | release stubs|fill|link|dedupe|merge | artist merge|unlink|recredit | repair previews|credits|artist-twins|dj-sets | review scan|open|list|show|decide | inbox [show|approve|reject|snooze] | agent cases|show|run|ask|advise|sweep|drop|evals export | pass | tracking [check]   (see the header of src/cli/catalog.ts)');
	}
} catch (e) {
	log.error('catalog_cli_failed', { error: e instanceof Error ? e.message : String(e) });
	process.exitCode = 1;
}

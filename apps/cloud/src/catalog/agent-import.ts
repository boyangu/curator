// Releases a back-office agent gathered by browsing — a label's own website,
// Beatport and Traxsource in Guy's Chrome (their Cloudflare walls stop every
// fetch the worker can make, and every automated browser), smart links
// resolved to store ids — handed to the catalogue in one plain shape
// (`catalog label import`). The agent reads; this file writes, through the
// same identity rules as every tracker:
//
//   - each release is claimed as the source's own (provider 'website',
//     'beatport', 'traxsource'…, by its page), joined to the catalogue's
//     release by representation, catalogue number… else title + credited
//     names + date, or created;
//   - every store link on it (a Spotify album, a Beatport release, an Apple
//     album…) becomes a representation of that same release — unless that
//     id already belongs to another release, which opens a `duplicate`
//     review rather than moving it;
//   - tracks likewise, by ISRC where the agent saw one;
//   - the release is tied to the label (`release-label`, the source page as
//     evidence), and its catalogue number kept as a fact.
// Reason 'enrichment': nothing reaches anyone's feed. `dry` runs it all and
// rolls back, reporting what would match.

import type { CatalogClaim, CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { openReview } from './admin.js';
import { findRepresentation } from './identity.js';
import { Ingester, ingestClaims, linkReleasesToLabel } from './ingest.js';

export type AgentTrack = { title: string; artists?: string[]; isrc?: string | null; durationSec?: number | null; links?: Record<string, string> };
export type AgentRelease = {
	title: string;
	artists: string[];
	date?: string | null;
	catalogNumber?: string | null;
	// The page the agent read it on (the source's own id for it).
	url: string;
	// Store pages for it: spotify, beatport, traxsource, apple, deezer, bandcamp, tidal…
	links?: Record<string, string>;
	tracks?: AgentTrack[];
	coverUrl?: string | null;
	type?: string | null;
};
export type AgentImport = { source: string; by?: string; releases: AgentRelease[] };
export type AgentImportReport = {
	releases: number;
	matched: number;
	created: number;
	storeIds: number;
	conflicts: { release: string; store: string; id: string; heldBy: string }[];
	unread: { release: string; link: string }[];
	dry: boolean;
};

// A store page as (provider, kind, id): the ids the trackers key on.
export function storeRef(raw: string): { provider: CatalogProvider; kind: 'release' | 'recording'; id: string } | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	const host = u.hostname.replace(/^(www|open|geo|music|embed)\./, '');
	const parts = u.pathname.split('/').filter(Boolean);
	const last = (i: number) => parts[parts.length - i];
	if (host === 'spotify.com') {
		const at = parts.findIndex((p) => p === 'album' || p === 'track');
		const id = at >= 0 ? parts[at + 1] : undefined;
		if (id && /^[A-Za-z0-9]{22}$/.test(id)) return { provider: 'spotify', kind: parts[at] === 'album' ? 'release' : 'recording', id };
	}
	if (host === 'beatport.com' && (parts[0] === 'release' || parts[0] === 'track') && /^\d+$/.test(last(1) ?? '')) return { provider: 'beatport', kind: parts[0] === 'release' ? 'release' : 'recording', id: last(1)! };
	if (host === 'traxsource.com' && (parts[0] === 'title' || parts[0] === 'track') && /^\d+$/.test(parts[1] ?? '')) return { provider: 'traxsource', kind: parts[0] === 'title' ? 'release' : 'recording', id: parts[1]! };
	if (host === 'deezer.com') {
		const at = parts.findIndex((p) => p === 'album' || p === 'track');
		const id = at >= 0 ? parts[at + 1] : undefined;
		if (id && /^\d+$/.test(id)) return { provider: 'deezer', kind: parts[at] === 'album' ? 'release' : 'recording', id };
	}
	// music.apple.com, geo.music.apple.com, itunes.apple.com.
	if ((host === 'apple.com' || host.endsWith('.apple.com')) && parts.includes('album')) {
		const id = u.searchParams.get('i') ? null : parts.find((p) => /^\d{6,}$/.test(p));
		if (id) return { provider: 'apple', kind: 'release', id };
	}
	if (host === 'tidal.com') {
		const at = parts.findIndex((p) => p === 'album' || p === 'track');
		const id = at >= 0 ? parts[at + 1] : undefined;
		if (id && /^\d+$/.test(id)) return { provider: 'tidal', kind: parts[at] === 'album' ? 'release' : 'recording', id };
	}
	return null;
}

const SOURCE_PROVIDERS: Record<string, CatalogProvider> = { 'beatport.com': 'beatport', 'traxsource.com': 'traxsource', 'bandcamp.com': 'bandcamp' };

// Who a source page belongs to: a store (its own id) or the label's website.
function sourceOf(url: string): { provider: CatalogProvider; id: string } {
	const ref = storeRef(url);
	if (ref?.kind === 'release') return { provider: ref.provider, id: ref.id };
	const u = new URL(url);
	const host = u.hostname.replace(/^www\./, '');
	const provider = Object.entries(SOURCE_PROVIDERS).find(([h]) => host === h || host.endsWith(`.${h}`))?.[1] ?? 'website';
	return { provider, id: `${host}${u.pathname.replace(/\/+$/, '')}`.slice(0, 200) };
}

export async function agentImport(db: Db, labelId: string, input: AgentImport, opts: { dry?: boolean } = {}): Promise<AgentImportReport> {
	const report: AgentImportReport = { releases: input.releases.length, matched: 0, created: 0, storeIds: 0, conflicts: [], unread: [], dry: !!opts.dry };
	const rollback = new Error('dry run');
	try {
		await withSystemTx(db, async (tx) => {
			const [label] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1 and kind = 'label'`, [labelId]);
			if (!label) throw new Error(`label ${labelId} not found`);
			for (const r of input.releases) await importRelease(tx, labelId, label.name, r, report);
			// The agent read the label's listing: it was scanned, whatever it found.
			await tx.query(`update curator.catalog_object set scanned_at = now() where id = $1`, [labelId]);
			if (opts.dry) throw rollback;
		});
	} catch (e) {
		if (e !== rollback) throw e;
	}
	return report;
}

// A release title as stores disagree on it: "Low Tide EP", "Low Tide - EP",
// "Low Tide (EP)" and "Low Tide" are one release; format words set aside.
export const releaseTitleKey = (title: string): string =>
	nameFold(title.replace(/\s*[-–—(\[]?\s*\b(EP|LP|Album|Single)\b\s*[)\]]?\s*$/i, '').trim() || title);

async function labelReleaseByTitle(tx: Queryable, labelId: string, labelName: string, title: string, artists: string[], date: string | null): Promise<string | null> {
	const key = releaseTitleKey(title);
	// The label's releases whose fold starts with the key, compared on the key
	// itself (the stores' format words differ either way).
	const rows = (
		await tx.query<{ id: string; name: string; artists: string | null; release_ms: unknown; reps: unknown }>(
			`select o.id, o.name, extract(epoch from o.release_at) * 1000 as release_ms,
				(select string_agg(a.name_fold, '|') from curator.catalog_edge ar join curator.catalog_object a on a.id = ar.src where ar.dst = o.id and ar.kind = 'artist-release') as artists,
				(select count(*) from curator.catalog_source_object so where so.object_id = o.id) as reps
			from curator.catalog_object o
			where o.kind = 'release' and o.merged_into is null and o.name_fold like $1 || '%'
				and (exists (select 1 from curator.catalog_edge e where e.src = o.id and e.kind = 'release-label' and e.dst = $2) or lower(o.label_text) = lower($3))`,
			[key.replace(/[\\%_]/g, (m) => `\\${m}`), labelId, labelName],
		)
	).filter((r) => releaseTitleKey(r.name) === key);
	const want = new Set(artists.map(nameFold));
	// With artists named, one must be shared; with none (a compilation), the title alone.
	const hits = want.size ? rows.filter((r) => (r.artists ?? '').split('|').some((a) => want.has(a))) : rows;
	if (hits.length <= 1) return hits[0]?.id ?? null;
	if (!date) return null;
	const at = Date.parse(date);
	const near = hits
		.map((h) => ({ id: h.id, reps: Number(h.reps), gap: h.release_ms === null ? Infinity : Math.abs(Number(h.release_ms) - at) }))
		.sort((a, b) => a.gap - b.gap || b.reps - a.reps);
	// The nearest, if it is clearly nearer than the next and within two months.
	if (near[0]!.gap <= 60 * 86400_000 && near[0]!.gap * 2 < near[1]!.gap) return near[0]!.id;
	// A tie — the label already holds this release twice (a Bandcamp copy and
	// a store copy the joins missed): the better-held copy, not a third one
	// (2026-10-29 minted 37 that way). The twins detector proposes merging
	// the two; a new object would only add to it. Apart by more than two
	// months they are two releases of one title: neither.
	const close = near.filter((h) => h.gap <= 60 * 86400_000 || h.gap === Infinity);
	return close.length ? close.sort((a, b) => b.reps - a.reps)[0]!.id : null;
}

async function importRelease(tx: Queryable, labelId: string, labelName: string, r: AgentRelease, report: AgentImportReport): Promise<void> {
	const src = sourceOf(r.url);
	// Credits by name, identified within the label (as Bandcamp's label-hosted
	// ones are): joined to a known artist through the release when it joins.
	const artist = (name: string): CatalogClaim => ({ provider: src.provider, kind: 'artist', providerId: `${labelId}/${nameFold(name)}`.slice(0, 200), name });
	const date = r.date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(r.date) ? r.date : undefined;
	const claim: CatalogClaim = {
		provider: src.provider,
		kind: 'release',
		providerId: src.id,
		name: r.title,
		url: r.url,
		facts: {
			...(date ? { releaseDate: date } : {}),
			...(r.catalogNumber ? { catalogNumber: r.catalogNumber } : {}),
			...(r.coverUrl ? { coverUrl: r.coverUrl } : {}),
			...(r.type ? { releaseType: r.type } : {}),
			labelText: labelName,
			...(r.tracks?.length ? { trackCount: r.tracks.length } : {}),
		},
		artists: r.artists.map(artist),
		recordings: (r.tracks ?? []).map((t, i) => ({
			provider: src.provider,
			kind: 'recording' as const,
			providerId: `${src.id}#${i + 1}`.slice(0, 200),
			name: t.title,
			identifiers: t.isrc ? [{ namespace: 'isrc' as const, value: t.isrc }] : [],
			facts: { trackNumber: i + 1, ...(t.durationSec ? { durationSec: t.durationSec } : {}) },
			...(t.artists?.length ? { artists: t.artists.map(artist) } : {}),
		})),
	};
	// A release a store link already names is that release: the claim joins it.
	let objectId: string | null = null;
	for (const link of Object.values(r.links ?? {})) {
		const ref = storeRef(link);
		if (ref?.kind !== 'release') continue;
		objectId = await findRepresentation(tx, { provider: ref.provider, kind: 'release', providerId: ref.id });
		if (objectId) break;
	}
	// Else the label's own release of that title and a shared artist, whatever
	// the date: a site's date is often when the post went up, not the release
	// date (Steyoyoke's: 161 of 395 more than two days off, 2026-10-28), and
	// ingestion's title rule allows two days. The date only picks between
	// same-titled releases of the label (a remix edition).
	objectId ??= await labelReleaseByTitle(tx, labelId, labelName, r.title, r.artists, date ?? null);
	const ingester = new Ingester(tx, { reason: 'enrichment' });
	if (objectId) {
		await ingester.attachTo(objectId, claim);
		report.matched++;
	} else {
		const out = (await ingestClaims(tx, [claim], { reason: 'enrichment' })).outcomes[0]!;
		objectId = out.objectId;
		if (out.created) report.created++;
		else report.matched++;
	}
	await linkReleasesToLabel(tx, labelId, [{ objectId, claim }]);
	// Every store page for it, and for its tracks.
	const attach = async (objId: string, link: string, name: string, kind: 'release' | 'recording'): Promise<void> => {
		const ref = storeRef(link);
		if (!ref) {
			report.unread.push({ release: r.title, link });
			return;
		}
		if (ref.kind !== kind) return;
		const holder = await findRepresentation(tx, { provider: ref.provider, kind, providerId: ref.id });
		if (holder === objId) return;
		if (holder) {
			report.conflicts.push({ release: r.title, store: ref.provider, id: ref.id, heldBy: holder });
			await openReview(tx, { kind: 'duplicate', objectId: objId, candidates: [{ objectId: holder, name }], evidence: { reason: `${ref.provider} ${kind} ${ref.id} is on the other one; the agent found it for this one`, link } });
			return;
		}
		await ingester.attachTo(objId, { provider: ref.provider, kind, providerId: ref.id, name, url: link });
		report.storeIds++;
	};
	for (const link of Object.values(r.links ?? {})) await attach(objectId, link, r.title, 'release');
	for (const [i, t] of (r.tracks ?? []).entries()) {
		if (!t.links) continue;
		const rec = await findRepresentation(tx, { provider: src.provider, kind: 'recording', providerId: `${src.id}#${i + 1}`.slice(0, 200) });
		if (!rec) continue;
		for (const link of Object.values(t.links)) await attach(rec, link, t.title, 'recording');
	}
}

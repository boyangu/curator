// Evidence packs: what the reasoner reads about a case, built from the
// catalogue's own readers in one short transaction and rendered as compact
// JSON. Curated and capped — a focused pack beats a full dump for every model
// (the context-rot results), and the pack is the volatile tail after the
// cached prefix, so its size is the per-case cost.

import type { Queryable } from '../../db/db.js';
import { num } from '../../db/db.js';
import { getReview } from '../admin.js';
import { browseObject, type ObjectView } from '../browse.js';
import { WEAK_SQL } from '../identity.js';
import { insightsOf } from '../insights.js';
import type { AgentCase, ArtistBucketInput, ArtistTwinInput, CreditInput, LabelPagesInput, ReleaseTwinInput } from './cases.js';

const MAX_RELEASES = 25;
const MAX_TRACKS = 40;

export type EvidencePack = { question: string; evidence: Record<string, unknown>; research: boolean };

// An object as the model should see it: names, dates, ids and URLs, nothing
// about the catalogue's bookkeeping.
async function objectEvidence(tx: Queryable, id: string): Promise<Record<string, unknown> | null> {
	const v = await browseObject(tx, id);
	if (!v) return null;
	return trim(v);
}

function trim(v: ObjectView): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: v.id,
		kind: v.kind,
		name: v.name,
		sources: v.sources.map((s) => ({ provider: s.provider, id: s.providerId, url: s.url })),
		identifiers: v.identifiers,
	};
	if (v.release) out['release'] = v.release;
	if (v.labels?.length) out['labels'] = v.labels.map((l) => l.name);
	if (v.artists?.length) out['artists'] = v.artists.map((a) => ({ id: a.id, name: a.name, role: a.role ?? null }));
	if (v.tracks?.length) {
		out['tracks'] = v.tracks.slice(0, MAX_TRACKS).map((t) => ({ position: t.position, title: t.title, artists: t.artists.map((a) => a.name), durationSec: t.durationSec, isrc: t.isrc, providers: t.providers }));
		if ((v.trackCount ?? v.tracks.length) > MAX_TRACKS) out['tracksOmitted'] = (v.trackCount ?? v.tracks.length) - MAX_TRACKS;
	}
	if (v.releases?.length) {
		out['releases'] = v.releases.slice(0, MAX_RELEASES).map((r) => ({ id: r.id, title: r.title, date: r.date, type: r.type, labels: r.labels.map((l) => l.name), labelText: r.labelText, artists: r.artists.map((a) => a.name), tracks: r.tracks, providers: r.providers, ...(r.edition ? { edition: r.edition } : {}) }));
		if ((v.releaseCount ?? v.releases.length) > MAX_RELEASES) out['releasesOmitted'] = (v.releaseCount ?? v.releases.length) - MAX_RELEASES;
	}
	if (v.insights.length) out['operatorNotes'] = v.insights.map((i) => ({ topic: i.topic, body: i.body, by: i.actor }));
	return out;
}

async function pairsEvidence(tx: Queryable, pairs: { keep: string; fold: string }[]): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for (const p of pairs) out.push({ keep: await objectEvidence(tx, p.keep), fold: await objectEvidence(tx, p.fold) });
	return out;
}

// The releases an artist reached through one store against the rest: what a
// bucket looks like. Ingest evidences an artist's edges with the release's or
// recording's own claim (ingest.ts attachRelationships), never the artist's,
// so "through this id" is read by the provider of that evidence: exact when
// the artist holds one store id at the provider (detectBuckets asks only
// then), by provider when it holds two.
export async function releasesViaSource(tx: Queryable, artistId: string, provider: string): Promise<{ via: string[]; others: string[] }> {
	const rows = await tx.query<{ title: string; via: boolean }>(
		`with rel as (
			select e.dst as id, bool_or(so.provider = $2) as via
			from curator.catalog_edge e join curator.catalog_edge_evidence ev on ev.edge_id = e.id
			join curator.catalog_source_object so on so.id = ev.source_object_id
			where e.src = $1 and e.kind = 'artist-release' group by e.dst
			union all
			select rr.src, bool_or(so.provider = $2)
			from curator.catalog_edge ra join curator.catalog_edge_evidence ev on ev.edge_id = ra.id
			join curator.catalog_source_object so on so.id = ev.source_object_id
			join curator.catalog_edge rr on rr.dst = ra.src and rr.kind = 'release-recording'
			where ra.dst = $1 and ra.kind = 'recording-artist' group by rr.src
		)
		select r.name || coalesce(' (' || to_char(r.release_at, 'YYYY') || ')', '') ||
			coalesce(' [' || (select string_agg(distinct l.name, ', ') from curator.catalog_edge rl join curator.catalog_object l on l.id = rl.dst where rl.src = r.id and rl.kind = 'release-label') || ']', '') as title,
			bool_or(rel.via) as via
		from rel join curator.catalog_object r on r.id = rel.id and r.merged_into is null
		group by r.id, r.name, r.release_at order by r.release_at desc nulls last limit 80`,
		[artistId, provider],
	);
	return { via: rows.filter((r) => r.via).map((r) => r.title), others: rows.filter((r) => !r.via).map((r) => r.title) };
}

// The twins questions, shared by live packs and snapshot packs so a replayed
// decision reads the same words the reasoner reads.
const releaseTwinQuestion = (label: string) => `On the label «${label}», are these releases the same release held twice, or different releases? Answer per pair.`;
const artistTwinQuestion = (on: string[]) => `One store holds this artist under two ids, both credited on: ${on.join(' | ')}. Are the two the same act? Answer per pair.`;

// A twins pack from the pair views an inbox item kept (objects.ts PairView):
// how the regression set (agent/evals.ts) replays decisions made before cases
// stored their packs, since a merge leaves nothing else to read the pair
// from. Thinner than a live pack (no tracklists, no store ids), and says so.
export function packFromSnapshot(kind: 'release_twin' | 'artist_twin', s: { label?: string; on?: string[]; pairs: { keep: unknown; fold: unknown }[] }): EvidencePack {
	const pairs = s.pairs.map((p) => ({ keep: p.keep, fold: p.fold }));
	const source = 'inbox snapshot: each side as the operator saw it (title, artists, date, stores, track or credit count); tracklists and store ids were not kept';
	return kind === 'release_twin'
		? { question: releaseTwinQuestion(s.label ?? 'unknown'), evidence: { source, label: s.label ?? null, pairs }, research: false }
		: { question: artistTwinQuestion(s.on ?? []), evidence: { source, sharedReleases: s.on ?? [], pairs }, research: true };
}

export async function buildPack(tx: Queryable, c: AgentCase): Promise<EvidencePack> {
	switch (c.kind) {
		case 'release_twin': {
			const input = c.input as unknown as ReleaseTwinInput;
			return {
				question: releaseTwinQuestion(input.label.name),
				evidence: { label: input.label.name, pairs: await pairsEvidence(tx, input.pairs) },
				research: false,
			};
		}
		case 'artist_twin': {
			const input = c.input as unknown as ArtistTwinInput;
			return {
				question: artistTwinQuestion(input.on),
				evidence: { sharedReleases: input.on, pairs: await pairsEvidence(tx, input.pairs) },
				research: true,
			};
		}
		case 'artist_bucket': {
			const input = c.input as unknown as ArtistBucketInput;
			const artist = await objectEvidence(tx, input.artist);
			const split = await releasesViaSource(tx, input.artist, input.source.provider);
			const ids = await tx.query<{ n: unknown }>(`select count(*) as n from curator.catalog_source_object s where s.object_id = $1 and s.provider = $2 and s.kind = 'artist' and not ${WEAK_SQL}`, [input.artist, input.source.provider]);
			return {
				question: `Is ${input.source.provider} id ${input.source.providerId} a profile of this one artist, or a bucket holding several acts under the name?`,
				evidence: {
					artist,
					releasesThroughThisStore: split.via,
					releasesThroughOtherStoresOnly: split.others,
					...(input.stats ? { detectorCounts: input.stats } : {}),
					...(num(ids[0]?.n) > 1 ? { note: `the artist holds ${num(ids[0]?.n)} ${input.source.provider} ids: the split is by store, not by this one id` } : {}),
				},
				research: true,
			};
		}
		case 'credit': {
			const input = c.input as unknown as CreditInput;
			const release = await objectEvidence(tx, input.release);
			const pieces: Record<string, unknown>[] = [];
			for (const id of input.pieces) {
				const p = await objectEvidence(tx, id);
				if (p) pieces.push(p);
			}
			return {
				question: `A ${input.provider} reader minted these artists from the credit ${input.creditText ? `"${input.creditText}"` : '(text not kept)'} on this release. One act cut apart, or several artists?`,
				evidence: { creditText: input.creditText, pieces, release },
				research: true,
			};
		}
		case 'label_pages': {
			const input = c.input as unknown as LabelPagesInput;
			const label = await objectEvidence(tx, input.label);
			const reviews: Record<string, unknown>[] = [];
			for (const id of input.reviews) {
				const r = await getReview(tx, id);
				if (!r || r.status !== 'open') continue;
				reviews.push({ review: r.id, candidates: r.candidates.map((cand, i) => ({ candidate: i, provider: cand.provider, id: cand.providerId, url: cand.url ?? null, name: cand.name, listing: cand.releases ?? null, measured: cand.evidence ?? null })) });
			}
			const insights = await insightsOf(tx, [input.label]);
			return {
				question: 'For each candidate page, is it this label\'s own page (the two-points cross-check), not the label\'s, or unsure?',
				evidence: { label, reviews, operatorNotes: (insights.get(input.label) ?? []).map((i) => i.body) },
				research: true,
			};
		}
	}
}

// The user turn: the question, then the evidence as JSON, the question again
// last (the long-context rule: the instruction nearest the answer wins).
export function renderPack(p: EvidencePack): string {
	return `${p.question}\n\n<evidence>\n${JSON.stringify(p.evidence, null, 1)}\n</evidence>\n\n${p.question} Call record_verdict with your answer.`;
}

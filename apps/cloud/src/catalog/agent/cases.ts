// Cases: the questions the identity rules could not settle, queued for the
// reasoner (sql/0024). Each kind has an input shape (what the detector knew)
// and a verdict shape (what the model must answer, as a strict tool call —
// verdict/schemas.ts is the one source for both the JSON Schema the model
// gets and the zod parser that checks what came back).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/db.js';
import { num, numOrNull } from '../../db/db.js';

export const CASE_KINDS = ['credit', 'release_twin', 'artist_twin', 'artist_bucket', 'label_pages'] as const;
export type AgentCaseKind = (typeof CASE_KINDS)[number];
export type AgentCaseStatus = 'queued' | 'leased' | 'decided' | 'applied' | 'proposed' | 'declined' | 'failed' | 'moot';

// ── inputs ───────────────────────────────────────────────────────────────────────────────

export type Pair = { keep: string; fold: string };
// Two or more releases of one title on one label (inbox-detectors.ts twinGroups).
export type ReleaseTwinInput = { pairs: Pair[]; label: { id: string; name: string } };
// One artist name held under two ids by one store, on the releases named (artist-twins.ts).
export type ArtistTwinInput = { pairs: Pair[]; on: string[] };
// A store profile suspected of holding several acts.
// `stats`: the detector's numbers for the id (inbox-detectors.ts BucketStats); absent when asked by hand.
export type ArtistBucketInput = { artist: string; source: { provider: string; providerId: string }; stats?: { releases: number; labels: number; yearSpan: number; shared: number; others: number; labelsShared?: number; labelsElsewhere?: number } };
// Artists minted together on one release whose names look like one credit cut apart.
export type CreditInput = { release: string; creditText: string | null; pieces: string[]; provider: string };
// A label's page reviews the profiler could not settle.
export type LabelPagesInput = { label: string; reviews: number[] };

export type CaseInput = { credit: CreditInput; release_twin: ReleaseTwinInput; artist_twin: ArtistTwinInput; artist_bucket: ArtistBucketInput; label_pages: LabelPagesInput };

// ── verdicts ─────────────────────────────────────────────────────────────────────────────

const Confidence = z.number().min(0).max(1);
const Rationale = z.string().min(1).max(500);
const Citations = z.array(z.string().url()).max(5);
const base = { confidence: Confidence, rationale: Rationale, citations: Citations };

const PairVerdict = z.object({ keep: z.string(), fold: z.string(), verdict: z.enum(['same', 'different', 'unsure']) });

export const VERDICT = {
	release_twin: z.object({ ...base, pairs: z.array(PairVerdict).min(1) }),
	artist_twin: z.object({ ...base, pairs: z.array(PairVerdict).min(1) }),
	artist_bucket: z.object({
		...base,
		// bucket: the store id holds several acts and must come off the artist;
		// clean: it is this artist's own profile.
		verdict: z.enum(['bucket', 'clean', 'unsure']),
	}),
	credit: z.object({
		...base,
		// compound: the pieces are one act under the full credit; split: the
		// pieces are the real artists and the credit named several.
		verdict: z.enum(['compound', 'split', 'unsure']),
		// compound only: the one act's name as it should read.
		name: z.string().max(200).optional(),
	}),
	label_pages: z.object({
		...base,
		candidates: z.array(z.object({ review: z.number().int(), candidate: z.number().int(), verdict: z.enum(['attach', 'not_same', 'unsure']) })),
	}),
} as const;

export type Verdict<K extends AgentCaseKind> = z.infer<(typeof VERDICT)[K]>;
export type AnyVerdict = { [K in AgentCaseKind]: Verdict<K> }[AgentCaseKind];

// The same shapes as JSON Schema for the model's strict tool (zod 3 cannot
// emit it). `additionalProperties: false` + every key required is what
// strict tool use demands; optional fields are nullable instead.
const jsBase = {
	confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are, 0 to 1.' },
	rationale: { type: 'string', maxLength: 500, description: 'One or two sentences naming the evidence you relied on.' },
	citations: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'URLs you actually read, when web research informed the verdict; empty otherwise.' },
};
const jsPairs = {
	type: 'array',
	minItems: 1,
	items: {
		type: 'object',
		additionalProperties: false,
		required: ['keep', 'fold', 'verdict'],
		properties: { keep: { type: 'string' }, fold: { type: 'string' }, verdict: { type: 'string', enum: ['same', 'different', 'unsure'] } },
	},
};
export const VERDICT_JSON_SCHEMA: Record<AgentCaseKind, Record<string, unknown>> = {
	release_twin: { type: 'object', additionalProperties: false, required: ['pairs', 'confidence', 'rationale', 'citations'], properties: { pairs: jsPairs, ...jsBase } },
	artist_twin: { type: 'object', additionalProperties: false, required: ['pairs', 'confidence', 'rationale', 'citations'], properties: { pairs: jsPairs, ...jsBase } },
	artist_bucket: {
		type: 'object',
		additionalProperties: false,
		required: ['verdict', 'confidence', 'rationale', 'citations'],
		properties: { verdict: { type: 'string', enum: ['bucket', 'clean', 'unsure'] }, ...jsBase },
	},
	credit: {
		type: 'object',
		additionalProperties: false,
		required: ['verdict', 'name', 'confidence', 'rationale', 'citations'],
		properties: { verdict: { type: 'string', enum: ['compound', 'split', 'unsure'] }, name: { type: ['string', 'null'], maxLength: 200, description: 'compound only: the one act, as the credit should read.' }, ...jsBase },
	},
	label_pages: {
		type: 'object',
		additionalProperties: false,
		required: ['candidates', 'confidence', 'rationale', 'citations'],
		properties: {
			candidates: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['review', 'candidate', 'verdict'],
					properties: { review: { type: 'integer' }, candidate: { type: 'integer' }, verdict: { type: 'string', enum: ['attach', 'not_same', 'unsure'] } },
				},
			},
			...jsBase,
		},
	},
};

export function parseVerdict<K extends AgentCaseKind>(kind: K, raw: unknown): Verdict<K> {
	// A strict tool sends `null` where zod expects an absent optional.
	const cleaned = raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== null)) : raw;
	return VERDICT[kind].parse(cleaned) as Verdict<K>;
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────

export type AgentCase = {
	id: number;
	kind: AgentCaseKind;
	subjects: string[];
	input: Record<string, unknown>;
	status: AgentCaseStatus;
	attempts: number;
	lastError: string | null;
	verdict: unknown;
	confidence: number | null;
	model: string | null;
	promptHash: string | null;
	usage: Record<string, unknown> | null;
	costUsd: number | null;
	inboxId: number | null;
	createdAt: number;
	decidedAt: number | null;
	nextDueAt: number;
};

type Row = {
	id: unknown; kind: AgentCaseKind; subjects: string; input: string; status: AgentCaseStatus; attempts: unknown; last_error: string | null;
	verdict: string | null; confidence: unknown; model: string | null; prompt_hash: string | null; usage: string | null; cost_usd: unknown; inbox_id: unknown;
	created_ms: unknown; decided_ms: unknown; due_ms: unknown;
};
const COLUMNS = `id, kind, subjects::text as subjects, input::text as input, status, attempts, last_error, verdict::text as verdict, confidence, model, prompt_hash, usage::text as usage, cost_usd, inbox_id,
	extract(epoch from created_at) * 1000 as created_ms, extract(epoch from decided_at) * 1000 as decided_ms, extract(epoch from next_due_at) * 1000 as due_ms`;
const uuids = (s: string): string[] => (s === '{}' ? [] : s.slice(1, -1).split(','));
const toCase = (r: Row): AgentCase => ({
	id: num(r.id),
	kind: r.kind,
	subjects: uuids(r.subjects),
	input: JSON.parse(r.input) as Record<string, unknown>,
	status: r.status,
	attempts: num(r.attempts),
	lastError: r.last_error,
	verdict: r.verdict === null ? null : (JSON.parse(r.verdict) as unknown),
	confidence: numOrNull(r.confidence),
	model: r.model,
	promptHash: r.prompt_hash,
	usage: r.usage === null ? null : (JSON.parse(r.usage) as Record<string, unknown>),
	costUsd: numOrNull(r.cost_usd),
	inboxId: numOrNull(r.inbox_id),
	createdAt: num(r.created_ms),
	decidedAt: numOrNull(r.decided_ms),
	nextDueAt: num(r.due_ms),
});

// Queues a case; null when the same question is already live (queued, leased
// or decided), or when a subject was merged away (a merged id's pack would be
// its keeper's, read twice). `key` is what makes two cases the same question
// beyond their subjects (the pairs, the source id); absent, the subjects
// alone do.
export async function enqueueCase<K extends AgentCaseKind>(tx: Queryable, c: { kind: K; subjects: string[]; input: CaseInput[K]; key?: string }): Promise<number | null> {
	const merged = await tx.query(`select 1 from curator.catalog_object where id = any($1::uuid[]) and merged_into is not null limit 1`, [`{${c.subjects.join(',')}}`]);
	if (merged.length) return null;
	// A twin pair already before the operator (an open or snoozed inbox item
	// that would merge it, the reasoner's own proposals included) or before
	// the reasoner (a live case) is not asked again, whichever way round it is
	// listed. 2026-11-03: a decided case is `proposed`, outside the digest's
	// live set, and snoozing hid the worker's item from the detectors, so the
	// same seven pairs were asked every pass, up to nine times each.
	if (c.kind === 'release_twin' || c.kind === 'artist_twin') {
		const input = c.input as ReleaseTwinInput | ArtistTwinInput;
		const pending = await pendingPairs(tx);
		const fresh = input.pairs.filter((p) => !pending.has(pairKey(p)));
		if (!fresh.length) return null;
		if (fresh.length < input.pairs.length) {
			input.pairs = fresh;
			c.subjects = [...new Set(fresh.flatMap((p) => [p.keep, p.fold]))];
		}
	}
	const digest = createHash('sha256').update(`${c.kind}|${[...c.subjects].sort().join(',')}|${c.key ?? ''}`).digest('hex').slice(0, 40);
	const [row] = await tx.query<{ id: unknown }>(
		`insert into curator.catalog_agent_case (kind, subjects, input, digest) values ($1, $2::uuid[], $3::text::jsonb, $4)
		on conflict (digest) where status in ('queued', 'leased', 'decided') do nothing returning id`,
		[c.kind, `{${c.subjects.join(',')}}`, JSON.stringify(c.input), digest],
	);
	return row ? num(row.id) : null;
}

const pairKey = (p: { keep: string; fold: string }) => [p.keep, p.fold].sort().join('|');

async function pendingPairs(tx: Queryable): Promise<Set<string>> {
	const rows = await tx.query<{ pairs: string | null }>(
		`select apply->'args'->'pairs' as pairs from curator.catalog_inbox where status = 'open' and apply->>'op' in ('mergeReleases', 'mergeArtists')
		union all
		select input->'pairs' from curator.catalog_agent_case where kind in ('release_twin', 'artist_twin') and status in ('queued', 'leased', 'decided')`,
	);
	const out = new Set<string>();
	for (const r of rows) {
		const pairs = (typeof r.pairs === 'string' ? JSON.parse(r.pairs) : r.pairs) as { keep: string; fold: string }[] | null;
		for (const p of pairs ?? []) out.add(pairKey(p));
	}
	return out;
}

export async function getCase(tx: Queryable, id: number): Promise<AgentCase | null> {
	const [r] = await tx.query<Row>(`select ${COLUMNS} from curator.catalog_agent_case where id = $1::bigint`, [String(id)]);
	return r ? toCase(r) : null;
}

export async function listCases(tx: Queryable, opts: { status?: AgentCaseStatus | 'live'; kind?: AgentCaseKind; limit?: number } = {}): Promise<AgentCase[]> {
	const status = opts.status === 'live' ? ['queued', 'leased', 'decided'] : opts.status ? [opts.status] : null;
	const rows = await tx.query<Row>(
		`select ${COLUMNS} from curator.catalog_agent_case
		where ($1::text[] is null or status = any($1::text[])) and ($2::text is null or kind = $2)
		order by coalesce(decided_at, created_at) desc, id desc limit $3::int`,
		[status ? `{${status.join(',')}}` : null, opts.kind ?? null, String(opts.limit ?? 50)],
	);
	return rows.map(toCase);
}

export async function caseCounts(tx: Queryable): Promise<Record<string, number>> {
	const rows = await tx.query<{ status: string; n: unknown }>(`select status, count(*) as n from curator.catalog_agent_case group by status`);
	return Object.fromEntries(rows.map((r) => [r.status, num(r.n)]));
}

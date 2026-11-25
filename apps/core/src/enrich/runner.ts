// Enrichment runner core. `enrichOne` runs applicable enrichers over a single
// target, in priority order, as a primary+fallback chain: the first enricher to
// fill a field owns it, later ones only fill the gaps (fillGaps), and once every
// core field is set the remaining fallbacks are skipped (isComplete). It's the
// one piece both the library batch
// (sync/spotify.ts) and the feed drain (feed/enrichment.ts) share — the
// orchestration around it (where targets come from, how results persist)
// differs per use-case and lives in the caller + its sink.
//
// `pacingMs` enforces politeness AFTER each enricher network call (Beatport
// Cloudflare-blocks aggressive scrapers). The feed paces at ~1.5s; the library
// batch at ~350ms — both are properties of the caller, passed through here so
// the delay lands between the actual lookups rather than around them.

import type { DjMetadataPatch, Enricher, EnricherOutcome, EnrichmentResult, EnrichmentTarget } from '@curator/sync-core/enrich/contract';
import { log } from '@curator/sync-core/log';

const elog = log.for('enrich');

export interface EnrichOptions {
	signal?: AbortSignal;
	pacingMs?: number;
}

// The DJ-metadata fields a fallback chain is trying to fill. releaseDate is
// excluded on purpose: some providers (Traxsource) can't supply it, so
// requiring it would never let the chain short-circuit.
const CORE_FIELDS: (keyof DjMetadataPatch)[] = ['bpm', 'keyCamelot', 'genre', 'label'];

function isComplete(patch: DjMetadataPatch | null): boolean {
	return !!patch && CORE_FIELDS.every((f) => patch[f] != null);
}

// Gap-fill: the first enricher to produce a non-null value for a field owns it;
// later (fallback) enrichers only fill what's still missing, and never overwrite
// a value with null. This is what makes [primary, …fallbacks] ordering work.
function fillGaps(base: DjMetadataPatch | null, next: DjMetadataPatch): DjMetadataPatch {
	const out: DjMetadataPatch = { ...(base ?? {}) };
	for (const [k, v] of Object.entries(next) as [keyof DjMetadataPatch, DjMetadataPatch[keyof DjMetadataPatch]][]) {
		if (v == null) continue;
		if (out[k] == null) out[k] = v as never;
	}
	return out;
}

export async function enrichOne(
	target: EnrichmentTarget,
	enrichers: readonly Enricher[],
	opts: EnrichOptions = {},
): Promise<EnrichmentResult> {
	let patch: EnrichmentResult['patch'] = null;
	const sourceLinks: EnrichmentResult['sourceLinks'] = [];
	let errored = false;
	let deferredUntil: number | null = null;
	const asked: string[] = [];
	const outcomes: EnricherOutcome[] = [];
	// A store sat out before anything was found: what the fallbacks fill is
	// theirs alone, and the primary still has to be asked (Traxsource files
	// Organic House as "Electronica"; its BPMs and keys differ too).
	let primarySatOut = false;
	// A store that sat this lookup out because it's blocking us (cooling down
	// before the call, or blocked during it — a lane can also turn it away
	// while queued) may well have the track: remember when it reopens.
	const noteBlocked = (enricher: Enricher): number | null => {
		const until = enricher.blockedUntil?.() ?? null;
		if (until == null || until <= Date.now()) return null;
		deferredUntil = deferredUntil == null ? until : Math.min(deferredUntil, until);
		return until;
	};
	const blocked = (enricher: Enricher, until: number): EnricherOutcome => {
		const reason = enricher.blockedReason?.() ?? null;
		return { enricher: enricher.id, result: 'blocked', until, ...(reason ? { detail: reason } : {}) };
	};

	for (const enricher of enrichers) {
		if (opts.signal?.aborted) break;
		// Every core field already filled by a higher-priority enricher — the
		// remaining fallbacks have nothing to add, so skip their network calls.
		if (isComplete(patch)) break;
		if (!enricher.applicableTo(target)) {
			const until = noteBlocked(enricher);
			if (until != null) {
				outcomes.push(blocked(enricher, until));
				if (!patch) primarySatOut = true;
			}
			continue;
		}

		let outcome: EnricherOutcome;
		try {
			const out = await enricher.enrich(target, opts.signal);
			// A lane hands back null without asking when the store blocked us
			// while the lookup queued — that's not an answer.
			const answered = !!out || !enricher.blockedUntil?.();
			if (answered) asked.push(enricher.id);
			if (out?.kind === 'metadata') {
				patch = fillGaps(patch, out.patch);
				if (out.sourceLink) sourceLinks.push(out.sourceLink);
			}
			// 'analysis' outputs carry no metadata patch — the analyzer queue
			// persists track_analysis rows + peaks itself. enrichOne drives only
			// metadata enrichers; the analysis enricher runs via its own queue.
			outcome = { enricher: enricher.id, result: out ? 'hit' : answered ? 'miss' : 'blocked' };
		} catch (err) {
			// One flaky enricher must not abort the rest — log and move on. Record
			// that a lookup failed so the caller can distinguish a transient error
			// (retry) from a clean no-match (don't), rather than seeing both as a
			// null patch.
			errored = true;
			elog.warn('enricher failed', { enricher: enricher.id }, err);
			outcome = { enricher: enricher.id, result: 'error', detail: err instanceof Error ? err.message : String(err) };
		}
		const until = noteBlocked(enricher);
		if (until != null && outcome.result !== 'hit') outcome = outcome.result === 'blocked' ? blocked(enricher, until) : { ...outcome, until };
		// Blocked or failed into a block: it never answered, so a retry asks it.
		if (until != null && !patch && (outcome.result === 'blocked' || outcome.result === 'error')) primarySatOut = true;
		outcomes.push(outcome);

		if (opts.pacingMs) await new Promise((r) => setTimeout(r, opts.pacingMs));
	}

	const provisional = primarySatOut && !!patch;
	return {
		patch, sourceLinks, errored,
		deferredUntil: isComplete(patch) && !primarySatOut ? null : deferredUntil,
		asked, outcomes,
		...(provisional ? { provisional } : {}),
	};
}

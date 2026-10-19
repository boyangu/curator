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

import type { DjMetadataPatch, Enricher, EnrichmentResult, EnrichmentTarget } from './contract.js';
import { log } from '../log.js';

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

	for (const enricher of enrichers) {
		if (opts.signal?.aborted) break;
		// Every core field already filled by a higher-priority enricher — the
		// remaining fallbacks have nothing to add, so skip their network calls.
		if (isComplete(patch)) break;
		if (!enricher.applicableTo(target)) continue;

		try {
			const out = await enricher.enrich(target, opts.signal);
			if (out?.kind === 'metadata') {
				patch = fillGaps(patch, out.patch);
				if (out.sourceLink) sourceLinks.push(out.sourceLink);
			}
			// 'analysis' outputs carry no metadata patch — the analyzer queue
			// persists track_analysis rows + peaks itself. enrichOne drives only
			// metadata enrichers; the analysis enricher runs via its own queue.
		} catch (err) {
			// One flaky enricher must not abort the rest — log and move on. Record
			// that a lookup failed so the caller can distinguish a transient error
			// (retry) from a clean no-match (don't), rather than seeing both as a
			// null patch.
			errored = true;
			elog.warn('enricher failed', { enricher: enricher.id }, err);
		}

		if (opts.pacingMs) await new Promise((r) => setTimeout(r, opts.pacingMs));
	}

	return { patch, sourceLinks, errored };
}

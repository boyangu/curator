// Traxsource enricher — the fallback behind BeatportEnricher for tracks
// Beatport's catalog misses. Same contract; the runner (enrichOne) keeps
// Beatport authoritative and lets this one fill the gaps (genre/label/bpm/key)
// or carry a track Beatport never matched. Traxsource exposes no ISRC or
// release date on the accessible search page (see @curator/traxsource), so
// matching leans on the title + artist + duration rule.

import { TraxsourceClient, type FetchLike as TraxsourceFetch } from '@curator/traxsource';
import type { Enricher, EnricherOutput, EnrichmentTarget } from '../contract.js';
import { keyToCamelot } from '../keys.js';

export class TraxsourceEnricher implements Enricher {
	readonly id = 'traxsource';
	readonly produces = 'metadata' as const;
	private readonly client: TraxsourceClient;

	constructor(fetchImpl?: TraxsourceFetch) {
		this.client = new TraxsourceClient(fetchImpl ? { fetchImpl } : {});
	}

	// Skip while cooling down from a Cloudflare block (see BeatportEnricher).
	applicableTo(target: EnrichmentTarget): boolean {
		return !!target.query.title && !!target.query.artists?.[0] && !this.client.isCoolingDown();
	}

	async enrich(target: EnrichmentTarget): Promise<EnricherOutput | null> {
		const q = target.query;
		const tx = await this.client.lookup({
			title: q.title,
			artists: q.artists,
			duration: q.durationSec ?? null,
			isrc: q.isrc ?? null,
		});
		if (!tx) return null;
		return {
			kind: 'metadata',
			patch: {
				bpm: tx.bpm,
				// Traxsource prints musical notation ("D#min"); keyToCamelot
				// handles the spelled-out quality. The raw value rides on
				// source_link.keyLocal.
				keyCamelot: keyToCamelot(tx.key),
				genre: tx.genre,
				// Don't blank an existing label on a miss.
				label: tx.label ?? q.label ?? null,
				releaseDate: tx.release_date,
			},
			sourceLink: {
				source: 'traxsource',
				sourceTrackId: String(tx.id),
				url: tx.url,
				isrc: tx.isrc,
				title: tx.title,
				artists: tx.artists,
				duration: tx.duration,
				bpm: tx.bpm,
				key: tx.key,
				payload: tx,
			},
		};
	}
}

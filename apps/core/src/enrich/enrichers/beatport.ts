// Beatport enricher — the single canonical one, shared by the library batch
// and the feed drain (previously duplicated as sync/spotify.ts's inline lookup
// and feed/enrichment.ts's BeatportFeedEnricher). Streaming sources carry no
// DJ metadata; Beatport's catalog fills in label / genre / BPM / key, matched
// by the ISRC-aware scorer inside BeatportClient.lookup.

import { BeatportClient, type FetchLike as BeatportFetch } from '@curator/beatport';
import type { Enricher, EnricherOutput, EnrichmentTarget } from '../contract.js';
import { keyToCamelot } from '../keys.js';

export class BeatportEnricher implements Enricher {
	readonly id = 'beatport';
	readonly produces = 'metadata' as const;
	private readonly client: BeatportClient;

	constructor(fetchImpl?: BeatportFetch) {
		this.client = new BeatportClient(fetchImpl ? { fetchImpl } : {});
	}

	// Needs only a title + a credited artist — the scorer does the rest.
	// While the client is cooling down from a Cloudflare block, report
	// not-applicable so the runner skips Beatport (no network, no per-track
	// error) and the Traxsource fallback carries the batch until it recovers.
	applicableTo(target: EnrichmentTarget): boolean {
		return !!target.query.title && !!target.query.artists?.[0] && !this.client.isCoolingDown();
	}

	async enrich(target: EnrichmentTarget): Promise<EnricherOutput | null> {
		const q = target.query;
		const bp = await this.client.lookup({
			title: q.title,
			artists: q.artists,
			duration: q.durationSec ?? null,
			isrc: q.isrc ?? null,
		});
		if (!bp) return null;
		return {
			kind: 'metadata',
			patch: {
				bpm: bp.bpm,
				// Beatport reports musical notation ("Am"); convert to canonical
				// Camelot at the boundary. Unmappable → null (we don't persist
				// raw musical strings). The raw value is kept on source_link.keyLocal.
				keyCamelot: keyToCamelot(bp.key),
				genre: bp.genre,
				// Beatport's label is the source of truth, but don't blank an
				// existing one on a miss — preserve the query's label.
				label: bp.label ?? q.label ?? null,
				releaseDate: bp.release_date,
			},
			sourceLink: {
				source: 'beatport',
				sourceTrackId: String(bp.id),
				url: bp.url,
				isrc: bp.isrc,
				title: bp.title,
				artists: bp.artists,
				duration: bp.duration,
				bpm: bp.bpm,
				key: bp.key,
				payload: bp,
			},
		};
	}
}

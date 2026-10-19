// Enrichment contract — the relocatable boundary shared by every use-case
// (library, feed, future non-feed discover). See planning/tech/cloud-
// architecture.md. The shape mirrors the feed's original FeedEnricher, lifted
// out so the SAME enricher (Beatport today, Discogs/MusicBrainz later) and the
// SAME runner serve every sink.
//
// Two seams:
//   - Enricher  — a provider: query in, patch out. Stateless; cloud-movable
//                 when its inputs are Plane-A data (title/artist/ISRC). The
//                 (future) analysis enricher is Plane-B — it needs the local
//                 audio bytes, so applicableTo() gates it to local targets.
//   - Sink      — per-use-case persistence. LibrarySink writes curator.db
//                 (track fields + source_link); the feed merges into its
//                 payload. The sink is the only place a DB schema is touched.

// DJ metadata an enricher fills. The same field names live on FeedItemPayload /
// FeedTrackRef and curator.db `track`, so one patch merges into any sink.
export interface DjMetadataPatch {
	bpm?: number | null;
	keyCamelot?: string | null;
	genre?: string | null;
	label?: string | null;
	// Track release date (ISO string). Beatport carries a track/release-level
	// date that's more accurate than Spotify's album date, so this is an
	// enricher-wins field at the sink (overrides the sync-seeded value).
	releaseDate?: string | null;
}

// One track to enrich. `label` carries the existing label so an enricher can
// preserve it on a miss rather than blanking it. `durationSec` aids the
// matcher's duration tie-break.
export interface TrackQuery {
	title: string;
	artists: string[];
	durationSec?: number | null;
	isrc?: string | null;
	label?: string | null;
}

// The source-specific catalog identity an enricher matched (e.g. a Beatport
// track id + url + raw payload). The LibrarySink persists this as a
// `source_link` row so later dedupe/refresh can find it; the feed ignores it
// (feed items reference remote content by source ids only — no source_link).
export interface SourceLinkDraft {
	source: string;
	sourceTrackId: string;
	url?: string | null;
	isrc?: string | null;
	title?: string | null;
	artists?: string[] | null;
	duration?: number | null;
	bpm?: number | null;
	key?: string | null;
	payload?: unknown;
}

// What enrichment runs against. `id` is the canonical entity id (the library
// trackId) when there is one — metadata enrichers ignore it; the analysis
// enricher needs it to enqueue a job. `localAudio` resolves a playable local
// path; it's undefined for remote-only targets (feed items), which is exactly
// how the analysis enricher knows it can't act on them (Plane B).
export interface EnrichmentTarget {
	id?: string;
	query: TrackQuery;
	localAudio?: () => Promise<string | null>;
}

// One enricher's output. `metadata` carries a patch (+ optional source link);
// `analysis` reports that the local-analysis enricher (Plane B) ran for a
// track — the analyzer queue persists the track_analysis rows + peaks itself,
// so there's nothing for a sink to write, just the fact that it completed.
export type EnricherOutput =
	| { kind: 'metadata'; patch: DjMetadataPatch; sourceLink?: SourceLinkDraft }
	| { kind: 'analysis'; trackId: string };

// A provider plugin. Registered enrichers run in priority order as a
// primary+fallback chain: the first to fill a field wins it, later ones only
// fill gaps, and the chain stops once every core field is set (see
// runner.enrichOne).
export interface Enricher {
	readonly id: string;
	readonly produces: 'metadata' | 'analysis';
	// Can this enricher act on this target? Metadata enrichers need only a
	// title + artist; an analysis enricher additionally needs localAudio.
	applicableTo(target: EnrichmentTarget): boolean;
	enrich(target: EnrichmentTarget, signal?: AbortSignal): Promise<EnricherOutput | null>;
}

// The aggregate of every enricher over one target — what a sink persists.
// `patch` is null when nothing matched (no enricher produced metadata).
// `errored` is true when at least one *applicable* enricher threw (network /
// WAF / parse) during this run — it lets a caller tell a clean no-match
// (nothing on Beatport) apart from a failed lookup it should retry later,
// instead of collapsing both into a null patch. A run can both error AND
// produce a partial patch (one enricher threw, a fallback filled some fields).
export interface EnrichmentResult {
	patch: DjMetadataPatch | null;
	sourceLinks: SourceLinkDraft[];
	errored: boolean;
}

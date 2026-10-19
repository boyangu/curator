// Feed enrichment — background pass that runs every registered FeedEnricher
// over produced items exactly once. Kicked after each producer poll/backfill;
// processes the worklist sequentially with a politeness delay (Beatport
// cloudflare-blocks aggressive scrapers — same constraint as the library
// enricher in sync/spotify.ts).
//
// Enrichment is per-track: a track item is one lookup; an album item is one
// lookup per resolved track (the album-expander stage fills payload.tracks
// before items reach the bus). It stays POST-bus and async so a deep backfill
// can't block the feed from populating behind Beatport's 1.5s/track pace.

import type { DjMetadataPatch, Enricher, SourceLinkDraft, TrackQuery } from '../enrich/contract.js';
import { enrichOne } from '../enrich/runner.js';
import type { EnrichStatus, FeedItem, FeedItemPayload, FeedTrackRef } from './types.js';
import type { FeedStore } from './store.js';
import { log } from '../log.js';

const flog = log.for('feed');

const DELAY_MS = 1500;
const BATCH_SIZE = 20;

// A track ref already carries DJ metadata (e.g. a legacy row enriched before
// per-track status existed) — treat it as settled so the album drain doesn't
// re-scrape it.
function refHasMetadata(r: FeedTrackRef): boolean {
	return r.bpm != null || r.keyCamelot != null || r.genre != null || r.label != null;
}

// Most frequent non-empty value (ties → first seen). Used to collapse per-track
// genre/label into one album-level value.
function modeOf(values: (string | null | undefined)[]): string | null {
	const counts = new Map<string, number>();
	for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best: string | null = null;
	let bestN = 0;
	for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
	return best;
}

export class FeedEnrichmentQueue {
	private running = false;
	private stopped = false;

	constructor(
		private readonly store: FeedStore,
		private readonly enrichers: Enricher[],
		// Politeness delay after each Beatport lookup (WAF). Injectable only so
		// tests can run at 0; production always uses the 1.5s default.
		private readonly pacingMs: number = DELAY_MS,
		// Fired after each item is enriched + persisted (background drain AND the
		// on-view path). Lets the desktop push a live update so a card's freshly
		// landed genre/label/bpm chips appear without a manual refresh. Best-
		// effort — a throwing listener must not derail the drain.
		private readonly onEnriched?: (item: FeedItem) => void,
	) {}

	// Start (or continue) draining the unenriched worklist. Idempotent —
	// overlapping kicks while a drain is running are no-ops; the drain
	// re-queries the store until it comes back empty.
	kick(): void {
		if (this.running || this.stopped || this.enrichers.length === 0) return;
		this.running = true;
		void this.drain().finally(() => { this.running = false; });
	}

	stop(): void {
		this.stopped = true;
	}

	// On-demand enrichment of one item — the "user is viewing this card" path
	// (getItemDetail for an expanded album). Idempotent: an already-stamped item
	// is returned untouched, so a re-expand spends no Beatport calls. Awaited and
	// returns the updated item so the caller hands fresh metadata straight back to
	// the renderer instead of waiting on the background drain to reach it.
	//
	// Safe to call per-viewed-item because it's one item at a time (user-paced) —
	// unlike fanning a lookup out across every visible card, which would fire
	// concurrent scrapes and trip Beatport's Cloudflare WAF.
	async enrichItem(itemId: string): Promise<FeedItem | null> {
		const item = await this.store.getItem(itemId);
		if (!item) return null;
		// 'ok'/'na' are terminal — don't re-spend Beatport calls. A prior 'err'
		// (or a never-attempted item) falls through to a fresh attempt, so the
		// on-view / promote paths retry an item the background drain failed on.
		if (item.enrichStatus === 'ok' || item.enrichStatus === 'na') {
			// Already settled — but rows enriched before album-level genre/label
			// existed have only per-track values. Backfill the album-level fields
			// from the existing track refs (pure derivation, no Beatport calls) so
			// old albums light up their card chips without a re-scrape.
			if (item.type === 'album' && this.applyAlbumGenreLabel(item)) {
				await this.store.setPayload(item.id, item.payload);
			}
			return item;
		}
		if (this.enrichers.length === 0) return item;
		return this.runOne(item);
	}

	private async drain(): Promise<void> {
		for (;;) {
			if (this.stopped) return;
			const items = await this.store.listUnenriched(BATCH_SIZE);
			if (items.length === 0) return;
			for (const item of items) {
				if (this.stopped) return;
				await this.runOne(item);
			}
		}
	}

	// Enrich + persist one item, returning the updated item. Shared by the
	// background drain and the on-view enrichItem path so both produce identical
	// results. Each attempt records an outcome status: 'ok' (metadata landed),
	// 'na' (clean miss — terminal), or 'err' (a lookup threw — the drain retries
	// it next pass instead of stranding it like the old "stamp on any outcome").
	private async runOne(item: FeedItem): Promise<FeedItem> {
		try {
			const { payload, status } = item.type === 'album'
				? await this.enrichAlbumPayload(item)
				: await this.enrichTrackPayload(item);
			await this.store.markEnriched(item.id, status, payload ?? undefined);
			const updated = { ...item, payload: payload ?? item.payload, enrichStatus: status, enrichedAt: Date.now() };
			try { this.onEnriched?.(updated); } catch (err) { flog.warn('onEnriched listener threw', undefined, err); }
			return updated;
		} catch (err) {
			// A throw HERE is outside enrichOne's per-enricher try (a store/payload
			// bug, not a Beatport miss). Record it as retryable 'err' so the next
			// drain re-attempts rather than marking it done-empty forever.
			flog.warn('enrichment failed', { itemId: item.id }, err);
			await this.store.markEnriched(item.id, 'err');
			return { ...item, enrichStatus: 'err', enrichedAt: Date.now() };
		}
	}

	// Track item → one lookup. Returns the merged payload + outcome status: a
	// hit yields the patched payload + 'ok'; a miss yields no payload change and
	// 'na' (clean no-match) or 'err' (the lookup threw — retryable).
	private async enrichTrackPayload(item: FeedItem): Promise<{ payload: FeedItemPayload | null; status: EnrichStatus }> {
		const { patch, sourceLinks, errored } = await this.lookup({
			title: item.payload.title,
			artists: item.payload.artists,
			durationSec: item.payload.durationSec ?? null,
			isrc: item.payload.isrc ?? null,
			label: item.payload.label ?? null,
		});
		if (patch) return { payload: { ...item.payload, ...patch, sourceLinks }, status: 'ok' };
		return { payload: null, status: errored ? 'err' : 'na' };
	}

	// Album item → one lookup per resolved track, patched in place, each ref
	// stamped with its own enrichStatus (drives the row's N/A / ERR marker),
	// plus the album-level genre/label derived from the tracks (a release
	// carries one label and one (sub)genre, so the modal track value is the
	// album's). Refs already settled ('ok'/'na', or legacy refs that already
	// carry metadata) are skipped — no re-scrape. Albums the expander couldn't
	// resolve (no tracks) are filtered out by listUnenriched, so they get
	// enriched once their tracks land — or on first expand via enrichItem.
	//
	// The aggregate status is 'err' when any ref still needs work (a ref errored,
	// or the drain stopped mid-loop leaving refs unattempted) so the album is
	// re-picked by listUnenriched and only the unsettled refs retry; else 'ok'
	// ('na' refs are a settled per-row state, not an album-level failure).
	private async enrichAlbumPayload(item: FeedItem): Promise<{ payload: FeedItemPayload | null; status: EnrichStatus }> {
		const tracks = item.payload.tracks ?? [];
		let changed = false;
		for (const ref of tracks) {
			if (this.stopped) break;
			if (ref.enrichStatus === 'ok' || ref.enrichStatus === 'na') continue;
			if (!ref.enrichStatus && refHasMetadata(ref)) { ref.enrichStatus = 'ok'; changed = true; continue; }
			const { patch, sourceLinks, errored } = await this.lookup({
				title: ref.title,
				artists: ref.artists,
				durationSec: ref.durationSec,
				isrc: ref.isrc ?? null,
				label: ref.label ?? null,
			});
			if (patch) {
				Object.assign(ref, patch);
				ref.sourceLinks = sourceLinks;
				ref.enrichStatus = 'ok';
			} else {
				ref.enrichStatus = errored ? 'err' : 'na';
			}
			changed = true;
		}
		if (this.applyAlbumGenreLabel(item)) changed = true;
		const unfinished = tracks.some((r) => r.enrichStatus !== 'ok' && r.enrichStatus !== 'na');
		const status: EnrichStatus = unfinished ? 'err' : 'ok';
		return { payload: changed ? item.payload : null, status };
	}

	// Set the album-level genre/label from the track refs' modal values (a
	// release carries one label and one (sub)genre). Pure, no network. Returns
	// true when it changed the payload. Don't blank an existing value on a miss —
	// only set when the tracks actually surfaced one.
	private applyAlbumGenreLabel(item: FeedItem): boolean {
		const tracks = item.payload.tracks ?? [];
		const genre = modeOf(tracks.map((t) => t.genre));
		const label = modeOf(tracks.map((t) => t.label));
		let changed = false;
		if (genre && genre !== item.payload.genre) { item.payload.genre = genre; changed = true; }
		if (label && label !== item.payload.label) { item.payload.label = label; changed = true; }
		return changed;
	}

	// Run every enricher over one track query, merging patches (later wins),
	// pacing 1.5s after each lookup (Beatport politeness). Returns the full
	// EnrichmentResult: the merged patch, the matched `sourceLinks` (catalog
	// identity — carried onto the payload/ref so promotion can persist a
	// source_link identical to a direct library enrich), and whether a lookup
	// errored (tells a clean miss apart from a failure the caller should retry).
	private async lookup(q: TrackQuery): Promise<{ patch: DjMetadataPatch | null; sourceLinks: SourceLinkDraft[]; errored: boolean }> {
		const { patch, sourceLinks, errored } = await enrichOne({ query: q }, this.enrichers, { pacingMs: this.pacingMs });
		return { patch, sourceLinks, errored };
	}
}

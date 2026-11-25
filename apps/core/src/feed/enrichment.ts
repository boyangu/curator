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

import type { DjMetadataPatch, Enricher, EnrichmentResult, SourceLinkDraft, TrackQuery } from '@curator/sync-core/enrich/contract';
import { enrichOne } from '../enrich/runner.js';
import type { EnrichStatus, FeedEnrichReport, FeedItem, FeedItemActivity, FeedItemPayload, FeedTrackRef } from '@curator/sync-core/feed/types';
import type { FeedStore } from '@curator/sync-core/feed/store';
import { log } from '@curator/sync-core/log';

const flog = log.for('feed');

const DELAY_MS = 1500;
const BATCH_SIZE = 20;

interface LookupOutcome {
	payload: FeedItemPayload | null;
	status: EnrichStatus;
	deferredUntil?: number | null;
}

// A track ref already carries DJ metadata (e.g. a legacy row enriched before
// per-track status existed) — treat it as settled so the album drain doesn't
// re-scrape it.
function refHasMetadata(r: FeedTrackRef): boolean {
	return r.bpm != null || r.keyCamelot != null || r.genre != null || r.label != null;
}

// The DJ facts a lookup would add are all there already (a catalogue card
// that carried Beatport's BPM, key and genre): no lookup. A catalogue ref's
// genre/label can be the release's, so they alone don't settle it.
function hasDjFacts(r: Pick<FeedTrackRef, 'bpm' | 'keyCamelot' | 'genre'>): boolean {
	return r.bpm != null && !!r.keyCamelot && !!r.genre;
}

// Catalogue first, enrichment fills gaps (2026-11-04): a lookup only sets
// what is still empty, so the catalogue's facts — and anything the user
// already saw on the card — are never replaced by a scrape. Returns the
// fields it set.
function fillOnly<T extends object>(target: T, patch: DjMetadataPatch): string[] {
	const set: string[] = [];
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined || v === null || v === '') continue;
		const cur = (target as Record<string, unknown>)[k];
		if (cur !== undefined && cur !== null && cur !== '') continue;
		(target as Record<string, unknown>)[k] = v;
		set.push(k);
	}
	return set;
}

// A lookup's patch onto a track: fill-only, except over the values an earlier
// attempt marked provisional — a fallback's, filled while Beatport was blocking
// us — which a non-provisional answer replaces. What a provisional answer
// fills is marked in turn; once the track settles nothing is.
function applyLookup<T extends { enrichProvisional?: string[] }>(target: T, res: EnrichmentResult): void {
	const prov = new Set(target.enrichProvisional ?? []);
	if (res.patch) {
		if (!res.provisional) {
			for (const k of [...prov]) {
				const v = (res.patch as Record<string, unknown>)[k];
				if (v === undefined || v === null || v === '') continue;
				(target as Record<string, unknown>)[k] = v;
				prov.delete(k);
			}
		}
		const filled = fillOnly(target, res.patch);
		if (res.provisional) for (const k of filled) prov.add(k);
	}
	if (res.deferredUntil == null || prov.size === 0) delete target.enrichProvisional;
	else target.enrichProvisional = [...prov];
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

// Slack after a store's block window before the re-kick, so the probe lands
// past the cooldown rather than on its edge.
const WAKE_SLACK_MS = 5_000;

export class FeedEnrichmentQueue {
	private running = false;
	private stopped = false;
	// Items a lookup couldn't settle because a store was blocking us, parked
	// until it reopens (itemId → when). The drain skips them and wakes itself
	// at the earliest release; a producer's kick in between leaves them be.
	// In memory: after a restart they're retried once, which costs one probe
	// of the store and parks them again.
	private readonly parked = new Map<string, number>();
	private wake: ReturnType<typeof setTimeout> | null = null;

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
		// Fired when an item's enrichment starts and ends (background drain AND
		// on-view), so a card on screen can say "Enriching…" meanwhile.
		private readonly onActivity?: (a: FeedItemActivity) => void,
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
		if (this.wake) clearTimeout(this.wake);
		this.wake = null;
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
		// Parked behind a blocked store — asking now would only reach the
		// fallback again; the wake retries it once the store reopens.
		if ((this.parked.get(item.id) ?? 0) > Date.now()) return item;
		return this.runOne(item);
	}

	private async drain(): Promise<void> {
		const now = Date.now();
		for (const [id, at] of this.parked) if (at <= now) this.parked.delete(id);
		// Each item at most once per pass: an 'err' row stays on the worklist,
		// and re-listing it straight away would spin on a failing lookup.
		const tried = new Set<string>();
		for (;;) {
			if (this.stopped) return;
			const items = await this.store.listUnenriched(BATCH_SIZE, [...tried, ...this.parked.keys()]);
			if (items.length === 0) break;
			for (const item of items) {
				if (this.stopped) return;
				tried.add(item.id);
				await this.runOne(item);
			}
		}
		this.scheduleWake();
	}

	private scheduleWake(): void {
		if (this.wake) clearTimeout(this.wake);
		this.wake = null;
		if (this.stopped || this.parked.size === 0) return;
		const at = Math.min(...this.parked.values());
		this.wake = setTimeout(() => { this.wake = null; this.kick(); }, Math.max(0, at - Date.now()) + WAKE_SLACK_MS);
		this.wake.unref?.();
		flog.info('enrichment parked behind a blocked store', { items: this.parked.size, until: new Date(at).toISOString() });
	}

	// Enrich + persist one item, returning the updated item. Shared by the
	// background drain and the on-view enrichItem path so both produce identical
	// results. Each attempt records an outcome status: 'ok' (metadata landed),
	// 'na' (clean miss — terminal), or 'err' (a lookup threw — the drain retries
	// it next pass instead of stranding it like the old "stamp on any outcome").
	private async runOne(item: FeedItem): Promise<FeedItem> {
		this.activity(item.id, 'enrich');
		try {
			const { payload, status, deferredUntil } = item.type === 'album'
				? await this.enrichAlbumPayload(item)
				: await this.enrichTrackPayload(item);
			if (deferredUntil != null) this.parked.set(item.id, deferredUntil);
			else this.parked.delete(item.id);
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
		} finally {
			this.activity(item.id, null);
		}
	}

	private activity(itemId: string, activity: FeedItemActivity['activity']): void {
		try { this.onActivity?.({ itemId, activity }); } catch (err) { flog.warn('onActivity listener threw', undefined, err); }
	}

	// Track item → one lookup. Returns the merged payload + outcome status: a
	// hit yields the patched payload + 'ok'; a miss yields no payload change and
	// 'na' (clean no-match) or 'err' (the lookup threw — retryable). A store
	// blocking us while the facts are still incomplete is never 'na': whatever
	// the fallback found is kept, the item stays 'err', and `deferredUntil`
	// says when the blocked store can be asked.
	private async enrichTrackPayload(item: FeedItem): Promise<LookupOutcome> {
		if (hasDjFacts(item.payload) && !item.payload.enrichProvisional?.length) return { payload: null, status: 'ok' };
		const res = await this.lookup({
			title: item.payload.title,
			artists: item.payload.artists,
			durationSec: item.payload.durationSec ?? null,
			isrc: item.payload.isrc ?? null,
			label: item.payload.label ?? null,
		}, item.payload.enrichAsked);
		const retry = !!item.payload.enrichAsked;
		const payload: FeedItemPayload = { ...item.payload };
		report(payload, res);
		if (!res.patch && !retry && res.deferredUntil == null) {
			return { payload, status: res.errored ? 'err' : 'na' };
		}
		if (res.patch) payload.sourceLinks = mergeLinks(item.payload.sourceLinks, res.sourceLinks);
		applyLookup(payload, res);
		carryAsked(payload, res);
		// On a retry, what an earlier attempt's fallback found still counts.
		const found = !!res.patch || (payload.sourceLinks?.length ?? 0) > 0;
		const status: EnrichStatus = res.deferredUntil != null ? 'err' : found ? 'ok' : res.errored ? 'err' : 'na';
		return { payload, status, deferredUntil: res.deferredUntil };
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
	private async enrichAlbumPayload(item: FeedItem): Promise<LookupOutcome> {
		const tracks = item.payload.tracks ?? [];
		let changed = false;
		let deferredUntil: number | null = null;
		for (const ref of tracks) {
			if (this.stopped) break;
			if (ref.enrichStatus === 'ok' || ref.enrichStatus === 'na') continue;
			if (!ref.enrichStatus && (ref.catalogId ? hasDjFacts(ref) : refHasMetadata(ref))) { ref.enrichStatus = 'ok'; changed = true; continue; }
			const res = await this.lookup({
				title: ref.title,
				artists: ref.artists,
				durationSec: ref.durationSec,
				isrc: ref.isrc ?? null,
				label: ref.label ?? null,
			}, ref.enrichAsked);
			if (res.patch) ref.sourceLinks = mergeLinks(ref.sourceLinks, res.sourceLinks);
			applyLookup(ref, res);
			carryAsked(ref, res);
			report(ref, res);
			// Same rule as a track item: blocked-while-incomplete stays 'err'.
			const found = !!res.patch || (ref.sourceLinks?.length ?? 0) > 0;
			ref.enrichStatus = res.deferredUntil != null ? 'err' : found ? 'ok' : res.errored ? 'err' : 'na';
			if (res.deferredUntil != null) deferredUntil = deferredUntil == null ? res.deferredUntil : Math.min(deferredUntil, res.deferredUntil);
			changed = true;
		}
		if (this.applyAlbumGenreLabel(item)) changed = true;
		const unfinished = tracks.some((r) => r.enrichStatus !== 'ok' && r.enrichStatus !== 'na');
		const status: EnrichStatus = unfinished ? 'err' : 'ok';
		return { payload: changed ? item.payload : null, status, deferredUntil };
	}

	// Set the album-level genre/label from the track refs' modal values (a
	// release carries one label and one (sub)genre) when the album has none —
	// a catalogue card's own genre/label stand. One derived from provisional
	// track values is provisional too, and re-derived once Beatport has
	// answered for the tracks. Pure, no network. Returns true when it changed
	// the payload.
	private applyAlbumGenreLabel(item: FeedItem): boolean {
		const p = item.payload;
		const tracks = p.tracks ?? [];
		const prov = new Set(p.enrichProvisional ?? []);
		let changed = false;
		for (const f of ['genre', 'label'] as const) {
			if (p[f] && !prov.has(f)) continue;
			const v = modeOf(tracks.map((t) => t[f]));
			if (!v) continue;
			if (v !== p[f]) { p[f] = v; changed = true; }
			const still = tracks.some((t) => t[f] === v && t.enrichProvisional?.includes(f));
			if (still !== prov.has(f)) { changed = true; if (still) prov.add(f); else prov.delete(f); }
		}
		if (prov.size) p.enrichProvisional = [...prov];
		else delete p.enrichProvisional;
		return changed;
	}

	// Run every enricher over one track query, merging patches (later wins),
	// pacing 1.5s after each lookup (Beatport politeness). Returns the full
	// EnrichmentResult: the merged patch, the matched `sourceLinks` (catalog
	// identity — carried onto the payload/ref so promotion can persist a
	// source_link identical to a direct library enrich), and whether a lookup
	// errored (tells a clean miss apart from a failure the caller should retry).
	//
	// `asked`: stores that already answered this track on an earlier, deferred
	// attempt — skipped, so a retry behind a long block asks only the blocked
	// store instead of re-asking the fallback at every wake.
	private async lookup(q: TrackQuery, asked?: readonly string[]): Promise<EnrichmentResult> {
		const enrichers = asked?.length ? this.enrichers.filter((e) => !asked.includes(e.id)) : this.enrichers;
		return enrichOne({ query: q }, enrichers, { pacingMs: this.pacingMs });
	}
}

// What a deferred track carries into its retry: every store that has answered
// it so far; cleared once the track settles.
function carryAsked(target: { enrichAsked?: string[] }, res: EnrichmentResult): void {
	if (res.deferredUntil == null) {
		delete target.enrichAsked;
		return;
	}
	const all = new Set([...(target.enrichAsked ?? []), ...(res.asked ?? [])]);
	if (all.size) target.enrichAsked = [...all];
}

// What the stores said this attempt, for the marker's tooltip; a store a
// retry skipped (it had answered already) keeps what it said last time.
function report(target: { enrichReport?: FeedEnrichReport }, res: EnrichmentResult): void {
	const now = res.outcomes ?? [];
	const kept = (target.enrichReport?.outcomes ?? []).filter((o) => !now.some((n) => n.enricher === o.enricher));
	target.enrichReport = { at: Date.now(), outcomes: [...kept, ...now] };
}

// A retry's matches join the ones an earlier deferred attempt found (one per
// store, the newer winning).
function mergeLinks(prev: SourceLinkDraft[] | undefined, next: SourceLinkDraft[]): SourceLinkDraft[] {
	const bySource = new Map((prev ?? []).map((l) => [l.source, l]));
	for (const l of next) bySource.set(l.source, l);
	return [...bySource.values()];
}

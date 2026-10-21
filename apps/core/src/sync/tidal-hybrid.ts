// Hybrid matcher — finds Tidal track IDs for tracks already in the Curator
// library (typically from Spotify ingest). The Spotify playlist remains the
// primary; this just adds a `source_link.source='tidal'` row per matched
// track so we can play, link out, or download from Tidal later.
//
// Matching strategy mirrors the tidalext logic — ISRC-first (deterministic,
// no false positives), then title+artist text search. Tidal v2's search
// endpoint doesn't return artist resources at the include level we use,
// so the text-fallback acceptance rule for non-ISRC is title-exact AND
// duration ≤ 5s — strict enough to avoid common false positives without
// the artist signal.

import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { sortColumn } from './sort.js';
import type { ZTrackSortT } from '@curator/shared';
import { randomUUID } from 'node:crypto';
import { track, sourceLink, playlistTrack, playlist, claimLink } from '@curator/shared/schema';
import { TidalApiClient, type TidalTrackV2 } from '@curator/tidal';
import { sharedScorer } from '@curator/matcher';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import type { AuthService } from '../auth/service.js';
import type { ProgressFn } from './spotify.js';
import { addClaims } from '../library/mutators.js';
import { log } from '../log.js';

const hlog = log.for('tidal-hybrid');

export class TidalHybrid {
	private readonly cancelToken?: import('./cancellation.js').CancelToken;
	constructor(
		private readonly db: Db,
		private readonly auth: AuthService,
		opts: { cancelToken?: import('./cancellation.js').CancelToken } = {}
	) {
		this.cancelToken = opts.cancelToken;
	}

	private async buildClient(): Promise<TidalApiClient> {
		const token = await this.auth.getTidalAccessToken();
		if (!token) throw new Error('Tidal not connected');
		const countryCode = this.auth.getTidalCountryCode() ?? 'US';
		return new TidalApiClient(config.tidal.apiBase, async () => token, countryCode);
	}

	// Find a Tidal track for a single Curator track. Idempotent: if a tidal
	// source_link already exists, returns its `sourceTrackId` without re-searching.
	async matchOne(trackId: string, client?: TidalApiClient): Promise<{ tidalId: string } | null> {
		const t = this.db.select().from(track).where(eq(track.id, trackId)).get();
		if (!t) {
			hlog.warn('matchOne: no track row', { trackId });
			return null;
		}
		hlog.debug('matchOne', { title: t.title, isrc: t.isrc ?? null, duration: t.duration });
		const existing = this.db
			.select({ id: sourceLink.sourceTrackId })
			.from(sourceLink)
			.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, 'tidal')))
			.get();
		if (existing) {
			hlog.debug('already linked', { tidalId: existing.id });
			return { tidalId: existing.id };
		}
		// Another device of the account already matched (or ingested) this
		// recording on Tidal: its claim is a derived link here
		// (sync-log/claim-links.ts). That is a match — no search crawl — but
		// it stays derived: writing it as an own source_link would make this
		// device claim a Tidal copy it never verified, and adopt a remote row.
		const derived = this.db
			.select({ id: claimLink.sourceTrackId })
			.from(claimLink)
			.where(and(eq(claimLink.trackId, trackId), eq(claimLink.source, 'tidal')))
			.get();
		if (derived) {
			hlog.debug('already matched by the account', { tidalId: derived.id });
			return { tidalId: derived.id };
		}
		// A remote row (not on this device) is matched by the device that
		// holds it; a link here would adopt it as this device's own (the
		// migrate.ts trigger) on a title search.
		if (t.remoteOnly) {
			hlog.debug('remote row: not matched here', { trackId });
			return null;
		}

		const c = client ?? (await this.buildClient());
		const candidates = await this.findTidalCandidates(t, c);
		if (!candidates.length) {
			hlog.debug('no acceptable match');
			return null;
		}

		// Walk candidates in best-first order; skip any already linked to a
		// different Curator track (the UNIQUE constraint on
		// (source, source_track_id) would throw on insert otherwise — happens
		// when two Curator tracks share an ISRC and the matcher hands both
		// the same top hit). Alternate Tidal ids with the same ISRC are
		// "the same recording" so picking the next free one is correct.
		let pick: TidalTrackV2 | null = null;
		for (const c of candidates) {
			const otherClaim = this.db
				.select({ trackId: sourceLink.trackId })
				.from(sourceLink)
				.where(and(eq(sourceLink.source, 'tidal'), eq(sourceLink.sourceTrackId, String(c.id))))
				.get();
			if (otherClaim && otherClaim.trackId !== t.id) {
				hlog.warn('tidalId already claimed, trying next candidate', { tidalId: c.id, claimedBy: otherClaim.trackId });
				continue;
			}
			pick = c;
			break;
		}
		if (!pick) {
			hlog.info('all candidates already claimed by other Curator tracks — duplicate ingest?');
			return null;
		}
		hlog.debug('matched', { tidalId: pick.id, title: pick.title, isrc: pick.isrc ?? null, duration: pick.duration });

		this.db
			.insert(sourceLink)
			.values({
				id: randomUUID(),
				trackId: t.id,
				source: 'tidal',
				sourceTrackId: pick.id,
				url: pick.url,
				isrcLocal: pick.isrc,
				titleLocal: pick.title,
				artistsLocal: null,
				albumLocal: null,
				durationLocal: pick.duration,
				bpmLocal: pick.bpm,
				keyLocal: pick.key,
				payload: pick as unknown,
				fetchedAt: new Date(),
			})
			.run();
		// The match is the account's claim for the row's recording, so the
		// other devices show the link without searching again
		// (claim-links.ts). An ISRC hit is a provider's judgement (0.9, the
		// ISRC-bind confidence), a title + duration pick a content one (0.7):
		// neither anchors an identity merge on its own (identity.ts).
		const byIsrc = !!t.isrc && !!pick.isrc && pick.isrc.toUpperCase() === t.isrc.toUpperCase();
		addClaims(this.db, t.id, [{ kind: 'tidal', value: String(pick.id), confidence: byIsrc ? 0.9 : 0.7 }]);

		return { tidalId: pick.id };
	}

	// Bulk per-track Tidal match. Used by the multi-select context menu: walks
	// the supplied id list in order, emitting the same enrichment progress
	// events as the playlist-wide hybrid sync so the renderer's banner +
	// per-row pip update flow Just Works.
	async matchMany(
		trackIds: string[],
		progress: ProgressFn = () => {}
	): Promise<{ matched: number; scanned: number }> {
		if (!trackIds.length) return { matched: 0, scanned: 0 };
		this.cancelToken?.reset();
		const client = await this.buildClient();
		let matched = 0;
		for (let i = 0; i < trackIds.length; i++) {
			if (this.cancelToken?.cancelled) {
				hlog.info('matchMany cancelled by user');
				break;
			}
			const id = trackIds[i]!;
			const t = this.db.select({ id: track.id, title: track.title }).from(track).where(eq(track.id, id)).get();
			if (!t) continue;
			progress({
				stage: 'enriching',
				enrichment: {
					source: 'tidal',
					index: i + 1,
					total: trackIds.length,
					trackId: t.id,
					trackTitle: t.title,
					phase: 'before',
				},
			});
			try {
				const res = await this.matchOne(t.id, client);
				if (res) matched++;
				progress({
					stage: 'enriching',
					enrichment: {
						source: 'tidal',
						index: i + 1,
						total: trackIds.length,
						trackId: t.id,
						trackTitle: t.title,
						phase: 'after',
						matched: !!res,
					},
				});
			} catch (err) {
				hlog.warn('matchMany failed', { title: t.title }, err);
			}
		}
		progress({ stage: 'done', totals: { playlists: 0, tracksUpserted: 0, tracksEnriched: matched } });
		return { matched, scanned: trackIds.length };
	}

	// Toggle hybrid mode for a Spotify playlist. When enabled, walks the
	// tracklist and runs matchOne for each unlinked track. Progress events
	// reuse the same banner the Beatport enrichment pipeline emits, so the
	// UI doesn't need a parallel implementation.
	async setPlaylistHybrid(
		playlistId: string,
		enabled: boolean,
		progress: ProgressFn = () => {},
		sort?: { column: ZTrackSortT['column']; dir: 'asc' | 'desc' }
	): Promise<{ matched: number; scanned: number; enabled: boolean }> {
		this.db.update(playlist).set({ hybridTidal: enabled }).where(eq(playlist.id, playlistId)).run();
		if (!enabled) return { matched: 0, scanned: 0, enabled: false };

		// Tracks in this playlist that don't yet have a tidal source_link.
		// The OR isNull check lets us also reattempt rows whose previous match
		// row was deleted manually.
		// Match order follows the user's current visible sort (passed in from
		// the renderer). Falls back to playlist position when no sort is given.
		const orderCol = sort
			? (sort.column === 'index' ? playlistTrack.position : sortColumn(sort.column))
			: playlistTrack.position;
		const orderBy = sort?.dir === 'desc' ? desc(orderCol!) : asc(orderCol ?? playlistTrack.position);
		const targets = this.db
			.select({ id: track.id, title: track.title, isrc: track.isrc })
			.from(track)
			.innerJoin(playlistTrack, eq(playlistTrack.trackId, track.id))
			.leftJoin(
				sourceLink,
				and(eq(sourceLink.trackId, track.id), eq(sourceLink.source, 'tidal'))
			)
			// Already matched by another device of the account (a derived
			// link, claim-links.ts): skipped, like an own link — no re-crawl.
			.leftJoin(
				claimLink,
				and(eq(claimLink.trackId, track.id), eq(claimLink.source, 'tidal'))
			)
			.where(and(
				eq(playlistTrack.playlistId, playlistId),
				or(isNull(sourceLink.id)),
				isNull(claimLink.trackId),
				// Remote rows (not on this device): matchOne refuses them.
				eq(track.remoteOnly, false),
			))
			.orderBy(orderBy)
			.all();

		if (!targets.length) return { matched: 0, scanned: 0, enabled: true };

		this.cancelToken?.reset();
		const client = await this.buildClient();
		let matched = 0;
		for (let i = 0; i < targets.length; i++) {
			if (this.cancelToken?.cancelled) {
				hlog.info('match loop cancelled by user');
				progress({ stage: 'done', totals: { playlists: 0, tracksUpserted: 0, tracksEnriched: matched } });
				return { matched, scanned: i, enabled: true };
			}
			const t = targets[i]!;
			progress({
				stage: 'enriching',
				enrichment: {
					source: 'tidal',
					index: i + 1,
					total: targets.length,
					trackId: t.id,
					trackTitle: t.title,
					phase: 'before',
				},
			});
			try {
				const res = await this.matchOne(t.id, client);
				if (res) matched++;
				progress({
					stage: 'enriching',
					enrichment: {
						source: 'tidal',
						index: i + 1,
						total: targets.length,
						trackId: t.id,
						trackTitle: t.title,
						phase: 'after',
						matched: !!res,
					},
				});
			} catch (err) {
				hlog.warn('match failed', { title: t.title }, err);
			}
		}
		progress({ stage: 'done', totals: { playlists: 0, tracksUpserted: 0, tracksEnriched: matched } });
		return { matched, scanned: targets.length, enabled: true };
	}

	// Core matcher — returns ALL acceptable candidates in best-first order, so
	// matchOne can walk past ones already claimed by other Curator tracks
	// (duplicate-ISRC ingest issue). Each pass yields its acceptables before
	// the next pass runs; ISRC hits always rank above text-search picks.
	private async findTidalCandidates(
		t: { title: string; isrc: string | null; duration: number | null; artists: unknown },
		client: TidalApiClient
	): Promise<TidalTrackV2[]> {
		const out: TidalTrackV2[] = [];
		const seen = new Set<string>();

		// 1) ISRC catalog lookup — GET /tracks?filter[isrc]=… is a real index.
		// All rows returned HAVE the requested ISRC. Multiple typically means
		// the same recording across regional masters; they're interchangeable
		// for our purposes so we keep all of them as fallbacks.
		if (t.isrc) {
			hlog.debug('pass 1: ISRC filter', { isrc: t.isrc });
			const hits = await client.getTracksByIsrc(t.isrc).catch((err) => {
				hlog.warn('ISRC filter threw', undefined, err);
				return [] as TidalTrackV2[];
			});
			hlog.debug('pass 1: hits', { hits: hits.length });
			for (const c of hits.slice(0, 15)) {
				hlog.debug('candidate', { id: c.id, title: c.title, version: c.version ?? null, isrc: c.isrc ?? null, duration: c.duration ?? null });
			}
			for (const c of hits) {
				if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
			}
		}

		// 2) Title + primary artist text-search fallback. Tidal v2 search at our
		// include level doesn't return artist relationships, so we accept on
		// title-exact + duration ≤ 5s as a substitute for the artistMatch
		// half of the strict rule.
		const primaryArtist = Array.isArray(t.artists) && (t.artists[0] as { name?: string })?.name
			? ((t.artists[0] as { name: string }).name)
			: null;
		if (primaryArtist) {
			const q = `${t.title} ${primaryArtist}`;
			hlog.debug('pass 2: text search', { query: q });
			const candidates = await client.searchTracks(q).catch((err) => {
				hlog.warn('text search threw', undefined, err);
				return [] as TidalTrackV2[];
			});
			hlog.debug('pass 2: candidates', { candidates: candidates.length });
			for (const c of candidates.slice(0, 15)) {
				hlog.debug('candidate', { id: c.id, title: c.title, version: c.version ?? null, isrc: c.isrc ?? null, duration: c.duration ?? null });
			}

			// ISRC-on-candidates first (handles the case where target.isrc was
			// missing but Tidal still surfaces the right track with one).
			if (t.isrc) {
				for (const c of candidates) {
					if (c.isrc && c.isrc.toUpperCase() === t.isrc.toUpperCase() && !seen.has(c.id)) {
						seen.add(c.id); out.push(c);
					}
				}
			}

			// Strict acceptance: title-exact + duration ≤ 5s. Rank by closeness
			// of duration; title-bare-exact gets a small bonus.
			const targetTitleN = sharedScorer.normalize(t.title);
			const targetTitleBaseN = sharedScorer.normalize(sharedScorer.baseTitle(t.title));
			const targetDur = t.duration ?? 0;
			const scored: { c: TidalTrackV2; score: number }[] = [];
			for (const c of candidates) {
				if (seen.has(c.id)) continue;
				const candTitleFullN = sharedScorer.normalize([c.title, c.version].filter(Boolean).join(' '));
				const candTitleBareN = sharedScorer.normalize(c.title);
				const titleExact =
					(candTitleBareN === targetTitleN && candTitleBareN.length > 0) ||
					(candTitleFullN === targetTitleN && candTitleFullN.length > 0) ||
					(candTitleBareN === targetTitleBaseN && candTitleBareN.length > 0);
				if (!titleExact) {
					hlog.debug('reject: title mismatch', { id: c.id, candidateTitle: c.title, targetTitle: t.title });
					continue;
				}
				if (!c.duration || !targetDur) {
					hlog.debug('reject: no duration', { id: c.id, candidateDuration: c.duration, targetDuration: targetDur });
					continue;
				}
				const dDiff = Math.abs(c.duration - targetDur);
				if (dDiff > 5) {
					hlog.debug('reject: duration diff > 5s', { id: c.id, dDiff });
					continue;
				}
				const score = (dDiff <= 2 ? 100 : 50) + (candTitleBareN === targetTitleN ? 10 : 0);
				hlog.debug('accept', { id: c.id, score, dDiff });
				scored.push({ c, score });
			}
			scored.sort((a, b) => b.score - a.score);
			for (const s of scored) {
				seen.add(s.c.id); out.push(s.c);
			}
		}

		return out;
	}
}

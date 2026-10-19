// Beatport HTML-scrape client. Ports the logic from tidalext/common/beatport.js.
// Beatport doesn't expose a public OAuth API for our use case (per Phase 0
// research), so we scrape the search page's __NEXT_DATA__ JSON blob.
//
// Scoring delegates to the shared Scorer in @curator/matcher — same strict
// acceptance rule (title + artist + dur ≤ 5s OR ISRC) for consistency
// across Tidal and Beatport.
//
// By default we emit one line per lookup — the final match result. Set
// CURATOR_BP_DEBUG=1 for the full verbose trace (queries, candidates, scorer).
// Logs go to whatever stdout the process is attached to (Electron main).

import {
	sharedScorer,
	ProviderBlockedError,
	Cooldown,
	cloudflareChallengeReason,
	type Trace,
} from '@curator/matcher';

declare const process: { env?: Record<string, string | undefined> } | undefined;

const DEBUG = (typeof process !== 'undefined' ? process?.env?.CURATOR_BP_DEBUG : null) === '1';

// After Cloudflare hands us a challenge, skip Beatport for this long before
// probing again — long enough that a multi-thousand-track batch stops hammering
// the wall and lets the Traxsource fallback carry it, short enough that a
// transient block self-heals within one sitting. Per-client (see Cooldown).
const BLOCK_COOLDOWN_MS = 5 * 60 * 1000;

export interface BeatportTrack {
	id: number;
	url: string;
	title: string;
	mix: string | null;
	isrc: string | null;
	duration: number | null;
	bpm: number | null;
	key: string | null;
	genre: string | null;
	label: string | null;
	artists: string[];
	release_date: string | null;
}

export interface BeatportTarget {
	title: string;
	artists: string[];
	duration: number | null;
	isrc?: string | null;
}

interface RawTrack {
	track_id?: string | number;
	id?: string | number;
	track_name?: string;
	name?: string;
	title?: string;
	mix_name?: string;
	mix?: { name?: string };
	isrc?: string | null;
	length?: number | string;
	length_ms?: number;
	bpm?: number | null;
	key_name?: string | null;
	key?: { name?: string } | string | null;
	genre?: { genre_name?: string; name?: string } | Array<{ genre_name?: string; name?: string }>;
	sub_genre?: { genre_name?: string; name?: string } | Array<{ genre_name?: string; name?: string }>;
	label?: { label_name?: string; name?: string };
	// Track-detail page nests label + genre under `release` and uses .name
	// (search-results pages flatten everything onto the track and use
	// .label_name / .genre_name). We try both shapes.
	release?: {
		label?: { label_name?: string; name?: string };
		genre?: { genre_name?: string; name?: string } | Array<{ genre_name?: string; name?: string }>;
		sub_genre?: { genre_name?: string; name?: string } | Array<{ genre_name?: string; name?: string }>;
	};
	release_label?: { name?: string; label_name?: string };
	release_label_name?: string;
	artists?: Array<{ artist_name?: string; name?: string }>;
	slug?: string;
	publish_date?: string;
	release_date?: string;
	new_release_date?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BeatportClientOptions {
	// Inject a fetch impl. In Electron main, pass `net.fetch` — its Chromium
	// network stack presents a real Chrome TLS fingerprint + UA, which is
	// required because Beatport's Cloudflare WAF 403s anything that looks
	// like Node/undici.
	fetchImpl?: FetchLike;
}

export class BeatportClient {
	// One-shot structural log for the first __NEXT_DATA__ payload we see, so
	// we can verify the parse path matches what Beatport currently ships.
	// Tracked separately per path: search-results pages and track-detail pages
	// have different shapes and we want a sample of each.
	private static structureLogged = false;
	private static detailStructureLogged = false;
	private readonly fetchImpl: FetchLike;
	private readonly cooldown = new Cooldown(BLOCK_COOLDOWN_MS);

	constructor(opts: BeatportClientOptions = {}) {
		this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	}

	// True while we're backing off after a detected Cloudflare challenge. The
	// enricher gates applicableTo() on this so a batch skips Beatport entirely
	// (letting the Traxsource fallback carry it) instead of throwing per track.
	isCoolingDown(): boolean {
		return this.cooldown.active;
	}

	// Trip the cooldown and raise a typed error. Called the moment a response
	// is identified as a Cloudflare challenge — never continues past here.
	private _blocked(status: number, reason: string): never {
		const firstHit = !this.cooldown.active;
		this.cooldown.trip();
		if (firstHit) {
			console.warn(`[beatport] Cloudflare challenge (${reason}, HTTP ${status}) — backing off ${BLOCK_COOLDOWN_MS / 1000}s; falling back to Traxsource`);
		}
		throw new ProviderBlockedError('beatport', status, reason);
	}

	async lookup(target: BeatportTarget): Promise<BeatportTrack | null> {
		// One line per lookup summarizing the outcome. Verbose tracing (DEBUG)
		// adds the per-query/candidate/scorer detail above this.
		const logResult = (matched: boolean) =>
			console.log(`[beatport] ${target.isrc ?? '-'} ${(target.artists ?? []).join(', ')} - ${target.title} : matched:${matched}`);

		if (!target.title || !target.artists?.[0]) {
			if (DEBUG) console.log('[beatport] lookup: missing title or artist', { title: target.title, artists: target.artists });
			logResult(false);
			return null;
		}
		if (DEBUG) console.log(`[beatport] ───────── lookup "${target.title}" by ${target.artists.join('/')} (dur:${target.duration}s, isrc:${target.isrc ?? '-'})`);

		// Query fallback chain. Beatport's search ranks pages by ~10 hits, and
		// noisy artist tokens (e.g. "&ME") can push the actual track off the
		// first page. Walk all artists; for each, try the raw name then a
		// special-char-stripped variant. Stop as soon as we get an acceptable
		// pick — the strict scorer prevents false positives even when later
		// queries return many unrelated candidates.
		const queries = this._buildQueries(target);
		const seenIds = new Set<number>();
		const allCandidates: BeatportTrack[] = [];
		for (const q of queries) {
			const candidates = await this._search(q);
			if (DEBUG) console.log(`[beatport] got ${candidates.length} candidate(s) for query "${q}"`);
			let added = 0;
			for (const c of candidates) {
				if (!seenIds.has(c.id)) {
					seenIds.add(c.id);
					allCandidates.push(c);
					added++;
				}
			}
			if (DEBUG && added > 0) {
				for (const c of candidates.slice(0, 5)) {
					console.log(`[beatport]   cand id=${c.id} "${c.title}${c.mix ? ` (${c.mix})` : ''}" by ${c.artists.join('/')} ${c.duration}s bpm=${c.bpm} key=${c.key} isrc=${c.isrc}`);
				}
			}
			const picked = this._pickBest(allCandidates, target);
			if (picked) {
				if (DEBUG) console.log(`[beatport] ✔ picked id=${picked.id} "${picked.title}" bpm=${picked.bpm} key=${picked.key} label=${picked.label} genre=${picked.genre} (after query "${q}")`);
				logResult(true);
				return picked;
			}
			if (DEBUG) console.log(`[beatport]   no acceptable pick yet (pool=${allCandidates.length}); trying next query`);
		}
		// Last resort: the strict scorer rejects an Original-vs-Extended pairing
		// because their lengths differ by minutes. When the DB track and a
		// Beatport candidate differ ONLY by original-vs-extended — same base
		// title, same artist, neither side a named remix — accept it anyway.
		// The Original and Extended share label/genre/key/BPM, which is all we
		// enrich. Runs once over the full accumulated pool so a later query
		// still gets the chance to surface a strict match first.
		const fallback = this._pickExtendedFallback(allCandidates, target);
		if (fallback) {
			if (DEBUG) console.log(`[beatport] ⤷ extended/original fallback id=${fallback.id} "${fallback.title}${fallback.mix ? ` (${fallback.mix})` : ''}" (dur ${fallback.duration}s vs target ${target.duration}s)`);
			logResult(true);
			return fallback;
		}
		if (DEBUG) console.log(`[beatport] ✗ no acceptable candidate for "${target.title}" across ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
		logResult(false);
		return null;
	}

	private _buildQueries(target: BeatportTarget): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const push = (q: string) => {
			const k = q.toLowerCase().trim();
			if (k && !seen.has(k)) {
				seen.add(k);
				out.push(q);
			}
		};
		// Primary: title + every artist in one query. This is the most
		// distinctive search we can build — Beatport's relevance ranking
		// puts the actual track at #1 when the credit matches. Burns one
		// request instead of N, and the candidate pool is already filtered
		// by the artists we care about.
		const artists = target.artists.filter(Boolean);
		if (artists.length) push(`${target.title} ${artists.join(' ')}`);
		// Fallbacks per-artist — only used if the primary returns no
		// acceptable candidate (e.g. Beatport credits a different subset
		// than Spotify). One per artist; no synthetic cleaned variants,
		// since those produce title-with-noise queries.
		for (const a of artists) push(`${target.title} ${a}`);
		return out;
	}

	// Fetch a specific track by Beatport ID. Used when the user supplies an
	// explicit Beatport URL in the Edit-Track modal — we trust their pick over
	// the search-and-score result. The slug after /track/ is decorative; "-"
	// works fine.
	async fetchById(id: number): Promise<BeatportTrack | null> {
		const url = `https://www.beatport.com/track/-/${id}`;
		if (DEBUG) console.log(`[beatport] fetchById GET ${url}`);
		const res = await this.fetchImpl(url, {
			credentials: 'omit',
			headers: {
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
			},
		}).catch((err: unknown) => {
			if (DEBUG) console.warn('[beatport] fetchById threw', err instanceof Error ? err.message : err);
			return null;
		});
		if (!res) return null;
		// Distinguish a Cloudflare challenge from a genuine 404 so the Edit-Track
		// modal shows "Beatport is blocked, try later" instead of the misleading
		// "track not found or page parse failed". Header first, then body sniff.
		const cfHeader = cloudflareChallengeReason(res.status, res.headers, null);
		if (cfHeader) this._blocked(res.status, cfHeader);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			const reason = cloudflareChallengeReason(res.status, res.headers, body);
			if (reason) this._blocked(res.status, reason);
			if (DEBUG) console.warn(`[beatport] fetchById non-OK ${res.status}`);
			return null;
		}
		const html = await res.text();
		const candidates = this._extractCandidates(html);
		// The track-detail page yields a single track in tracks.data (or the
		// tree-walk fallback). Prefer the one whose id matches if multiple.
		const exact = candidates.find((c) => c.id === id);
		return exact ?? candidates[0] ?? null;
	}

	private async _search(query: string): Promise<BeatportTrack[]> {
		// /search/tracks returns the full tracks-only result list (page size 25+).
		// The plain /search endpoint caps the tracks block at 10 — that's the
		// truncation tidalext hit consistently (rawCount: 10 across the
		// diagnostics file). Tracks that don't rank in the top-10 for a given
		// query were invisible to the old client.
		//
		// Short-circuit while cooling down from a recent block — no point
		// spending a request (and a 350ms pace) on a wall. Throwing keeps the
		// runner's `errored` accounting honest for direct lookup() callers; the
		// batch path never reaches here because applicableTo() is already false.
		if (this.cooldown.active) throw new ProviderBlockedError('beatport', 0, 'cooldown');
		const url = `https://www.beatport.com/search/tracks?q=${encodeURIComponent(query)}`;
		if (DEBUG) console.log(`[beatport] GET ${url}`);
		const res = await this.fetchImpl(url, {
			credentials: 'omit',
			headers: {
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
			},
		}).catch((err: unknown) => {
			if (DEBUG) console.warn('[beatport] fetch threw', err instanceof Error ? err.message : err);
			return null;
		});
		if (!res) return [];
		if (DEBUG) console.log(`[beatport] response status=${res.status} ct=${res.headers.get('content-type')} redirected=${res.redirected} url=${res.url}`);
		// A Cloudflare challenge is tagged on the header even before we read the
		// body — check that first (cheap), then the body on the statuses CF uses
		// for challenges. Either way we trip the cooldown and throw a typed
		// ProviderBlockedError so the runner records `errored` and moves to the
		// fallback, instead of mistaking the WAF wall for "not in the catalog".
		const cfHeader = cloudflareChallengeReason(res.status, res.headers, null);
		if (cfHeader) this._blocked(res.status, cfHeader);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			const reason = cloudflareChallengeReason(res.status, res.headers, body);
			if (reason) this._blocked(res.status, reason);
			if (DEBUG) console.warn(`[beatport] non-OK response (${res.status}), bailing`);
			return [];
		}
		const html = await res.text();
		if (DEBUG) console.log(`[beatport] body bytes=${html.length} has __NEXT_DATA__=${html.includes('__NEXT_DATA__')} has cloudflare=${html.toLowerCase().includes('cloudflare')}`);
		return this._extractCandidates(html);
	}

	private _extractCandidates(html: string): BeatportTrack[] {
		const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
		if (!m || !m[1]) {
			if (DEBUG) console.warn('[beatport] no __NEXT_DATA__ script tag found in HTML');
			return [];
		}
		let next: any;
		try {
			next = JSON.parse(m[1]);
		} catch (err) {
			if (DEBUG) console.warn('[beatport] __NEXT_DATA__ JSON parse failed', err instanceof Error ? err.message : err);
			return [];
		}

		// One-time structure log — helps us verify the parse path. Same diagnostic
		// the tidalext extension used to discover the actual track schema.
		if (DEBUG && !BeatportClient.structureLogged) {
			BeatportClient.structureLogged = true;
			const q0 = next?.props?.pageProps?.dehydratedState?.queries?.[0];
			console.log('[beatport] queries[0].queryKey:', JSON.stringify(q0?.queryKey));
			console.log('[beatport] queries[0].state keys:', q0?.state ? Object.keys(q0.state) : 'no state');
			const data = q0?.state?.data;
			if (data && typeof data === 'object') {
				console.log('[beatport] queries[0].state.data top-level keys:', Object.keys(data));
				for (const k of Object.keys(data)) {
					const v = (data as Record<string, unknown>)[k];
					if (Array.isArray(v)) console.log(`[beatport]  .${k}: Array(${v.length})`, v[0] ? 'first item keys: ' + Object.keys(v[0]).slice(0, 15).join(',') : 'empty');
					else if (v && typeof v === 'object') console.log(`[beatport]  .${k}: Object`, Object.keys(v).slice(0, 15));
					else console.log(`[beatport]  .${k}:`, typeof v, v);
				}
			}
			const firstTrack = data?.tracks?.data?.[0];
			if (firstTrack) console.log('[beatport] first track keys:', Object.keys(firstTrack), 'sample:', JSON.stringify(firstTrack, null, 2).slice(0, 2000));
			else console.log('[beatport] tracks.data[0] missing — falling back to tree walk');
		}

		// Fast path A — search results. Beatport has shipped two shapes for the
		// dehydrated react-query:
		//   older:   queries[0].state.data.tracks.data
		//   current: the search-tracks query's state.data.data  (a flat array,
		//            queryKey ['search-tracks', {...}, region])
		// Scan every query (the search query isn't always index 0) and accept
		// either shape. Without this the current shape silently falls through to
		// the expensive full-tree walk below on every single lookup.
		const searchQueries = next?.props?.pageProps?.dehydratedState?.queries;
		if (Array.isArray(searchQueries)) {
			for (const q of searchQueries) {
				const sd = q?.state?.data;
				if (!sd || typeof sd !== 'object') continue;
				const key = q?.queryKey;
				const isSearch = Array.isArray(key) && typeof key[0] === 'string' && key[0].includes('search');
				const direct: unknown =
					(Array.isArray(sd.tracks?.data) ? sd.tracks.data : null) ??
					(isSearch && Array.isArray(sd.data) ? sd.data : null);
				if (Array.isArray(direct) && direct.length) {
					if (DEBUG) console.log(`[beatport] fast path (search): ${direct.length} entries via ${sd.tracks?.data ? 'tracks.data' : 'data'}`);
					return direct.map((t: RawTrack) => this._normalize(t)).filter((t: BeatportTrack | null): t is BeatportTrack => t !== null);
				}
			}
		}

		// Fast path B — track-detail page: the canonical track is the data object
		// itself (queries[0].state.data), with queryKey shaped like ['track', id].
		// Without this, the tree walk below would collect only the "related",
		// "fans also bought", and "more from this artist" carousels, never the
		// track being viewed — fetchById would then return a recommendation's
		// genre/label instead of the requested track's.
		const queries = next?.props?.pageProps?.dehydratedState?.queries;
		if (Array.isArray(queries)) {
			for (const q of queries) {
				const data = q?.state?.data;
				if (data && typeof data === 'object' && !Array.isArray(data)) {
					const looksLikeDetail = (data.id != null || data.track_id != null) &&
						(typeof data.bpm === 'number' ||
						 typeof data.mix_name === 'string' ||
						 typeof data.length_ms === 'number' ||
						 (data.key !== undefined && (typeof data.key === 'string' || (data.key as { name?: string })?.name !== undefined)));
					if (looksLikeDetail) {
						if (DEBUG) console.log('[beatport] fast path (detail): single track at queries[*].state.data');
						if (DEBUG && !BeatportClient.detailStructureLogged) {
							BeatportClient.detailStructureLogged = true;
							const d = data as Record<string, unknown>;
							console.log('[beatport] detail page — top-level keys:', Object.keys(d).slice(0, 40).join(','));
							const release = d['release'] as Record<string, unknown> | undefined;
							if (release && typeof release === 'object') {
								console.log('[beatport] detail page — release keys:', Object.keys(release).slice(0, 30).join(','));
								console.log('[beatport] detail page — release.label:', JSON.stringify(release['label'])?.slice(0, 300));
								console.log('[beatport] detail page — release.genre:', JSON.stringify(release['genre'])?.slice(0, 300));
								console.log('[beatport] detail page — release.sub_genre:', JSON.stringify(release['sub_genre'])?.slice(0, 300));
							}
							console.log('[beatport] detail page — t.label:', JSON.stringify(d['label'])?.slice(0, 300));
							console.log('[beatport] detail page — t.genre:', JSON.stringify(d['genre'])?.slice(0, 300));
							console.log('[beatport] detail page — t.sub_genre:', JSON.stringify(d['sub_genre'])?.slice(0, 300));
						}
						const n = this._normalize(data as RawTrack);
						if (DEBUG) console.log(`[beatport] detail normalize → label=${n?.label ?? 'null'} genre=${n?.genre ?? 'null'}`);
						if (n) return [n];
					}
				}
			}
		}

		if (DEBUG) console.log('[beatport] fast path empty, walking tree');
		// Fallback: walk the tree, collect anything that quacks like a track
		const out: RawTrack[] = [];
		const seen = new WeakSet<object>();
		const looksLikeTrack = (o: unknown): o is RawTrack => {
			if (!o || typeof o !== 'object') return false;
			const obj = o as Record<string, unknown>;
			const id = obj.id ?? obj.track_id;
			if (typeof id !== 'number' && !(typeof id === 'string' && /^\d+$/.test(id))) return false;
			return (
				typeof obj.bpm === 'number' ||
				typeof obj.mix_name === 'string' ||
				typeof obj.length_ms === 'number' ||
				(obj.key !== undefined && ((obj.key as { name?: string })?.name !== undefined || typeof obj.key === 'string'))
			);
		};
		const walk = (node: unknown): void => {
			if (!node || typeof node !== 'object') return;
			if (seen.has(node as object)) return;
			seen.add(node as object);
			if (Array.isArray(node)) {
				for (const item of node) {
					if (looksLikeTrack(item)) out.push(item);
					walk(item);
				}
				return;
			}
			// Test the object itself too — on the track-detail page, the
			// canonical track is a plain object (not an array item), so the
			// old array-only check missed it and returned a related-track's
			// genre/label instead.
			if (looksLikeTrack(node)) out.push(node as RawTrack);
			for (const v of Object.values(node)) walk(v);
		};
		walk(next);
		const byId = new Map<unknown, RawTrack>();
		for (const t of out) {
			const id = t.id ?? t.track_id;
			if (id != null && !byId.has(id)) byId.set(id, t);
		}
		if (DEBUG) console.log(`[beatport] tree walk found ${byId.size} track-shaped objects`);
		return Array.from(byId.values()).map((t) => this._normalize(t)).filter((t): t is BeatportTrack => t !== null);
	}

	private _normalize(t: RawTrack): BeatportTrack | null {
		const id = Number(t.track_id ?? t.id);
		if (!Number.isFinite(id) || id === 0) return null;
		let durationSec: number | null = null;
		if (typeof t.length === 'number') durationSec = Math.round(t.length / 1000);
		else if (typeof t.length_ms === 'number') durationSec = Math.round(t.length_ms / 1000);
		else if (typeof t.length === 'string') durationSec = this._parseHms(t.length);
		const artistNames = Array.isArray(t.artists)
			? t.artists.map((a) => a.artist_name ?? a.name ?? '').filter(Boolean)
			: [];
		// Genre / sub_genre — try every shape we've seen.
		// Search-result pages: t.genre = { genre_name: 'Melodic House & Techno' }
		// Detail page: t.release.genre = { name: 'Melodic House & Techno' }
		// Sometimes an array of genres; sometimes the sub_genre is the visible
		// label the user sees on Beatport's UI.
		const pickGenre = (g: RawTrack['genre'] | undefined): string | null => {
			if (!g) return null;
			if (Array.isArray(g)) return g[0]?.genre_name ?? g[0]?.name ?? null;
			return g.genre_name ?? g.name ?? null;
		};
		const genreName =
			pickGenre(t.genre) ??
			pickGenre(t.sub_genre) ??
			pickGenre(t.release?.genre) ??
			pickGenre(t.release?.sub_genre) ??
			null;
		const keyName = typeof t.key === 'object' ? t.key?.name ?? null : (typeof t.key === 'string' ? t.key : null);
		// Label — same dual-shape problem. Search-result page flattens to
		// t.label.label_name; detail page nests under release with .name
		// instead of .label_name. Some legacy pages emit a flat
		// release_label_name string. Walk every variant we've seen.
		const labelName =
			t.label?.label_name ??
			t.label?.name ??
			t.release?.label?.label_name ??
			t.release?.label?.name ??
			t.release_label?.label_name ??
			t.release_label?.name ??
			t.release_label_name ??
			null;
		return {
			id,
			url: t.slug ? `https://www.beatport.com/track/${t.slug}/${id}` : `https://www.beatport.com/track/-/${id}`,
			title: t.track_name ?? t.name ?? t.title ?? '',
			mix: t.mix_name ?? (typeof t.mix === 'object' ? t.mix?.name ?? null : null),
			isrc: t.isrc ?? null,
			duration: durationSec,
			bpm: t.bpm ?? null,
			key: this._shortKey(t.key_name ?? keyName),
			genre: genreName,
			label: labelName,
			artists: artistNames,
			release_date: t.publish_date ?? t.release_date ?? t.new_release_date ?? null,
		};
	}

	private _shortKey(k: string | null | undefined): string | null {
		if (!k) return null;
		const m = String(k).match(/^([A-G])([#b♯♭]?)\s+(Major|Minor|maj|min)/i);
		if (!m) return k;
		const accidental = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2] ?? '';
		const isMinor = /^min/i.test(m[3] ?? '');
		return `${m[1]}${accidental}${isMinor ? 'm' : ''}`;
	}

	private _parseHms(s: string | null | undefined): number | null {
		if (!s) return null;
		const parts = s.split(':').map(Number);
		if (parts.some((n) => Number.isNaN(n))) return null;
		if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
		if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
		return null;
	}

	private _pickBest(candidates: BeatportTrack[], target: BeatportTarget): BeatportTrack | null {
		if (!candidates.length) return null;
		const adapted = candidates.map((c) => ({
			id: c.id,
			title: c.title,
			version: c.mix,
			artists: c.artists,
			duration: c.duration,
			isrc: c.isrc,
			__src: c,
		}));
		const trace: Trace | null = DEBUG ? {} : null;
		const picked = sharedScorer.pick(adapted, {
			title: target.title,
			artists: target.artists,
			duration: target.duration,
			isrc: target.isrc ?? null,
		}, trace);
		if (DEBUG && trace?.candidates?.length) {
			console.log(`[beatport] scorer breakdown (best=${trace.bestScore ?? 0}):`);
			for (const tc of trace.candidates) {
				console.log(`[beatport]   score=${tc.score} ${tc.why} :: ${tc.cand}`);
			}
		}
		return picked ? (picked as typeof adapted[number]).__src : null;
	}

	// Original↔Extended last-resort match (see lookup). Fires only when the
	// strict scorer found nothing. Eligible candidates share the target's base
	// title and at least one artist, and are themselves only an Original or
	// Extended mix — a named remix / Radio Edit / Dub is a distinct recording
	// and never qualifies. Duration is deliberately ignored here. An Original
	// candidate beats an Extended one when both are present.
	private _pickExtendedFallback(candidates: BeatportTrack[], target: BeatportTarget): BeatportTrack | null {
		if (!candidates.length) return null;
		const norm = (s: string | null | undefined) => sharedScorer.normalize(s);
		const targetBaseN = norm(sharedScorer.baseTitle(target.title));
		if (!targetBaseN) return null;
		// Never pull this trick when the DB track itself asks for a specific
		// remix — only when it's unversioned, Original, or Extended.
		const targetVersion = this._titleVersion(target.title);
		if (targetVersion && this._versionClass(targetVersion) === null) return null;
		const targetArtistSet = new Set((target.artists || []).map(norm).filter(Boolean));

		let best: BeatportTrack | null = null;
		let bestRank = -1;
		for (const c of candidates) {
			const vc = this._versionClass(c.mix);
			if (vc === null) continue; // a named remix / edit — not the same recording
			if (norm(sharedScorer.baseTitle(c.title)) !== targetBaseN) continue;
			if (!(c.artists || []).some((a) => targetArtistSet.has(norm(a)))) continue;
			const rank = vc === 'original' ? 1 : 0;
			if (rank > bestRank) {
				bestRank = rank;
				best = c;
			}
		}
		return best;
	}

	// Classify a mix / version annotation. Only Original and Extended count as
	// "the same recording for metadata purposes"; everything else is distinct.
	private _versionClass(v: string | null | undefined): 'original' | 'extended' | null {
		const n = sharedScorer.normalize(v);
		if (!n || n === 'original mix' || n === 'original') return 'original';
		if (n === 'extended mix' || n === 'extended') return 'extended';
		return null;
	}

	// Trailing version annotation from a title: "(X)", "[X]", or " - X".
	private _titleVersion(title: string | null | undefined): string {
		if (!title) return '';
		const s = String(title);
		const m = s.match(/[\(\[]([^)\]]+)[\)\]]\s*$/) ?? s.match(/\s+-\s+(.+?)\s*$/);
		return m ? (m[1] ?? '').trim() : '';
	}
}

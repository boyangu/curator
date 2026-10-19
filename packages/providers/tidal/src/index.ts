// Tidal provider — covers the official OAuth flow + the v2 API surface.
//
// Auth model:  Authorization Code + PKCE + client_secret (Tidal's documented
// pattern — non-standard in that they send both PKCE verifier AND client_secret
// on token exchange, matching what @tidal-music/auth does internally).
//
// Token lifetime is short (~1h access, longer-lived refresh). The auth service
// owns refresh; this module is stateless and just exposes the primitives.

import { Buffer } from 'node:buffer';
import { webcrypto as crypto } from 'node:crypto';

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface TidalAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: string;
	authorizeUrl: string;
	tokenUrl: string;
}

export interface TidalTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: Date;
	scope: string;
}

function base64url(buf: ArrayBuffer): string {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generateTidalPkce(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = base64url(verifierBytes.buffer);
	const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const challenge = base64url(challengeBytes);
	return { verifier, challenge };
}

export function buildTidalAuthorizeUrl(cfg: TidalAuthConfig, codeChallenge: string, state: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: cfg.clientId,
		redirect_uri: cfg.redirectUri,
		scope: cfg.scopes,
		code_challenge_method: 'S256',
		code_challenge: codeChallenge,
		state,
	});
	return `${cfg.authorizeUrl}?${params}`;
}

export async function exchangeTidalCodeForTokens(
	cfg: TidalAuthConfig,
	code: string,
	codeVerifier: string
): Promise<TidalTokens> {
	const res = await fetch(cfg.tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: cfg.redirectUri,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret,
			code_verifier: codeVerifier,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Tidal token exchange failed: ${res.status} ${body}`);
	}
	const json = (await res.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		scope: string;
	};
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiresAt: new Date(Date.now() + json.expires_in * 1000),
		scope: json.scope,
	};
}

export async function refreshTidalTokens(
	cfg: TidalAuthConfig,
	refreshToken: string
): Promise<TidalTokens> {
	const res = await fetch(cfg.tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Tidal refresh failed: ${res.status} ${body}`);
	}
	const json = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		scope: string;
	};
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token ?? refreshToken,
		expiresAt: new Date(Date.now() + json.expires_in * 1000),
		scope: json.scope,
	};
}

// ─── Legacy v1 streaming client (api.tidal.com/v1) ──────────────────────────
// Uses the sniffed listen.tidal.com bearer (kind='session' in our auth store)
// to hit endpoints the third-party OAuth surface can't reach: /playbackinfo
// for FLAC stream manifests, /tracks/{id} for metadata, /albums/{id} for
// artwork. Only used by the download pipeline.

export interface TidalV1Track {
	id: number;
	title: string;
	version: string | null;
	duration: number;
	isrc: string | null;
	trackNumber: number;
	volumeNumber: number;
	artists: { id: number; name: string; type: 'MAIN' | 'FEATURED' }[];
	album: { id: number; title: string; cover: string | null };
	audioQuality: string;
	url: string;
}

export interface TidalV1PlaybackInfo {
	trackId: number;
	assetPresentation: string;
	audioMode: string;
	audioQuality: string;
	manifestMimeType: string;
	manifestHash: string;
	manifest: string; // base64-encoded DASH manifest XML
}

// Structured failure from the v1 API. Tidal speaks in HTTP status + a finer
// `subStatus` code (e.g. 403/4032 = "No content matching subscription
// location" = region-locked) plus a `userMessage`. We surface those fields so
// the caller can map them to a product-facing message instead of re-parsing
// the raw JSON body out of an Error string. Extends Error so existing
// `instanceof Error` / `.message` consumers keep working.
export class TidalApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly subStatus: number | null,
		readonly userMessage: string | null,
		readonly body: string
	) {
		super(`Tidal v1 ${status} ${path}: ${body}`);
		this.name = 'TidalApiError';
	}
}

export class TidalV1Client {
	constructor(private readonly creds: { token: string; countryCode: string }) {}

	private async request<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
		const qs = new URLSearchParams({
			countryCode: this.creds.countryCode,
			locale: 'en_US',
			deviceType: 'BROWSER',
			...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
		});
		const url = `https://api.tidal.com/v1${path}?${qs}`;
		const res = await fetch(url, { headers: { Authorization: this.creds.token } });
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			// Pull subStatus/userMessage when the body is Tidal's standard error
			// JSON; tolerate a non-JSON body (proxy/HTML error pages) by leaving
			// them null and keeping the raw text for diagnostics.
			let subStatus: number | null = null;
			let userMessage: string | null = null;
			try {
				const j = JSON.parse(body) as { subStatus?: number; userMessage?: string };
				subStatus = typeof j.subStatus === 'number' ? j.subStatus : null;
				userMessage = typeof j.userMessage === 'string' ? j.userMessage : null;
			} catch {
				// non-JSON body — fields stay null
			}
			throw new TidalApiError(res.status, path, subStatus, userMessage, body);
		}
		return res.json() as Promise<T>;
	}

	getTrack(id: string | number): Promise<TidalV1Track> {
		return this.request<TidalV1Track>(`/tracks/${id}`);
	}

	// PlaybackInfo returns a base64-encoded DASH manifest plus quality info.
	// audioQuality is what we'd LIKE — Tidal returns the closest available.
	// usage=STREAM is the typical value (used by listen.tidal.com); DOWNLOAD
	// is also accepted by some accounts.
	getPlaybackInfo(
		trackId: string | number,
		opts: { audioQuality: string; manifestType?: 'BTS' | 'DASH' | 'EMU' } = { audioQuality: 'HI_RES_LOSSLESS' }
	): Promise<TidalV1PlaybackInfo> {
		return this.request<TidalV1PlaybackInfo>(
			`/tracks/${trackId}/playbackinfo`,
			{
				audioquality: opts.audioQuality,
				playbackmode: 'STREAM',
				assetpresentation: 'FULL',
				...(opts.manifestType ? { manifesttype: opts.manifestType } : {}),
			}
		);
	}
}

// ─── App-wide rate gate (v2 API) ─────────────────────────────────────────────
// Tidal enforces a token-bucket rate limit per client-ID, shared across every
// TidalApiClient instance in the process. Observed 2026-07-12: a full-library
// sync burst (≈400 requests in ~50s) trips a 429 wall that keeps rejecting
// even a handful of requests ~10min later. Same design as the Spotify gate
// (packages/providers/spotify): all request STARTS serialize through one
// module-level chain with a minimum spacing, and an observed 429 arms a
// shared cooldown (honoring Retry-After) so the whole process backs off
// together. Only starts are spaced — in-flight requests still overlap.
const MIN_INTERVAL_MS = 250; // ~4 starts/sec
const MAX_COOLDOWN_MS = 60_000;
let gateChain: Promise<void> = Promise.resolve();
let nextAllowedAt = 0;
let cooldownUntil = 0;

function waitForSlot(): Promise<void> {
	const my = gateChain.then(async () => {
		const wait = Math.max(nextAllowedAt, cooldownUntil) - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
	});
	gateChain = my.catch(() => {});
	return my;
}

function noteRateLimit(retryAfterSec: number): void {
	const until = Date.now() + Math.min(Math.max(retryAfterSec, 1) * 1000, MAX_COOLDOWN_MS);
	if (until > cooldownUntil) cooldownUntil = until;
	console.warn(`[tidal] 429 — cooling down ${Math.round((until - Date.now()) / 1000)}s (retry-after ${retryAfterSec}s)`);
}

// ─── API client (v2 / openapi.tidal.com) ────────────────────────────────────

export interface TidalUser {
	id: string;
	displayName: string | null;
	country: string | null;
	email: string | null;
	picture: string | null;
}

export interface TidalPlaylist {
	id: string;
	name: string;
	description: string | null;
	numberOfItems: number | null;
	playlistType: string | null;
	accessType: string | null;
	// ISO timestamp of the last remote modification. Tidal has no
	// snapshot_id equivalent — this is the change-detection cursor the
	// sync loop diffs against (numberOfItems is the belt to its braces).
	lastModifiedAt: string | null;
}

export interface TidalTrackV2 {
	id: string;
	title: string;
	version: string | null;
	duration: number | null;       // seconds
	isrc: string | null;
	bpm: number | null;
	key: string | null;
	keyScale: 'MAJOR' | 'MINOR' | null;
	explicit: boolean;
	artists: { id: string; name: string; main: boolean }[];
	album: { id: string; title: string } | null;
	url: string | null;
}

// One playlist member in remote order. `addedAt` comes from the
// relationship identifier's meta (when Tidal supplies it) — the playlist
// order itself is the `data` array order, NOT the `included` order.
export interface TidalPlaylistItem {
	track: TidalTrackV2;
	addedAt: string | null;
}

// JSON:API resource shape used throughout Tidal v2. Relationship-endpoint
// `data` entries are resource identifiers that may carry per-edge `meta`
// (playlist items expose addedAt there).
interface JsonApiResource {
	id: string;
	type: string;
	attributes?: Record<string, unknown>;
	relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] }>;
	meta?: Record<string, unknown>;
}

interface JsonApiDoc<D = JsonApiResource | JsonApiResource[]> {
	data?: D;
	included?: JsonApiResource[];
	links?: { next?: string };
}

// Track resource → TidalTrackV2. Artist/album names resolve through the
// resource's relationship linkage against the `included` map — linkage is
// only present when the request `include`d those types, so both fall back
// to empty/null gracefully.
function trackFromResource(r: JsonApiResource, includedById?: Map<string, JsonApiResource>): TidalTrackV2 {
	const a = (r.attributes ?? {}) as Record<string, unknown>;
	const artists: TidalTrackV2['artists'] = [];
	let album: TidalTrackV2['album'] = null;
	if (includedById) {
		const artistRefs = r.relationships?.['artists']?.data;
		for (const ref of Array.isArray(artistRefs) ? artistRefs : []) {
			const res = includedById.get(`${ref.type}:${ref.id}`);
			const name = (res?.attributes ?? {})['name'];
			if (typeof name === 'string') artists.push({ id: ref.id, name, main: artists.length === 0 });
		}
		const albumRefs = r.relationships?.['albums']?.data;
		const firstAlbum = Array.isArray(albumRefs) ? albumRefs[0] : albumRefs;
		if (firstAlbum) {
			const res = includedById.get(`${firstAlbum.type}:${firstAlbum.id}`);
			const title = (res?.attributes ?? {})['title'];
			if (typeof title === 'string') album = { id: firstAlbum.id, title };
		}
	}
	return {
		id: r.id,
		title: (a['title'] as string | undefined) ?? '',
		version: (a['version'] as string | null | undefined) ?? null,
		duration: parseIsoDurationSeconds(typeof a['duration'] === 'string' ? (a['duration'] as string) : null),
		isrc: typeof a['isrc'] === 'string' ? (a['isrc'] as string) : null,
		bpm: (a['bpm'] as number | null | undefined) ?? null,
		key: (a['key'] as string | null | undefined) ?? null,
		keyScale: (a['keyScale'] as 'MAJOR' | 'MINOR' | null | undefined) ?? null,
		explicit: a['explicit'] === true,
		artists,
		album,
		url: `https://tidal.com/browse/track/${r.id}`,
	};
}

function playlistFromResource(r: JsonApiResource): TidalPlaylist {
	const a = (r.attributes ?? {}) as { name?: string; description?: string; numberOfItems?: number; playlistType?: string; accessType?: string; lastModifiedAt?: string };
	return {
		id: r.id,
		name: a.name ?? '(untitled)',
		description: a.description ?? null,
		numberOfItems: typeof a.numberOfItems === 'number' ? a.numberOfItems : null,
		playlistType: a.playlistType ?? null,
		accessType: a.accessType ?? null,
		lastModifiedAt: typeof a.lastModifiedAt === 'string' ? a.lastModifiedAt : null,
	};
}

export class TidalApiClient {
	constructor(
		private readonly apiBase: string,
		private readonly tokenProvider: () => Promise<string>,
		private readonly countryCode: string
	) {}

	private async request<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
		const url = new URL(path, this.apiBase.endsWith('/') ? this.apiBase : this.apiBase + '/');
		// JSON:API requires countryCode for most endpoints — apply it once here.
		if (!('countryCode' in params)) params['countryCode'] = this.countryCode;
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		// 429s retry through the shared gate (which the 429 itself pushes out
		// via noteRateLimit), so one long library sync survives hitting the
		// bucket instead of failing the whole run partway.
		for (let attempt = 0; ; attempt++) {
			await waitForSlot();
			const token = await this.tokenProvider();
			const res = await fetch(url, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/vnd.api+json',
				},
			});
			if (res.status === 429 && attempt < 4) {
				const ra = Number(res.headers.get('retry-after'));
				noteRateLimit(Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt * 2); // 2s,4s,8s,16s fallback
				continue;
			}
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(`Tidal API ${res.status} ${url.pathname}: ${body}`);
			}
			return res.json() as Promise<T>;
		}
	}

	// Resolve the logged-in user. The OpenAPI spec exposes /users/me.
	async getMe(): Promise<TidalUser> {
		const doc = await this.request<JsonApiDoc<JsonApiResource>>('users/me');
		const r = doc.data;
		if (!r) throw new Error('Tidal /users/me returned no data');
		const a = (r.attributes ?? {}) as { username?: string; firstName?: string; lastName?: string; country?: string; email?: string; picture?: string };
		return {
			id: r.id,
			displayName: a.username ?? ([a.firstName, a.lastName].filter(Boolean).join(' ').trim() || null),
			country: a.country ?? null,
			email: a.email ?? null,
			picture: a.picture ?? null,
		};
	}

	// List the user's playlists. Cursor-paginated; we walk all pages.
	async listMyPlaylists(): Promise<TidalPlaylist[]> {
		const out: TidalPlaylist[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 50; i++) { // safety cap
			const params: Record<string, string> = { include: 'items', sort: '-lastModifiedAt' };
			if (cursor) params['page[cursor]'] = cursor;
			const doc = await this.request<JsonApiDoc<JsonApiResource[]>>(
				'userCollectionPlaylists/me/relationships/items',
				params
			);
			for (const r of doc.included ?? []) {
				if (r.type !== 'playlists') continue;
				out.push(playlistFromResource(r));
			}
			const next = doc.links?.next;
			if (!next) break;
			const nextUrl = new URL(next, this.apiBase);
			const c = nextUrl.searchParams.get('page[cursor]');
			if (!c) break;
			cursor = c;
		}
		return out;
	}

	// Single playlist meta. Used by the per-playlist lazy sync to compare
	// lastModifiedAt before paying for the full items walk.
	async getPlaylist(playlistId: string): Promise<TidalPlaylist | null> {
		const doc = await this.request<JsonApiDoc<JsonApiResource>>(
			`playlists/${encodeURIComponent(playlistId)}`
		).catch(() => null);
		const r = doc?.data;
		if (!r || r.type !== 'playlists') return null;
		return playlistFromResource(r);
	}

	// Fetch a single track by Tidal id. Used when the user supplies an explicit
	// Tidal URL in the Edit-Track modal — we trust their pick and skip the
	// search/score pipeline entirely.
	async getTrackById(id: string): Promise<TidalTrackV2 | null> {
		const doc = await this.request<JsonApiDoc<JsonApiResource>>(`tracks/${encodeURIComponent(id)}`).catch(() => null);
		const r = doc?.data;
		if (!r || r.type !== 'tracks') return null;
		return trackFromResource(r);
	}

	// Catalog ISRC lookup. `GET /tracks?filter[isrc]=…` is the proper catalog
	// endpoint — it's an index, not a text search. The wrong v1-style approach
	// of querying ISRC against `searchResults` returns fuzzy junk in v2.
	async getTracksByIsrc(isrc: string): Promise<TidalTrackV2[]> {
		const out: TidalTrackV2[] = [];
		const doc = await this.request<JsonApiDoc<JsonApiResource[]>>(
			'tracks',
			{ 'filter[isrc]': isrc }
		).catch(() => null);
		if (!doc?.data) return out;
		const resources = Array.isArray(doc.data) ? doc.data : [doc.data];
		for (const r of resources) {
			if (r.type !== 'tracks') continue;
			out.push(trackFromResource(r));
		}
		return out;
	}

	// Search for tracks matching a free-text query. Tidal v2 exposes search via
	// a "search result" virtual resource whose id IS the query string. The
	// returned `included[]` holds the track resources we score against.
	async searchTracks(query: string, limit = 25): Promise<TidalTrackV2[]> {
		// `searchResults` paths require the query in the path segment (not a
		// query param). encodeURIComponent on the entire string handles the
		// edge cases (spaces, slashes, ampersands).
		const out: TidalTrackV2[] = [];
		const doc = await this.request<JsonApiDoc<JsonApiResource | JsonApiResource[]>>(
			`searchResults/${encodeURIComponent(query)}/relationships/tracks`,
			{ include: 'tracks' }
		).catch(() => null);
		if (!doc) return out;
		const seen = new Set<string>();
		for (const r of doc.included ?? []) {
			if (r.type !== 'tracks' || seen.has(r.id)) continue;
			seen.add(r.id);
			// artists/albums aren't returned at this include level — the
			// helper leaves them empty/null without linkage data.
			out.push(trackFromResource(r));
			if (out.length >= limit) break;
		}
		return out;
	}

	// List a playlist's members in REMOTE ORDER, artists + album resolved.
	//
	// Two-phase on purpose:
	//   (1) Walk `relationships/items` pages and keep the `data` identifier
	//       order — that IS the playlist order (the `included` array carries
	//       each track once, unordered, so iterating it would both scramble
	//       positions and collapse duplicate members).
	//   (2) The item include level doesn't ship artist resources, so batch
	//       the collected ids through `GET /tracks?filter[id]=…` with
	//       include=artists,albums to fill names.
	async listPlaylistItems(playlistId: string): Promise<TidalPlaylistItem[]> {
		return this.listItems(`playlists/${encodeURIComponent(playlistId)}/relationships/items`);
	}

	// The user's favorited tracks ("My Collection"), newest first — the
	// API's default sort for this relationship. Same shape as a playlist's
	// items, so the sync's synthetic "Favorite Tracks" playlist reuses the
	// whole replace pipeline.
	async listFavoriteItems(): Promise<TidalPlaylistItem[]> {
		return this.listItems('userCollectionTracks/me/relationships/items');
	}

	// Favorites collection meta — lastModifiedAt + numberOfItems, the change
	// cursor that lets an unchanged collection skip the full items walk.
	async getFavoritesMeta(): Promise<{ lastModifiedAt: string | null; numberOfItems: number | null } | null> {
		const doc = await this.request<JsonApiDoc<JsonApiResource>>('userCollectionTracks/me').catch(() => null);
		const r = doc?.data;
		if (!r) return null;
		const a = (r.attributes ?? {}) as { lastModifiedAt?: string; numberOfItems?: number };
		return {
			lastModifiedAt: typeof a.lastModifiedAt === 'string' ? a.lastModifiedAt : null,
			numberOfItems: typeof a.numberOfItems === 'number' ? a.numberOfItems : null,
		};
	}

	private async listItems(relationshipPath: string): Promise<TidalPlaylistItem[]> {
		const ordered: { id: string; addedAt: string | null }[] = [];
		const attrsById = new Map<string, JsonApiResource>();
		let cursor: string | undefined;
		for (let i = 0; i < 500; i++) { // safety cap (pages are ~20 items)
			const params: Record<string, string> = { include: 'items' };
			if (cursor) params['page[cursor]'] = cursor;
			const doc = await this.request<JsonApiDoc<JsonApiResource[]>>(
				relationshipPath,
				params
			);
			for (const ref of doc.data ?? []) {
				// Playlists can hold videos too — skip anything non-track.
				if (ref.type !== 'tracks') continue;
				const addedAt = ref.meta?.['addedAt'];
				ordered.push({ id: ref.id, addedAt: typeof addedAt === 'string' ? addedAt : null });
			}
			for (const r of doc.included ?? []) {
				if (r.type === 'tracks') attrsById.set(r.id, r);
			}
			const next = doc.links?.next;
			if (!next) break;
			const nextUrl = new URL(next, this.apiBase);
			const c = nextUrl.searchParams.get('page[cursor]');
			if (!c) break;
			cursor = c;
		}

		const withNames = await this.getTracksByIds([...new Set(ordered.map((o) => o.id))]);
		return ordered.map(({ id, addedAt }) => {
			// Prefer the artist-resolved shape; fall back to the bare item-level
			// attributes so a partial phase-2 failure still yields usable rows.
			const track = withNames.get(id)
				?? (attrsById.has(id) ? trackFromResource(attrsById.get(id)!) : null);
			return track ? { track, addedAt } : null;
		}).filter((x): x is TidalPlaylistItem => x !== null);
	}

	// Batch catalog lookup by track id, artists + albums resolved. Chunked at
	// 20 ids — Tidal v2's page-size ceiling for the tracks index.
	private async getTracksByIds(ids: string[]): Promise<Map<string, TidalTrackV2>> {
		const out = new Map<string, TidalTrackV2>();
		for (let i = 0; i < ids.length; i += 20) {
			const chunk = ids.slice(i, i + 20);
			const doc = await this.request<JsonApiDoc<JsonApiResource[]>>(
				'tracks',
				{ 'filter[id]': chunk.join(','), include: 'artists,albums' }
			).catch((err) => {
				// Batch failure degrades to item-level attributes upstream —
				// log so a systematic 400 (API contract drift) is visible.
				console.warn(`[tidal] batch track lookup failed for ${chunk.length} ids`, err);
				return null;
			});
			if (!doc?.data) continue;
			const includedById = new Map<string, JsonApiResource>();
			for (const r of doc.included ?? []) includedById.set(`${r.type}:${r.id}`, r);
			const resources = Array.isArray(doc.data) ? doc.data : [doc.data];
			for (const r of resources) {
				if (r.type !== 'tracks') continue;
				out.set(r.id, trackFromResource(r, includedById));
			}
		}
		return out;
	}
}

// ISO-8601 duration → seconds. Tidal exposes durations like "PT3M45S".
function parseIsoDurationSeconds(s: string | null): number | null {
	if (!s) return null;
	const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
	if (!m) return null;
	const h = m[1] ? Number(m[1]) : 0;
	const min = m[2] ? Number(m[2]) : 0;
	const sec = m[3] ? Number(m[3]) : 0;
	return Math.round(h * 3600 + min * 60 + sec);
}

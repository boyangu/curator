// Spotify Web API client — PKCE auth + minimal user-data endpoints needed
// for Phase 1 (verify connection). Phase 2 fills in playlist sync.

import { generatePkce } from '@curator/shared';

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

export interface SpotifyAuthConfig {
	clientId: string;
	redirectUri: string;
	scopes: string;
}

export interface SpotifyTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: Date;
	scope: string;
}

export interface SpotifyMe {
	id: string;
	display_name: string | null;
	email: string | null;
	country: string;
	product: string;
	images: { url: string }[];
	external_urls: { spotify: string };
}

export interface SpotifyTrack {
	id: string;
	name: string;
	duration_ms: number;
	explicit: boolean;
	external_ids: { isrc?: string };
	artists: { id: string; name: string }[];
	album: {
		id: string;
		name: string;
		release_date: string;
		images: { url: string; width: number; height: number }[];
	};
}

export interface SpotifyArtist {
	id: string;
	name: string;
	images?: { url: string }[];
	genres?: string[];
	external_urls?: { spotify: string };
}

// Simplified album object as returned by /artists/{id}/albums and the
// `album` field of a full track. `album_group` is only present on the
// artist-albums endpoint ('album' | 'single' | 'compilation' | 'appears_on').
export interface SpotifyAlbum {
	id: string;
	name: string;
	album_type: string;
	album_group?: string;
	release_date: string;
	total_tracks: number;
	images: { url: string; width: number; height: number }[];
	artists: { id: string; name: string }[];
	external_urls?: { spotify: string };
}

// Full album object from /albums — the ONLY place Spotify exposes the
// release's `label` string (the simplified object above doesn't carry it).
// The KB's release expansion reads it to seed label entities.
export interface SpotifyFullAlbum extends SpotifyAlbum {
	label?: string;
	external_ids?: { upc?: string };
	// First page (≤ 50) of the release's tracklist; `next` pages through
	// /albums/{id}/tracks.
	tracks?: { items: Array<{ id: string; track_number: number; disc_number: number }>; next: string | null };
}

// Simplified track from /albums/{id}/tracks — no external_ids and no album
// (the caller already knows the album). Promotion paths that need ISRC use
// getTracksByIds for the full object.
export interface SpotifySimplifiedTrack {
	id: string;
	name: string;
	duration_ms: number;
	explicit: boolean;
	track_number: number;
	disc_number: number;
	artists: { id: string; name: string }[];
}

export interface SpotifyPlaylist {
	id: string;
	name: string;
	description: string | null;
	owner: { id: string; display_name: string | null };
	images: { url: string }[];
	tracks: { total: number };
	collaborative: boolean;
	public: boolean | null;
	snapshot_id: string;
	external_urls: { spotify: string };
}

// ─── PKCE helpers ──────────────────────────────────────────────────────────
// Shared with the other OAuth providers; re-exported because the desktop's
// auth flow imports it from here.

export { generatePkce };

export function buildAuthorizeUrl(
	cfg: SpotifyAuthConfig,
	codeChallenge: string,
	state: string
): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: cfg.clientId,
		redirect_uri: cfg.redirectUri,
		scope: cfg.scopes,
		code_challenge_method: 'S256',
		code_challenge: codeChallenge,
		state,
	});
	return `${AUTH_BASE}/authorize?${params}`;
}

// ─── Token exchange + refresh ───────────────────────────────────────────────

export async function exchangeCodeForTokens(
	cfg: SpotifyAuthConfig,
	code: string,
	codeVerifier: string
): Promise<SpotifyTokens> {
	const res = await fetch(`${AUTH_BASE}/api/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: cfg.redirectUri,
			client_id: cfg.clientId,
			code_verifier: codeVerifier,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Spotify token exchange failed: ${res.status} ${body}`);
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

export async function refreshTokens(
	cfg: SpotifyAuthConfig,
	refreshToken: string
): Promise<SpotifyTokens> {
	const res = await fetch(`${AUTH_BASE}/api/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: cfg.clientId,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Spotify refresh failed: ${res.status} ${body}`);
	}
	const json = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		scope: string;
	};
	return {
		accessToken: json.access_token,
		// Spotify sometimes rotates the refresh token, sometimes not
		refreshToken: json.refresh_token ?? refreshToken,
		expiresAt: new Date(Date.now() + json.expires_in * 1000),
		scope: json.scope,
	};
}

// ─── App-wide rate gate ─────────────────────────────────────────────────────
// Spotify enforces its rate limit per client-ID in a rolling window, shared
// across every user token and every SpotifyClient instance in the process. A
// burst from one subsystem (the feed's album-expander walking a new-releases
// batch) would 429 an unrelated interactive call (an album expand) that lands
// in the same window. So ALL outbound calls — reads and writes, every
// instance — serialize their *start* through this one module-level gate:
//   • a minimum spacing between request starts (steady-state ceiling), and
//   • a hard global cooldown whenever a 429 is actually observed (honoring
//     Retry-After), so the whole process backs off together instead of each
//     caller independently burning its 3-attempt retry budget against a window
//     that's already empty.
// Only request *starts* are spaced — in-flight requests still overlap, so
// throughput is interval-bound, not serialized end-to-end.
const MIN_INTERVAL_MS = 333; // ~3 starts/sec (~180/min) — under the per-app ceiling
const MAX_COOLDOWN_MS = 10_000; // cap the gate camp-out; interactive callers wait behind this
// When Spotify returns a Retry-After this long, it's not a rolling-window blip
// — the app-wide quota is spent and it has been seen returning hours-long
// values. Treat anything above this as a quota ban: fail calls fast and let
// background pollers idle (see spotifyBackoffUntil) instead of hammering the
// wall every 10s, which only reinforces the ban.
const QUOTA_BAN_RETRY_AFTER_SEC = 30;
// Cap how long pollers idle on a ban — Spotify's hours-long Retry-After would
// otherwise blank the feed for the whole window. Re-probe every 15 min; if
// still banned the next 429 just re-arms this.
const MAX_BACKOFF_MS = 15 * 60 * 1000;
let gateChain: Promise<void> = Promise.resolve();
let nextAllowedAt = 0;
let cooldownUntil = 0;
let backoffUntil = 0; // quota-ban horizon pollers honor — distinct from the gate's 10s cooldown
let gateQueued = 0; // callers currently waiting for a start slot — the saturation gauge

// Returns the time spent waiting for a slot and how many other callers were
// already queued ahead when this one arrived. Both are logged per call: a high
// `waitedMs`/`queuedAhead` on an interactive call is the signature of a
// background walk hogging the shared window.
function rateGate(): Promise<{ waitedMs: number; queuedAhead: number }> {
	const queuedAhead = gateQueued;
	gateQueued++;
	const start = Date.now();
	// Chain off the previous acquire so concurrent callers queue for distinct
	// slots rather than all reading the same `now`. The chain only sequences
	// the (short) wait-for-slot step, not the request itself.
	const wait = gateChain.then(async () => {
		const earliest = Math.max(Date.now(), nextAllowedAt, cooldownUntil);
		const delay = earliest - Date.now();
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		nextAllowedAt = Math.max(earliest, Date.now()) + MIN_INTERVAL_MS;
	});
	gateChain = wait.catch(() => {}); // a future reject must not wedge the chain
	return wait.then(
		() => {
			gateQueued--;
			return { waitedMs: Date.now() - start, queuedAhead };
		},
		(err) => {
			gateQueued--;
			throw err;
		},
	);
}

// Push the shared cooldown out whenever a 429 is seen, so every queued and
// future call waits for the rolling window to recover. A short Retry-After only
// arms the gate cooldown (≤10s); a long one (quota ban) additionally arms the
// poller backoff so background sweeps stop instead of re-banning the app.
function noteRateLimit(retryAfterSec: number): void {
	const until = Date.now() + Math.min(Math.max(retryAfterSec, 1) * 1000, MAX_COOLDOWN_MS);
	if (until > cooldownUntil) cooldownUntil = until;
	if (retryAfterSec >= QUOTA_BAN_RETRY_AFTER_SEC) {
		const backoff = Date.now() + MAX_BACKOFF_MS;
		if (backoff > backoffUntil) backoffUntil = backoff;
		console.warn(
			`[spotify] 429 quota ban — Spotify asked for ${retryAfterSec}s (~${Math.round((retryAfterSec / 3600) * 10) / 10}h). ` +
				`Failing calls fast; pollers idle ${MAX_BACKOFF_MS / 60000}min. Reduce call volume (followed-artist sweep?).`,
		);
	} else {
		console.warn(`[spotify] 429 cooldown ${Math.round((until - Date.now()) / 100) / 10}s (retry-after ${retryAfterSec}s)`);
	}
}

// How long background pollers should stay idle after a quota ban (epoch ms; 0 =
// clear). Producers check this and skip a poll entirely rather than poke a wall
// that's still up.
export function spotifyBackoffUntil(): number {
	return backoffUntil;
}

// A quota ban lives on Spotify's side keyed to the client-ID and clears on a
// fixed deadline (observed: hours). Every request while it's active risks
// topping the penalty up, so during our local backoff window we don't hit the
// network AT ALL — interactive calls included. Returns a 429-tagged error to
// throw (callers key off "429" for the rate-limit message), or null when clear.
// The window is capped at MAX_BACKOFF_MS, so the first call after it lapses
// re-probes; a still-active ban just re-arms it. This bounds real probes to
// ~one per backoff window instead of one per user click.
function bannedError(): Error | null {
	const remaining = backoffUntil - Date.now();
	if (remaining <= 0) return null;
	return new Error(`Spotify 429 (quota ban — backing off locally, ~${Math.ceil(remaining / 60000)} min left)`);
}

// ─── Call logging ────────────────────────────────────────────────────────────
// request()/write() are the single chokepoint every outbound call passes
// through, so this is the one place to see what's consuming the per-client-ID
// rate window. Each call logs: a process-unique seq, the subsystem tag (the
// owning SpotifyClient's `tag`), endpoint, HTTP status, gate wait, callers
// queued ahead, network time, and attempt. A rolling per-(endpoint,tag) tally
// is dumped on every 429 and every 200 calls so a burst is attributable after
// the fact.
//
// Set SPOTIFY_LOG=off to silence the per-call lines (the tally dumps and 429
// warnings still print).

const PER_CALL_LOG = process.env['SPOTIFY_LOG'] !== 'off';
let seq = 0;
let callsSinceDump = 0;
interface TallyRow {
	calls: number;
	rateLimited: number;
	gateWaitMs: number;
	netMs: number;
}
const tally = new Map<string, TallyRow>();

// Collapse ids/queries out of a path so calls aggregate per endpoint shape.
function endpointKey(method: string, path: string): string {
	const p = (path.split('?')[0] ?? path).replace(
		/\/(playlists|albums|artists|users)\/[^/]+/g,
		'/$1/{id}',
	);
	return `${method} ${p}`;
}

// Concise path for the per-call line: drop the huge `fields` param, keep the
// rest (limit/offset/ids are the interesting bits).
function logPath(path: string): string {
	const qIdx = path.indexOf('?');
	if (qIdx < 0) return path;
	const params = new URLSearchParams(path.slice(qIdx + 1));
	params.delete('fields');
	const ids = params.get('ids');
	if (ids && ids.length > 40) params.set('ids', `${ids.slice(0, 37)}…(${ids.split(',').length})`);
	const q = params.toString();
	return q ? `${path.slice(0, qIdx)}?${q}` : path.slice(0, qIdx);
}

function recordCall(
	method: string,
	path: string,
	tag: string,
	status: number | 'neterr',
	attempt: number,
	waitedMs: number,
	queuedAhead: number,
	netMs: number,
): void {
	const key = `${endpointKey(method, path)} [${tag}]`;
	const row = tally.get(key) ?? { calls: 0, rateLimited: 0, gateWaitMs: 0, netMs: 0 };
	row.calls++;
	row.gateWaitMs += waitedMs;
	row.netMs += netMs;
	if (status === 429) row.rateLimited++;
	tally.set(key, row);

	if (PER_CALL_LOG) {
		console.log(
			`[spotify] #${seq} ${tag} ${method} ${logPath(path)} ${status} ` +
				`wait=${waitedMs}ms ahead=${queuedAhead} net=${netMs}ms` +
				(attempt > 0 ? ` attempt=${attempt + 1}` : ''),
		);
	}
	if (status === 429) dumpTally('429 observed');
	else if (++callsSinceDump >= 200) dumpTally('200 calls');
}

function dumpTally(reason: string): void {
	callsSinceDump = 0;
	const rows = [...tally.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 15);
	if (rows.length === 0) return;
	const lines = rows.map(([key, r]) =>
		`    ${r.calls.toString().padStart(5)} calls  ${r.rateLimited} ×429  ` +
		`avg wait ${Math.round(r.gateWaitMs / r.calls)}ms  avg net ${Math.round(r.netMs / r.calls)}ms  ${key}`,
	);
	console.log(`[spotify] call tally (${reason}, top ${rows.length} by volume):\n${lines.join('\n')}`);
}

// Programmatic snapshot of the per-(endpoint,tag) tally — for tests or an
// on-demand diagnostic readout. Sorted by call volume, descending.
export function spotifyCallStats(): Array<{
	key: string;
	calls: number;
	rateLimited: number;
	avgGateWaitMs: number;
	avgNetMs: number;
}> {
	return [...tally.entries()]
		.map(([key, r]) => ({
			key,
			calls: r.calls,
			rateLimited: r.rateLimited,
			avgGateWaitMs: Math.round(r.gateWaitMs / r.calls),
			avgNetMs: Math.round(r.netMs / r.calls),
		}))
		.sort((a, b) => b.calls - a.calls);
}

// ─── Authenticated client ───────────────────────────────────────────────────

export class SpotifyClient {
	// `tag` labels this client's calls in the rate-window log — pass the owning
	// subsystem ('sync:run', 'source:spotify', 'interactive:expand', a producer
	// id) so window pressure is attributable to the path that caused it.
	constructor(
		private readonly accessToken: string,
		private readonly tag = 'untagged',
	) {}

	// GETs are idempotent, so transient network failures (undici "fetch
	// failed" with ECONNRESET on a stale keep-alive socket — seen in the
	// wild right after token refresh) and 429s retry with a short backoff.
	// HTTP error statuses other than 429 throw immediately. Writes do NOT
	// retry — POST/DELETE on playlists are not idempotent.
	private async request<T>(path: string): Promise<T> {
		const tag = this.tag;
		// Quota ban active → fail instantly without touching the network, so even
		// interactive expands can't keep the penalty alive while it decays.
		const banned = bannedError();
		if (banned) {
			seq++;
			if (PER_CALL_LOG) console.log(`[spotify] #${seq} ${tag} GET ${logPath(path)} ban-skip — ${banned.message}`);
			throw banned;
		}
		let lastErr: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			// Extra backoff for transient network-error retries; 429 waits are
			// handled by the shared cooldown the gate enforces on the next pass.
			if (attempt > 0 && lastErr instanceof TypeError) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
			const { waitedMs, queuedAhead } = await rateGate();
			seq++;
			const netStart = Date.now();
			let res: Response;
			try {
				res = await fetch(`${API_BASE}${path}`, {
					headers: { Authorization: `Bearer ${this.accessToken}` },
					// Bound every request — a hung socket must surface as an
					// error the caller can show, not an indefinite pending
					// promise behind a UI spinner.
					signal: AbortSignal.timeout(20_000),
				});
			} catch (err) {
				lastErr = err;
				recordCall('GET', path, tag, 'neterr', attempt, waitedMs, queuedAhead, Date.now() - netStart);
				continue;
			}
			const netMs = Date.now() - netStart;
			recordCall('GET', path, tag, res.status, attempt, waitedMs, queuedAhead, netMs);
			if (res.status === 429) {
				// Record the Retry-After on the shared gate so EVERY queued/future
				// call backs off together, then decide whether to retry. A short
				// Retry-After is a rolling-window blip worth one more attempt after
				// the gate's brief cooldown. A long one is a quota ban: retrying
				// just camps an interactive caller for the full 3-attempt budget
				// (the 30s "loading…" hang) and re-pokes a wall that won't move —
				// fail fast and let the next user action / poll re-probe.
				const retryAfterSec = Number(res.headers.get('retry-after') ?? '1');
				noteRateLimit(retryAfterSec);
				lastErr = new Error(`Spotify 429 ${path}`);
				if (retryAfterSec >= QUOTA_BAN_RETRY_AFTER_SEC) break;
				continue;
			}
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				throw new Error(`Spotify ${res.status} ${path}: ${body}`);
			}
			return res.json() as Promise<T>;
		}
		throw lastErr;
	}

	// Generic write — POST / PUT / DELETE. Spotify's write endpoints either
	// return a small JSON body (snapshot_id wrapper) or nothing (204). We
	// always parse-when-present so callers get the snapshot back for the
	// next-poll short-circuit.
	private async write<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
		// Writes count against the same per-client-ID window — pace them through
		// the shared gate too. No retry (POST/DELETE aren't idempotent), but a
		// 429 here still feeds the cooldown so concurrent reads back off.
		const tag = this.tag;
		// Same quota-ban short-circuit as request() — don't poke the wall.
		const banned = bannedError();
		if (banned) {
			seq++;
			if (PER_CALL_LOG) console.log(`[spotify] #${seq} ${tag} ${method} ${logPath(path)} ban-skip — ${banned.message}`);
			throw banned;
		}
		const { waitedMs, queuedAhead } = await rateGate();
		seq++;
		const netStart = Date.now();
		const res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				'Content-Type': 'application/json',
			},
			body: body == null ? undefined : JSON.stringify(body),
		});
		recordCall(method, path, tag, res.status, 0, waitedMs, queuedAhead, Date.now() - netStart);
		if (!res.ok) {
			if (res.status === 429) noteRateLimit(Number(res.headers.get('retry-after') ?? '1'));
			const txt = await res.text().catch(() => '');
			throw new Error(`Spotify ${res.status} ${method} ${path}: ${txt}`);
		}
		if (res.status === 204) return null;
		const len = res.headers.get('content-length');
		if (len === '0') return null;
		return res.json() as Promise<T>;
	}

	getMe(): Promise<SpotifyMe> {
		return this.request<SpotifyMe>('/me');
	}

	// Fetch metadata for one playlist — used to compare snapshot_id before
	// committing to a full /tracks refetch in the lazy-sync path.
	getPlaylist(id: string): Promise<SpotifyPlaylist> {
		return this.request<SpotifyPlaylist>(
			`/playlists/${encodeURIComponent(id)}?fields=id,name,description,owner(id,display_name),images,tracks(total),collaborative,public,snapshot_id,external_urls`
		);
	}

	// Paginate /me/playlists. Returns all of the user's playlists (including ones
	// they follow). "Liked Songs" is NOT included — that's /me/tracks and gets
	// synthesized as a separate playlist by the sync layer.
	async getUserPlaylists(): Promise<SpotifyPlaylist[]> {
		const out: SpotifyPlaylist[] = [];
		let next: string | null = '/me/playlists?limit=50&offset=0';
		let page = 0;
		while (next) {
			page++;
			const body: SpotifyPaginated<SpotifyPlaylist> = await this.request(next);
			out.push(...body.items);
			// URL-parse to extract pathname+search regardless of host/protocol —
			// the old simple replace(API_BASE, '') was brittle to any host quirk
			// (e.g. Spotify occasionally returning trailing slashes).
			if (body.next) {
				try {
					const u = new URL(body.next);
					next = u.pathname.replace(/^\/v1/, '') + u.search;
				} catch {
					console.warn('[spotify] could not parse next URL', body.next);
					next = null;
				}
			} else {
				next = null;
			}
		}
		console.log(`[spotify] /me/playlists complete: ${out.length} playlists across ${page} page(s)`);
		return out;
	}

	// Paginate /playlists/{id}/tracks. Yields each PlaylistTrack item (which
	// wraps Track plus per-item metadata like added_at). null `track` happens
	// when a track is removed from Spotify catalog but still in the playlist —
	// filtered out by the caller.
	async getPlaylistTracks(playlistId: string): Promise<SpotifyPlaylistTrack[]> {
		const out: SpotifyPlaylistTrack[] = [];
		let next: string | null =
			`/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&offset=0` +
			'&fields=' +
			encodeURIComponent(
				// track_number / disc_number + the album's artists / type / size
				// feed the album seam (apps/core/src/library/albums.ts) so a
				// newly synced track lands on a fully described release.
				'next,items(added_at,added_by.id,is_local,track(id,name,duration_ms,explicit,external_ids,external_urls,track_number,disc_number,artists(id,name),album(id,name,release_date,images,album_type,total_tracks,artists(id,name))))'
			);
		while (next) {
			const page: SpotifyPaginated<SpotifyPlaylistTrack> = await this.request(next);
			out.push(...page.items);
			next = page.next ? page.next.replace(API_BASE, '') : null;
		}
		return out;
	}

	// Liked Songs — separate Spotify endpoint, same shape we adapt to playlist track
	async getLikedSongs(): Promise<SpotifyPlaylistTrack[]> {
		const out: SpotifyPlaylistTrack[] = [];
		let next: string | null = '/me/tracks?limit=50&offset=0';
		while (next) {
			const page: SpotifyPaginated<SpotifyPlaylistTrack> = await this.request(next);
			out.push(...page.items);
			next = page.next ? page.next.replace(API_BASE, '') : null;
		}
		return out;
	}

	// ─── Discover-feed reads ────────────────────────────────────────────

	// Followed artists. Cursor-paginated (after=<last artist id>), unlike
	// the offset pagination every other endpoint uses. Requires the
	// user-follow-read scope — older stored tokens without it get a 403
	// until the user reconnects.
	async getFollowedArtists(): Promise<SpotifyArtist[]> {
		const out: SpotifyArtist[] = [];
		let after: string | null = null;
		for (;;) {
			const path: string = `/me/following?type=artist&limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`;
			const body: { artists: { items: SpotifyArtist[]; cursors: { after: string | null } } } =
				await this.request(path);
			out.push(...body.artists.items);
			after = body.artists.cursors?.after ?? null;
			if (!after || body.artists.items.length === 0) break;
		}
		return out;
	}

	// Recent releases for one artist. Single page — the new-releases
	// producer only cares about the newest handful per poll; Spotify
	// returns newest-first.
	async getArtistAlbums(
		artistId: string,
		opts: { includeGroups?: string; limit?: number } = {},
	): Promise<SpotifyAlbum[]> {
		const include = opts.includeGroups ?? 'album,single';
		const limit = Math.min(opts.limit ?? 20, 50);
		const body: SpotifyPaginated<SpotifyAlbum> = await this.request(
			`/artists/${encodeURIComponent(artistId)}/albums?include_groups=${encodeURIComponent(include)}&limit=${limit}`,
		);
		return body.items;
	}

	// Full tracklist of an album (simplified track objects — no ISRC).
	async getAlbumTracks(albumId: string): Promise<SpotifySimplifiedTrack[]> {
		const out: SpotifySimplifiedTrack[] = [];
		let next: string | null = `/albums/${encodeURIComponent(albumId)}/tracks?limit=50&offset=0`;
		while (next) {
			const page: SpotifyPaginated<SpotifySimplifiedTrack> = await this.request(next);
			out.push(...page.items);
			next = page.next ? page.next.replace(API_BASE, '') : null;
		}
		return out;
	}

	// Full track objects by id (50 per request — chunked). Used at feed
	// promotion time to get ISRC + album art for ingest.
	async getTracksByIds(ids: string[]): Promise<SpotifyTrack[]> {
		const out: SpotifyTrack[] = [];
		for (const chunk of chunkArray(ids, 50)) {
			const body: { tracks: (SpotifyTrack | null)[] } = await this.request(
				`/tracks?ids=${chunk.map(encodeURIComponent).join(',')}`,
			);
			for (const t of body.tracks) if (t) out.push(t);
		}
		return out;
	}

	// Full artist objects by id (50 per request — chunked). Powers the KB
	// artist `detail` aspect (images + genre strings).
	async getArtists(ids: string[]): Promise<SpotifyArtist[]> {
		const out: SpotifyArtist[] = [];
		for (const chunk of chunkArray(ids, 50)) {
			const body: { artists: (SpotifyArtist | null)[] } = await this.request(
				`/artists?ids=${chunk.map(encodeURIComponent).join(',')}`,
			);
			for (const a of body.artists) if (a) out.push(a);
		}
		return out;
	}

	// One page of an artist's releases with pagination surfaced — the KB
	// `releases` aspect walks the whole catalog page by page (unlike the
	// newest-handful single-page read above, which the feed producer keeps).
	async getArtistAlbumsPage(
		artistId: string,
		opts: { includeGroups?: string; limit?: number; offset?: number } = {},
	): Promise<SpotifyPaginated<SpotifyAlbum>> {
		const include = opts.includeGroups ?? 'album,single';
		const limit = Math.min(opts.limit ?? 50, 50);
		const offset = opts.offset ?? 0;
		return await this.request(
			`/artists/${encodeURIComponent(artistId)}/albums?include_groups=${encodeURIComponent(include)}&limit=${limit}&offset=${offset}`,
		);
	}

	// Artist search — journey seeding and agent-stub → catalog unification.
	async searchArtists(query: string, limit = 10): Promise<SpotifyArtist[]> {
		const body: { artists?: SpotifyPaginated<SpotifyArtist> } = await this.request(
			`/search?type=artist&q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 50)}`,
		);
		return body.artists?.items ?? [];
	}

	// Track search — the in-app agent's catalog lookup. Full track objects
	// (ISRC + album) so hits can seed KB entities / result sets directly.
	async searchTracks(query: string, limit = 10): Promise<SpotifyTrack[]> {
		const body: { tracks?: SpotifyPaginated<SpotifyTrack> } = await this.request(
			`/search?type=track&q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 50)}`,
		);
		return body.tracks?.items ?? [];
	}

	// Full album objects by id (20 per request — the documented /albums
	// ceiling). The full object is the only carrier of `label`.
	async getAlbums(ids: string[]): Promise<SpotifyFullAlbum[]> {
		const out: SpotifyFullAlbum[] = [];
		for (const chunk of chunkArray(ids, 20)) {
			const body: { albums: (SpotifyFullAlbum | null)[] } = await this.request(
				`/albums?ids=${chunk.map(encodeURIComponent).join(',')}`,
			);
			for (const a of body.albums) if (a) out.push(a);
		}
		return out;
	}

	// ─── Writes ─────────────────────────────────────────────────────────
	// All write endpoints require playlist-modify-public / -private scopes;
	// missing scope produces a 403 with a clear body. Track ids on the wire
	// are spotify:track:<id> URIs — callers pass raw ids, we wrap.

	async createPlaylist(userId: string, name: string, opts: { description?: string; isPublic?: boolean } = {}): Promise<SpotifyPlaylist> {
		const body = {
			name,
			description: opts.description ?? '',
			public: opts.isPublic ?? false,
		};
		const created = await this.write<SpotifyPlaylist>(
			'POST',
			`/users/${encodeURIComponent(userId)}/playlists`,
			body,
		);
		if (!created) throw new Error('Spotify createPlaylist returned empty body');
		return created;
	}

	// Spotify has no "delete playlist". The equivalent on a playlist you
	// own is to unfollow it — which removes it from your library. Other
	// followers keep their copy. Documented as the canonical delete path.
	async unfollowPlaylist(playlistId: string): Promise<void> {
		await this.write<void>('DELETE', `/playlists/${encodeURIComponent(playlistId)}/followers`);
	}

	// DELETE /me/following?type=artist — stop following an artist, removing
	// them from the new-releases producer's scan on the next poll. Mirrors the
	// /me/following reader used to build the followed-artist list.
	async unfollowArtist(artistId: string): Promise<void> {
		await this.write<void>('DELETE', `/me/following?type=artist&ids=${encodeURIComponent(artistId)}`);
	}

	// PUT /playlists/{id}  — change name / description / public flag.
	// Spotify accepts a partial body (only present fields are updated). 200 OK
	// with empty body on success; 403 when the auth scope is missing; 404 for
	// a playlist the user doesn't own. We don't return anything: callers
	// re-sync via /playlists/{id} if they need the post-change snapshot.
	async changePlaylistDetails(
		playlistId: string,
		patch: { name?: string; description?: string; isPublic?: boolean },
	): Promise<void> {
		const body: Record<string, unknown> = {};
		if (patch.name !== undefined) body['name'] = patch.name;
		if (patch.description !== undefined) body['description'] = patch.description;
		if (patch.isPublic !== undefined) body['public'] = patch.isPublic;
		if (Object.keys(body).length === 0) return;
		await this.write<void>('PUT', `/playlists/${encodeURIComponent(playlistId)}`, body);
	}

	// Max 100 URIs per request. We chunk so the caller can pass any size.
	// snapshot_id is returned per chunk; we return only the final one
	// (each subsequent write supersedes the prior snapshot).
	async addPlaylistTracks(playlistId: string, trackIds: string[]): Promise<{ snapshot_id: string }> {
		if (trackIds.length === 0) return { snapshot_id: '' };
		let snapshot = '';
		for (const chunk of chunkArray(trackIds, 100)) {
			const uris = chunk.map(toTrackUri);
			const res = await this.write<{ snapshot_id: string }>(
				'POST',
				`/playlists/${encodeURIComponent(playlistId)}/tracks`,
				{ uris },
			);
			if (res?.snapshot_id) snapshot = res.snapshot_id;
		}
		return { snapshot_id: snapshot };
	}

	// Remove every occurrence of each given track id. Same 100-per-request
	// cap as add. NB: this removes ALL occurrences of the URI in the
	// playlist — for duplicate-aware deletes (remove one instance, leave
	// the other), you'd pass `positions` per URI, which we don't need yet
	// because curator's reorder path uses replace, not remove.
	async removePlaylistTracks(playlistId: string, trackIds: string[]): Promise<{ snapshot_id: string }> {
		if (trackIds.length === 0) return { snapshot_id: '' };
		let snapshot = '';
		for (const chunk of chunkArray(trackIds, 100)) {
			const tracks = chunk.map((id) => ({ uri: toTrackUri(id) }));
			const res = await this.write<{ snapshot_id: string }>(
				'DELETE',
				`/playlists/${encodeURIComponent(playlistId)}/tracks`,
				{ tracks },
			);
			if (res?.snapshot_id) snapshot = res.snapshot_id;
		}
		return { snapshot_id: snapshot };
	}

	// Positional reorder — the uris-less form of PUT /playlists/{id}/tracks:
	// {range_start, insert_before, range_length} moves rows IN PLACE, so each
	// item's added_at survives. (A uris replace re-adds everything, resetting
	// added_at for the whole playlist — how the 2026-06-27 recovery flattened
	// ~80 playlists' recency.) Moves apply sequentially with pre-move indices;
	// snapshot_id chains through so Spotify applies each against the state
	// the previous one produced.
	async reorderPlaylistTracks(
		playlistId: string,
		moves: Array<{ range_start: number; insert_before: number; range_length?: number }>,
		snapshotId?: string | null,
	): Promise<{ snapshot_id: string }> {
		let snapshot = snapshotId ?? '';
		for (const m of moves) {
			const body: Record<string, unknown> = {
				range_start: m.range_start,
				insert_before: m.insert_before,
				range_length: m.range_length ?? 1,
			};
			if (snapshot) body['snapshot_id'] = snapshot;
			const res = await this.write<{ snapshot_id: string }>(
				'PUT',
				`/playlists/${encodeURIComponent(playlistId)}/tracks`,
				body,
			);
			if (res?.snapshot_id) snapshot = res.snapshot_id;
		}
		return { snapshot_id: snapshot };
	}

	// Full replace of a playlist's tracks. The Spotify API splits this into:
	//   PUT /playlists/{id}/tracks  (sets the first 100, replacing everything)
	//   POST /playlists/{id}/tracks (appends each subsequent 100-track chunk)
	// Single-call PUT only accepts up to 100 URIs — append is required for
	// anything larger. CAUTION: re-adds every item, resetting added_at — for
	// pure reorders use reorderPlaylistTracks above.
	async replacePlaylistTracks(playlistId: string, trackIds: string[]): Promise<{ snapshot_id: string }> {
		const chunks = chunkArray(trackIds, 100);
		let snapshot = '';
		// First chunk replaces; if zero tracks, an explicit empty replace
		// clears the playlist.
		const first = chunks[0] ?? [];
		const firstRes = await this.write<{ snapshot_id: string }>(
			'PUT',
			`/playlists/${encodeURIComponent(playlistId)}/tracks`,
			{ uris: first.map(toTrackUri) },
		);
		if (firstRes?.snapshot_id) snapshot = firstRes.snapshot_id;
		for (let i = 1; i < chunks.length; i++) {
			const res = await this.write<{ snapshot_id: string }>(
				'POST',
				`/playlists/${encodeURIComponent(playlistId)}/tracks`,
				{ uris: chunks[i]!.map(toTrackUri) },
			);
			if (res?.snapshot_id) snapshot = res.snapshot_id;
		}
		return { snapshot_id: snapshot };
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────

function toTrackUri(id: string): string {
	// Accept either raw id or full URI — be liberal in input, normalize.
	return id.startsWith('spotify:') ? id : `spotify:track:${id}`;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	if (arr.length === 0) return [];
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

export interface SpotifyPaginated<T> {
	href: string;
	items: T[];
	limit: number;
	next: string | null;
	offset: number;
	previous: string | null;
	total: number;
}

export interface SpotifyPlaylistTrack {
	added_at: string;
	added_by: { id: string } | null;
	is_local: boolean;
	track: SpotifyTrack | null;
}

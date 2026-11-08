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

// email / country / product are gone from GET /me under the February 2026
// Development Mode rules (see SPOTIFY_2026 below).
export interface SpotifyMe {
	id: string;
	display_name: string | null;
	email?: string | null;
	country?: string;
	product?: string;
	images: { url: string }[];
	external_urls: { spotify: string };
}

export interface SpotifyTrack {
	id: string;
	name: string;
	duration_ms: number;
	explicit: boolean;
	// Absent under the 2026 rules — the ISRC then has to come from elsewhere.
	external_ids?: { isrc?: string };
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
	// Spotify now calls this `items`; normalizePlaylist maps it back.
	tracks: { total: number };
	// Spotify withheld the playlist's items (2026 rules: only owners and
	// collaborators see them). Its tracks can't be read — not "it's empty".
	itemsWithheld?: boolean;
	collaborative: boolean;
	public: boolean | null;
	snapshot_id: string;
	external_urls: { spotify: string };
}

// ─── Spotify's 2026 API (SPOTIFY_2026) ─────────────────────────────────────
// The February 2026 Development Mode rules (moved onto existing apps in March,
// with a postponement some older apps — ours, as of 2026-10-26 — still enjoy):
// batch GET /tracks|/albums|/artists?ids= removed; /playlists/{id}/tracks
// renamed /items, with each entry's `track` now `item` and the playlist's
// `tracks` now `items`; a playlist's items served only to its owner and
// collaborators; POST /users/{id}/playlists → POST /me/playlists; follow /
// unfollow → /me/library with URIs; search capped at 10 results; ISRC, UPC and
// label dropped from track and album objects.
//
// The client speaks both: each call tries its preferred form and falls back to
// the other when Spotify says that form doesn't exist here (FORM_GONE), and
// remembers which one answered, so the switch-over needs no release. Batch reads
// prefer the batch (one call instead of 50) and drop to single lookups only once
// Spotify refuses the batch. A write is only re-sent in the other form after a
// rejection, which Spotify returns before doing anything.

export class SpotifyHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'SpotifyHttpError';
	}
}

// Spotify withheld a playlist's items. Callers must leave what they hold for
// that playlist untouched — reading this as "the playlist is now empty" would
// remove every row locally (and from rekordbox on the next push).
export class SpotifyPlaylistItemsWithheldError extends Error {
	constructor(readonly playlistId: string, detail: string) {
		super(`Spotify no longer shares this playlist's tracks with Curator (${detail})`);
		this.name = 'SpotifyPlaylistItemsWithheldError';
	}
}

// Statuses that mean "this form of the request isn't served here" rather than
// a failure of the request itself. 400 counts for writes and filtered reads: a
// body or `fields` shape the other API version doesn't know.
const FORM_GONE = new Set([400, 403, 404, 410]);
const formChoice = new Map<string, number>();

function normalizePlaylist(raw: SpotifyPlaylist & { items?: { total?: number } }): SpotifyPlaylist {
	const count = raw.tracks ?? raw.items;
	const { items: _items, ...rest } = raw;
	return {
		...rest,
		tracks: { total: count?.total ?? 0 },
		...(count ? {} : { itemsWithheld: true }),
	};
}

type RawPlaylistEntry = Omit<SpotifyPlaylistTrack, 'track'> & { track?: SpotifyTrack | null; item?: SpotifyTrack | null };

function normalizeEntry(raw: RawPlaylistEntry): SpotifyPlaylistTrack {
	const { item, track, ...rest } = raw;
	return { ...rest, track: track ?? item ?? null };
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
// Only request *starts* are paced — in-flight requests still overlap, so
// throughput is rate-bound, not serialized end-to-end.
//
// The pace is a token bucket: a short burst (a page of cards matching, an
// album expand's handful of calls) goes out at once, and a long walk (the
// catalogue worker's artist sweep) settles at the refill rate. The client id
// is shared with the local master's own readers, which pace themselves
// (apps/cloud catalog/spotify-pace.ts); the two together stay well under the
// volume that earned the app a 3-hour ban on 2026-11-06 (~4,700 calls in 20
// minutes, ~235/min).
// Configurable (configureSpotifyPace, or CURATOR_SPOTIFY_BURST /
// CURATOR_SPOTIFY_PER_SEC in the environment): `burst` is how many calls may
// start at once from an idle gate, `perSec` the sustained ceiling after that.
export interface SpotifyPace {
	burst: number;
	perSec: number;
}
const DEFAULT_PACE: SpotifyPace = { burst: 4, perSec: 1 }; // 4 at once, then 60 calls/min
const envNum = (name: string): number | null => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : null;
};
let pace: SpotifyPace = {
	burst: envNum('CURATOR_SPOTIFY_BURST') ?? DEFAULT_PACE.burst,
	perSec: envNum('CURATOR_SPOTIFY_PER_SEC') ?? DEFAULT_PACE.perSec,
};
export function configureSpotifyPace(next: Partial<SpotifyPace>): SpotifyPace {
	pace = { ...pace, ...next };
	tokens = Math.min(tokens, pace.burst);
	return { ...pace };
}
export function spotifyPace(): SpotifyPace {
	return { ...pace };
}
const MAX_COOLDOWN_MS = 10_000; // cap the gate camp-out; interactive callers wait behind this
// When Spotify returns a Retry-After this long, it's not a rolling-window blip
// — the app-wide quota is spent and it has been seen returning hours-long
// values. Treat anything above this as a quota ban: fail every call fast,
// interactive ones included, until the deadline Spotify named.
const QUOTA_BAN_RETRY_AFTER_SEC = 30;
// The ban is honoured in full (Spotify's deadline is fixed; probing it earlier
// only takes another 429 and, per its docs, can extend it), with a sanity cap
// for a nonsense header.
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
let gateChain: Promise<void> = Promise.resolve();
let tokens = pace.burst;
let lastRefillAt = Date.now();
let cooldownUntil = 0;
let backoffUntil = 0; // quota-ban horizon every caller honours — distinct from the gate's 10s cooldown
let gateQueued = 0; // callers currently waiting for a start slot — the saturation gauge

// The ban deadline outlives the process: the desktop restarts (a dev loop, a
// crash) and each fresh process used to re-probe the wall at once — four
// restarts on 2026-11-06 meant four more 429s. Core wires an app_setting-
// backed store on boot; tests and the CLI run without one.
export interface SpotifyBackoffStore {
	load(): number | null;
	save(until: number): void;
}
let backoffStore: SpotifyBackoffStore | null = null;
export function configureSpotifyBackoffStore(store: SpotifyBackoffStore | null): void {
	backoffStore = store;
	const stored = store?.load() ?? 0;
	if (stored > backoffUntil) backoffUntil = stored;
}

function refillTokens(now: number): void {
	tokens = Math.min(pace.burst, tokens + ((now - lastRefillAt) / 1000) * pace.perSec);
	lastRefillAt = now;
}

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
		// A cooldown (a 429 just seen) holds every start; then a token, or the
		// wait until the bucket refills one.
		const cool = cooldownUntil - Date.now();
		if (cool > 0) await new Promise((r) => setTimeout(r, cool));
		refillTokens(Date.now());
		if (tokens < 1) {
			await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / pace.perSec) * 1000)));
			refillTokens(Date.now());
		}
		tokens = Math.max(0, tokens - 1);
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
// arms the gate cooldown (≤10s) and empties the bucket; a long one (quota ban)
// arms the backoff every caller fails fast against until Spotify's deadline.
function noteRateLimit(retryAfterSec: number): void {
	const until = Date.now() + Math.min(Math.max(retryAfterSec, 1) * 1000, MAX_COOLDOWN_MS);
	if (until > cooldownUntil) cooldownUntil = until;
	tokens = 0;
	lastRefillAt = Date.now();
	if (retryAfterSec >= QUOTA_BAN_RETRY_AFTER_SEC) {
		const backoff = Date.now() + Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
		if (backoff > backoffUntil) {
			backoffUntil = backoff;
			try { backoffStore?.save(backoff); } catch { /* the deadline still holds for this process */ }
		}
		console.warn(
			`[spotify] 429 quota ban — Spotify asked for ${retryAfterSec}s (~${Math.round((retryAfterSec / 3600) * 10) / 10}h). ` +
				`No Spotify call goes out until ${new Date(backoffUntil).toISOString()}.`,
		);
	} else {
		console.warn(`[spotify] 429 cooldown ${Math.round((until - Date.now()) / 100) / 10}s (retry-after ${retryAfterSec}s)`);
	}
}

// The quota-ban deadline (epoch ms; 0 = clear). Producers and the catalogue
// worker check this and skip a poll entirely rather than poke a wall that's
// still up.
export function spotifyBackoffUntil(): number {
	return backoffUntil > Date.now() ? backoffUntil : 0;
}

// A quota ban lives on Spotify's side keyed to the client-ID and clears on a
// fixed deadline (observed: hours). Every request while it's active risks
// topping the penalty up, so until then we don't hit the network AT ALL —
// interactive calls included. Returns a 429-tagged error to throw (callers key
// off "429" for the rate-limit message), or null when clear.
const BAN_MESSAGE = 'Spotify 429 (quota ban';
function bannedError(): Error | null {
	const remaining = backoffUntil - Date.now();
	if (remaining <= 0) return null;
	return new Error(`${BAN_MESSAGE} — no calls until ${new Date(backoffUntil).toLocaleTimeString()}, ~${Math.ceil(remaining / 60000)} min left)`);
}

// Whether an error is the local ban refusal (no network was touched): callers
// that would otherwise record a failed attempt leave the item untried instead.
export function isSpotifyQuotaBackoff(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(BAN_MESSAGE);
}

// The gate as a plain `fetch`, for code that builds its own Spotify requests
// (the catalogue readers a desktop runs for its follows, @curator/catalog-
// readers): every call takes a start slot behind the same gate as the
// SpotifyClient instances, a 429 arms the shared cooldown, and the call is in
// the same log. The caller handles the status; no retry (the readers'
// getJson turns a 429 into their own rate-limit error).
export async function gatedFetch(url: string, init?: RequestInit, tag = 'catalog:reader'): Promise<Response> {
	const path = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
	const method = init?.method ?? 'GET';
	const banned = bannedError();
	if (banned) {
		seq++;
		if (PER_CALL_LOG) console.log(`[spotify] #${seq} ${tag} ${method} ${logPath(path)} ban-skip — ${banned.message}`);
		throw banned;
	}
	const { waitedMs, queuedAhead } = await rateGate();
	seq++;
	const netStart = Date.now();
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (err) {
		recordCall(method, path, tag, 'neterr', 0, waitedMs, queuedAhead, Date.now() - netStart);
		throw err;
	}
	recordCall(method, path, tag, res.status, 0, waitedMs, queuedAhead, Date.now() - netStart);
	if (res.status === 429) noteRateLimit(Number(res.headers.get('retry-after') ?? '1'));
	return res;
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
				throw new SpotifyHttpError(res.status, `Spotify ${res.status} ${path}: ${body}`);
			}
			return res.json() as Promise<T>;
		}
		throw lastErr;
	}

	// One logical call in its alternative forms (SPOTIFY_2026), the last answer
	// that worked tried first. `gone` is the set of statuses that move on to the
	// next form; anything else is the call's real outcome and is thrown as is.
	private async inForms<T>(key: string, forms: Array<() => Promise<T>>, gone: Set<number> = FORM_GONE): Promise<T> {
		const first = formChoice.get(key) ?? 0;
		const order = [first, ...forms.map((_, i) => i).filter((i) => i !== first)];
		let lastErr: unknown;
		for (const i of order) {
			try {
				const out = await forms[i]!();
				if (i !== first) {
					formChoice.set(key, i);
					console.log(`[spotify] ${key}: switched to form ${i + 1} of ${forms.length}`);
				}
				return out;
			} catch (err) {
				if (!(err instanceof SpotifyHttpError) || !gone.has(err.status)) throw err;
				lastErr = err;
			}
		}
		throw lastErr;
	}

	// Batch lookup with single-id fallback. A batch the API no longer serves
	// is only written off once a single lookup succeeds — a 403 that both
	// forms share is a real refusal (bad token), not the endpoint going away.
	private async lookupMany<T extends { id: string }>(
		key: string,
		ids: string[],
		chunk: number,
		batch: (ids: string[]) => Promise<(T | null)[]>,
		single: (id: string) => Promise<T>,
	): Promise<T[]> {
		const out: T[] = [];
		const singles = async (part: string[]): Promise<void> => {
			for (const id of part) {
				try {
					out.push(await single(id));
				} catch (err) {
					// A batch answers null for an unknown id; keep that contract.
					if (err instanceof SpotifyHttpError && (err.status === 404 || err.status === 400)) continue;
					throw err;
				}
			}
		};
		for (const part of chunkArray(ids, chunk)) {
			if (formChoice.get(key) === 1) {
				await singles(part);
				continue;
			}
			try {
				for (const x of await batch(part)) if (x) out.push(x);
			} catch (err) {
				if (!(err instanceof SpotifyHttpError) || !FORM_GONE.has(err.status)) throw err;
				const before = out.length;
				await singles(part);
				if (out.length > before) {
					formChoice.set(key, 1);
					console.log(`[spotify] ${key}: batch refused (${err.status}), using single lookups`);
				}
			}
		}
		return out;
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
			throw new SpotifyHttpError(res.status, `Spotify ${res.status} ${method} ${path}: ${txt}`);
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
	// Both names of the count go into the filter (SPOTIFY_2026); an API that
	// rejects the filter gets the unfiltered object.
	async getPlaylist(id: string): Promise<SpotifyPlaylist> {
		const base = `/playlists/${encodeURIComponent(id)}`;
		const raw = await this.inForms('playlist-meta', [
			() => this.request<SpotifyPlaylist>(`${base}?fields=id,name,description,owner(id,display_name),images,tracks(total),items(total),collaborative,public,snapshot_id,external_urls`),
			() => this.request<SpotifyPlaylist>(base),
		], new Set([400]));
		return normalizePlaylist(raw);
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
			out.push(...body.items.map(normalizePlaylist));
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

	// Paginate a playlist's items. Yields each PlaylistTrack item (which
	// wraps Track plus per-item metadata like added_at). null `track` happens
	// when a track is removed from Spotify catalog but still in the playlist —
	// filtered out by the caller.
	//
	// Never returns a short list in place of the real one: callers replace
	// their rows with what this returns, so a withheld or truncated answer
	// throws (SpotifyPlaylistItemsWithheldError / Error) instead.
	async getPlaylistTracks(playlistId: string): Promise<SpotifyPlaylistTrack[]> {
		// track_number / disc_number + the album's artists / type / size feed
		// the album seam (apps/core/src/library/albums.ts) so a newly synced
		// track lands on a fully described release.
		const trackFields = '(id,name,duration_ms,explicit,external_ids,external_urls,track_number,disc_number,artists(id,name),album(id,name,release_date,images,album_type,total_tracks,artists(id,name)))';
		const base = `/playlists/${encodeURIComponent(playlistId)}`;
		const itemsFields = `next,total,items(added_at,added_by.id,is_local,item${trackFields},track${trackFields})`;
		const tracksFields = `next,total,items(added_at,added_by.id,is_local,track${trackFields})`;
		let itemsStatus: number | null = null;
		type Page = SpotifyPaginated<RawPlaylistEntry>;
		let first: Page;
		try {
			first = await this.inForms<Page>('playlist-items', [
				() => this.request<Page>(`${base}/items?limit=100&offset=0&fields=${encodeURIComponent(itemsFields)}`).catch((err) => {
					if (err instanceof SpotifyHttpError) itemsStatus = err.status;
					throw err;
				}),
				() => this.request<Page>(`${base}/tracks?limit=100&offset=0&fields=${encodeURIComponent(tracksFields)}`),
				() => this.request<Page>(`${base}/items?limit=100&offset=0`),
			]);
		} catch (err) {
			// Only the owner/collaborator rule answers 403 on /items; a missing
			// playlist is a 404 and stays a plain error.
			if (itemsStatus === 403 && err instanceof SpotifyHttpError) {
				throw new SpotifyPlaylistItemsWithheldError(playlistId, `items ${itemsStatus}, last form ${err.status}`);
			}
			throw err;
		}
		const out: SpotifyPlaylistTrack[] = [];
		let page: Page = first;
		for (;;) {
			if (!Array.isArray(page.items)) throw new SpotifyPlaylistItemsWithheldError(playlistId, 'no items in the answer');
			// The /me/playlists quirk (right total, empty items) seen on a
			// playlist would read as "emptied" — refuse it.
			if (page.items.length === 0 && out.length < (page.total ?? 0)) {
				throw new Error(`Spotify returned ${out.length} of ${page.total} items for playlist ${playlistId}; not trusting a short list`);
			}
			out.push(...page.items.map(normalizeEntry));
			if (!page.next) break;
			page = await this.request<Page>(page.next.replace(API_BASE, ''));
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
	getTracksByIds(ids: string[]): Promise<SpotifyTrack[]> {
		return this.lookupMany<SpotifyTrack>(
			'tracks-batch',
			ids,
			50,
			async (part) => (await this.request<{ tracks: (SpotifyTrack | null)[] }>(`/tracks?ids=${part.map(encodeURIComponent).join(',')}`)).tracks,
			(id) => this.request<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`),
		);
	}

	// Full artist objects by id (50 per request — chunked). Powers the KB
	// artist `detail` aspect (images + genre strings).
	getArtists(ids: string[]): Promise<SpotifyArtist[]> {
		return this.lookupMany<SpotifyArtist>(
			'artists-batch',
			ids,
			50,
			async (part) => (await this.request<{ artists: (SpotifyArtist | null)[] }>(`/artists?ids=${part.map(encodeURIComponent).join(',')}`)).artists,
			(id) => this.request<SpotifyArtist>(`/artists/${encodeURIComponent(id)}`),
		);
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
		const body = await this.search<{ artists?: SpotifyPaginated<SpotifyArtist> }>('artist', query, limit);
		return body.artists?.items ?? [];
	}

	// Track search — the in-app agent's catalog lookup. Full track objects
	// (ISRC + album) so hits can seed KB entities / result sets directly.
	async searchTracks(query: string, limit = 10): Promise<SpotifyTrack[]> {
		const body = await this.search<{ tracks?: SpotifyPaginated<SpotifyTrack> }>('track', query, limit);
		return body.tracks?.items ?? [];
	}

	// Album search — the feed's lazy Spotify match for a release that arrived
	// from a store (core feed/spotify-match.ts): by `upc:` or by album + artist.
	async searchAlbums(query: string, limit = 10): Promise<SpotifyAlbum[]> {
		const body = await this.search<{ albums?: SpotifyPaginated<SpotifyAlbum> }>('album', query, limit);
		return body.albums?.items ?? [];
	}

	// The 2026 rules cap `limit` at 10 (SPOTIFY_2026): a larger ask that comes
	// back 400 is re-asked at 10, and later searches stay at 10.
	private search<T>(type: 'artist' | 'track' | 'album', query: string, limit: number): Promise<T> {
		const at = (n: number) => () =>
			this.request<T>(`/search?type=${type}&q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), n)}`);
		if (limit <= 10) return at(10)();
		return this.inForms('search-limit', [at(50), at(10)], new Set([400]));
	}

	// Full album objects by id (20 per request — the documented /albums
	// ceiling). The full object is the only carrier of `label`.
	getAlbums(ids: string[]): Promise<SpotifyFullAlbum[]> {
		return this.lookupMany<SpotifyFullAlbum>(
			'albums-batch',
			ids,
			20,
			async (part) => (await this.request<{ albums: (SpotifyFullAlbum | null)[] }>(`/albums?ids=${part.map(encodeURIComponent).join(',')}`)).albums,
			(id) => this.request<SpotifyFullAlbum>(`/albums/${encodeURIComponent(id)}`),
		);
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
		const created = await this.inForms('create-playlist', [
			() => this.write<SpotifyPlaylist>('POST', '/me/playlists', body),
			() => this.write<SpotifyPlaylist>('POST', `/users/${encodeURIComponent(userId)}/playlists`, body),
		]);
		if (!created) throw new Error('Spotify createPlaylist returned empty body');
		return normalizePlaylist(created);
	}

	// Track-list writes on /items with /tracks as the older form (SPOTIFY_2026).
	// The 2026 DELETE body names its list `items`, the older one `tracks`.
	private playlistItemsWrite<T>(
		method: 'POST' | 'PUT' | 'DELETE',
		playlistId: string,
		body: Record<string, unknown>,
		olderBody: Record<string, unknown> = body,
	): Promise<T | null> {
		const base = `/playlists/${encodeURIComponent(playlistId)}`;
		return this.inForms(`playlist-items-${method}`, [
			() => this.write<T>(method, `${base}/items`, body),
			() => this.write<T>(method, `${base}/tracks`, olderBody),
		]);
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
		await this.inForms('unfollow-artist', [
			() => this.write<void>('DELETE', '/me/library', { uris: [`spotify:artist:${artistId}`] }),
			() => this.write<void>('DELETE', `/me/following?type=artist&ids=${encodeURIComponent(artistId)}`),
		]);
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
			const res = await this.playlistItemsWrite<{ snapshot_id: string }>('POST', playlistId, { uris });
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
			const entries = chunk.map((id) => ({ uri: toTrackUri(id) }));
			const res = await this.playlistItemsWrite<{ snapshot_id: string }>('DELETE', playlistId, { items: entries }, { tracks: entries });
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
			const res = await this.playlistItemsWrite<{ snapshot_id: string }>('PUT', playlistId, body);
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
		const firstRes = await this.playlistItemsWrite<{ snapshot_id: string }>('PUT', playlistId, { uris: first.map(toTrackUri) });
		if (firstRes?.snapshot_id) snapshot = firstRes.snapshot_id;
		for (let i = 1; i < chunks.length; i++) {
			const res = await this.playlistItemsWrite<{ snapshot_id: string }>('POST', playlistId, { uris: chunks[i]!.map(toTrackUri) });
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

// Spotify Web Playback SDK host (runs in the sidecar's hidden renderer).
//
// This is a near-verbatim relocation of the Spotify logic that used to live in
// the desktop renderer's player.ts (ensureSpotify / playSpotify /
// handleSpotifyStateChange / position polling). The control surface is now
// JSON-RPC: commands arrive via window.spx.onCommand, results/events go back
// via window.spx. Tokens are fetched from the host on demand (the desktop
// CoreService still owns Spotify auth).

// ── SDK + bridge typings ────────────────────────────────────────────────────
type SpotifyPlayer = {
	connect(): Promise<boolean>;
	addListener(event: string, cb: (data: unknown) => void): boolean;
	togglePlay(): Promise<void>;
	pause(): Promise<void>;
	resume(): Promise<void>;
	seek(positionMs: number): Promise<void>;
	setVolume(volume: number): Promise<void>;
	getCurrentState(): Promise<SpotifyState | null>;
	activateElement(): Promise<void>;
};
type SpotifyState = {
	paused: boolean;
	position: number; // ms
	duration: number; // ms
	track_window: {
		current_track: {
			id: string;
			name: string;
			artists: { name: string }[];
			album: { images: { url: string }[] };
		};
	};
};
type SpotifyPlayerOpts = {
	name: string;
	getOAuthToken: (cb: (token: string) => void) => void;
	volume?: number;
};
interface SpxBridge {
	onCommand(cb: (cmd: { id: number; method: string; params?: unknown }) => void): void;
	sendResult(id: number, result: unknown, error: { kind: string; message: string } | null): void;
	emit(ev: unknown): void;
	requestToken(): void;
	onToken(cb: (token: string | null) => void): void;
	ready(): void;
}
declare global {
	interface Window {
		Spotify?: { Player: new (opts: SpotifyPlayerOpts) => SpotifyPlayer };
		onSpotifyWebPlaybackSDKReady?: () => void;
		spx: SpxBridge;
	}
}

const spx = window.spx;

// ── token bridge ────────────────────────────────────────────────────────────
// The host answers requestToken() with a single set_token push. We resolve
// every in-flight waiter on each push — the SDK's getOAuthToken and the
// explicit play-time fetch share the same channel.
let tokenWaiters: ((t: string | null) => void)[] = [];
spx.onToken((t) => {
	const ws = tokenWaiters;
	tokenWaiters = [];
	for (const w of ws) w(t);
});
function getToken(): Promise<string | null> {
	return new Promise((resolve) => {
		tokenWaiters.push(resolve);
		spx.requestToken();
	});
}

// ── SDK lifecycle ───────────────────────────────────────────────────────────
let player: SpotifyPlayer | null = null;
let deviceId: string | null = null;
let ready: Promise<void> | null = null;
let activated = false;

async function ensureSpotify(): Promise<void> {
	if (ready) return ready;
	ready = (async () => {
		if (!window.Spotify) {
			await new Promise<void>((resolve, reject) => {
				const s = document.createElement('script');
				s.src = 'https://sdk.scdn.co/spotify-player.js';
				s.async = true;
				s.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'));
				document.head.appendChild(s);
				window.onSpotifyWebPlaybackSDKReady = () => resolve();
			});
		}
		const p = new window.Spotify!.Player({
			name: 'Curator',
			getOAuthToken: (cb) => {
				getToken().then((t) => { if (t) cb(t); }).catch(() => { /* SDK surfaces auth_error */ });
			},
		});
		p.addListener('ready', (data: unknown) => {
			deviceId = (data as { device_id: string }).device_id;
			spx.emit({ event: 'ready', deviceId });
		});
		p.addListener('not_ready', () => { deviceId = null; });
		p.addListener('initialization_error', (e: unknown) => log('init error', e));
		p.addListener('authentication_error', (e: unknown) => {
			log('auth error', e);
			spx.emit({ event: 'auth_error', message: errMessage(e) });
		});
		p.addListener('account_error', (e: unknown) => {
			log('account error (Premium required?)', e);
			spx.emit({ event: 'auth_error', message: errMessage(e) });
		});
		p.addListener('playback_error', (e: unknown) => log('playback error', e));
		p.addListener('player_state_changed', (st: unknown) => {
			if (st) handleStateChange(st as SpotifyState);
		});
		const ok = await p.connect();
		if (!ok) throw new Error('Spotify SDK connect() returned false');
		// connect() resolves before "ready" fires — wait briefly for the device id.
		await new Promise<void>((resolve) => {
			const start = Date.now();
			const tick = (): void => {
				if (deviceId) return resolve();
				if (Date.now() - start > 8000) return resolve();
				setTimeout(tick, 100);
			};
			tick();
		});
		player = p;
	})();
	return ready;
}

// ── state → events ──────────────────────────────────────────────────────────
// Natural-end detection mirrors the original renderer logic: Spotify reports
// paused + position 0 when a track finishes on its own; compare against the
// previous tick to distinguish that from a user pause+seek.
let lastPosition = 0;
let lastDuration = 0;
let lastPlaying = false;

function emitState(st: SpotifyState): void {
	const t = st.track_window.current_track;
	spx.emit({
		event: 'state_changed',
		position: st.position / 1000,
		duration: st.duration / 1000,
		playing: !st.paused,
		track: {
			id: t.id,
			title: t.name,
			artist: t.artists.map((a) => a.name).join(', '),
			coverUrl: t.album.images[0]?.url ?? null,
		},
	});
}

// Keep the most-recent progress fresh. Fed by BOTH the transition handler AND
// the 50ms poll — without the poll feeding it, lastPosition stayed at the
// track-start value (~0) for the whole track, so the natural-end check below
// ("last known position was near the end") never passed and the feed never
// auto-advanced.
function rememberProgress(st: SpotifyState): void {
	lastPosition = st.position;
	lastDuration = st.duration;
	lastPlaying = !st.paused;
}

function handleStateChange(st: SpotifyState): void {
	emitState(st);
	// The SDK reports paused + position 0 when a track finishes on its own.
	// Distinguish that from a user pause / seek-to-start by requiring the LAST
	// known position (kept near the end by the poll) to be within 2s of the
	// duration. Compute BEFORE remembering this (paused, pos-0) transition.
	const naturalEnd = st.paused && st.position === 0 && lastPlaying
		&& lastPosition > lastDuration - 2000;
	if (naturalEnd) spx.emit({ event: 'ended' });
	rememberProgress(st);
}

// 50ms position poll — the SDK exposes no position event, only transition
// events. The desktop DeckController needs ~50ms position precision for
// quantize/loop scheduling, so we poll getCurrentState while playing and push
// state_changed, exactly as the renderer's old startPositionPolling did.
let pollTimer: ReturnType<typeof setInterval> | null = null;
function startPolling(): void {
	if (pollTimer != null) return;
	pollTimer = setInterval(() => {
		if (!player) return;
		player.getCurrentState().then((st) => {
			if (st && !st.paused) { emitState(st); rememberProgress(st); } /* keep progress fresh for natural-end */
		}).catch(() => { /* transient */ });
	}, 50);
}

// ── play ────────────────────────────────────────────────────────────────────
async function trackPlayable(sourceTrackId: string, token: string): Promise<boolean | null> {
	try {
		const r = await fetch(
			`https://api.spotify.com/v1/tracks/${encodeURIComponent(sourceTrackId)}?market=from_token`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!r.ok) return null;
		const body = (await r.json()) as { is_playable?: boolean };
		return body.is_playable ?? null;
	} catch {
		return null;
	}
}

async function play(sourceTrackId: string): Promise<void> {
	await ensureSpotify();
	if (!deviceId) throw rpcError('internal', 'Spotify device not ready');
	startPolling();
	// Prime EME once. With autoplay-policy disabled this is largely belt-and-
	// suspenders, but it forces the CDM session up before the first license
	// request rather than lazily mid-play.
	if (!activated && player) {
		try { await player.activateElement(); activated = true; } catch { /* non-fatal */ }
	}
	const tok = await getToken();
	if (!tok) throw rpcError('auth', 'No Spotify token (reconnect required)');
	const resp = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ uris: [`spotify:track:${sourceTrackId}`] }),
	});
	if (!resp.ok && resp.status !== 204) {
		const text = await resp.text().catch(() => '');
		// 403 "Restriction violated" is ambiguous: region-locked track vs.
		// another device owning the session. Disambiguate via a market-scoped
		// is_playable probe — a definitive false is region-unavailable, which
		// the host maps back to SpotifyTrackUnavailableError so the Discover
		// feed flags + skips it.
		if (resp.status === 403 && /Restriction violated/i.test(text)) {
			const playable = await trackPlayable(sourceTrackId, tok);
			// Marker token in the message: `kind` doesn't survive the host's
			// ipcRenderer.invoke serialization, so player.ts matches the message.
			if (playable === false) throw rpcError('track_unavailable', 'SPOTIFY_TRACK_UNAVAILABLE: track unavailable in this market');
		}
		throw rpcError('play', `Spotify play failed: ${resp.status} ${text}`);
	}
}

// ── command dispatch ────────────────────────────────────────────────────────
interface RpcError { kind: string; message: string }
function rpcError(kind: string, message: string): RpcError {
	return { kind, message };
}
function isRpcError(e: unknown): e is RpcError {
	return !!e && typeof e === 'object' && typeof (e as RpcError).kind === 'string';
}
function errMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
	return String(e);
}
function log(...args: unknown[]): void {
	// Renderer console → main's stderr via Chromium logging.
	console.error('[spotify-sdk]', ...args);
}

async function runCommand(method: string, params: unknown): Promise<unknown> {
	const p = (params ?? {}) as Record<string, unknown>;
	switch (method) {
		case 'ensure':
			await ensureSpotify();
			return { ready: true, deviceId };
		case 'play':
			await play(String(p.sourceTrackId));
			return {};
		case 'pause':
			await player?.pause();
			return {};
		case 'resume':
			await player?.resume();
			return {};
		case 'toggle':
			await player?.togglePlay();
			return {};
		case 'seek':
			await player?.seek(Number(p.seconds) * 1000);
			return {};
		case 'set_volume':
			await player?.setVolume(Number(p.volume));
			return {};
		case 'stop':
			// SDK has no unload; pause is the closest stop. The device stays
			// registered so the next play is fast.
			await player?.pause().catch(() => { /* nothing loaded yet */ });
			return {};
		default:
			throw rpcError('internal', `unknown method: ${method}`);
	}
}

spx.onCommand((cmd) => {
	runCommand(cmd.method, cmd.params)
		.then((result) => spx.sendResult(cmd.id, result, null))
		.catch((e) => {
			const err = isRpcError(e) ? e : { kind: 'internal', message: errMessage(e) };
			spx.sendResult(cmd.id, null, err);
		});
});

spx.ready();

// Module marker — makes the `declare global` above legal (a file with no
// import/export is treated as a script, where global augmentation is an error).
export {};

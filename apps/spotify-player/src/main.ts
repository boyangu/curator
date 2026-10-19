// Electron main for the headless Spotify playback sidecar.
//
// Why this process exists: the Spotify Web Playback SDK needs a Chromium
// renderer with Widevine/EME. Rather than chain the whole desktop app to the
// castlabs fork + VMP signing, that DRM-bound work is isolated here — a tiny
// Electron app built + signed once and bundled as a resource. The desktop app
// spawns it and talks JSON-RPC over a loopback socket (see the host at
// apps/desktop/src/main/spotify-sidecar.ts).
//
// Transport: an Electron main process CANNOT reliably read piped stdin (it
// sees immediate EOF) and leaks stray bytes onto stdout, so — unlike the Rust
// audio sidecar — we don't use stdio for the protocol. The host listens on
// 127.0.0.1 and passes --rpc-port/--rpc-nonce; we connect, prove ourselves
// with the nonce, then exchange LF-delimited JSON frames over the socket.
// stderr is still piped (for logs).

import { app, BrowserWindow, components, ipcMain } from 'electron';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';

// ── logging → stderr only ───────────────────────────────────────────────────
function log(msg: string): void {
	process.stderr.write(`[spotify-sidecar] ${msg}\n`);
}

// Lift the autoplay gesture requirement — this process is headless, so there's
// no user gesture to prime EME with. (The desktop renderer used
// activateElement() inside a click; here we just remove the policy.) Force
// Chromium's own logging to stderr too.
app.commandLine.appendSwitch('enable-logging', 'stderr');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── RPC socket to the host ──────────────────────────────────────────────────
function argValue(name: string): string {
	const pref = `--${name}=`;
	const hit = process.argv.find((a) => a.startsWith(pref));
	return hit ? hit.slice(pref.length) : '';
}
const rpcPort = Number(argValue('rpc-port')) || 0;
const rpcNonce = argValue('rpc-nonce');

let sock: Socket | null = null;
let sockConnected = false;
const sockWriteQueue: string[] = [];

function writeFrame(obj: unknown): void {
	const frame = JSON.stringify(obj) + '\n';
	if (sock && sockConnected) sock.write(frame);
	else sockWriteQueue.push(frame);
}

function connectRpc(): void {
	if (!rpcPort) { log('no --rpc-port; cannot reach host — quitting'); app.quit(); return; }
	const s = connect(rpcPort, '127.0.0.1', () => {
		// Prove ourselves to the host before anything else.
		s.write(rpcNonce + '\n');
		sockConnected = true;
		for (const f of sockWriteQueue.splice(0)) s.write(f);
		log(`rpc connected on port ${rpcPort}`);
	});
	s.setEncoding('utf8');
	let buf = '';
	s.on('data', (chunk: string) => {
		buf += chunk;
		let idx = buf.indexOf('\n');
		while (idx >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.trim().length > 0) handleRequest(line);
			idx = buf.indexOf('\n');
		}
	});
	// Host went away (closed socket / exited) — nothing left to serve.
	s.on('close', () => { log('rpc socket closed — quitting'); app.quit(); });
	s.on('error', (err) => { log(`rpc socket error: ${String(err)}`); app.quit(); });
	sock = s;
}

// ── command buffering until the renderer is ready ───────────────────────────
let win: BrowserWindow | null = null;
let rendererReady = false;
const pendingCmds: { id: number; method: string; params?: unknown }[] = [];

function dispatchToRenderer(cmd: { id: number; method: string; params?: unknown }): void {
	if (!rendererReady || !win || win.isDestroyed()) {
		pendingCmds.push(cmd);
		return;
	}
	win.webContents.send('spx:cmd', cmd);
}

function handleRequest(line: string): void {
	let msg: { id?: number; method?: string; params?: unknown };
	try {
		msg = JSON.parse(line);
	} catch {
		log(`non-JSON request: ${line}`);
		return;
	}
	const id = typeof msg.id === 'number' ? msg.id : null;
	const method = msg.method;
	if (id == null || !method) return;

	// Handled in main directly — no renderer round-trip needed.
	if (method === 'set_token') {
		const token = (msg.params as { token?: string | null } | undefined)?.token ?? null;
		if (win && !win.isDestroyed()) win.webContents.send('spx:token', token);
		writeFrame({ id, result: {} });
		return;
	}
	if (method === 'shutdown') {
		writeFrame({ id, result: {} });
		app.quit();
		return;
	}
	// Everything else (ensure/play/pause/resume/toggle/seek/set_volume/stop)
	// is the renderer's job — forward and let it echo a result by id.
	dispatchToRenderer({ id, method, params: msg.params });
}

// ── sidecar renderer → host ─────────────────────────────────────────────────
ipcMain.on('spx:ready', () => {
	rendererReady = true;
	for (const cmd of pendingCmds.splice(0)) {
		if (win && !win.isDestroyed()) win.webContents.send('spx:cmd', cmd);
	}
});
ipcMain.on('spx:result', (_e, payload: { id: number; result: unknown; error: { kind: string; message: string } | null }) => {
	if (payload.error) writeFrame({ id: payload.id, error: payload.error });
	else writeFrame({ id: payload.id, result: payload.result });
});
ipcMain.on('spx:evt', (_e, ev: unknown) => {
	writeFrame(ev);
});
ipcMain.on('spx:need-token', () => {
	writeFrame({ event: 'need_token' });
});

// Connect to the host as early as possible so play commands aren't lost while
// the window boots (handleRequest buffers them until the renderer is ready).
connectRpc();

// ── boot ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
	log('app ready; awaiting Widevine components…');
	try { await components.whenReady(); log('Widevine components ready'); }
	catch (err) { log(`components.whenReady failed: ${String(err)}`); }

	win = new BrowserWindow({
		show: false,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false,
		},
	});

	win.webContents.on('render-process-gone', (_e, details) => {
		log(`renderer gone: ${details.reason}`);
		app.quit();
	});

	await win.loadFile(join(__dirname, '../renderer/index.html'));
	log('renderer loaded');
}).catch((err) => {
	log(`boot failed: ${String(err)}`);
	app.quit();
});

app.on('window-all-closed', () => { app.quit(); });

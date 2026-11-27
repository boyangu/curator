// The Cloud Admin tab: the cloud's back office (apps/cloud cli/backoffice.ts)
// inside this app, against production, for the operator only.
//
// Why it is shaped like this:
//   - Operator only. It exists when all three hold: the build says
//     CURATOR_OPERATOR=1 (baked from the repo's .env, electron.vite.config.ts),
//     the app runs unpackaged — from the repo, where the back office's source
//     is — and the repo's .env holds the schema owner's connection string.
//     No packaged build, and nobody else's machine, ever has the tab.
//   - The credential never leaves this process. It is read from the repo's
//     .env when the tab is first opened (never baked into a bundle, never
//     sent to the renderer, never logged) and handed to the back office as
//     its child environment alone. The back office reaches Postgres over
//     verified TLS (apps/cloud db/tls.ts).
//   - Nobody else can drive it. The back office listens on loopback only,
//     answers this machine's pages only (Host and JSON checks, cli/loopback.ts),
//     and — run from here — only requests carrying a secret made fresh for
//     each launch (CURATOR_ADMIN_TOKEN). That secret lives in this process and
//     the back office's, and is added to requests by this view's own session,
//     which nothing else uses: no page in a browser and no other program on
//     the machine can read or write production through it. Every write is
//     stamped with this machine and user by the back office itself.
//   - The page runs as a web page: its own in-memory session, sandboxed, no
//     Node, no preload; no new windows; it cannot navigate off the back office
//     (an https link opens in the system browser instead).
//
// Started when the tab is first opened, stopped when the app quits. Kept in
// this one module: the operator's tools are to leave the open-source repo.

import { app, BrowserWindow, session, shell, WebContentsView, type Session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { CloudAdminBounds, CloudAdminStatus } from '../ipc.js';
import { mainLog } from './log.js';

const log = mainLog.for('cloud-admin');

// out/main → apps/desktop/out/main: the repo is four up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const START_TIMEOUT_MS = 90_000;
const PARTITION = 'cloud-admin';

export interface CloudAdmin {
	available(): boolean;
	// Starts the back office when it is not running, and shows it over `bounds`.
	open(bounds: CloudAdminBounds): Promise<CloudAdminStatus>;
	bounds(bounds: CloudAdminBounds): void;
	hide(): void;
	stop(): void;
}

// The schema owner's connection string from the repo's .env, by shape only
// (as scripts/cloud-db-apply.mjs checks it); null when absent or not one.
function ownerUrl(): string | null {
	const file = join(REPO_ROOT, '.env');
	if (!existsSync(file)) return null;
	for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith('CURATOR_DB_OWNER_URL=')) continue;
		let value = line.slice('CURATOR_DB_OWNER_URL='.length).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		try {
			const u = new URL(value);
			if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
			if (!/^postgres([.]|$)/.test(decodeURIComponent(u.username))) return null;
			return value;
		} catch {
			return null;
		}
	}
	return null;
}

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const s = createServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const addr = s.address();
			s.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
		});
	});

// A page saying what went wrong, in the view itself.
const errorPage = (reason: string): string =>
	`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Cloud Admin</title><body style="font:14px system-ui;padding:32px;color:#444"><h2 style="margin:0 0 8px">Cloud Admin did not start</h2><p>${reason.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</p></body>`)}`;

export function createCloudAdmin(deps: { getMainWindow: () => BrowserWindow | null }): CloudAdmin {
	let child: ChildProcess | null = null;
	let origin: string | null = null;
	let starting: Promise<void> | null = null;
	let failure: string | null = null;
	let view: WebContentsView | null = null;
	let viewWindow: BrowserWindow | null = null;
	let ses: Session | null = null;

	const available = (): boolean => process.env.CURATOR_OPERATOR === '1' && !app.isPackaged && ownerUrl() !== null;

	async function start(): Promise<void> {
		const url = ownerUrl();
		if (!url) throw new Error('the repo .env holds no owner connection string (CURATOR_DB_OWNER_URL)');
		const port = await freePort();
		const token = randomBytes(32).toString('hex');
		const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, CURATOR_BACKOFFICE_PORT: String(port), CURATOR_ADMIN_TOKEN: token };
		delete env.ELECTRON_RUN_AS_NODE;
		// pnpm is a .cmd on Windows, which Node starts only through a shell; the
		// arguments are fixed, nothing of the page's reaches them.
		const proc = spawn('pnpm', ['--filter', '@curator/cloud', 'backoffice'], { cwd: REPO_ROOT, env, shell: process.platform === 'win32', windowsHide: true });
		child = proc;
		let tail = '';
		const keep = (b: Buffer): void => {
			tail = (tail + b.toString()).slice(-2000);
		};
		proc.stderr?.on('data', keep);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no answer in ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS);
			proc.stdout?.on('data', (b: Buffer) => {
				keep(b);
				if (new RegExp(`http://127\\.0\\.0\\.1:${port}/backoffice`).test(tail)) {
					clearTimeout(timer);
					resolve();
				}
			});
			proc.once('exit', (code) => {
				clearTimeout(timer);
				// The last lines say why; the credential is never in them (the
				// back office names no connection string it refuses).
				reject(new Error(`the back office exited (${code ?? 'signal'}): ${tail.trim().split(/\r?\n/).slice(-3).join(' · ').slice(0, 400)}`));
			});
		});
		proc.once('exit', (code) => {
			if (child === proc) {
				child = null;
				origin = null;
				log.warn('the back office stopped', { code });
			}
		});
		origin = `http://127.0.0.1:${port}`;
		// This view's own session: the secret goes on its requests to the back
		// office, and nowhere else.
		ses = session.fromPartition(PARTITION);
		ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
		ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => cb({ requestHeaders: { ...details.requestHeaders, 'x-curator-admin': token } }));
		log.info('the back office is up', { port });
	}

	function ensureView(win: BrowserWindow): WebContentsView {
		if (view && viewWindow === win) return view;
		if (view && viewWindow && !viewWindow.isDestroyed()) viewWindow.contentView.removeChildView(view);
		ses ??= session.fromPartition(PARTITION);
		const v = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
		const ours = (url: string): boolean => !!origin && (url === origin || url.startsWith(`${origin}/`));
		const outside = (url: string): void => {
			if (url.startsWith('https://')) void shell.openExternal(url);
		};
		v.webContents.setWindowOpenHandler(({ url }) => {
			outside(url);
			return { action: 'deny' };
		});
		const guard = (e: { preventDefault(): void }, url: string): void => {
			if (ours(url) || url.startsWith('data:')) return;
			e.preventDefault();
			outside(url);
		};
		v.webContents.on('will-navigate', guard);
		v.webContents.on('will-redirect', guard);
		win.contentView.addChildView(v);
		view = v;
		viewWindow = win;
		return v;
	}

	const place = (b: CloudAdminBounds): void => {
		view?.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
	};

	return {
		available,

		async open(bounds) {
			if (!available()) return { state: 'unavailable', reason: 'Cloud Admin is for the operator, from the repo' };
			const win = deps.getMainWindow();
			if (!win || win.isDestroyed()) return { state: 'failed', reason: 'no window' };
			const v = ensureView(win);
			place(bounds);
			v.setVisible(true);
			if (!origin) {
				failure = null;
				starting ??= start().catch((e: unknown) => {
					failure = e instanceof Error ? e.message : String(e);
					log.warn('the back office did not start', { error: failure });
					stopChild();
				}).finally(() => {
					starting = null;
				});
				await starting;
				if (failure) {
					void v.webContents.loadURL(errorPage(failure));
					return { state: 'failed', reason: failure };
				}
				void v.webContents.loadURL(`${origin}/backoffice#/settings`);
			} else if (!v.webContents.getURL().startsWith(origin)) {
				void v.webContents.loadURL(`${origin}/backoffice#/settings`);
			}
			return { state: 'ready', reason: null };
		},

		bounds: place,

		hide() {
			view?.setVisible(false);
		},

		stop() {
			stopChild();
			if (view && viewWindow && !viewWindow.isDestroyed()) viewWindow.contentView.removeChildView(view);
			view?.webContents.close();
			view = null;
			viewWindow = null;
		},
	};

	// The back office and anything pnpm started under it: on Windows a shell
	// sits between, and only the tree's kill reaches the server.
	function stopChild(): void {
		const proc = child;
		child = null;
		origin = null;
		if (!proc?.pid) return;
		if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
		else proc.kill('SIGTERM');
	}
}

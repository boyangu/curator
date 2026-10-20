// One-shot recovery for a renderer load that a network change killed.
//
// When the host gains or loses a network adapter (WSL's Hyper-V vEthernet
// coming up on a cold `wsl.exe` spawn, a VPN connecting, Docker starting),
// Chromium aborts every in-flight request with ERR_NETWORK_CHANGED — and that
// includes the renderer's own page and, in dev, every module the Vite server
// is still streaming. A module graph with one aborted import never evaluates,
// so the window stays blank until someone presses Ctrl+R. The analyzer spawn
// is already deferred past the first load (CoreService.startAnalyzer); this is
// the defence in depth for every other source of a network change.
//
// Policy: reload once the burst settles, at most MAX_AUTO_RELOADS times per
// window. The cap is for the window's lifetime, never reset — a page that
// keeps failing must not turn into a reload loop. Electron-free so it is
// unit-testable; index.ts wires it to did-fail-load + webRequest.

// net::ERR_NETWORK_CHANGED (net/base/net_error_list.h). did-fail-load reports
// the number; webRequest.onErrorOccurred reports the string.
export const ERR_NETWORK_CHANGED = -21;
const ERR_NETWORK_CHANGED_TEXT = 'net::ERR_NETWORK_CHANGED';

export const MAX_AUTO_RELOADS = 2;
// Reloading the instant the error lands tends to hit the same change while
// Chromium's network stack is still re-probing; same reasoning (and figure)
// as the dev resume reload in index.ts. Also coalesces the burst: dozens of
// module requests fail at once and should cost one reload.
export const RELOAD_SETTLE_MS = 800;

export interface LoadRecoveryTarget {
	reload(): void;
	isDestroyed(): boolean;
}

export interface LoadRecoveryLog {
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
}

export class LoadRecovery {
	private reloads = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private gaveUp = false;

	constructor(
		private readonly target: LoadRecoveryTarget,
		private readonly log: LoadRecoveryLog,
		private readonly opts: { maxReloads?: number; settleMs?: number } = {},
	) {}

	// webContents 'did-fail-load'. Sub-frame failures and other codes (notably
	// ERR_ABORTED, which a superseded navigation reports) are not ours.
	onFailLoad(errorCode: number, url: string, isMainFrame: boolean): void {
		if (!isMainFrame || errorCode !== ERR_NETWORK_CHANGED) return;
		this.schedule('page', url);
	}

	// session.webRequest.onErrorOccurred, already scoped by the caller to the
	// renderer's own origin and webContents — a failed third-party fetch
	// (Spotify API, cover art) must never reload the app.
	onRequestError(error: string, url: string): void {
		if (error !== ERR_NETWORK_CHANGED_TEXT) return;
		this.schedule('resource', url);
	}

	get reloadCount(): number { return this.reloads; }

	dispose(): void {
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
	}

	private schedule(kind: 'page' | 'resource', url: string): void {
		if (this.timer) return;
		const max = this.opts.maxReloads ?? MAX_AUTO_RELOADS;
		if (this.reloads >= max) {
			if (!this.gaveUp) {
				this.gaveUp = true;
				this.log.warn('renderer load hit ERR_NETWORK_CHANGED again — auto-reload limit reached, press Ctrl+R', { kind, url, reloads: this.reloads });
			}
			return;
		}
		this.reloads++;
		this.log.info('renderer load hit ERR_NETWORK_CHANGED — reloading', { kind, url, attempt: this.reloads, max });
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.target.isDestroyed()) this.target.reload();
		}, this.opts.settleMs ?? RELOAD_SETTLE_MS);
	}
}

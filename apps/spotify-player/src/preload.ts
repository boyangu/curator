// Preload bridge for the Spotify sidecar's hidden renderer. Exposes a tiny,
// typed surface (`window.spx`) so the SDK-hosting renderer never touches
// ipcRenderer directly. The contextIsolation boundary holds even though the
// renderer loads a remote script (Spotify's CDN SDK) — that script can't reach
// Node or the broader ipcRenderer.
import { contextBridge, ipcRenderer } from 'electron';

// Command from main (forwarded from the host's stdin JSON-RPC). `id`
// correlates the eventual result frame; `method`/`params` mirror the host
// protocol (see apps/desktop/src/main/spotify-sidecar.ts).
export interface SpxCommand {
	id: number;
	method: string;
	params?: unknown;
}

const bridge = {
	// Subscribe to commands pushed from main. Returns nothing — there's a
	// single subscriber (sdk.ts) for the process lifetime.
	onCommand(cb: (cmd: SpxCommand) => void): void {
		ipcRenderer.on('spx:cmd', (_e, cmd: SpxCommand) => cb(cmd));
	},
	// Reply to a command. Exactly one of result/error is meaningful; error
	// carries a `kind` so the host can reconstruct a typed rejection (e.g.
	// track_unavailable) across the stdio boundary.
	sendResult(id: number, result: unknown, error: { kind: string; message: string } | null): void {
		ipcRenderer.send('spx:result', { id, result, error });
	},
	// Push an async event up to the host (state_changed / ended / ready /
	// auth_error). Shape mirrors the SpotifyEvent union in apps/desktop/src/ipc.ts.
	emit(ev: unknown): void {
		ipcRenderer.send('spx:evt', ev);
	},
	// Ask the host for a fresh Spotify access token. The host answers with a
	// `set_token` command that resolves via onToken below.
	requestToken(): void {
		ipcRenderer.send('spx:need-token');
	},
	onToken(cb: (token: string | null) => void): void {
		ipcRenderer.on('spx:token', (_e, token: string | null) => cb(token));
	},
	// Tell main the renderer script has loaded and can accept commands. Main
	// buffers any commands that arrive before this.
	ready(): void {
		ipcRenderer.send('spx:ready');
	},
};

contextBridge.exposeInMainWorld('spx', bridge);

export type Spx = typeof bridge;

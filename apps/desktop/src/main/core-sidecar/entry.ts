// Core sidecar entry. Runs inside an Electron utility process spawned by
// apps/desktop/src/main/core-sidecar/host.ts. Owns the @curator/core service
// (DB, scanner, sync, downloads, analyzer queue, ...) so none of that work
// touches the main process's event loop.
//
// Protocol shapes live in ./protocol.ts — keep this and host.ts in sync.
//
// Lifecycle:
//   1. Process starts; this module loads.
//   2. We call createCoreService(dbPath, ...adapters).
//   3. Once core is ready we emit a `ready` frame. Main waits on this
//      before letting the renderer open IPC channels.
//   4. From then on we accept `call` frames (forward RPC from renderer
//      through main into the service) and emit `event` frames for
//      subscriptions. Reverse RPC (`host-call`) is for Electron-only
//      operations like parse.audio, fetch.beatport, OAuth windows.

import { createCoreService, type CoreService, type ParseFn, type ParseResult } from '@curator/core';
import { createLogger, isLogLevel } from '@curator/shared/log';
import type {
	MainToSidecar,
	SidecarToMain,
	CallFrame,
	HostResultFrame,
	HostErrorFrame,
} from './protocol.js';

// process.parentPort is added by Electron when the script is launched via
// app.utilityProcess.fork. If it's missing, someone tried to run this with
// plain `node` — fail loud so the bug can't masquerade as a silent hang.
if (!process.parentPort) {
	throw new Error('core-sidecar entry must be launched via app.utilityProcess.fork');
}

const parentPort = process.parentPort;

function send(msg: SidecarToMain): void {
	parentPort.postMessage(msg);
}

// ─── Reverse RPC plumbing ────────────────────────────────────────────────
//
// The sidecar's adapters (parseAudio, beatportFetch, openSpotifyAuth, …)
// each post a host-call frame and await a host-result/host-error frame.
// We multiplex many concurrent calls over the same channel via `id`.

let nextHostCallId = 1;
interface PendingHostCall {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
}
const pendingHostCalls = new Map<number, PendingHostCall>();

function hostCall<T>(method: string, args: unknown[]): Promise<T> {
	const id = nextHostCallId++;
	return new Promise<T>((resolve, reject) => {
		pendingHostCalls.set(id, { resolve: resolve as (v: unknown) => void, reject });
		send({ kind: 'host-call', id, method, args });
	});
}

function resolveHostCall(frame: HostResultFrame | HostErrorFrame): void {
	const pending = pendingHostCalls.get(frame.id);
	if (!pending) {
		slog.warn(`host-${frame.kind === 'host-result' ? 'result' : 'error'} for unknown id`, { id: frame.id });
		return;
	}
	pendingHostCalls.delete(frame.id);
	if (frame.kind === 'host-result') pending.resolve(frame.value);
	else pending.reject(new Error(frame.message));
}

// ─── Service construction ────────────────────────────────────────────────
//
// Minimal-config boot for step 1. As later migration steps move things
// over, this section grows: peaks dir + analyzer/rekordbox specs from
// env, beatportFetch as a hostCall, more adapters.

const dbPath = process.env['CURATOR_DB_PATH'];
if (!dbPath) {
	// pre-logger / fatal: console so the host's stderr pipe captures it
	console.error('[core-sidecar] CURATOR_DB_PATH not set');
	process.exit(1);
}

const parseAudio: ParseFn = (path) => hostCall<ParseResult>('parse.audio', [path]);

// Sidecar logger: port-only. Records forward to main, which owns the single
// JSONL file AND the dev console render — a console sink here would double-
// print every record in dev (once via the host's stdout pipe, once via
// main's own console sink). Records are stamped proc:'core' and
// level-filtered HERE; main writes them through verbatim. Stray non-logger
// output (crash dumps, third-party prints) still reaches main via the
// host's stdio pipes.
const sidecarLog = createLogger({
	proc: 'core',
	// Same policy as main's envLevel(): explicit override, else debug in dev
	// (ELECTRON_RENDERER_URL rides in via the host's env spread), info packaged.
	level: isLogLevel(process.env['CURATOR_LOG_LEVEL'])
		? process.env['CURATOR_LOG_LEVEL']
		: process.env['ELECTRON_RENDERER_URL'] ? 'debug' : 'info',
	sinks: [{ write: (record) => send({ kind: 'log', record }) }],
});

const slog = sidecarLog.for('core-sidecar');

let core: CoreService;
try {
	core = createCoreService(dbPath, { parseAudio, logger: sidecarLog });
} catch (err) {
	// pre-logger / fatal: console so the host's stderr pipe captures it
	console.error('[core-sidecar] failed to construct core', err);
	process.exit(1);
}

// Forward scan progress to main as an event frame; main re-broadcasts on the
// `library:scan-progress` channel to every renderer (see host.ts fanoutEvent).
// Without this, the renderer would never see scan ticks because the scanner
// now runs in this sub-process, not in main.
//
// MIGRATION RULE: when moving a core subscription into this sidecar, MOVE
// it — delete the matching svc.subscribeX block in main/index.ts
// registerIpc in the same change. Both processes hold full CoreService
// instances, so a copied subscription double-emits on the same channel and
// every renderer consumer sees each event twice (progress counters double-
// count, toasts fire twice). Scan progress is safe today only because the
// scanner itself runs in exactly one process per mode.
core.subscribeLibraryScan((p) => {
	send({ kind: 'event', channel: 'library:scan-progress', payload: p });
});

// Kick off chokidar after a short delay so the renderer has time to bootstrap
// its initial IPC requests (auth status, playlists, tracks) against a quiet
// main process before the scan starts emitting events. Same rationale as the
// did-finish-load + 2s deferral in main/index.ts, but enforced sidecar-side
// instead.
setTimeout(() => {
	core.startLibraryWatching().catch((err) => {
		slog.error('startLibraryWatching failed', err);
	});
}, 2000);

// ─── Dispatch table ──────────────────────────────────────────────────────
//
// One entry per IPC channel that's migrated through the sidecar. Adding
// a channel is a one-liner: `'foo:bar': (svc, args) => svc.fooBar(...args)`.
// During the channel-by-channel migration (step 2+) entries land here as
// each handler in apps/desktop/src/main/handlers.ts switches from
// direct-call to passthrough.
//
// Methods that take a progress callback (sync:spotify:run et al.) will
// emit progress via the event channel; the dispatch entry passes a
// closure that calls send({ kind: 'event', channel: 'sync:progress', ... }).

type Dispatch = Record<string, (svc: CoreService, args: unknown[]) => Promise<unknown> | unknown>;

const dispatch: Dispatch = {
	'tracks:list': (svc, args) => {
		const [filter, sort, limit, offset] = args as [unknown, unknown, unknown, unknown];
		return svc.getTracks(filter as never, sort as never, limit as never, offset as never);
	},
	'tracks:page': (svc, args) => {
		const [filter, sort, req] = args as [unknown, unknown, unknown];
		return svc.getTracksPage(filter as never, sort as never, req as never);
	},
	'tracks:ids': (svc, args) => {
		const [filter, sort] = args as [unknown, unknown];
		return svc.getTrackIds(filter as never, sort as never);
	},
	// Hot READ-ONLY channels routed off main's event loop. Each must stay a
	// pure DB read — writes (and anything touching analyzer/rekordbox/auth)
	// stay in-process until their adapters migrate here too. Keep in sync
	// with the readViaSidecar() call sites in main/handlers.ts.
	'playlists:list': (svc) => svc.getPlaylists(),
	'playlists:list-with-folders': (svc) => svc.getPlaylistsWithFolders(),
	'tags:list': (svc) => svc.getTags(),
	'tags:counts': (svc) => svc.getTagCounts(),
	'artists:list': (svc, args) => svc.listArtists(args[0] as never),
	'artists:get': (svc, args) => svc.getArtist(args[0] as string),
	'artists:resolve': (svc, args) => svc.resolveArtistByName(args[0] as string),
	'artists:links': (svc, args) => svc.getArtistLinks(args[0] as string),
	'artists:merge-suggestions': (svc, args) => svc.listArtistMergeSuggestions(args[0] as never),
	'albums:by-ids': (svc, args) => svc.getAlbumsByIds(args[0] as string[]),
	'organize:recommend': (svc, args) => svc.recommendForSelection(args[0] as string[]),
	'tracks:tags': (svc, args) => svc.getTrackTags(args[0] as string),
	'tracks:tags-batch': (svc, args) => svc.getTrackTagsBatch(args[0] as string[]),
	'tracks:playlists': (svc, args) => svc.getTrackPlaylists(args[0] as string),
	'tracks:playlists-batch': (svc, args) => svc.getTrackPlaylistsBatch(args[0] as string[]),
	'tracks:state-counts': (svc) => svc.getStateCounts(),
	'tracks:source-counts': (svc) => svc.getSourceCounts(),
};

async function handleCall(frame: CallFrame): Promise<void> {
	const fn = dispatch[frame.method];
	if (!fn) {
		send({ kind: 'error', id: frame.id, message: `unknown method: ${frame.method}` });
		return;
	}
	try {
		const value = await fn(core, frame.args);
		send({ kind: 'result', id: frame.id, value });
	} catch (err) {
		send({
			kind: 'error',
			id: frame.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

// ─── Message loop ────────────────────────────────────────────────────────

parentPort.on('message', (evt) => {
	const msg = evt.data as MainToSidecar | undefined;
	if (!msg) return;
	if (msg.kind === 'call') {
		handleCall(msg).catch((err) => slog.error('handleCall threw', err));
	} else if (msg.kind === 'host-result' || msg.kind === 'host-error') {
		resolveHostCall(msg);
	} else if (msg.kind === 'shutdown') {
		gracefulExit();
	}
});

// Graceful teardown on the host's shutdown frame. core.close() stops the
// scanner, the analyzer + rekordbox sidecars, the source schedulers, and
// closes the SQLite handle — the work the host's proc.kill() can't reach.
// We then exit so this utility process (which holds better_sqlite3.node)
// doesn't linger and lock the .node file against the next rebuild:node.
let exiting = false;
function gracefulExit(): void {
	if (exiting) return;
	exiting = true;
	try { core.close(); } catch (err) { slog.error('close() threw', err); }
	// close() fires the child-sidecar shutdowns and returns; give them a
	// beat to land their graceful-exit RPC before we go. They also self-exit
	// on stdin EOF the moment this process dies, so a short wait is enough.
	setTimeout(() => process.exit(0), 300);
}

// Surface unhandled rejections — without this, a buggy promise chain
// silently swallows errors and looks like a hang to the renderer.
process.on('unhandledRejection', (reason) => {
	slog.error('unhandled rejection', reason);
});

send({ kind: 'ready' });
slog.info('ready');

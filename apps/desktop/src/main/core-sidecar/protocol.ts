// Wire protocol between the Electron main process and the core sidecar
// (apps/desktop/src/main/core-sidecar/entry.ts running inside a utility
// process). All frames travel over `UtilityProcess.postMessage` /
// `process.parentPort.postMessage` and are structured-cloned — no JSON
// serialization, but the same constraints apply (no functions, no
// non-cloneable objects).
//
// Three categories:
//   1. Forward RPC — renderer triggers an IPC call; main forwards into
//      the sidecar via a `call` frame; sidecar replies `result` / `error`.
//   2. Event channel — sidecar pushes events (scan progress, download
//      queue updates, etc.) that main forwards to all renderer windows.
//   3. Reverse RPC — the sidecar asks main to do an Electron-only thing
//      (parse audio via the ingest pool, run net.fetch for Beatport,
//      open the OAuth window, etc.) and awaits the result.

// ─── Forward RPC ─────────────────────────────────────────────────────────

/** Main → sidecar: please run this core method. */
export interface CallFrame {
	kind: 'call';
	id: number;
	method: string;       // IPC channel name (e.g. 'tracks:list')
	args: unknown[];
}

/** Sidecar → main: terminal success frame for a forward call. */
export interface ResultFrame {
	kind: 'result';
	id: number;
	value: unknown;
}

/** Sidecar → main: terminal failure frame for a forward call. */
export interface ErrorFrame {
	kind: 'error';
	id: number;
	message: string;
	// Optional structured error kind (e.g. 'auth_required'). Lets the
	// renderer key off a discriminator without parsing message strings.
	errKind?: string;
}

// ─── Event channel ───────────────────────────────────────────────────────

/** Sidecar → main: broadcast event. Main re-emits to every renderer via
 *  webContents.send(channel, payload). */
export interface EventFrame {
	kind: 'event';
	channel: string;
	payload: unknown;
}

// ─── Reverse RPC ─────────────────────────────────────────────────────────

/** Sidecar → main: please do this Electron-only thing. */
export interface HostCallFrame {
	kind: 'host-call';
	id: number;
	method: string;       // e.g. 'parse.audio', 'fetch.beatport'
	args: unknown[];
}

/** Main → sidecar: terminal success frame for a host-call. */
export interface HostResultFrame {
	kind: 'host-result';
	id: number;
	value: unknown;
}

/** Main → sidecar: terminal failure frame for a host-call. */
export interface HostErrorFrame {
	kind: 'host-error';
	id: number;
	message: string;
}

// ─── Logging ─────────────────────────────────────────────────────────────

import type { LogRecord } from '@curator/shared/log';

/** Sidecar → main: one structured log record. Already level-filtered and
 *  proc-stamped ('core') in the sidecar; main writes it straight through to
 *  its sinks so the whole app shares one JSONL timeline (Windows can't
 *  rotate a file another process holds open, so per-process files are out). */
export interface LogFrame {
	kind: 'log';
	record: LogRecord;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

/** Sidecar → main: emitted once after createCoreService succeeds and any
 *  startup migrations have completed. Main blocks renderer load until this
 *  arrives so the UI never queries a sidecar that isn't there yet. */
export interface ReadyFrame {
	kind: 'ready';
}

/** Main → sidecar: begin graceful teardown and exit. The sidecar calls
 *  core.close() — which stops the analyzer + rekordbox child processes it
 *  owns — then exits the utility process itself. Without this, the host's
 *  fallback proc.kill() terminates only the sidecar process and orphans
 *  those Python children (proc.kill() is not a tree-kill on Windows). */
export interface ShutdownFrame {
	kind: 'shutdown';
}

// ─── Unions ──────────────────────────────────────────────────────────────

export type MainToSidecar = CallFrame | HostResultFrame | HostErrorFrame | ShutdownFrame;
export type SidecarToMain =
	| ResultFrame
	| ErrorFrame
	| EventFrame
	| HostCallFrame
	| ReadyFrame
	| LogFrame;

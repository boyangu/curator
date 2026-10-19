// WorkspaceHost — the async seam between the workspace's consumers (agent
// tools, via the manager) and wherever the SQLite engine actually runs.
// Two implementations:
//   - createInlineWorkspaceHost (here): the engine in-process, sync calls
//     wrapped in resolved promises. Default for tests, headless CLI, and the
//     CORE_SIDECAR path (core is already off the main loop there — sync is a
//     known, acceptable limitation).
//   - UtilityWorkspaceHost (apps/desktop/src/main/workspace/host.ts): the
//     engine in an Electron utilityProcess, OS-killable mid-query — the
//     parseAudio injection pattern, because better-sqlite3 has no interrupt
//     and agent-written SQL must never be able to wedge the main loop.

import { WorkspaceEngine, type WorkspaceColumn, type WorkspaceDbPaths, type WorkspaceQueryResult } from './engine.js';

export type { WorkspaceColumn, WorkspaceDbPaths, WorkspaceQueryResult };

// A watchdog kill took the worker (runaway query) — every session's loaded
// tables are gone. Tool layer converts this into an honest "workspace was
// reset — re-load your tables" error the model can act on.
export class WorkspaceResetError extends Error {
	constructor(message = 'workspace was reset') {
		super(message);
		this.name = 'WorkspaceResetError';
	}
}

export interface WorkspaceHost {
	ensure(sessionId: string): Promise<{ tables: string[] }>;
	loadBegin(sessionId: string, table: string, columns: WorkspaceColumn[]): Promise<void>;
	loadRows(sessionId: string, table: string, rows: unknown[][]): Promise<void>;
	loadEnd(sessionId: string, table: string): Promise<{ rowCount: number }>;
	query(sessionId: string, sql: string, maxRows: number): Promise<WorkspaceQueryResult>;
	drop(sessionId: string): Promise<void>;
	stop(): Promise<void>;
}

export function createInlineWorkspaceHost(paths: WorkspaceDbPaths): WorkspaceHost {
	const engine = new WorkspaceEngine(paths);
	return {
		async ensure(sessionId) { return engine.ensure(sessionId); },
		async loadBegin(sessionId, table, columns) { engine.loadBegin(sessionId, table, columns); },
		async loadRows(sessionId, table, rows) { engine.loadRows(sessionId, table, rows); },
		async loadEnd(sessionId, table) { return engine.loadEnd(sessionId, table); },
		async query(sessionId, sql, maxRows) { return engine.query(sessionId, sql, maxRows); },
		async drop(sessionId) { engine.dropSession(sessionId); },
		async stop() { engine.close(); },
	};
}

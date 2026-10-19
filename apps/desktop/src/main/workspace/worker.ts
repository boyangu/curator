// Workspace worker — Electron utility process hosting the agent workspace's
// SQLite engine (read-only curator.db main + feed/kb attaches + TEMP
// scratch, see apps/core/src/agent/workspace/engine.ts). Runs out-of-process
// because better-sqlite3 is synchronous with no query interrupt: an
// agent-written pathological join can only be stopped by killing this
// process (UtilityWorkspaceHost's watchdog), which must never take the main
// loop with it. Bundled to workspace-worker.cjs (electron.vite.config.ts).

import { WorkspaceEngine, type WorkspaceColumn, type WorkspaceDbPaths } from '@curator/core';

type WorkerRequest =
	| { id: number; op: 'init'; paths: WorkspaceDbPaths }
	| { id: number; op: 'ensure'; sessionId: string }
	| { id: number; op: 'load-begin'; sessionId: string; table: string; columns: WorkspaceColumn[] }
	| { id: number; op: 'load-rows'; sessionId: string; table: string; rows: unknown[][] }
	| { id: number; op: 'load-end'; sessionId: string; table: string }
	| { id: number; op: 'query'; sessionId: string; sql: string; maxRows: number }
	| { id: number; op: 'drop'; sessionId: string };

let engine: WorkspaceEngine | null = null;

function post(frame: Record<string, unknown>): void {
	process.parentPort.postMessage(frame);
}

process.parentPort.on('message', (e) => {
	const msg = e.data as WorkerRequest;
	try {
		switch (msg.op) {
			case 'init':
				engine = new WorkspaceEngine(msg.paths);
				post({ id: msg.id, ok: true });
				return;
			default:
				break;
		}
		if (!engine) throw new Error('workspace worker not initialized');
		switch (msg.op) {
			case 'ensure':
				post({ id: msg.id, ok: true, ...engine.ensure(msg.sessionId) });
				return;
			case 'load-begin':
				engine.loadBegin(msg.sessionId, msg.table, msg.columns);
				post({ id: msg.id, ok: true });
				return;
			case 'load-rows':
				engine.loadRows(msg.sessionId, msg.table, msg.rows);
				post({ id: msg.id, ok: true });
				return;
			case 'load-end':
				post({ id: msg.id, ok: true, ...engine.loadEnd(msg.sessionId, msg.table) });
				return;
			case 'query':
				post({ id: msg.id, ok: true, result: engine.query(msg.sessionId, msg.sql, msg.maxRows) });
				return;
			case 'drop':
				engine.dropSession(msg.sessionId);
				post({ id: msg.id, ok: true });
				return;
		}
	} catch (err) {
		post({ id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) });
	}
});

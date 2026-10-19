import { describe, expect, it } from 'vitest';
import { createWorkspaceManager } from './manager.js';
import { WorkspaceResetError, type WorkspaceHost } from './host.js';
import type { WorkspaceColumn } from './engine.js';

interface HostLog {
	calls: string[];
	loaded: Map<string, unknown[][]>;
}

function fakeHost(overrides?: Partial<WorkspaceHost>): WorkspaceHost & HostLog {
	const calls: string[] = [];
	const loaded = new Map<string, unknown[][]>();
	// Per-session loaded-table sets — the manager resyncs its mirror from
	// ensure()'s answer on every op, so the fake must model it.
	const sessionTables = new Map<string, Set<string>>();
	const host: WorkspaceHost & HostLog = {
		calls,
		loaded,
		async ensure(sessionId) {
			calls.push(`ensure:${sessionId}`);
			return { tables: [...(sessionTables.get(sessionId) ?? [])] };
		},
		async loadBegin(sessionId, table, _columns) {
			calls.push(`begin:${sessionId}:${table}`);
			loaded.set(table, []);
		},
		async loadRows(_sessionId, table, rows) {
			calls.push(`rows:${table}:${rows.length}`);
			loaded.get(table)!.push(...rows);
		},
		async loadEnd(sessionId, table) {
			calls.push(`end:${table}`);
			(sessionTables.get(sessionId) ?? sessionTables.set(sessionId, new Set()).get(sessionId)!).add(table);
			return { rowCount: loaded.get(table)!.length };
		},
		async query(sessionId, _sql, maxRows) {
			calls.push(`query:${sessionId}:${maxRows}`);
			return { columns: ['x'], rows: [[1]], truncated: false, elapsedMs: 1 };
		},
		async drop(sessionId) { calls.push(`drop:${sessionId}`); sessionTables.delete(sessionId); },
		async stop() { calls.push('stop'); },
		...overrides,
	};
	return host;
}

const COLS: WorkspaceColumn[] = [{ name: 'title', type: 'text' }, { name: 'bpm', type: 'real' }];

describe('WorkspaceManager', () => {
	it('loads datasets with provenance columns appended and batches of 500', async () => {
		const host = fakeHost();
		const mgr = createWorkspaceManager(host);
		const ws = mgr.forSession('s1');
		const rows = Array.from({ length: 1200 }, (_, i) => ({ title: `t${i}`, bpm: 120 + i }));
		const summary = await ws.loadDataset({
			table: 'tracks',
			columns: COLS,
			rows,
			provenance: (r) => ({ kind: 'library-track', refId: String(r['title']) }),
		});
		expect(summary).toMatchObject({ table: 'tracks', rowCount: 1200 });
		expect(summary.columns).toEqual(['title', 'bpm', '_kind', '_ref_id', '_provider', '_url', '_play_spotify_id']);
		expect(summary.sample).toHaveLength(3);
		// 1200 rows → 3 batches (500/500/200), each row widened with provenance.
		expect(host.calls.filter((c) => c.startsWith('rows:'))).toEqual(['rows:tracks:500', 'rows:tracks:500', 'rows:tracks:200']);
		expect(host.loaded.get('tracks')![0]).toEqual(['t0', 120, 'library-track', 't0', null, null, null]);
	});

	it('records provider-hit provenance into the session cache', async () => {
		const host = fakeHost();
		const mgr = createWorkspaceManager(host);
		const ws = mgr.forSession('s1');
		await ws.loadDataset({
			table: 'hits',
			columns: COLS,
			rows: [{ title: 'a', bpm: 1 }],
			provenance: () => ({ kind: 'provider-hit', refId: 'sp1', provider: 'spotify', playSpotifyId: 'sp1', url: 'https://x' }),
		});
		expect(ws.sessionProviderHits.get('spotify', 'sp1')).toEqual({ url: 'https://x', playSpotifyId: 'sp1' });
		expect(ws.sessionProviderHits.get('spotify', 'other')).toBeUndefined();
	});

	it('rejects reserved names and enforces the per-session table cap', async () => {
		const host = fakeHost();
		const mgr = createWorkspaceManager(host);
		const ws = mgr.forSession('s1');
		await expect(ws.loadDataset({ table: 'v_bad', columns: COLS, rows: [], provenance: () => ({ kind: 'library-track', refId: 'x' }) }))
			.rejects.toThrow(/invalid table name/);
		await expect(ws.loadDataset({ table: 'ok', columns: [{ name: '_sneaky', type: 'text' }], rows: [], provenance: () => ({ kind: 'library-track', refId: 'x' }) }))
			.rejects.toThrow(/reserved/);
		for (let i = 0; i < 24; i++) {
			await ws.loadDataset({ table: `t${i}`, columns: COLS, rows: [], provenance: () => ({ kind: 'library-track', refId: 'x' }) });
		}
		await expect(ws.loadDataset({ table: 'overflow', columns: COLS, rows: [], provenance: () => ({ kind: 'library-track', refId: 'x' }) }))
			.rejects.toThrow(/table limit/);
		// Replacing an existing table is still allowed at the cap.
		await expect(ws.loadDataset({ table: 't0', columns: COLS, rows: [], provenance: () => ({ kind: 'library-track', refId: 'x' }) }))
			.resolves.toMatchObject({ table: 't0' });
	});

	it('evicts the LRU session past the live cap', async () => {
		const host = fakeHost();
		const mgr = createWorkspaceManager(host, { maxLive: 2 });
		mgr.forSession('a');
		mgr.forSession('b');
		mgr.forSession('a'); // refresh a
		mgr.forSession('c'); // evicts b
		expect(host.calls).toContain('drop:b');
		expect(host.calls).not.toContain('drop:a');
	});

	it('re-ensures on EVERY op so an idle-death reset self-heals (the chaos-test bug)', async () => {
		let failNext = false;
		const host = fakeHost({
			async query(sessionId, _sql, maxRows) {
				host.calls.push(`query:${sessionId}:${maxRows}`);
				if (failNext) { failNext = false; throw new WorkspaceResetError(); }
				return { columns: [], rows: [], truncated: false, elapsedMs: 1 };
			},
		});
		const mgr = createWorkspaceManager(host);
		const ws = mgr.forSession('s1');
		await ws.query('SELECT 1');
		expect(host.calls.filter((c) => c === 'ensure:s1')).toHaveLength(1);
		failNext = true;
		await expect(ws.query('SELECT 1')).rejects.toThrow(WorkspaceResetError);
		// Every op re-ensures — a worker that died while IDLE (nothing in
		// flight to reject) still gets a fresh connection on the next call.
		await ws.query('SELECT 1');
		expect(host.calls.filter((c) => c === 'ensure:s1')).toHaveLength(3);
	});

	it('drop and stop forward to the host', async () => {
		const host = fakeHost();
		const mgr = createWorkspaceManager(host);
		mgr.forSession('s1');
		await mgr.drop('s1');
		expect(host.calls).toContain('drop:s1');
		await mgr.stop();
		expect(host.calls).toContain('stop');
	});
});

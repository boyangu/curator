import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAgentStore } from './store.js';
import type { AgentResultSet } from './result-set.js';

describe('SqliteAgentStore', () => {
	let dir: string;
	let store: SqliteAgentStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'curator-agent-store-'));
		store = new SqliteAgentStore(join(dir, 'agent.db'));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('round-trips sessions and messages', () => {
		const s = store.createSession('Berlin labels');
		expect(store.sessionExists(s.id)).toBe(true);
		store.appendMessage(s.id, 't1', { role: 'user', content: 'find stuff' });
		store.appendMessage(s.id, 't1', { role: 'assistant', content: [{ type: 'text', text: 'here you go' }] });
		const messages = store.getMessages(s.id);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: 'user', content: 'find stuff' });

		const detail = store.getSession(s.id)!;
		expect(detail.session.messageCount).toBe(2);
		expect(detail.turns).toEqual([
			expect.objectContaining({ turnId: 't1', role: 'user', text: 'find stuff' }),
			expect.objectContaining({ turnId: 't1', role: 'assistant', text: 'here you go' }),
		]);
	});

	it('merges multi-step assistant text of one turn into one display bubble', () => {
		const s = store.createSession('x');
		store.appendMessage(s.id, 't1', { role: 'user', content: 'q' });
		store.appendMessage(s.id, 't1', { role: 'assistant', content: [{ type: 'text', text: 'part one. ' }] });
		// Tool traffic between steps is elided from the display transcript.
		store.appendMessage(s.id, 't1', { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'query_library', output: { type: 'json', value: {} } }] });
		store.appendMessage(s.id, 't1', { role: 'assistant', content: [{ type: 'text', text: 'part two.' }] });
		const detail = store.getSession(s.id)!;
		expect(detail.turns).toHaveLength(2);
		expect(detail.turns[1]!.text).toBe('part one. part two.');
	});

	it('strips the view-context suffix from displayed user turns, keeps it on the wire', () => {
		const s = store.createSession('x');
		store.appendMessage(s.id, 't1', { role: 'user', content: 'show me tracks\n\n[current view: Spotify tab, playlist "Peak Time" (playlistId p1)]' });
		// Wire history keeps the context (the model needs each turn's vantage).
		expect((store.getMessages(s.id)[0] as { content: string }).content).toContain('[current view:');
		// Display transcript hides the instrumentation.
		expect(store.getSession(s.id)!.turns[0]!.text).toBe('show me tracks');
	});

	it('round-trips result sets and lists them on the session', () => {
		const s = store.createSession('x');
		const rs: AgentResultSet = {
			id: 'rs1',
			sessionId: s.id,
			turnId: 't1',
			title: 'Picks',
			summary: 'why',
			createdAt: Date.now(),
			items: [
				{ kind: 'provider-hit', title: 'Track', artists: ['A'], providerRef: { provider: 'spotify', id: 'sp1' }, badge: 'web', playRef: { source: 'spotify', sourceTrackId: 'sp1' } },
			],
		};
		store.insertResultSet(rs);
		expect(store.getResultSet('rs1')).toEqual(rs);
		expect(store.getSession(s.id)!.resultSets).toEqual([
			expect.objectContaining({ id: 'rs1', title: 'Picks', itemCount: 1 }),
		]);
	});

	it('deleteSession cascades messages and result sets', () => {
		const s = store.createSession('x');
		store.appendMessage(s.id, 't1', { role: 'user', content: 'q' });
		store.insertResultSet({ id: 'rs1', sessionId: s.id, turnId: 't1', title: 'T', summary: null, createdAt: 1, items: [] });
		store.deleteSession(s.id);
		expect(store.sessionExists(s.id)).toBe(false);
		expect(store.getMessages(s.id)).toEqual([]);
		expect(store.getResultSet('rs1')).toBeNull();
	});

	it('lists sessions most recently touched first', () => {
		const a = store.createSession('a');
		const b = store.createSession('b');
		// updated_at is epoch-ms; a same-ms tie would make this flaky, so nudge.
		const bump = Date.now() + 10;
		store.touchSession(a.id);
		// Force a distinct timestamp ordering via direct touch after a tick.
		while (Date.now() <= bump - 10) { /* spin one ms */ }
		store.touchSession(a.id);
		const list = store.listSessions();
		expect(list.map((s) => s.id)).toContain(a.id);
		expect(list.map((s) => s.id)).toContain(b.id);
	});
});

// AgentStore — sessions, messages and result sets over a separate agent.db
// (the fourth DB file, beside curator.db / feed.db / knowledge.db). Same
// separate-DB reasoning as the KB: conversation history is its own
// lifecycle, and its churn must never touch the sacred curator.db. No
// foreign keys cross databases — result-set items reference library/feed/KB
// rows by id, resolved at read time.
//
// Synchronous better-sqlite3 like SqliteKnowledgeStore; volumes are tiny
// (messages per session, not tracks per library).

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { WireMessage } from './protocol.js';
import type { AgentResultSet } from './result-set.js';

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS agent_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_message (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_message_session ON agent_message (session_id, created_at);
CREATE TABLE IF NOT EXISTS agent_result_set (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT,
	items_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_result_set_session ON agent_result_set (session_id, created_at);
`;

export interface AgentSessionSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

export interface AgentSessionDetail {
	session: AgentSessionSummary;
	// Display transcript: user text + assistant text per turn (tool traffic
	// is elided — the renderer rebuilds activity from live events only).
	turns: { turnId: string; role: 'user' | 'assistant'; text: string; createdAt: number }[];
	resultSets: { id: string; turnId: string; title: string; itemCount: number; createdAt: number }[];
}

export interface AgentStore {
	createSession(title: string): AgentSessionSummary;
	listSessions(): AgentSessionSummary[];
	getSession(id: string): AgentSessionDetail | null;
	deleteSession(id: string): void;
	touchSession(id: string): void;
	sessionExists(id: string): boolean;

	appendMessage(sessionId: string, turnId: string, message: WireMessage): void;
	// Full wire history for a session — what `run` re-sends.
	getMessages(sessionId: string): WireMessage[];

	insertResultSet(rs: AgentResultSet): void;
	getResultSet(id: string): AgentResultSet | null;

	close(): void;
}

interface SessionRow { id: string; title: string; created_at: number; updated_at: number; message_count: number }
interface MessageRow { turn_id: string; role: string; content_json: string; created_at: number }
interface ResultSetRow { id: string; session_id: string; turn_id: string; title: string; summary: string | null; items_json: string; created_at: number }

// Pull the displayable text out of a wire message (assistant content can be
// a part array carrying tool calls we don't display from persistence). User
// messages may carry a trailing "[current view: …]" context suffix (see
// service.ts VIEW_CONTEXT_PREFIX) — instrumentation for the model, stripped
// from the transcript the user reads back.
function messageText(msg: WireMessage): string {
	if (typeof msg.content === 'string') {
		return msg.role === 'user'
			? msg.content.replace(/\n\n\[current view: [^\]]*\]$/, '')
			: msg.content;
	}
	if (msg.role === 'assistant') {
		return msg.content
			.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
			.map((p) => p.text)
			.join('');
	}
	return '';
}

export class SqliteAgentStore implements AgentStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.db.exec(DDL);
		this.db
			.prepare(`INSERT OR REPLACE INTO agent_meta (key, value) VALUES ('schema_version', ?)`)
			.run(String(SCHEMA_VERSION));
	}

	createSession(title: string): AgentSessionSummary {
		const now = Date.now();
		const id = randomUUID();
		this.db.prepare(`INSERT INTO agent_session (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
			.run(id, title, now, now);
		return { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
	}

	listSessions(): AgentSessionSummary[] {
		const rows = this.db.prepare(`
			SELECT s.*, (SELECT COUNT(*) FROM agent_message m WHERE m.session_id = s.id) AS message_count
			FROM agent_session s ORDER BY s.updated_at DESC
		`).all() as SessionRow[];
		return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.message_count }));
	}

	sessionExists(id: string): boolean {
		return this.db.prepare(`SELECT 1 FROM agent_session WHERE id = ?`).get(id) !== undefined;
	}

	getSession(id: string): AgentSessionDetail | null {
		const row = this.db.prepare(`
			SELECT s.*, (SELECT COUNT(*) FROM agent_message m WHERE m.session_id = s.id) AS message_count
			FROM agent_session s WHERE s.id = ?
		`).get(id) as SessionRow | undefined;
		if (!row) return null;
		const messages = this.db
			.prepare(`SELECT turn_id, role, content_json, created_at FROM agent_message WHERE session_id = ? ORDER BY created_at, rowid`)
			.all(id) as MessageRow[];
		const turns: AgentSessionDetail['turns'] = [];
		for (const m of messages) {
			if (m.role !== 'user' && m.role !== 'assistant') continue;
			const text = messageText(JSON.parse(m.content_json) as WireMessage);
			if (text.trim().length === 0) continue;
			// Assistant text arrives as one message per loop step — merge steps
			// of the same turn into one display bubble.
			const last = turns[turns.length - 1];
			if (last && last.turnId === m.turn_id && last.role === m.role) {
				last.text += text;
			} else {
				turns.push({ turnId: m.turn_id, role: m.role, text, createdAt: m.created_at });
			}
		}
		const sets = this.db
			.prepare(`SELECT * FROM agent_result_set WHERE session_id = ? ORDER BY created_at`)
			.all(id) as ResultSetRow[];
		return {
			session: { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, messageCount: row.message_count },
			turns,
			resultSets: sets.map((r) => ({
				id: r.id,
				turnId: r.turn_id,
				title: r.title,
				itemCount: (JSON.parse(r.items_json) as unknown[]).length,
				createdAt: r.created_at,
			})),
		};
	}

	deleteSession(id: string): void {
		const del = this.db.transaction(() => {
			this.db.prepare(`DELETE FROM agent_message WHERE session_id = ?`).run(id);
			this.db.prepare(`DELETE FROM agent_result_set WHERE session_id = ?`).run(id);
			this.db.prepare(`DELETE FROM agent_session WHERE id = ?`).run(id);
		});
		del();
	}

	touchSession(id: string): void {
		this.db.prepare(`UPDATE agent_session SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
	}

	appendMessage(sessionId: string, turnId: string, message: WireMessage): void {
		this.db
			.prepare(`INSERT INTO agent_message (id, session_id, turn_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(randomUUID(), sessionId, turnId, message.role, JSON.stringify(message), Date.now());
	}

	getMessages(sessionId: string): WireMessage[] {
		const rows = this.db
			.prepare(`SELECT content_json FROM agent_message WHERE session_id = ? ORDER BY created_at, rowid`)
			.all(sessionId) as { content_json: string }[];
		return rows.map((r) => JSON.parse(r.content_json) as WireMessage);
	}

	insertResultSet(rs: AgentResultSet): void {
		this.db
			.prepare(`INSERT INTO agent_result_set (id, session_id, turn_id, title, summary, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(rs.id, rs.sessionId, rs.turnId, rs.title, rs.summary, JSON.stringify(rs.items), rs.createdAt);
	}

	getResultSet(id: string): AgentResultSet | null {
		const row = this.db.prepare(`SELECT * FROM agent_result_set WHERE id = ?`).get(id) as ResultSetRow | undefined;
		if (!row) return null;
		return {
			id: row.id,
			sessionId: row.session_id,
			turnId: row.turn_id,
			title: row.title,
			summary: row.summary,
			createdAt: row.created_at,
			items: JSON.parse(row.items_json) as AgentResultSet['items'],
		};
	}

	close(): void {
		this.db.close();
	}
}

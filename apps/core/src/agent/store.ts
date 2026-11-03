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
import type { DecisionLog, DecisionOutcome, DecisionRecord, WireMessage } from '@curator/agent-core';
import type { AgentResultSet } from './result-set.js';

// 2: the decision log (agent_decision, agent_decision_outcome) — every turn
// on the record with its prompt version, usage and tool calls, so corrections
// can be mined into regression cases (@curator/agent-core decision.ts).
const SCHEMA_VERSION = 2;

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
CREATE TABLE IF NOT EXISTS agent_decision (
	id TEXT PRIMARY KEY,
	surface TEXT NOT NULL,
	task TEXT NOT NULL,
	prompt_hash TEXT NOT NULL,
	model TEXT NOT NULL,
	subject TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER NOT NULL,
	stop_reason TEXT NOT NULL,
	usage_json TEXT NOT NULL,
	cost_usd REAL,
	tool_calls_json TEXT NOT NULL,
	verdict_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_decision_subject ON agent_decision (subject, started_at);
CREATE TABLE IF NOT EXISTS agent_decision_outcome (
	id TEXT PRIMARY KEY,
	decision_id TEXT NOT NULL,
	at INTEGER NOT NULL,
	by_whom TEXT NOT NULL,
	kind TEXT NOT NULL,
	correction_json TEXT,
	note TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_decision_outcome_decision ON agent_decision_outcome (decision_id);
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

export interface AgentStore extends DecisionLog {
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

	// The decision log, newest first; `subject` narrows to one session.
	listDecisions(opts?: { subject?: string; limit?: number }): DecisionRecord[];

	close(): void;
}

interface DecisionRow {
	id: string; surface: string; task: string; prompt_hash: string; model: string; subject: string | null;
	started_at: number; ended_at: number; stop_reason: string; usage_json: string; cost_usd: number | null; tool_calls_json: string; verdict_json: string | null;
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

	record(d: DecisionRecord): void {
		this.db
			.prepare(
				`INSERT INTO agent_decision (id, surface, task, prompt_hash, model, subject, started_at, ended_at, stop_reason, usage_json, cost_usd, tool_calls_json, verdict_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				d.id, d.surface, d.task, d.promptHash, d.model, d.subject ?? null, d.startedAt, d.endedAt, d.stopReason,
				JSON.stringify(d.usage), d.costUsd, JSON.stringify(d.toolCalls), d.verdict === null || d.verdict === undefined ? null : JSON.stringify(d.verdict),
			);
	}

	outcome(o: DecisionOutcome): void {
		this.db
			.prepare(`INSERT INTO agent_decision_outcome (id, decision_id, at, by_whom, kind, correction_json, note) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(randomUUID(), o.decisionId, o.at, o.by, o.kind, o.correction === undefined ? null : JSON.stringify(o.correction), o.note ?? null);
	}

	listDecisions(opts: { subject?: string; limit?: number } = {}): DecisionRecord[] {
		const rows = this.db
			.prepare(`SELECT * FROM agent_decision WHERE (? IS NULL OR subject = ?) ORDER BY started_at DESC LIMIT ?`)
			.all(opts.subject ?? null, opts.subject ?? null, opts.limit ?? 100) as DecisionRow[];
		return rows.map((r) => ({
			id: r.id,
			surface: r.surface as DecisionRecord['surface'],
			task: r.task,
			promptHash: r.prompt_hash,
			model: r.model,
			...(r.subject ? { subject: r.subject } : {}),
			startedAt: r.started_at,
			endedAt: r.ended_at,
			stopReason: r.stop_reason as DecisionRecord['stopReason'],
			usage: JSON.parse(r.usage_json) as DecisionRecord['usage'],
			costUsd: r.cost_usd,
			toolCalls: JSON.parse(r.tool_calls_json) as DecisionRecord['toolCalls'],
			verdict: r.verdict_json === null ? null : (JSON.parse(r.verdict_json) as unknown),
		}));
	}

	close(): void {
		this.db.close();
	}
}

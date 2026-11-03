// The decision log — one record per agent run, whatever the surface: what
// was asked, which prompt version and model answered, what it cost, what it
// called, what it decided, and later what became of it. Appended by every
// harness; never injected into a prompt. It is the raw material for evals
// (a corrected decision becomes a regression case), for memory (an explicit
// correction becomes a note or a claim) and for the cost view.
//
// Storage is the consumer's (agent.db on the desktop, the catalogue's tables
// in the cloud); this file is the shape they share.

import type { RunStopReason, RunUsage } from './protocol.js';

// Where the run happened. One string per product surface so the log can be
// filtered and the eval sets split.
export type DecisionSurface = 'assistant' | 'catalog' | 'research' | 'library' | 'mcp';

export interface DecisionToolCall {
	tool: string;
	ok: boolean;
	// Milliseconds spent in the host's execute; absent for provider-executed tools.
	ms?: number;
}

export interface DecisionRecord {
	id: string;
	surface: DecisionSurface;
	// The kind of task on that surface: a chat turn, a catalogue case name,
	// a research aspect.
	task: string;
	// Content hash of the assembled prompt prefix (prompts/assemble.ts): the
	// prompt version this decision was made under.
	promptHash: string;
	model: string;
	// The session or case this run belongs to, as the surface names it.
	subject?: string;
	startedAt: number;
	endedAt: number;
	stopReason: RunStopReason;
	usage: RunUsage;
	// USD, when the consumer knows the model's rates; null until it does.
	costUsd: number | null;
	toolCalls: DecisionToolCall[];
	// What the run decided, in the surface's own shape (a verdict object, a
	// result-set id, the final text's first line); null for a run that
	// produced nothing.
	verdict: unknown;
}

// What became of a decision, recorded when known: the user or operator
// agreed, corrected it (with the correction), or undid it. `by` names who.
export interface DecisionOutcome {
	decisionId: string;
	at: number;
	by: string;
	kind: 'accepted' | 'corrected' | 'undone' | 'rejected';
	correction?: unknown;
	note?: string;
}

export interface DecisionLog {
	record(d: DecisionRecord): Promise<void> | void;
	outcome(o: DecisionOutcome): Promise<void> | void;
}

export const noopDecisionLog: DecisionLog = { record: () => {}, outcome: () => {} };

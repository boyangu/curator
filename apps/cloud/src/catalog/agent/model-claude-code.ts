// The reasoner on Guy's Claude Code subscription instead of an API key: the
// same prefix, pack and verdict schema, sent through `claude -p` (headless
// print mode) with the verdict as structured output. A stopgap for the local
// catalogue while the hosted key is not worth paying for; the cloud worker
// has no claude.ai login and keeps the API adapter (model.ts).
//
// Why each flag:
//   ANTHROPIC_API_KEY removed from the child's env — print mode prefers an API
//     key over the claude.ai login, so with the key set machine-wide (it is,
//     on Guy's PC) every case would bill the key: the very thing to avoid.
//   --system-prompt            the reasoner's prefix replaces Claude Code's own prompt.
//   --json-schema              the case's strict verdict schema; the answer comes
//                              back validated as `structured_output`.
//   --tools / --allowedTools   none, or WebSearch + WebFetch for research cases
//                              (print mode cannot ask for permission).
//   --setting-sources ""       no user/project settings: no hooks, no plugins.
//   --strict-mcp-config        no MCP servers.
//   --no-session-persistence   cases leave no resumable sessions behind.
//   cwd = the OS temp dir      no project CLAUDE.md is in reach.
//
// Spend: the subscription's usage limits, shared with Guy's interactive
// sessions. The cost Claude Code reports is notional (list price), so the
// case records 0 and the daily call ceiling is what bounds a day.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { ModelAnswer, ModelCall, ModelUsage } from './model.js';
import { VERDICT_TOOL } from './prompts.js';

type Result = {
	is_error?: boolean;
	subtype?: string;
	stop_reason?: string;
	result?: string;
	structured_output?: unknown;
	api_error_status?: number | null;
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
	modelUsage?: Record<string, unknown>;
};

// The prompts name the API adapter's verdict tool; here the answer is the
// structured output, so the words follow.
const reword = (s: string) =>
	s
		.replaceAll(`Call ${VERDICT_TOOL} with your answer.`, 'Give your answer as the structured output.')
		.replaceAll(`calling ${VERDICT_TOOL}`, 'giving the structured output')
		.replaceAll(VERDICT_TOOL, 'the structured output');

// `binArgs`: arguments before Claude Code's own (a test runs a script under node).
export function claudeCodeModelCall(cfg: { model: string; bin?: string; binArgs?: string[]; timeoutMs?: number }): ModelCall {
	const bin = cfg.bin ?? 'claude';
	const timeoutMs = cfg.timeoutMs ?? 300_000;
	return (req) =>
		new Promise<ModelAnswer>((resolve, reject) => {
			const verdict = req.prefix.tools.find((t) => t.name === VERDICT_TOOL);
			if (!verdict) return reject(new Error('the prefix carries no verdict tool'));
			const tools = req.research ? ['WebSearch', 'WebFetch'] : [''];
			const args = [
				...(cfg.binArgs ?? []),
				'-p',
				'--output-format', 'json',
				'--model', cfg.model,
				'--system-prompt', reword(req.prefix.blocks.map((b) => b.text).join('\n\n')),
				'--json-schema', JSON.stringify(verdict.parameters),
				'--tools', ...tools,
				...(req.research ? ['--allowedTools', 'WebSearch', 'WebFetch'] : []),
				'--setting-sources', '',
				'--strict-mcp-config',
				'--no-session-persistence',
			];
			const env = { ...process.env };
			delete env.ANTHROPIC_API_KEY;
			const child = spawn(bin, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
			let out = '';
			let err = '';
			const timer = setTimeout(() => child.kill(), timeoutMs);
			const onAbort = () => child.kill();
			req.abort?.addEventListener('abort', onAbort, { once: true });
			child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
			child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
			child.on('error', (e) => {
				clearTimeout(timer);
				reject(new Error(`claude could not start (${bin}): ${e.message} — is Claude Code installed and on PATH?`));
			});
			child.on('close', (code, signal) => {
				clearTimeout(timer);
				req.abort?.removeEventListener('abort', onAbort);
				let r: Result;
				try {
					r = JSON.parse(out) as Result;
				} catch {
					return reject(new Error(`claude -p ${signal ? `was stopped (${signal}, over ${timeoutMs / 1000}s?)` : `exited ${code}`}: ${(err || out).trim().slice(0, 300)}`));
				}
				const u = r.usage ?? {};
				const usage: ModelUsage = {
					inputTokens: u.input_tokens ?? 0,
					outputTokens: u.output_tokens ?? 0,
					cacheReadTokens: u.cache_read_input_tokens ?? 0,
					cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
					webSearches: u.server_tool_use?.web_search_requests ?? 0,
				};
				// Claude Code runs a small model on the side (titles); the answer is the other one.
				const model = Object.keys(r.modelUsage ?? {}).find((m) => !m.includes('haiku')) ?? cfg.model;
				const declined = r.stop_reason === 'refusal';
				if (r.is_error && !declined) {
					// A usage limit, an overload, max turns: the reasoner retries the case later.
					return reject(new Error(`claude -p ${r.subtype ?? 'error'}${r.api_error_status ? ` (HTTP ${r.api_error_status})` : ''}: ${(r.result ?? err).trim().slice(0, 300)}`));
				}
				resolve({
					verdict: r.structured_output ?? null,
					stopReason: r.stop_reason ?? r.subtype ?? '',
					declined,
					text: r.result ?? '',
					model: `claude-code/${model}`,
					usage,
					costUsd: 0,
				});
			});
			child.stdin.end(reword(req.user), 'utf8');
		});
}

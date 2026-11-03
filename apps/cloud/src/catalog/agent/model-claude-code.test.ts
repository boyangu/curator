// The Claude Code adapter against a stand-in `claude` (a node script that
// answers like `claude -p --output-format json`): the API key never reaches
// the child, the verdict schema and the reworded prompts do, research cases
// get the web tools, and an error result is a failure the reasoner retries.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeCodeModelCall } from './model-claude-code.js';
import { prefixFor } from './prompts.js';

// Echoes what it was given inside a well-formed result; FAKE_MODE=error answers as a usage limit does.
const FAKE = `
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
	const args = process.argv.slice(2);
	const at = (f) => args[args.indexOf(f) + 1];
	if (process.env.FAKE_MODE === 'error') {
		process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_during_execution', api_error_status: 429, result: 'usage limit reached' }));
		return;
	}
	const toolsAt = args.indexOf('--tools');
	const tools = [];
	for (let i = toolsAt + 1; i < args.length && !args[i].startsWith('--'); i++) tools.push(args[i]);
	process.stdout.write(JSON.stringify({
		is_error: false, subtype: 'success', stop_reason: 'tool_use', result: '{}',
		structured_output: { pairs: [], confidence: 0.9, rationale: 'echo', citations: [], seen: {
			key: process.env.ANTHROPIC_API_KEY ?? null, schema: JSON.parse(at('--json-schema')), system: at('--system-prompt'), user: input, tools, allowed: args.includes('--allowedTools'), model: at('--model'), settings: at('--setting-sources'),
		} },
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } },
		modelUsage: { 'claude-haiku-5-5': {}, 'claude-opus-5-5': {} },
	}));
});`;

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fake(): { bin: string; binArgs: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'curator-fake-claude-'));
	dirs.push(dir);
	const script = join(dir, 'claude.cjs');
	writeFileSync(script, FAKE);
	return { bin: process.execPath, binArgs: [script] };
}

describe('Claude Code reasoner backend', () => {
	it('sends the prefix, schema and pack without the API key, and reads the structured verdict', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
		try {
			const call = claudeCodeModelCall({ model: 'claude-opus-5-5', ...fake() });
			const prefix = prefixFor('release_twin');
			const a = await call({ prefix, user: 'Same release? Call record_verdict with your answer.', research: false });
			const seen = (a.verdict as { seen: Record<string, unknown> }).seen;
			expect(seen.key).toBeNull();
			expect(seen.schema).toEqual(prefix.tools[0]!.parameters);
			expect(seen.system).not.toContain('record_verdict');
			expect(seen.system).toContain('structured output');
			expect(seen.user).toBe('Same release? Give your answer as the structured output.');
			expect(seen.tools).toEqual(['']);
			expect(seen.allowed).toBe(false);
			expect(seen.settings).toBe('');
			expect(a).toMatchObject({ declined: false, model: 'claude-code/claude-opus-5-5', costUsd: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, webSearches: 2 } });

			const r = await call({ prefix: prefixFor('artist_twin'), user: 'Same act?', research: true });
			const rs = (r.verdict as { seen: Record<string, unknown> }).seen;
			expect(rs.tools).toEqual(['WebSearch', 'WebFetch']);
			expect(rs.allowed).toBe(true);
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it('turns an error result into a failure the reasoner retries', async () => {
		process.env.FAKE_MODE = 'error';
		try {
			const call = claudeCodeModelCall({ model: 'claude-opus-5-5', ...fake() });
			await expect(call({ prefix: prefixFor('credit'), user: 'x', research: false })).rejects.toThrow(/HTTP 429.*usage limit/);
		} finally {
			delete process.env.FAKE_MODE;
		}
	});

	it('says so when claude cannot start', async () => {
		const call = claudeCodeModelCall({ model: 'm', bin: join(tmpdir(), 'no-such-claude-binary.exe') });
		await expect(call({ prefix: prefixFor('credit'), user: 'x', research: false })).rejects.toThrow(/could not start/);
	});
});

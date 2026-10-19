import { describe, expect, it } from 'vitest';
import { AgentSidecarManager } from './sidecar.js';
import type { AgentDelta, RunParams } from './protocol.js';

// Scripted fake sidecar child (plain Node, CJS via -e): speaks the protocol
// well enough to exercise handshake, configure, classify, and the
// bidirectional run (delta stream + reverse-RPC tool-call).
const FAKE_SIDECAR = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ event: 'hello', name: 'curator-agent', version: '0.0.0-test', protocol: 1 });
let pendingRunId = null, pendingTurn = null;
rl.on('line', (line) => {
	if (!line.trim()) return;
	let f; try { f = JSON.parse(line); } catch { return; }
	if (f.method === 'configure') send({ id: f.id, result: { ok: true } });
	if (f.method === 'classify') send({ id: f.id, result: { mode: 'quick' } });
	if (f.method === 'run') {
		pendingRunId = f.id; pendingTurn = f.params.turnId;
		send({ event: 'delta', turnId: pendingTurn, delta: { type: 'text', text: 'hi ' } });
		send({ event: 'tool-call', turnId: pendingTurn, callId: 'c1', tool: 'echo', args: { x: 1 } });
	}
	if (f.method === 'tool-result') {
		send({ event: 'delta', turnId: pendingTurn, delta: { type: 'text', text: 'done' } });
		send({ id: pendingRunId, result: {
			turnId: pendingTurn, stopReason: 'done', text: 'hi done',
			newMessages: [{ role: 'assistant', content: 'hi done' }],
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, steps: 1 },
			echoedToolResult: f.result,
		} });
	}
	if (f.method === 'tool-error') {
		send({ id: pendingRunId, result: {
			turnId: pendingTurn, stopReason: 'error', text: '', newMessages: [],
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 1 },
			errorMessage: f.message,
		} });
	}
	if (f.method === 'shutdown') process.exit(0);
});
`;

const runParams: RunParams = {
	turnId: 't1',
	mode: 'quick',
	system: 'sys',
	messages: [{ role: 'user', content: 'hello' }],
	tools: [],
	limits: { maxSteps: 4, maxToolResultBytes: 1024 },
};

function makeManager(script = FAKE_SIDECAR): AgentSidecarManager {
	return new AgentSidecarManager({ executable: process.execPath, args: ['-e', script] });
}

const CONFIG = { provider: 'anthropic' as const, apiKey: 'k', routerModel: 'r', researchModel: 'R' };

describe('AgentSidecarManager', () => {
	it('runs a turn: streams deltas, dispatches tool calls, returns the result', async () => {
		const mgr = makeManager();
		mgr.start();
		await mgr.configure(CONFIG);
		const deltas: AgentDelta[] = [];
		const toolCalls: { callId: string; tool: string; args: unknown }[] = [];
		const result = await mgr.run(runParams, {
			onDelta: (d) => deltas.push(d),
			onToolCall: async (callId, tool, args) => {
				toolCalls.push({ callId, tool, args });
				return { echoed: args };
			},
		});
		expect(result.stopReason).toBe('done');
		expect(result.text).toBe('hi done');
		expect((result as unknown as { echoedToolResult: unknown }).echoedToolResult).toEqual({ echoed: { x: 1 } });
		expect(toolCalls).toEqual([{ callId: 'c1', tool: 'echo', args: { x: 1 } }]);
		expect(deltas).toEqual([
			{ type: 'text', text: 'hi ' },
			{ type: 'text', text: 'done' },
		]);
		await mgr.shutdown();
	});

	it('turns a throwing tool handler into a tool-error frame the sidecar sees', async () => {
		const mgr = makeManager();
		mgr.start();
		await mgr.configure(CONFIG);
		const result = await mgr.run(runParams, {
			onDelta: () => {},
			onToolCall: async () => { throw new Error('boom'); },
		});
		expect(result.stopReason).toBe('error');
		expect(result.errorMessage).toBe('boom');
		await mgr.shutdown();
	});

	it('honors per-tool watchdog overrides via toolTimeoutMs', async () => {
		const mgr = makeManager();
		mgr.start();
		await mgr.configure(CONFIG);
		// Handler sleeps past its (tiny) budget — the manager must send the
		// sidecar a tool-error, which the fake surfaces as an error result.
		const result = await mgr.run(runParams, {
			onDelta: () => {},
			toolTimeoutMs: () => 100,
			onToolCall: () => new Promise((resolve) => setTimeout(() => resolve({}), 1000)),
		});
		expect(result.stopReason).toBe('error');
		expect(result.errorMessage).toMatch(/timed out after 0.1s/);
		await mgr.shutdown();
	});

	it('classify round-trips', async () => {
		const mgr = makeManager();
		mgr.start();
		await mgr.configure(CONFIG);
		expect(await mgr.classify([{ role: 'user', content: 'q' }])).toEqual({ mode: 'quick' });
		await mgr.shutdown();
	});

	it('disables itself on a handshake mismatch', async () => {
		const mgr = makeManager(FAKE_SIDECAR.replace("name: 'curator-agent'", "name: 'imposter'"));
		mgr.start();
		await new Promise((r) => setTimeout(r, 500));
		expect(mgr.available).toBe(false);
		await expect(mgr.configure(CONFIG)).rejects.toThrow();
		await mgr.shutdown();
	});

	it('rejects in-flight requests when the sidecar dies', async () => {
		// Child that says hello then exits on any run request.
		const mgr = makeManager(`
			const rl = require('node:readline').createInterface({ input: process.stdin });
			process.stdout.write(JSON.stringify({ event: 'hello', name: 'curator-agent', version: 'x', protocol: 1 }) + '\\n');
			rl.on('line', (line) => {
				const f = JSON.parse(line);
				if (f.method === 'configure') process.stdout.write(JSON.stringify({ id: f.id, result: { ok: true } }) + '\\n');
				if (f.method === 'run') process.exit(1);
			});
		`);
		mgr.start();
		await mgr.configure(CONFIG);
		await expect(mgr.run(runParams, { onDelta: () => {}, onToolCall: async () => ({}) }))
			.rejects.toThrow(/exited/);
		await mgr.shutdown();
	});
});

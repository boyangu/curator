import { describe, expect, it } from 'vitest';
import { capToolResult, defaultLoop } from './loop.js';
import { noopLog, type LocalTool, type ModelAdapter, type ModelDelta, type ModelStep, type ToolPort } from './types.js';
import type { AgentConfig, AgentDelta, RunParams, WireMessage } from '../protocol.js';

const CONFIG: AgentConfig = {
	provider: 'openai-compatible',
	baseUrl: 'http://localhost:0',
	apiKey: 'k',
	routerModel: 'router-model',
	researchModel: 'research-model',
};

const params = (over?: Partial<RunParams>): RunParams => ({
	turnId: 't1',
	mode: 'research',
	system: 'sys',
	messages: [{ role: 'user', content: 'q' }],
	tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
	limits: { maxSteps: 5, maxToolResultBytes: 1024 },
	...over,
});

// Scripted adapter: each call shifts the next scripted step. A step is a
// list of deltas plus the response messages the step "produced".
interface ScriptedStep {
	deltas: ModelDelta[];
	messages: WireMessage[];
}

function scriptedAdapter(steps: ScriptedStep[]): ModelAdapter & { calls: number } {
	const adapter = {
		calls: 0,
		stream(): ModelStep {
			const step = steps[adapter.calls++];
			if (!step) throw new Error('adapter over-called');
			return {
				parts: (async function* () { yield* step.deltas; })(),
				responseMessages: async () => step.messages,
			};
		},
		async complete(): Promise<string> { return '{"mode":"quick"}'; },
	};
	return adapter;
}

const finish = (stopReason: 'end' | 'tool-calls', inputTokens = 10): ModelDelta => ({
	type: 'finish',
	stopReason,
	usage: { inputTokens, outputTokens: 5, cacheReadTokens: 2 },
});

const inlinePort = (fn: (tool: string, args: unknown) => unknown): ToolPort => ({
	execute: async (_id, tool, args) => fn(tool, args),
});

describe('defaultLoop', () => {
	it('runs tool-call cycles then finishes, accumulating text + usage', async () => {
		const adapter = scriptedAdapter([
			{
				deltas: [
					{ type: 'text', text: 'looking… ' },
					{ type: 'tool-call', callId: 'c1', tool: 'echo', args: { q: 1 }, providerExecuted: false },
					finish('tool-calls'),
				],
				messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: { q: 1 } }] }],
			},
			{
				deltas: [{ type: 'text', text: 'answer' }, finish('end')],
				messages: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
			},
		]);
		const executed: unknown[] = [];
		const emitted: AgentDelta[] = [];
		const result = await defaultLoop.run(
			params(),
			CONFIG,
			{ model: adapter, tools: inlinePort((_t, args) => { executed.push(args); return { ok: true }; }), localTools: {}, log: noopLog },
			(d) => emitted.push(d),
			new AbortController().signal,
		);
		expect(result.stopReason).toBe('done');
		expect(result.text).toBe('looking… answer');
		expect(executed).toEqual([{ q: 1 }]);
		expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, steps: 2 });
		// Message trail: assistant(tool-call) → tool(result) → assistant(text).
		expect(result.newMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
		const toolMsg = result.newMessages[1] as Extract<WireMessage, { role: 'tool' }>;
		expect(toolMsg.content[0]).toMatchObject({ toolCallId: 'c1', output: { type: 'json', value: { ok: true } } });
		expect(emitted.some((d) => d.type === 'tool-start' && d.tool === 'echo')).toBe(true);
	});

	it('stops at maxSteps when the model keeps calling tools', async () => {
		const step: ScriptedStep = {
			deltas: [
				{ type: 'tool-call', callId: 'c', tool: 'echo', args: {}, providerExecuted: false },
				finish('tool-calls'),
			],
			messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'echo', input: {} }] }],
		};
		const adapter = scriptedAdapter([step, step, step]);
		const result = await defaultLoop.run(
			params({ limits: { maxSteps: 3, maxToolResultBytes: 1024 } }),
			CONFIG,
			{ model: adapter, tools: inlinePort(() => ({})), localTools: {}, log: noopLog },
			() => {},
			new AbortController().signal,
		);
		expect(result.stopReason).toBe('max-steps');
		expect(adapter.calls).toBe(3);
	});

	it('caps oversized tool results with an explicit truncation marker', async () => {
		const adapter = scriptedAdapter([
			{
				deltas: [{ type: 'tool-call', callId: 'c1', tool: 'echo', args: {}, providerExecuted: false }, finish('tool-calls')],
				messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} }] }],
			},
			{ deltas: [finish('end')], messages: [] },
		]);
		const result = await defaultLoop.run(
			params({ limits: { maxSteps: 3, maxToolResultBytes: 100 } }),
			CONFIG,
			{ model: adapter, tools: inlinePort(() => ({ big: 'x'.repeat(500) })), localTools: {}, log: noopLog },
			() => {},
			new AbortController().signal,
		);
		const toolMsg = result.newMessages.find((m) => m.role === 'tool') as Extract<WireMessage, { role: 'tool' }>;
		expect(toolMsg.content[0]!.output).toMatchObject({ type: 'json', value: { truncated: true } });
	});

	it('turns a failing tool into an error-text result, not a failed turn', async () => {
		const adapter = scriptedAdapter([
			{
				deltas: [{ type: 'tool-call', callId: 'c1', tool: 'echo', args: {}, providerExecuted: false }, finish('tool-calls')],
				messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} }] }],
			},
			{ deltas: [{ type: 'text', text: 'recovered' }, finish('end')], messages: [] },
		]);
		const result = await defaultLoop.run(
			params(),
			CONFIG,
			{ model: adapter, tools: inlinePort(() => { throw new Error('nope'); }), localTools: {}, log: noopLog },
			() => {},
			new AbortController().signal,
		);
		expect(result.stopReason).toBe('done');
		const toolMsg = result.newMessages.find((m) => m.role === 'tool') as Extract<WireMessage, { role: 'tool' }>;
		expect(toolMsg.content[0]!.output).toEqual({ type: 'error-text', value: 'nope' });
	});

	it('executes local tools in-process and skips provider-executed calls', async () => {
		const localCalls: unknown[] = [];
		const local: LocalTool = {
			spec: { name: 'web_fetch', description: 'f', parameters: { type: 'object' } },
			execute: async (args) => { localCalls.push(args); return { text: 'page' }; },
		};
		const adapter = scriptedAdapter([
			{
				deltas: [
					{ type: 'tool-call', callId: 's1', tool: 'web_search', args: {}, providerExecuted: true },
					{ type: 'tool-call', callId: 'c1', tool: 'web_fetch', args: { url: 'https://x' }, providerExecuted: false },
					finish('tool-calls'),
				],
				messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'web_fetch', input: { url: 'https://x' } }] }],
			},
			{ deltas: [finish('end')], messages: [] },
		]);
		let portCalled = false;
		await defaultLoop.run(
			params(),
			CONFIG,
			{ model: adapter, tools: inlinePort(() => { portCalled = true; return {}; }), localTools: { web_fetch: local }, log: noopLog },
			() => {},
			new AbortController().signal,
		);
		expect(localCalls).toEqual([{ url: 'https://x' }]);
		expect(portCalled).toBe(false); // provider-executed + local both bypass the port
	});

	it('reports cancelled when aborted mid-stream', async () => {
		const abort = new AbortController();
		const adapter: ModelAdapter = {
			stream(): ModelStep {
				return {
					parts: (async function* (): AsyncGenerator<ModelDelta> {
						yield { type: 'text', text: 'partial' };
						abort.abort();
						throw new Error('aborted');
					})(),
					responseMessages: async () => [],
				};
			},
			async complete(): Promise<string> { return ''; },
		};
		const result = await defaultLoop.run(
			params(),
			CONFIG,
			{ model: adapter, tools: inlinePort(() => ({})), localTools: {}, log: noopLog },
			() => {},
			abort.signal,
		);
		expect(result.stopReason).toBe('cancelled');
		expect(result.text).toBe('partial');
	});
});

describe('capToolResult', () => {
	it('passes small results through as json', () => {
		expect(capToolResult({ a: 1 }, 100)).toEqual({ type: 'json', value: { a: 1 } });
	});
	it('replaces oversized results with marker + preview', () => {
		const out = capToolResult({ big: 'x'.repeat(5000) }, 100);
		expect(out).toMatchObject({ type: 'json', value: { truncated: true } });
		expect((out as { value: { preview: string } }).value.preview.length).toBeLessThanOrEqual(2000);
	});
});

// Default agent loop — while the model keeps calling tools and the step
// budget lasts: stream one model step, forward client tool calls to the
// host (or run sidecar-local tools), append results, re-stream. The AI SDK
// never executes tools here; the loop owns execution so the host stays the
// single authority on what a tool does.

import type { AgentDelta, RunParams, RunResult, RunUsage, WireMessage, WireToolResultPart } from '../protocol.js';
import type { AgentLoop, LoopDeps, ModelDelta } from './types.js';

const ARGS_SUMMARY_MAX = 120;

function summarize(value: unknown, max = ARGS_SUMMARY_MAX): string {
	let s: string;
	try {
		s = JSON.stringify(value) ?? '';
	} catch {
		s = String(value);
	}
	return s.length > max ? s.slice(0, max) + '…' : s;
}

// Cap a tool result before it enters model context. Oversized results are
// replaced (not sliced mid-JSON) with an explicit marker + paging hint the
// model can act on.
export function capToolResult(value: unknown, maxBytes: number): WireToolResultPart['output'] {
	let json: string;
	try {
		json = JSON.stringify(value) ?? 'null';
	} catch (err) {
		return { type: 'error-text', value: `tool result not serializable: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (Buffer.byteLength(json, 'utf8') <= maxBytes) return { type: 'json', value };
	return {
		type: 'json',
		value: {
			truncated: true,
			note: `result exceeded ${maxBytes} bytes — refine the query (smaller limit, offset paging, narrower filter)`,
			preview: json.slice(0, 2000),
		},
	};
}

interface PendingCall {
	callId: string;
	tool: string;
	args: unknown;
	local: boolean;
}

export const defaultLoop: AgentLoop = {
	async run(params: RunParams, config, deps: LoopDeps, emit: (d: AgentDelta) => void, abort: AbortSignal): Promise<RunResult> {
		const model = params.mode === 'research' ? config.researchModel : config.routerModel;
		const messages: WireMessage[] = [...params.messages];
		const newMessages: WireMessage[] = [];
		const usage: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0 };
		let text = '';

		// Local tool specs ride alongside the host's in the model's tool list.
		const tools = [...params.tools, ...Object.values(deps.localTools).map((t) => t.spec)];

		for (let stepNo = 1; stepNo <= params.limits.maxSteps; stepNo++) {
			if (abort.aborted) return { turnId: params.turnId, stopReason: 'cancelled', text, newMessages, usage };
			usage.steps = stepNo;
			emit({ type: 'step', model, step: stepNo });

			const step = deps.model.stream({
				config,
				model,
				system: params.system,
				messages,
				tools,
				// Provider-native web tools only on research turns — quick turns
				// are local-data lookups and shouldn't invite a web detour.
				nativeWebTools: params.mode === 'research',
				abort,
			});

			const calls: PendingCall[] = [];
			let finish: Extract<ModelDelta, { type: 'finish' }> | null = null;
			try {
				for await (const part of step.parts) {
					switch (part.type) {
						case 'text':
							text += part.text;
							emit({ type: 'text', text: part.text });
							break;
						case 'reasoning':
							emit({ type: 'reasoning', text: part.text });
							break;
						case 'tool-call':
							emit({ type: 'tool-start', callId: part.callId, tool: part.tool, argsSummary: summarize(part.args) });
							if (!part.providerExecuted) {
								calls.push({ callId: part.callId, tool: part.tool, args: part.args, local: part.tool in deps.localTools });
							}
							break;
						case 'tool-end':
							emit({ type: 'tool-end', callId: part.callId, tool: part.tool, ok: part.ok, summary: '' });
							break;
						case 'source':
							emit({ type: 'source', url: part.url, ...(part.title ? { title: part.title } : {}) });
							break;
						case 'finish':
							finish = part;
							break;
					}
				}
			} catch (err) {
				if (abort.aborted) return { turnId: params.turnId, stopReason: 'cancelled', text, newMessages, usage };
				return {
					turnId: params.turnId,
					stopReason: 'error',
					text,
					newMessages,
					usage,
					errorMessage: err instanceof Error ? err.message : String(err),
				};
			}

			if (finish) {
				usage.inputTokens += finish.usage.inputTokens;
				usage.outputTokens += finish.usage.outputTokens;
				usage.cacheReadTokens += finish.usage.cacheReadTokens;
			}
			deps.log.append(params.turnId, { step: stepNo, finish: finish?.stopReason, calls: calls.length });

			const respMsgs = await step.responseMessages();
			messages.push(...respMsgs);
			newMessages.push(...respMsgs);

			if (!finish || finish.stopReason !== 'tool-calls') {
				if (finish?.stopReason === 'error') {
					return { turnId: params.turnId, stopReason: 'error', text, newMessages, usage, errorMessage: 'model step failed' };
				}
				// 'end' and 'length' both terminate the turn — a length-capped
				// answer is still an answer.
				return { turnId: params.turnId, stopReason: 'done', text, newMessages, usage };
			}
			if (calls.length === 0) {
				// Provider executed everything server-side and still reported
				// tool-calls — nothing for us to do; loop for the next step.
				continue;
			}

			// Execute client tool calls (host + local) concurrently. A failed
			// tool becomes an error result the model can react to, never a
			// failed turn.
			const results = await Promise.all(
				calls.map(async (c): Promise<WireToolResultPart> => {
					try {
						const raw = c.local
							? await deps.localTools[c.tool]!.execute(c.args, abort)
							: await deps.tools.execute(c.callId, c.tool, c.args);
						const output = capToolResult(raw, params.limits.maxToolResultBytes);
						if (c.local) emit({ type: 'tool-end', callId: c.callId, tool: c.tool, ok: true, summary: summarize(raw) });
						return { type: 'tool-result', toolCallId: c.callId, toolName: c.tool, output };
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						if (c.local) emit({ type: 'tool-end', callId: c.callId, tool: c.tool, ok: false, summary: message });
						return { type: 'tool-result', toolCallId: c.callId, toolName: c.tool, output: { type: 'error-text', value: message } };
					}
				}),
			);
			if (abort.aborted) return { turnId: params.turnId, stopReason: 'cancelled', text, newMessages, usage };
			const toolMessage: WireMessage = { role: 'tool', content: results };
			messages.push(toolMessage);
			newMessages.push(toolMessage);
		}

		return { turnId: params.turnId, stopReason: 'max-steps', text, newMessages, usage };
	},
};

// Curator's tool specs and results in MCP's shapes (SDK v1, which already
// carries tool annotations and structured content).

import type { ToolAnnotations, WireToolSpec } from './protocol.js';

export type McpToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

// agent-core's annotations are MCP's hints under shorter names. Hints only:
// the desktop's confirm gate decides what a write may do.
export function toHints(a: ToolAnnotations | undefined): McpToolAnnotations | undefined {
	if (!a) return undefined;
	const out: McpToolAnnotations = {};
	if (a.readOnly !== undefined) out.readOnlyHint = a.readOnly;
	if (a.destructive !== undefined) out.destructiveHint = a.destructive;
	if (a.idempotent !== undefined) out.idempotentHint = a.idempotent;
	if (a.openWorld !== undefined) out.openWorldHint = a.openWorld;
	return out;
}

export function toMcpTool(t: WireToolSpec): { name: string; description: string; inputSchema: { type: 'object'; [k: string]: unknown }; annotations?: McpToolAnnotations } {
	const annotations = toHints(t.annotations);
	return {
		name: t.name,
		description: t.description,
		inputSchema: t.parameters as { type: 'object'; [k: string]: unknown },
		...(annotations ? { annotations } : {}),
	};
}

// A tool result for MCP: always a text block (every client reads it), plus
// structuredContent when the result is an object, so clients that can use
// the data skip re-parsing it. No outputSchema: results are heterogeneous.
export function toCallResult(result: unknown): { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown> } {
	const text = typeof result === 'string' ? result : JSON.stringify(result);
	const structured = result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined;
	return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

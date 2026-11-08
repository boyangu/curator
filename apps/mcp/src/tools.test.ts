// The shim's MCP shapes: annotations become MCP hints, object results carry
// structuredContent beside the text block, and the inlined bridge protocol
// number matches the shared one.

import { describe, expect, it } from 'vitest';
import { MCP_BRIDGE_PROTOCOL as SHARED } from '@curator/agent-core';
import { MCP_BRIDGE_PROTOCOL } from './protocol.js';
import { toCallResult, toHints, toMcpTool } from './tools.js';

describe('MCP shapes', () => {
	it('maps annotations to MCP hints and leaves them out when absent', () => {
		const t = toMcpTool({ name: 'remove_tracks_from_playlist', description: 'd', parameters: { type: 'object' }, annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: true } });
		expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
		expect(toMcpTool({ name: 'x', description: 'd', parameters: { type: 'object' } })).not.toHaveProperty('annotations');
		expect(toHints({ readOnly: true })).toEqual({ readOnlyHint: true });
	});

	it('returns structured content for object results only', () => {
		expect(toCallResult({ rows: [1, 2] })).toEqual({ content: [{ type: 'text', text: '{"rows":[1,2]}' }], structuredContent: { rows: [1, 2] } });
		expect(toCallResult('done')).toEqual({ content: [{ type: 'text', text: 'done' }] });
		expect(toCallResult([1, 2])).not.toHaveProperty('structuredContent');
		expect(toCallResult(null)).not.toHaveProperty('structuredContent');
	});

	it('keeps the inlined bridge protocol equal to the shared one', () => {
		expect(MCP_BRIDGE_PROTOCOL).toBe(SHARED);
	});
});

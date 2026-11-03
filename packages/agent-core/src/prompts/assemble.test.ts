// The prefix is deterministic and its hash moves only with the prefix: a
// rule change or a tool change is a new version, a reordered input is not a
// different prompt, and the breakpoint sits on the last stable block.

import { describe, expect, it } from 'vitest';
import { assemblePrompt, fnv1a64, promptHash } from './assemble.js';

const tools = [
	{ name: 'a', description: 'first', parameters: { type: 'object' } },
	{ name: 'b', description: 'second', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
];

describe('assemblePrompt', () => {
	it('joins core and pack, puts the breakpoint on the pack, and hashes the whole prefix', () => {
		const p = assemblePrompt({ core: 'core rules\n', pack: { id: 'catalog.twins', version: '1', text: '\npack rules' }, tools });
		expect(p.system).toBe('core rules\n\npack rules');
		expect(p.blocks.map((b) => b.cacheBreakpoint)).toEqual([false, true]);
		expect(p.packId).toBe('catalog.twins');
		expect(p.hash).toMatch(/^[0-9a-f]{16}$/);
		expect(assemblePrompt({ core: 'core rules', pack: { id: 'catalog.twins', version: '1', text: 'pack rules' }, tools }).hash).toBe(p.hash);
	});

	it('without a pack the core is the breakpoint', () => {
		const p = assemblePrompt({ core: 'only core' });
		expect(p.blocks).toEqual([{ text: 'only core', cacheBreakpoint: true }]);
		expect(p.packId).toBeNull();
	});

	it('changes the hash when a rule, a tool description or the tool order changes', () => {
		const base = promptHash('sys', tools);
		expect(promptHash('sys changed', tools)).not.toBe(base);
		expect(promptHash('sys', [tools[0]!, { ...tools[1]!, description: 'other' }])).not.toBe(base);
		expect(promptHash('sys', [tools[1]!, tools[0]!])).not.toBe(base);
		expect(promptHash('sys', tools)).toBe(base);
	});

	it('fnv1a64 matches the reference vector', () => {
		// FNV-1a 64 of the empty string is the offset basis.
		expect(fnv1a64('')).toBe('cbf29ce484222325');
		expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
	});
});

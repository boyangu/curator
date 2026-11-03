// Prompt assembly — the one place the cached prefix is built, so its order
// is deterministic and its version is a number anyone can compare.
//
// A provider's prompt cache is a byte-prefix match over tools → system →
// messages: the first differing byte invalidates everything after it. So
// the prefix is composed from parts that change at different rates — a
// frozen core (how this agent works at all), a surface's rule pack (what it
// decides and how, versioned in the repo), the tool specs in a fixed order —
// and everything volatile (retrieved memory, the evidence pack, the view
// context, the user's words) stays in the messages after it. The hash of the
// prefix is the prompt version: it goes on every decision record and eval
// row, so a changed rule shows up as a changed hash, nothing else does.

import type { WireToolSpec } from '../protocol.js';

export interface PromptPack {
	// Stable id of the surface or case the pack rules ('catalog.release_twin').
	id: string;
	// Bumped by hand with every rule change, with a changelog entry next to it.
	version: string;
	text: string;
}

export interface PromptPrefix {
	// The system prompt: core, then the pack, blank-line separated.
	system: string;
	// Where a cache breakpoint belongs: after the pack (the last block that
	// is identical across requests of this surface).
	blocks: { text: string; cacheBreakpoint: boolean }[];
	// Tool specs as given — the caller keeps their order fixed.
	tools: WireToolSpec[];
	// Version of the whole prefix (core + pack + tools).
	hash: string;
	packId: string | null;
	packVersion: string | null;
}

export function assemblePrompt(input: { core: string; pack?: PromptPack; tools?: WireToolSpec[] }): PromptPrefix {
	const tools = input.tools ?? [];
	const blocks: PromptPrefix['blocks'] = [{ text: input.core.trim(), cacheBreakpoint: !input.pack }];
	if (input.pack) blocks.push({ text: input.pack.text.trim(), cacheBreakpoint: true });
	const system = blocks.map((b) => b.text).join('\n\n');
	return {
		system,
		blocks,
		tools,
		hash: promptHash(system, tools),
		packId: input.pack?.id ?? null,
		packVersion: input.pack?.version ?? null,
	};
}

// FNV-1a over the UTF-8 bytes, 64-bit, as 16 hex digits. A version id, not a
// security primitive: collisions between two prompts of one product are
// not a realistic concern, and it needs no crypto module on any runtime.
export function promptHash(system: string, tools: readonly WireToolSpec[] = []): string {
	return fnv1a64(system + '\u0000' + JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters])));
}

export function fnv1a64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let h = 0xcbf29ce484222325n;
	for (const b of bytes) {
		h ^= BigInt(b);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, '0');
}

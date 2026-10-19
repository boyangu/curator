// The phone and the cloud service import the shared types; schema.ts carries
// drizzle-orm/sqlite-core, so a value import that reaches it from types.ts
// would load the SQLite dialect on runtimes that have no use for it.
//
// Checked statically rather than by loading the module and inspecting what
// came along: vitest serves ESM through its own module graph, so there is no
// require.cache to read, and vi.resetModules() does not say which files a
// fresh import touched. Walking the value-import graph from the source is
// exact for this question, because `import type` (and inline `type`
// specifiers under verbatimModuleSyntax) are erased and never load anything.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

const STATEMENT_RE = /^\s*(import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

// Specifiers of one file's imports that survive type erasure.
function valueImports(file: string): string[] {
	const text = readFileSync(file, 'utf8');
	const out: string[] = [];
	for (const m of text.matchAll(STATEMENT_RE)) {
		if (m[4]) {
			out.push(m[4]);
			continue;
		}
		const clause = m[2]!.trim();
		if (clause.startsWith('type ')) continue;
		// `import { type A, type B } from` is fully erased; any untyped
		// specifier keeps the import alive.
		const braces = clause.match(/^\{([\s\S]*)\}$/);
		if (braces && braces[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
		out.push(m[3]!);
	}
	return out;
}

// Every bare specifier reachable from `entry` through value imports.
function reachableBareImports(entry: string): Map<string, string> {
	const seen = new Set<string>();
	const bare = new Map<string, string>();
	const stack = [join(srcDir, entry)];
	while (stack.length) {
		const file = stack.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const spec of valueImports(file)) {
			if (spec.startsWith('.')) stack.push(join(dirname(file), spec.replace(/\.js$/, '.ts')));
			else bare.set(spec, relative(srcDir, file));
		}
	}
	return bare;
}

describe('drizzle-free shared modules', () => {
	it('types.ts reaches no drizzle-orm module through value imports', () => {
		const bare = reachableBareImports('types.ts');
		const drizzle = [...bare].filter(([spec]) => spec.startsWith('drizzle-orm'));
		expect(drizzle).toEqual([]);
		// Sanity: the walk sees real imports (zod is types.ts's one dependency).
		expect(bare.has('zod')).toBe(true);
	});

	it('enums.ts imports nothing', () => {
		expect(valueImports(join(srcDir, 'enums.ts'))).toEqual([]);
	});

	it('the walker does see drizzle when it is there', () => {
		expect([...reachableBareImports('schema.ts').keys()]).toContain('drizzle-orm/sqlite-core');
	});
});

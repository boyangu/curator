// Import-boundary check for the packages shared by desktop, cloud and phone,
// and for the cloud API that must never load desktop code.
//
// `packages/protocol` is the wire and merge contract and `packages/library-logic`
// holds pure functions both sides must agree on. They are loaded by the
// desktop main process, the cloud API and, later, a React Native app, so a
// single import of drizzle, better-sqlite3, node:* or app code would either
// fail to load on one of those runtimes or silently pull a SQLite dialect into
// the cloud. tsc cannot express "this package may only import X", so this runs
// after it in each package's typecheck script; a violation fails the build.
//
// Usage: node scripts/check-package-boundaries.mjs <package-name>

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// What each package may import from non-test source. Relative imports inside
// the package are always allowed; tests may also use vitest and node:* (they
// run under Node only).
//   allow      — any specifier of these packages
//   allowExact — these exact specifiers (subpaths of a package that is
//                otherwise off limits)
//   typeOnly   — `import type` / `export type` from these packages; erased at
//                compile time, so nothing loads at runtime
//   ownDeps    — this package.json's non-workspace `dependencies` are allowed
//                (plus `devDependencies` in tests); workspace packages still
//                need an explicit rule above
//   allowNode  — node:* builtins in non-test source too
//   testDirs   — files under these repo-relative dirs count as test code
//   deny       — patterns refused even where another rule would allow them
const RULES = {
	protocol: { dir: 'packages/protocol/src', allow: ['zod'] },
	'library-logic': {
		dir: 'packages/library-logic/src',
		// matcher is pure string scoring with no dependencies of its own;
		// versionOf is defined in terms of its baseTitle/normalize, so a copy
		// here would drift from the scanner's and the streaming dedup's view of
		// a title.
		allow: ['@curator/matcher'],
		// The shared barrel re-exports schema.ts and with it drizzle-orm/sqlite-core;
		// these two subpaths are import-free (packages/shared/src/enums.test.ts
		// pins that for the enums), so the merge engine can use the sync
		// field list and cue keys without dragging the dialect along.
		allowExact: ['@curator/shared/enums', '@curator/shared/sync'],
		typeOnly: ['@curator/shared'],
	},
	// The cloud API (plan D11): the shared contract packages and its own npm
	// dependencies, never desktop code. apps/core is SQLite-bound end to end,
	// so one import of it (or of a SQLite driver or dialect) would put the
	// desktop's storage stack inside the server. It is a Node service, so
	// node:* is fine in source, and its test harness under src/test/ counts as
	// test code (PGlite, jose key generation and the tRPC client are devDeps).
	cloud: {
		dir: 'apps/cloud/src',
		allow: ['@curator/protocol', '@curator/library-logic'],
		allowExact: ['@curator/shared/enums', '@curator/shared/sync'],
		typeOnly: ['@curator/shared'],
		ownDeps: 'apps/cloud/package.json',
		allowNode: true,
		testDirs: ['apps/cloud/src/test/'],
		deny: [/^@curator\/(core|desktop|mcp|agent)(\/|$)/, /sqlite/i],
	},
};

const name = process.argv[2];
const rule = RULES[name];
if (!rule) {
	console.error(`[package-boundaries] unknown package "${name}"; known: ${Object.keys(RULES).join(', ')}`);
	process.exit(2);
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (/\.tsx?$/.test(entry)) yield p;
	}
}

// Workspace packages are excluded: listing one as a dependency must not be a
// way around its explicit rule.
function ownDeps(pkgJsonPath) {
	const pkg = JSON.parse(readFileSync(join(repoRoot, pkgJsonPath), 'utf8'));
	const external = (deps) => Object.keys(deps ?? {}).filter((d) => !d.startsWith('@curator/'));
	return { prod: external(pkg.dependencies), dev: external(pkg.devDependencies) };
}
const deps = rule.ownDeps ? ownDeps(rule.ownDeps) : { prod: [], dev: [] };

const srcRoot = join(repoRoot, rule.dir);
const failures = [];
for (const file of walk(srcRoot)) {
	const rel = relative(repoRoot, file).split(sep).join('/');
	const isTest = /\.test\.tsx?$/.test(file) || (rule.testDirs ?? []).some((d) => rel.startsWith(d));
	const text = readFileSync(file, 'utf8');
	for (const m of text.matchAll(IMPORT_RE)) {
		const spec = m[1] ?? m[2] ?? m[3];
		if (spec.startsWith('./') || spec.startsWith('../')) continue;
		const line = text.slice(0, m.index).split('\n').length;
		const denied = (rule.deny ?? []).find((re) => re.test(spec));
		if (denied) {
			failures.push(`${rel}:${line} imports "${spec}"; ${name} must never import anything matching ${denied}`);
			continue;
		}
		if (isTest && (spec === 'vitest' || spec.startsWith('node:'))) continue;
		if (rule.allowNode && spec.startsWith('node:')) continue;
		const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
		if (rule.allow.includes(pkg)) continue;
		if (deps.prod.includes(pkg) || (isTest && deps.dev.includes(pkg))) continue;
		if (rule.allowExact?.includes(spec)) continue;
		if (rule.typeOnly?.includes(spec) && /^(?:import|export)\s+type\s/.test(m[0])) continue;
		const allowed = [
			...rule.allow,
			...(rule.allowExact ?? []),
			...(rule.typeOnly ?? []).map((p) => `type-only ${p}`),
			...(rule.ownDeps ? [`its own dependencies (${rule.ownDeps})`] : []),
		];
		failures.push(`${rel}:${line} imports "${spec}"; ${name} may import only ${allowed.length ? allowed.join(', ') : 'relative paths'}`);
	}
}

if (failures.length) {
	console.error(`[package-boundaries] ${failures.length} violation(s) in ${name}:`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`[package-boundaries] ${name} boundaries OK`);

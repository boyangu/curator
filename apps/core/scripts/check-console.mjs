// Core logging boundary check — bans bare console.* under apps/core/src so
// every record routes through the structured logger (src/log.ts) and lands
// in the desktop session file / a future hosted sink. Runs after tsc in the
// core typecheck script; a violation is a build failure, not a review catch.
//
// Exemptions: the smoke CLIs (console IS their product output) and the
// logger accessor itself would be one if it used console (it doesn't — the
// consoleSink lives in @curator/shared).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug)\(/;
const EXEMPT = new Set([
	join('auth', 'smoke.ts'),
	join('sync', 'smoke.ts'),
]);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
	}
}

const failures = [];
for (const file of walk(srcRoot)) {
	const rel = relative(srcRoot, file);
	if (EXEMPT.has(rel)) continue;
	const text = readFileSync(file, 'utf8');
	if (CONSOLE_RE.test(text)) {
		const line = text.split('\n').findIndex((l) => CONSOLE_RE.test(l)) + 1;
		failures.push(`${rel}:${line} — bare console.* in core; use the logger (src/log.ts)`);
	}
}

if (failures.length) {
	console.error('[console-check] core logging violations:\n  ' + failures.join('\n  '));
	process.exit(1);
}
console.log('[console-check] core console boundaries OK');

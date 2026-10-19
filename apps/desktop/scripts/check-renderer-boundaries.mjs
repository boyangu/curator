// Renderer architecture boundary checks (planning/tech/frontend-architecture.md).
// Run after tsc in the desktop typecheck script — a boundary violation is a
// build failure, not a review catch. Rules grow stricter per phase:
//
//   F1: region-host visibility is written ONLY by views/regionEffect.ts.
//   F2: window.api is referenced ONLY under renderer/data/ (the exemption
//       list below is the not-yet-migrated set — it may only SHRINK).
//   R3: bare console.* is banned in renderer AND main — everything routes
//       through the structured logger (renderer/data/log.ts, main/log.ts)
//       so packaged builds keep their logs. Exemption sets below.
//
// Heuristic on purpose: greps catch the exact idioms that caused the
// stale-writer bug class. TypeScript owns semantics; this owns discipline.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const rendererRoot = join(srcRoot, 'renderer');
const mainRoot = join(srcRoot, 'main');

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
	}
}

const failures = [];

// ── Rule 1: single visibility writer ────────────────────────────────────
// The historical writer idiom was `const tracksView = getElementById(...)`
// + `tracksView.hidden = ...`. Catch that variable-name pattern (and the
// direct-element form) everywhere except the derivation.
const HOST_VAR = /\b(tracksView|syncView|dlView|discoverView(?:El)?|emptyEl|hosts\.\w+)\.hidden\s*=/;
const VISIBILITY_OWNER = join('views', 'regionEffect.ts');

// ── Rule 1b: player-chrome body attributes ──────────────────────────────
// data-player-dock / -presence / -mode are pure derivations in the shell
// view model; views/regionEffect.ts is their only DOM writer — the same
// single-writer invariant as Rule 1. (The presence/mode writes used to live
// in main.ts and drifted out of sync with the dock rule.)
const PLAYER_CHROME = /document\.body\.dataset\.player(Dock|Presence|Mode)\s*=|body\.setAttribute\(\s*['"]data-player-/;

// ── Rule 2: window.api containment ──────────────────────────────────────
// Files allowed to touch window.api until F2 migrates them onto the data
// layer. This list may only shrink — add NOTHING here.
const API_EXEMPT_UNTIL_F2 = new Set([
	'main.ts',
	'player.ts',
	'omnibar.ts',
	'controllers.ts',
	'cuePalette.ts',
	join('components', 'DiscoverView.tsx'),
	join('stores', 'analysisStore.ts'),
	join('stores', 'tagsStore.ts'),
]);

// ── Rule 3: no bare console.* ───────────────────────────────────────────
// Everything routes through the structured logger so packaged builds keep
// their logs. Renderer exemption: data/log.ts (the logger itself — its
// consoleSink is the DevTools render path). Main exemption: the core-sidecar
// entry's pre-logger fatal guards (they fire before any logger can exist;
// the host's stderr pipe captures them).
const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug)\(/;
const CONSOLE_EXEMPT_RENDERER = new Set([join('data', 'log.ts')]);
const CONSOLE_EXEMPT_MAIN = new Set([join('core-sidecar', 'entry.ts')]);

for (const file of walk(rendererRoot)) {
	const rel = relative(rendererRoot, file);
	const text = readFileSync(file, 'utf8');

	if (rel !== VISIBILITY_OWNER && HOST_VAR.test(text)) {
		const line = text.split('\n').findIndex((l) => HOST_VAR.test(l)) + 1;
		failures.push(`${rel}:${line} — region-host visibility write outside views/regionEffect.ts`);
	}

	if (rel !== VISIBILITY_OWNER && PLAYER_CHROME.test(text)) {
		const line = text.split('\n').findIndex((l) => PLAYER_CHROME.test(l)) + 1;
		failures.push(`${rel}:${line} — player-chrome body attribute write outside views/regionEffect.ts`);
	}

	if (text.includes('window.api')) {
		const inData = rel.split(sep)[0] === 'data';
		if (!inData && !API_EXEMPT_UNTIL_F2.has(rel)) {
			failures.push(`${rel} — window.api outside renderer/data/ (and not on the F2 exemption list)`);
		}
	}

	if (!CONSOLE_EXEMPT_RENDERER.has(rel) && CONSOLE_RE.test(text)) {
		const line = text.split('\n').findIndex((l) => CONSOLE_RE.test(l)) + 1;
		failures.push(`${rel}:${line} — bare console.* in renderer; use the logger (renderer/data/log.ts)`);
	}
}

for (const file of walk(mainRoot)) {
	const rel = relative(mainRoot, file);
	if (CONSOLE_EXEMPT_MAIN.has(rel)) continue;
	const text = readFileSync(file, 'utf8');
	if (CONSOLE_RE.test(text)) {
		const line = text.split('\n').findIndex((l) => CONSOLE_RE.test(l)) + 1;
		failures.push(`main/${rel}:${line} — bare console.* in main; use mainLog (main/log.ts)`);
	}
}

if (failures.length) {
	console.error('[boundaries] renderer architecture violations:\n  ' + failures.join('\n  '));
	process.exit(1);
}
console.log('[boundaries] renderer boundaries OK');

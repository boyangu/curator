// Safety rails for the rekordbox e2e run. The sources are the user's live
// library (curator.db, rekordbox's master.db, the music files its rows point
// at) and are only ever read; every write lands in one work dir under the
// e2e root. These checks run before anything is copied, again before the
// rekordbox push, and refuse rather than warn: a path that resolves into a
// live folder is a bug in the caller, never something to work around.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

export class RailError extends Error {
	override readonly name = 'RailError';
}

// Absolute, symlinks/junctions resolved as far as the path exists, case
// folded on Windows (its filesystems are case-insensitive), no trailing
// separator. A target that does not exist yet is resolved through its
// nearest existing ancestor, so `..` and a junction above it cannot hide
// where it really lands.
export function canonical(p: string): string {
	let head = resolve(p);
	const tail: string[] = [];
	while (!existsSync(head)) {
		const up = dirname(head);
		if (up === head) break;
		tail.unshift(basename(head));
		head = up;
	}
	let real = head;
	try { real = realpathSync.native(head); } catch { /* keep the resolved form */ }
	let out = tail.length > 0 ? join(real, ...tail) : real;
	if (out.length > 1 && out.endsWith(sep) && !/^[A-Za-z]:\\$/.test(out)) out = out.slice(0, -1);
	return process.platform === 'win32' ? out.toLowerCase() : out;
}

// `child` is `parent` or below it.
export function isInside(child: string, parent: string): boolean {
	return insideCanonical(canonical(child), canonical(parent));
}

function insideCanonical(c: string, p: string): boolean {
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export type LiveRoots = {
	// %APPDATA%/Curator* (the app's userData, its profiles and siblings).
	curator: string[];
	// %APPDATA%/Pioneer (rekordbox's library, its share/ and backups).
	pioneer: string[];
	// The music folders: ~/Music, the library's watched folders and every
	// folder a local file row points into.
	music: string[];
};

export function defaultLiveRoots(opts: { env?: NodeJS.ProcessEnv; music?: readonly string[] } = {}): LiveRoots {
	const env = opts.env ?? process.env;
	const appData = env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
	let curator: string[] = [];
	try {
		curator = readdirSync(appData).filter((n) => /^@?curator/i.test(n)).map((n) => join(appData, n));
	} catch { /* no APPDATA dir: nothing live to protect there */ }
	if (!curator.some((c) => basename(c).toLowerCase() === 'curator')) curator.push(join(appData, 'Curator'));
	return { curator, pioneer: [join(appData, 'Pioneer')], music: [join(homedir(), 'Music'), ...(opts.music ?? [])] };
}

export type RailInput = {
	// The e2e root (planning/private/e2e for the CLI) and this run's dir.
	workRoot: string;
	workDir: string;
	// Everything the run will write: copies, databases, sidecar roots.
	targets: readonly string[];
	// Everything the run reads from the live library.
	sources: readonly string[];
	live: LiveRoots;
};

export function assertSafeTargets(input: RailInput): void {
	// Canonicalised once: the music roots are every folder a file row
	// points into, thousands on a real library.
	const liveAll = [...new Set([...input.live.curator, ...input.live.pioneer, ...input.live.music])].map((l) => ({ l, c: canonical(l) }));
	const liveHit = (p: string): string | undefined => {
		const c = canonical(p);
		return liveAll.find((x) => insideCanonical(c, x.c))?.l;
	};
	const hitRoot = liveHit(input.workRoot);
	if (hitRoot) throw new RailError(`refusing: the e2e root ${input.workRoot} is inside the live folder ${hitRoot}`);
	if (!isInside(input.workDir, input.workRoot) || canonical(input.workDir) === canonical(input.workRoot)) {
		throw new RailError(`refusing: the work dir ${input.workDir} is not a run folder under ${input.workRoot}`);
	}
	const sources = input.sources.flatMap((s) => [s, `${s}-wal`, `${s}-shm`, `${s}-journal`]).map(canonical);
	for (const t of input.targets) {
		const hit = liveHit(t);
		if (hit) throw new RailError(`refusing: target ${t} is inside the live folder ${hit}`);
		if (!isInside(t, input.workDir)) throw new RailError(`refusing: target ${t} is outside the work dir ${input.workDir}`);
		if (sources.includes(canonical(t))) throw new RailError(`refusing: target ${t} is a source path`);
		for (const s of input.sources) {
			if (isInside(s, t)) throw new RailError(`refusing: target ${t} contains the source ${s}`);
		}
	}
}

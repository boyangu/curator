// The rails refuse every target that lands in a live folder, on a source,
// or outside the run's work dir — and the run stops on them before it has
// copied or created anything.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_WORK_ROOT } from './paths.js';
import { runRekordboxE2E } from './pipeline.js';
import { assertSafeTargets, defaultLiveRoots, isInside, RailError, type LiveRoots } from './rails.js';

let dir: string;
let live: LiveRoots;
let workRoot: string;
let src: { curatorDb: string; rbDb: string };
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-e2e-rails-'));
	const appData = join(dir, 'AppData', 'Roaming');
	for (const d of ['Curator', 'Curator-second', 'Pioneer/rekordbox', 'Music']) mkdirSync(join(appData, d), { recursive: true });
	live = { curator: [join(appData, 'Curator'), join(appData, 'Curator-second')], pioneer: [join(appData, 'Pioneer')], music: [join(appData, 'Music')] };
	src = { curatorDb: join(appData, 'Curator', 'curator.db'), rbDb: join(appData, 'Pioneer', 'rekordbox', 'master.db') };
	writeFileSync(src.curatorDb, '');
	writeFileSync(src.rbDb, '');
	workRoot = join(dir, 'repo', 'planning', 'private', 'e2e');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const check = (workDir: string, targets: string[]): void => assertSafeTargets({ workRoot, workDir, targets, sources: [src.curatorDb, src.rbDb], live });

describe('rails', () => {
	it('accepts a run folder under the e2e root', () => {
		const wd = join(workRoot, 'run-1');
		expect(() => check(wd, [wd, join(wd, 'rb', 'master.db'), join(wd, 'founder', 'curator.db')])).not.toThrow();
	});

	it('refuses a work dir outside the e2e root, or the root itself', () => {
		expect(() => check(join(dir, 'elsewhere'), [])).toThrow(RailError);
		expect(() => check(workRoot, [])).toThrow(RailError);
		expect(() => check(join(workRoot, '..', 'sneaky'), [])).toThrow(RailError);
	});

	it('refuses targets in the live Curator, Pioneer and music folders', () => {
		const wd = join(workRoot, 'run-2');
		expect(() => check(wd, [src.rbDb])).toThrow(/live folder/);
		expect(() => check(wd, [join(live.curator[1]!, 'curator.db')])).toThrow(/live folder/);
		expect(() => check(wd, [join(live.music[0]!, 'x.flac')])).toThrow(/live folder/);
		// Case and `..` do not get around it on Windows.
		if (process.platform === 'win32') expect(() => check(wd, [join(wd, '..', '..', '..', '..', '..', 'AppData', 'Roaming', 'PIONEER', 'rekordbox', 'master.db')])).toThrow(/live folder/);
	});

	it('refuses a source as a target, and a target outside the work dir', () => {
		const wd = join(workRoot, 'run-3');
		expect(() => check(wd, [join(workRoot, 'run-4', 'master.db')])).toThrow(/outside the work dir/);
		const inside = { ...src, rbDb: join(wd, 'rb', 'master.db') };
		expect(() => assertSafeTargets({ workRoot, workDir: wd, targets: [inside.rbDb], sources: [inside.rbDb], live })).toThrow(/source path/);
		expect(() => assertSafeTargets({ workRoot, workDir: wd, targets: [join(wd, 'rb')], sources: [inside.rbDb], live })).toThrow(/contains the source/);
	});

	it('refuses an e2e root inside a live folder', () => {
		expect(() => assertSafeTargets({ workRoot: join(live.pioneer[0]!, 'e2e'), workDir: join(live.pioneer[0]!, 'e2e', 'r'), targets: [], sources: [], live })).toThrow(/e2e root/);
	});

	it('the CLI root passes against the real live folders', () => {
		const real = defaultLiveRoots();
		expect(real.pioneer[0]!.toLowerCase()).toContain('pioneer');
		expect(real.curator.some((c) => /curator$/i.test(c))).toBe(true);
		expect(real.music).toContain(join(homedir(), 'Music'));
		const wd = join(CLI_WORK_ROOT, 'never-created');
		expect(() => assertSafeTargets({ workRoot: CLI_WORK_ROOT, workDir: wd, targets: [join(wd, 'rb', 'master.db')], sources: [], live: real })).not.toThrow();
		expect(existsSync(wd)).toBe(false);
	});

	it('isInside is a path test, not a prefix test', () => {
		expect(isInside(join(dir, 'rb-reference'), join(dir, 'rb'))).toBe(false);
		expect(isInside(join(dir, 'rb', 'x'), join(dir, 'rb'))).toBe(true);
	});

	it('the run stops on a rail before it copies anything', async () => {
		const wd = join(dir, 'not-under-the-root');
		const r = await runRekordboxE2E({ sources: src, workRoot, workDir: wd, live, log: () => { /* quiet */ } });
		expect(r.exitCode).toBe(2);
		expect(r.error).toMatch(/not a run folder/);
		expect(existsSync(wd)).toBe(false);
		const r2 = await runRekordboxE2E({ sources: src, workRoot: join(live.curator[0]!, 'e2e'), live, log: () => { /* quiet */ } });
		expect(r2.exitCode).toBe(2);
		expect(existsSync(join(live.curator[0]!, 'e2e'))).toBe(false);
	});
});

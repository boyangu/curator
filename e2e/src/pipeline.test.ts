// The whole pipeline on a generated library (fixture.ts): a consistent
// library and rekordbox come out with no difference; a difference injected
// into the fresh desktop, or into rekordbox after the push, is reported and
// fails the run. Needs apps/rekordbox's venv (the real sidecar) and
// rekordbox closed (pyrekordbox refuses to commit while it runs).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, editRekordbox, type Fixture } from './fixture.js';
import { runRekordboxE2E } from './pipeline.js';
import { pythonAvailable, rekordboxProcesses } from './rekordbox.js';
import type { Report } from './report.js';

const blocked = !pythonAvailable() ? 'apps/rekordbox/.venv is missing' : (await rekordboxProcesses()).length > 0 ? 'rekordbox is running' : null;
if (blocked) console.warn(`[e2e] pipeline tests skipped: ${blocked}`);

const statusOf = (r: Report, name: string): string | undefined => r.checks.find((c) => c.name === name)?.status;

describe.skipIf(blocked !== null)('rekordbox e2e pipeline (fixture)', () => {
	let dir: string;
	let fx: Fixture;
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'curator-e2e-'));
		fx = await buildFixture(join(dir, 'fixture'));
	});
	afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows handles */ } });

	const run = (name: string, extra: Partial<Parameters<typeof runRekordboxE2E>[0]> = {}): Promise<Report> => runRekordboxE2E({
		sources: { curatorDb: fx.curatorDb, rbDb: fx.rbDb },
		workRoot: join(dir, 'work'),
		workDir: join(dir, 'work', name),
		keep: true,
		phaseTimeoutMs: 120_000,
		log: () => { /* quiet */ },
		...extra,
	});

	it('a consistent library round-trips with no difference', async () => {
		const r = await run('consistent');
		expect(r.error).toBeNull();
		const failed = r.checks.filter((c) => c.status === 'fail');
		expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
		expect(r.exitCode).toBe(0);
		for (const name of ['founder.unchanged', 'cloud.roundTrip', 'rekordbox.push', 'cloud.afterLink', 'rekordbox.compare']) expect(statusOf(r, name), name).toBe('pass');
		expect(r.facts['attach']).toMatchObject({ masterLinks: 6, attached: 6 });
		expect(r.facts['links']).toMatchObject({ joiner: 5, master: 5 });
		// The report is on disk, self-contained.
		const html = readFileSync(join(r.workDir, 'report.html'), 'utf8');
		expect(html).toContain('rekordbox end-to-end');
		expect(JSON.parse(readFileSync(join(r.workDir, 'report.json'), 'utf8'))).toMatchObject({ ok: true });
	});

	it('reports a difference injected into the fresh desktop and into rekordbox', async () => {
		const r = await run('injected', {
			hooks: {
				beforeRoundTrip: ({ joiner }) => {
					joiner.prepare(`UPDATE track SET rating = 1 WHERE recording_id = (SELECT recording_id FROM track WHERE title = 'Title 2' LIMIT 1)`).run();
				},
				beforeRekordboxCompare: async ({ rbDb, workDir }) => {
					await editRekordbox(rbDb, '1003', { Title: 'Changed behind our back' }, join(workDir, 'tmp'));
				},
			},
		});
		expect(r.error).toBeNull();
		expect(r.exitCode).toBe(1);
		const trip = r.checks.find((c) => c.name === 'cloud.roundTrip')!;
		expect(trip.status).toBe('fail');
		expect(trip.rows!.some((d) => d.table === 'tracks')).toBe(true);
		const rb = r.checks.find((c) => c.name === 'rekordbox.compare')!;
		expect(rb.status).toBe('fail');
		expect(rb.rows).toContainEqual({ table: 'content.title', key: '1003', left: 'Changed behind our back', right: 'Title 3' });
	});

	it('a dry run stops before rekordbox', async () => {
		const r = await run('dry', { dryRun: true, keep: false });
		expect(r.error).toBeNull();
		expect(r.exitCode).toBe(0);
		expect(statusOf(r, 'rekordbox.push')).toBe('skipped');
		expect(statusOf(r, 'rekordbox.compare')).toBeUndefined();
		// Without --keep only the report and the logs stay.
		const left = (await import('node:fs')).readdirSync(r.workDir).sort();
		expect(left.every((n) => n === 'report.json' || n === 'report.html' || n.endsWith('.jsonl'))).toBe(true);
	});
});

// The catalogue uploader (layer.ts uploadNow): derived pending work, blobs
// ≤ 2 in flight before the items naming them, puts of ≤ 100 items, verdicts
// recorded so nothing is re-sent unchanged, superseded blobs deleted, and the
// existing-library backfill that only the button starts. What is never
// shared: unstamped rows, rows under the 'rekordbox' marker, the rb_* slot.
// Generated temp libraries, fake server and Storage only.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FakeAnalyzer,
	FakeCatalogueServer,
	POLICY_D_A,
	addLocalTrack,
	fixedCpk,
	makeTestDevice,
	pcmMd5,
	seedAnalysed,
	waitFor,
	writeFlac,
	type TestDevice,
} from '../test-support/catalogue-fakes.js';
import type { CatalogueLayerDeps } from './layer.js';

const USER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

let root: string;
let server: FakeCatalogueServer;
const open: TestDevice[] = [];
const device = (name: string, layer: Partial<CatalogueLayerDeps> = {}): TestDevice => {
	const d = makeTestDevice(join(root, name), server, USER, { analyzer: new FakeAnalyzer({ perTrackPeaks: true }), layer });
	open.push(d);
	return d;
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'curator-uploader-'));
	server = new FakeCatalogueServer();
});
afterEach(() => {
	for (const d of open.splice(0)) d.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const states = (d: TestDevice): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const r of d.sqlite.prepare(`SELECT local_state AS s, count(*) AS n FROM catalogue_entry GROUP BY local_state`).all() as Array<{ s: string; n: number }>) out[r.s] = r.n;
	return out;
};

describe('uploader', () => {
	it('uploads what a finished analysis produced: blobs first (≤ 2 in flight), then puts of ≤ 100 items', async () => {
		const a = device('a');
		const n = 30;
		await seedAnalysed(a, Array.from({ length: n }, (_, i) => ({ trackId: `t${i}`, md5: pcmMd5(i) })), { upload: true });
		// 30 tracks × (rhythm, key, structure, advanced, fingerprint, lo).
		expect(server.items(USER)).toHaveLength(n * 6);
		expect(server.objects.size).toBe(n);
		expect(a.blobs.maxInFlight).toBeLessThanOrEqual(2);
		expect(Math.max(...server.calls.putSizes)).toBeLessThanOrEqual(100);
		expect(states(a)).toEqual({ uploaded: n * 6 });
		// Nothing left: a second run puts nothing.
		const puts = server.calls.put;
		await a.layer.uploadNow();
		expect(server.calls.put).toBe(puts);
	});

	it('never shares an unstamped row, a rekordbox-marked row, or the rb_* slot', async () => {
		const a = device('a');
		await a.layer.syncNow();
		const f1 = join(a.dir, 'lib', 'rb.flac');
		const f2 = join(a.dir, 'lib', 'unstamped.flac');
		writeFlac(f1, pcmMd5(1), 'rb');
		writeFlac(f2, pcmMd5(2), 'old');
		const h1 = await addLocalTrack(a, 'rb', f1);
		await addLocalTrack(a, 'unstamped', f2);
		a.sqlite.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at, audio_hash, duration, rb_beatgrid, rb_bpm, rb_key_camelot) VALUES ('rb', 'rekordbox', 1, ?, 30, x'0000803f', 128, '5A')`).run(h1);
		a.sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, beatgrid, key_camelot, analyzer_version, analyzed_at, audio_hash, duration) VALUES ('unstamped', 120, x'0000803f', '4A', '2.4.0', 1, NULL, 30)`).run();
		a.layer.queueHook.persisted('rb');
		a.layer.queueHook.persisted('unstamped');
		await a.layer.uploadNow();
		expect(server.calls.put).toBe(0);
		expect(server.items(USER)).toHaveLength(0);
	});

	it('records a refusal and does not send the same item again', async () => {
		const a = device('a');
		await a.layer.syncNow(); // caches D-a
		// The server narrows its policy after this device read it.
		server.policy = { allow: POLICY_D_A.allow.filter((x) => x.unit !== 'key') };
		await seedAnalysed(a, [{ trackId: 't', md5: pcmMd5(5) }]);
		await a.layer.uploadNow();
		expect(states(a).rejected).toBe(1);
		const puts = server.calls.put;
		a.layer.queueHook.persisted('t');
		await a.layer.uploadNow();
		expect(server.calls.put).toBe(puts);
	});

	it('deletes the blobs the server reports superseded', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 't', md5: pcmMd5(6) }], { upload: true });
		const lo = join(a.peaksDir, 'lo', 't.cpk');
		const first = [...server.objects.keys()];
		// Two newer analyses with other waveforms: the server keeps two
		// versions, so the first one's blob is no longer named.
		for (const [v, seed] of [['2.5.0', 50], ['2.6.0', 60]] as const) {
			a.sqlite.prepare(`UPDATE track_analysis SET analyzer_version = ? WHERE track_id = 't'`).run(v);
			writeFileSync(lo, fixedCpk('lo', seed));
			a.layer.queueHook.persisted('t');
			await a.layer.uploadNow();
		}
		expect(a.blobs.removed).toEqual(first);
		expect(server.objects.has(first[0]!)).toBe(false);
		expect(server.objects.size).toBe(2);
	});

	it('uploads nothing while the account is not entitled', async () => {
		server.entitled = false;
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 't', md5: pcmMd5(7) }], { upload: true });
		expect(server.calls.put).toBe(0);
		expect(a.blobs.uploads).toBe(0);
		expect(a.layer.status().entitled).toBe(false);
	});
});

describe('backfill (existing library, button only)', () => {
	it('is never started by itself; start → running → done, with pause and resume, waiting while analysis runs', async () => {
		let busy: string | null = null;
		const a = device('a');
		const n = 12;
		await seedAnalysed(a, Array.from({ length: n }, (_, i) => ({ trackId: `t${i}`, md5: pcmMd5(100 + i) })));
		// Restart on the same library: rows analysed earlier (before sign-in,
		// before the catalogue) that nothing in this session ever kicked.
		open.splice(open.indexOf(a), 1);
		a.close();
		const b = makeTestDevice(join(root, 'a'), server, USER, { layer: { busyPollMs: 20, uploadDebounceMs: 10, busyElsewhere: () => busy } });
		open.push(b);
		await b.layer.syncNow();
		b.layer.start();
		// Nothing goes up by itself.
		await new Promise((r) => setTimeout(r, 100));
		expect(server.calls.put).toBe(0);
		await waitFor(() => (b.layer.status().device.pending?.items ?? 0) > 0, 'pending estimate');
		expect(b.layer.status().device.pending!.items).toBe(n * 6);

		busy = 'audio analysis';
		b.layer.setBackfill('start');
		await waitFor(() => b.layer.status().backfill.waitingFor === 'audio analysis', 'waiting for analysis');
		expect(server.calls.put).toBe(0);
		b.layer.setBackfill('pause');
		expect(b.layer.status().settings.backfill).toBe('paused');
		busy = null;
		await new Promise((r) => setTimeout(r, 60));
		expect(server.calls.put).toBe(0);

		b.layer.setBackfill('resume');
		await waitFor(() => b.layer.status().settings.backfill === 'done', 'backfill done');
		expect(server.items(USER)).toHaveLength(n * 6);
		expect(b.layer.status().backfill.uploadedItems).toBe(n * 6);
		await waitFor(() => b.layer.status().device.pending?.items === 0, 'nothing pending');
	});
});

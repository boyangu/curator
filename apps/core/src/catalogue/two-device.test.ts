// Stage D-a exit (plan cloud-catalogue-phase1.md "Decisions" Q4): one account,
// two desktops, the same audio under different tags. Device A analyses a
// file and uploads; device B, holding a FLAC with identical PCM and other
// tags, takes the analysis instead of computing it. Asserted:
//   - B's analyzer computes nothing for the inline units (rhythm, key,
//     structure, advanced, fingerprint) — its one call skips every one;
//   - B's lo .cpk is byte-identical to A's (sha256);
//   - B's Curator-slot analysis columns and fingerprint equal A's;
//   - B still computes the hi tier itself (the server's D-a policy holds
//     no hi peaks) and its lo tier survives that pass untouched;
//   - the hydrate never held the main loop for 50 ms.
// Everything is generated in temp dirs: fake server, fake Storage, fake
// analyzer; never the live DB, music files or the network.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisFlagsToOptions, DEFAULT_AUTO_FLAGS } from '../analyzer/flags.js';
import {
	FakeAnalyzer,
	FakeCatalogueServer,
	POLICY_D_A,
	addLocalTrack,
	jobState,
	makeTestDevice,
	sha256,
	waitFor,
	writeFlac,
	type TestDevice,
} from '../test-support/catalogue-fakes.js';

const USER = '4f1c2a9e-6b1d-4c55-9a51-0d3c2f7e8a10';
const PCM_MD5 = '0123456789abcdef0123456789abcdef';

let root: string;
const devices: TestDevice[] = [];

afterEach(() => {
	for (const d of devices.splice(0)) d.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

type AnalysisRow = Record<string, unknown>;
const analysisRow = (d: TestDevice, trackId: string): AnalysisRow =>
	d.sqlite.prepare(`SELECT * FROM track_analysis WHERE track_id = ?`).get(trackId) as AnalysisRow;
const link = (d: TestDevice, trackId: string) =>
	d.sqlite.prepare(`SELECT fingerprint, fingerprint_duration_sec FROM source_link WHERE track_id = ?`).get(trackId) as { fingerprint: string | null; fingerprint_duration_sec: number | null };

// The Curator slot, normalised for comparison: JSON columns parsed (the
// real server stores jsonb, which does not keep key order), blobs as hex.
function curatorSlot(r: AnalysisRow): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of ['bpm', 'key_camelot', 'key_strength', 'brightness', 'power', 'dynamic_complexity', 'loudness_range_lu', 'dissonance', 'density',
		'intro_length_sec', 'outro_length_sec', 'first_drop_sec', 'drop_count', 'breakdown_count', 'analyzer_version']) out[k] = r[k];
	for (const k of ['beatgrid', 'downbeats']) out[k] = (r[k] as Buffer).toString('hex');
	for (const k of ['segments_json', 'features_json']) out[k] = JSON.parse(r[k] as string);
	return out;
}

describe('two devices, one account (stage D-a exit)', () => {
	it('device B reuses device A\'s analysis for the same audio under other tags, and still computes the hi waveform', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-two-device-'));
		const server = new FakeCatalogueServer();
		server.policy = POLICY_D_A;

		// ── device A analyses and uploads ──────────────────────────────
		const a = makeTestDevice(join(root, 'a'), server, USER, { analyzer: new FakeAnalyzer({ advanced: true }) });
		devices.push(a);
		const fileA = join(root, 'a', 'music', 'Artist - Song.flac');
		writeFlac(fileA, PCM_MD5, 'TITLE=Song\nARTIST=Artist');
		const hashA = await addLocalTrack(a, 'track-a', fileA);
		await a.layer.syncNow(); // learns the policy; the account holds nothing yet
		a.queue.enqueue(['track-a'], { priority: 0, analyzeOptions: analysisFlagsToOptions({ ...DEFAULT_AUTO_FLAGS, advanced: true }) });
		a.queue.setAutoEnabled(true);
		await waitFor(() => jobState(a, 'track-a') === 'done', 'A analysis');
		expect(a.analyzer.calls).toHaveLength(1);
		// Nobody else holds this audio: analysing it cost no lookup.
		expect(server.calls.lookup).toBe(0);
		await a.layer.uploadNow();

		const held = server.items(USER);
		expect(held.map((i) => `${i.unit}:${i.variant}`).sort()).toEqual(
			['advanced:default', 'fingerprint:default', 'key:default', 'peaks:lo', 'rhythm:default', 'structure:default'],
		);
		expect(held.every((i) => i.audioHash === hashA)).toBe(true);
		// D-a: the hi tier never leaves the device.
		expect([...server.objects.keys()]).toHaveLength(1);

		// ── device B: same PCM, different tags and name ────────────────
		const b = makeTestDevice(join(root, 'b'), server, USER, { analyzer: new FakeAnalyzer({ advanced: true }) });
		devices.push(b);
		const fileB = join(root, 'b', 'library', 'song (retagged).flac');
		writeFlac(fileB, PCM_MD5, 'TITLE=Song (Original Mix)\nARTIST=Artist feat. Someone\nCOMMENT=retagged by rekordbox');
		expect(readFileSync(fileB).equals(readFileSync(fileA))).toBe(false);
		const hashB = await addLocalTrack(b, 'track-b', fileB);
		expect(hashB).toBe(hashA);

		await b.layer.syncNow(); // inventory + hydrate
		expect(b.analyzer.calls).toHaveLength(0);
		expect(curatorSlot(analysisRow(b, 'track-b'))).toEqual(curatorSlot(analysisRow(a, 'track-a')));
		expect(analysisRow(b, 'track-b').audio_hash).toBe(hashA);
		expect(link(b, 'track-b')).toEqual(link(a, 'track-a'));
		const loA = sha256(readFileSync(join(a.peaksDir, 'lo', 'track-a.cpk')));
		expect(sha256(readFileSync(join(b.peaksDir, 'lo', 'track-b.cpk')))).toBe(loA);
		expect(existsSync(join(b.peaksDir, 'hi', 'track-b.cpk'))).toBe(false);

		// ── B's own background pass: only the hi waveform is left ─────
		b.queue.enqueue(['track-b'], { priority: 0, analyzeOptions: analysisFlagsToOptions({ ...DEFAULT_AUTO_FLAGS, advanced: true }) });
		b.queue.setAutoEnabled(true);
		await waitFor(() => jobState(b, 'track-b') === 'done', 'B analysis');
		expect(b.analyzer.calls).toHaveLength(1);
		const o = b.analyzer.calls[0]!.options ?? {};
		// Nothing inline is computed: every inline stage is skipped…
		expect(o.skipBeatgrid).toBe(true);
		expect(o.skipKey).toBe(true);
		expect(o.skipSegments).toBe(true);
		expect(o.skipFingerprint).toBe(true);
		expect(o.features ?? []).toEqual([]);
		expect(o.overrideBeatgrid ?? false).toBe(false);
		// …and the peaks stage runs, for the hi tier, writing its lo strip
		// somewhere that is thrown away.
		expect(o.skipPeaks ?? false).toBe(false);
		expect(b.analyzer.calls[0]!.outPeaksHiPath).toBe(join(b.peaksDir, 'hi', 'track-b.cpk'));
		expect(b.analyzer.calls[0]!.outPeaksLoPath).not.toBe(join(b.peaksDir, 'lo', 'track-b.cpk'));
		expect(existsSync(join(b.peaksDir, 'hi', 'track-b.cpk'))).toBe(true);
		expect(existsSync(b.analyzer.calls[0]!.outPeaksLoPath)).toBe(false);
		expect(sha256(readFileSync(join(b.peaksDir, 'lo', 'track-b.cpk')))).toBe(loA);
		// The pass changed nothing of what came from A.
		expect(curatorSlot(analysisRow(b, 'track-b'))).toEqual(curatorSlot(analysisRow(a, 'track-a')));
		expect(link(b, 'track-b')).toEqual(link(a, 'track-a'));

		const maxSliceMs = b.layer.stats().maxSliceMs;
		// Reported by the caller of this suite; the bound is the plan's.
		console.info(`[two-device] B hydrate maxSliceMs=${maxSliceMs.toFixed(2)}`);
		expect(maxSliceMs).toBeLessThan(50);
		// B re-uploads nothing it took from A.
		const puts = server.calls.put;
		await b.layer.uploadNow();
		expect(server.calls.put).toBe(puts);
	});
});

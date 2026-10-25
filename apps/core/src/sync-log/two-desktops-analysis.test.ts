// Protocol v5: the analyzer's results as library data (sync-log/
// track-analysis.ts), across two or three desktops on one account. Same rig
// and rails as the other two-desktop suites: generated databases only, no
// remoteWritePolicy, streaming adapters that record and throw, no rekordbox
// sidecar, no network. No desktop here has a catalogue transport at all, so
// everything a secondary shows of the master's analysis came through the op
// log or the snapshot.
//
//   - the master analyses a track after it was added: one set-analysis, the
//     secondary's remote row shows grid, structure and scores; a
//     re-analysis follows;
//   - a secondary's own analysis of a master track states nothing, and its
//     own file's analysis stands against the master's;
//   - the founder's base carries the analysis, a joiner has it on bootstrap,
//     and a legacy brightness without power is stated as nothing;
//   - a v4 server is sent no v5 op; after its upgrade the backfill states
//     the analysis and the master publishes a base with it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { StoredOp, TrackAnalysis } from '@curator/protocol';
import { consoleSink, createLogger, type LogRecord } from '@curator/shared/log';
import { setCoreLogger } from '../log.js';
import { persistAnalysisResult } from '../analyzer/persist.js';
import type { AnalyzeParams, AnalyzeResult } from '../analyzer/sidecar.js';
import { decodeFloat32, float32Buffer } from '../rekordbox/rb-slot.js';
import { fullResult } from '../test-support/catalogue-fakes.js';
import { markPreOpLog, TwoDesktopRig, tick, type Desktop } from '../test-support/two-desktops.js';
import { recordingIdForTrack } from './recording-id.js';
import { remoteTrackId } from './stable-ids.js';
import { slotDigest, TRACK_ANALYSIS_BACKFILL_KEY } from './track-analysis.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-analysis-'); });
afterEach(async () => {
	const upstream = rig.upstreamCalls();
	await rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
const v4Server = (): void => { rig.cloud.features = rig.cloud.features.filter((f) => f !== 'analysis_v5'); };
const v5Server = (): void => { if (!rig.cloud.features.includes('analysis_v5')) rig.cloud.features = [...rig.cloud.features, 'analysis_v5']; };
const analysisOps = (device?: string): StoredOp[] => rig.cloud.log.filter((o) => o.kind === 'set-analysis' && (device === undefined || o.device_id === device));

const result = (trackId: string, over: Partial<AnalyzeResult> = {}): AnalyzeResult =>
	// The rig's rows are 300 s long; the analysis must agree (the projection
	// guards the duration like the catalogue does).
	({ ...fullResult({ trackId, outPeaksLoPath: '', outPeaksHiPath: '', options: { features: ['brightness'] } } as unknown as AnalyzeParams), duration: 300, ...over });

// A local file for the row (as the scanner records it), then an analysis of
// it through the analyzer's own write path, stamped with the file's audio.
function analyse(d: Desktop, trackId: string, hash: string, over: Partial<AnalyzeResult> = {}): void {
	const path = `${d.musicDir}/${trackId}.flac`;
	d.raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash, duration_local) VALUES (?, ?, 'local', ?, ?, ?, 30)
		ON CONFLICT(id) DO NOTHING`).run(`sl-${trackId}`, trackId, path, path, hash);
	persistAnalysisResult(d.db, result(trackId, over), path, { audioHash: hash });
}

type Slot = { bpm: number | null; key_camelot: string | null; brightness: number | null; power: number | null; beatgrid: Buffer | null; downbeats: Buffer | null;
	segments_json: string | null; analyzer_version: string; audio_hash: string | null; adopted_digest: string | null; features_json: string | null; rb_key_camelot: string | null };
const slotOf = (d: Desktop, trackId: string): Slot | undefined => d.raw.prepare(`SELECT * FROM track_analysis WHERE track_id = ?`).get(trackId) as Slot | undefined;
const mirrorsOf = (d: Desktop, trackId: string): Record<string, unknown> =>
	d.raw.prepare(`SELECT bpm, key_camelot, brightness, power, dynamic_complexity, intro_length_sec, drop_count, attrs_adopted FROM track WHERE id = ?`).get(trackId) as Record<string, unknown>;

describe('the master\'s analysis reaches a secondary through the log', () => {
	it('one set-analysis per analysis; the remote row shows grid, structure, scores and tempo; a re-analysis follows', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		const aId = await a.deviceId();
		expect(analysisOps()).toEqual([]);

		analyse(a, 'trk-0', 'pcm-md5:aaaa');
		await rig.settle();
		const ops = analysisOps(aId);
		expect(ops.length).toBe(1);
		expect(ops[0]!.schema_version).toBe(5);
		const sent = (ops[0]!.payload as { analysis: Record<string, unknown> }).analysis;
		expect(sent).toMatchObject({ audio_hash: 'pcm-md5:aaaa', bpm: 124.5, key_camelot: '8A', brightness: 0.42, power: 0.66, drop_count: 1 });
		expect(sent).not.toHaveProperty('features');

		const remote = remoteTrackId(R('trk-0'));
		const s = slotOf(b, remote)!;
		expect([s.bpm, s.key_camelot, s.brightness, s.power, s.analyzer_version, s.audio_hash]).toEqual([124.5, '8A', 0.42, 0.66, '2.4.0', 'pcm-md5:aaaa']);
		// The slot reads back as exactly what was sent: a re-projection is a
		// digest compare, not a rewrite.
		expect(s.adopted_digest).toBe(slotDigest(sent as unknown as TrackAnalysis));
		expect(s.features_json).toBeNull();
		// The grid to the millisecond, the downbeats among its beats.
		const beats = decodeFloat32(s.beatgrid);
		const master = decodeFloat32(slotOf(a, 'trk-0')!.beatgrid);
		expect(beats.length).toBe(master.length);
		beats.forEach((t, i) => expect(Math.abs(t - master[i]!)).toBeLessThanOrEqual(0.0006));
		expect(decodeFloat32(s.downbeats).length).toBe(15);
		expect(JSON.parse(s.segments_json!)).toEqual([
			{ startSec: 0, endSec: 8, label: 'intro', source: 'analyzer', confidence: 0.9, energy: 0.3 },
			{ startSec: 8, endSec: 22, label: 'drop', source: 'analyzer', confidence: 0.8, energy: 0.9 },
			{ startSec: 22, endSec: 30.25, label: 'outro', source: 'analyzer', confidence: 0.7, energy: 0.2 },
		]);
		// The track mirrors, and the tempo / key adopted (the master's row has
		// none of its own: its analysis tempo lives in the slot).
		expect(mirrorsOf(b, remote)).toMatchObject({ bpm: 124.5, key_camelot: '8A', brightness: 0.42, power: 0.66, dynamic_complexity: 3.1, intro_length_sec: 8, drop_count: 1 });
		expect(JSON.parse(mirrorsOf(b, remote)['attrs_adopted'] as string)).toMatchObject({ bpm: { from: 'analysis' }, key_camelot: { from: 'analysis' } });

		// Idle cycles state nothing more, on either side.
		await rig.settle();
		expect(analysisOps().length).toBe(1);

		// A re-analysis: a new statement, the secondary follows.
		await tick();
		analyse(a, 'trk-0', 'pcm-md5:aaaa', { bpm: 126, brightness: 0.5, power: 0.7, key_camelot: '9A' });
		await rig.settle();
		expect(analysisOps(aId).length).toBe(2);
		expect(mirrorsOf(b, remote)).toMatchObject({ bpm: 126, key_camelot: '9A', brightness: 0.5, power: 0.7 });
		expect(slotOf(b, remote)!.bpm).toBe(126);
		// The secondary never stated any of it back.
		expect(analysisOps(await b.deviceId())).toEqual([]);
	});

	it('a secondary states nothing of a master recording; its own file\'s analysis stands', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		const b = await rig.desktop('b', { catalogue: ['trk-1', 'trk-0'] });
		await rig.settle();
		const bId = await b.deviceId();
		// B analyses its own copy of a recording the master brought.
		analyse(b, 'trk-1', 'pcm-md5:bbbb', { bpm: 99 });
		await rig.settle();
		expect(analysisOps(bId)).toEqual([]);
		// The master analyses its own copy (other audio): B keeps its own.
		analyse(a, 'trk-1', 'pcm-md5:a1a1', { bpm: 124.5 });
		await rig.settle();
		expect(analysisOps(await a.deviceId()).length).toBe(1);
		const s = slotOf(b, 'trk-1')!;
		expect([s.bpm, s.audio_hash, s.adopted_digest]).toEqual([99, 'pcm-md5:bbbb', null]);
		// B's own file of the SAME audio as the master's, not analysed here:
		// it takes the master's analysis (the grid lines up), adopted, and
		// states none of it.
		b.raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES ('sl-b0', 'trk-0', 'local', '/b/0.flac', '/b/0.flac', 'pcm-md5:a0a0')`).run();
		analyse(a, 'trk-0', 'pcm-md5:a0a0', { bpm: 122 });
		await rig.settle();
		const same = slotOf(b, 'trk-0')!;
		expect([same.bpm, same.audio_hash]).toEqual([122, 'pcm-md5:a0a0']);
		expect(same.adopted_digest).not.toBeNull();
		expect(analysisOps(bId)).toEqual([]);
		// A recording B brought itself, analysed there: B states it.
		b.raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES ('b-own', ?, 'B only', '[{"name":"B"}]', 'unsorted', 300)`).run(R('b-own'));
		await rig.settle();
		analyse(b, 'b-own', 'pcm-md5:b0b0', { bpm: 101 });
		await rig.settle();
		const mine = analysisOps(bId);
		expect(mine.map((o) => o.entity_id)).toEqual([R('b-own')]);
		// …and the master shows it on its remote row of B's track.
		expect(slotOf(a, remoteTrackId(R('b-own')))!.bpm).toBe(101);
	});

	it('the gate says, in counts, when it keeps an analysis of B\'s own that the master does not state', async () => {
		const recs: LogRecord[] = [];
		setCoreLogger(createLogger({ proc: 'core', level: 'debug', sinks: [{ write: (r) => { recs.push(r); } }] }));
		try {
			const kept = (): LogRecord[] => recs.filter((r) => r.area === 'track-analysis' && r.msg === 'analysis kept on this device: the master describes these recordings');
			const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1', 'trk-2'] });
			const b = await rig.desktop('b', { catalogue: ['trk-0', 'trk-1', 'trk-2'] });
			await rig.settle();
			// B's own analyses of two master recordings; the master states none.
			analyse(b, 'trk-1', 'pcm-md5:b1b1', { bpm: 99 });
			analyse(b, 'trk-2', 'pcm-md5:b2b2', { bpm: 98 });
			await rig.settle();
			expect(analysisOps(await b.deviceId())).toEqual([]);
			expect(kept().map((r) => [r.level, r.data])).toEqual([['info', { rows: 2, recordings: 2 }]]);
			// Counts only: no title, no id.
			expect(JSON.stringify(kept()[0]!.data)).not.toMatch(/trk-|Title/);
			// An analysis B adopted from the master is the master's, not kept.
			b.raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES ('sl-b0', 'trk-0', 'local', '/b/0.flac', '/b/0.flac', 'pcm-md5:a0a0')`).run();
			analyse(a, 'trk-0', 'pcm-md5:a0a0', { bpm: 122 });
			await rig.settle();
			expect(slotOf(b, 'trk-0')!.adopted_digest).not.toBeNull();
			expect(kept()).toHaveLength(1);
		} finally {
			setCoreLogger(createLogger({ proc: 'core', level: 'debug', sinks: [consoleSink()] }));
		}
	});
});

describe('the base carries the analysis', () => {
	const seedAnalysed = (raw: Database.Database): void => {
		const beats = Array.from({ length: 40 }, (_, i) => Math.fround(0.25 + i * 0.46875));
		const ins = raw.prepare(`INSERT INTO track_analysis (track_id, bpm, beatgrid, downbeats, key_camelot, brightness, power, segments_json, drop_count, duration,
			analyzer_version, analyzed_at, audio_hash) VALUES (?, 128, ?, ?, '8A', ?, ?, ?, 1, 300, '2.4.0', 1760000000000, ?)`);
		const segs = JSON.stringify([{ startSec: 0, endSec: 30, label: 'intro', source: 'analyzer', confidence: 0.9, energy: 0.2 }]);
		const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES (?, ?, 'local', ?, ?, ?)`);
		for (const [id, brightness, power] of [['trk-0', 1.5, 0.4], ['trk-1', 512.3, null]] as const) {
			link.run(`sl-${id}`, id, `/m/${id}.flac`, `/m/${id}.flac`, `h-${id}`);
			ins.run(id, float32Buffer(beats), float32Buffer(beats.filter((_, i) => i % 4 === 0)), brightness, power, segs, `h-${id}`);
			raw.prepare(`UPDATE track SET brightness = ?, power = ? WHERE id = ?`).run(brightness, power, id);
		}
		markPreOpLog(raw);
	};

	it('the founder folds it; a joiner bootstraps it; a brightness without power is never stated', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1', 'trk-2'], seed: seedAnalysed });
		await rig.settle([a]);
		// Folded into the base, not sent.
		expect(analysisOps()).toEqual([]);
		expect(rig.cloud.publishes.length).toBeGreaterThan(0);
		const aId = await a.deviceId();
		const cell = (d: Desktop, t: string): Record<string, unknown> | null => {
			const json = d.one<string | undefined>(`SELECT json_extract(value, ?) FROM sync_state WHERE map = 'libraryTracks' AND key = ?`, `$.fields."analysis.${aId}".value`, R(t));
			return json ? JSON.parse(json) : null;
		};
		expect(cell(a, 'trk-0')).toMatchObject({ bpm: 128, brightness: 1.5, power: 0.4 });
		// The 2026-10-17 damage: a raw-centroid brightness with no power.
		expect(cell(a, 'trk-1')).toMatchObject({ bpm: 128, brightness: null, power: null });
		// trk-2 was never analysed.
		expect(cell(a, 'trk-2')).toBeNull();

		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expect(rig.cloud.calls.storageBootstraps).toBeGreaterThan(0);
		expect(analysisOps()).toEqual([]);
		const r0 = remoteTrackId(R('trk-0'));
		const r1 = remoteTrackId(R('trk-1'));
		expect(slotOf(c, r0)).toMatchObject({ bpm: 128, brightness: 1.5, power: 0.4, key_camelot: '8A', audio_hash: 'h-trk-0' });
		expect(decodeFloat32(slotOf(c, r0)!.beatgrid).length).toBe(40);
		expect(mirrorsOf(c, r0)).toMatchObject({ bpm: 128, brightness: 1.5, power: 0.4 });
		expect(slotOf(c, r1)).toMatchObject({ bpm: 128, brightness: null, power: null });
		expect(mirrorsOf(c, r1)['brightness']).toBeNull();
		expect(slotOf(c, remoteTrackId(R('trk-2')))).toBeUndefined();
	});
});

describe('a v4 server', () => {
	it('is sent no v5 op; after its upgrade the backfill states the analysis and the master publishes a base with it', async () => {
		v4Server();
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		analyse(a, 'trk-0', 'pcm-md5:aaaa');
		await rig.settle();
		expect(rig.cloud.log.filter((o) => o.schema_version >= 5)).toEqual([]);
		expect((await a.svc.getCloudSyncStatus()).lastError).toBeNull();
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE schema_version >= 5`)).toBe(0);
		expect(slotOf(b, remoteTrackId(R('trk-0')))).toBeUndefined();

		// The master's base was founded by a build from before v5 (the real
		// master): its analysis backfill is still owed.
		a.raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(TRACK_ANALYSIS_BACKFILL_KEY);
		const published = rig.cloud.publishes.length;
		v5Server();
		await rig.settle();
		const ops = analysisOps(await a.deviceId());
		expect(ops.length).toBe(1);
		expect(slotOf(b, remoteTrackId(R('trk-0')))!.bpm).toBe(124.5);
		// The base now carries it: the master published past the backfill
		// without waiting for its 10k-op cadence.
		expect(rig.cloud.publishes.length).toBeGreaterThan(published);
		expect(rig.cloud.publishes.at(-1)!.seq).toBeGreaterThanOrEqual(ops[0]!.seq);
		expect(a.one(`SELECT count(*) FROM app_setting WHERE key = 'sync.snapshot_publish_requested'`)).toBe(0);
	});

	it('a rolled-back server refusing a v5 op holds v5 back, not the rest; its return releases it', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'] });
		await rig.settle();
		// The server answered with v5 last time and has since rolled back. No
		// fingerprint, so no claim goes first to tell the client so: the v5
		// stage runs on what it last heard and the push is refused whole.
		v4Server();
		const before = rig.cloud.log.length;
		analyse(a, 'trk-0', 'pcm-md5:aaaa', { fingerprint: null, fingerprint_duration_sec: null });
		await a.sync();
		expect(rig.cloud.log.filter((o) => o.schema_version >= 5)).toEqual([]);
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE state = 'pending' AND schema_version = 5`)).toBe(1);
		// Everything else still flows; the v5 op waits.
		await a.svc.setRating(['trk-0'], 4);
		await a.sync();
		await a.sync();
		expect(rig.cloud.log.slice(before).some((o) => o.kind === 'set-rating')).toBe(true);
		expect(rig.cloud.log.filter((o) => o.schema_version >= 5)).toEqual([]);
		expect((await a.svc.getCloudSyncStatus()).lastError).toBeNull();
		v5Server();
		await rig.settle();
		expect(analysisOps(await a.deviceId()).length).toBe(1);
	});
});

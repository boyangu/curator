// Analysis for rows without the file (the 2026-10-21 zero-loss audit, item
// 3): a fresh second device — or a streaming-only row — has no file, so the
// hydrator (which keyed everything off a live local link) restored none of
// the account's analysis there. It now targets those rows through their
// recording's audio-hash claim: one hash → that one; several → the master
// device's, when it claimed exactly one; else skipped and reported.
// Asserted on device B, against device A's real upload:
//   - a remote row and a streaming-only own row take the Curator slot, its
//     track mirrors, the stamp and the lo waveform, exactly as a device with
//     the file would (no fingerprint: that belongs to a file);
//   - track.bpm and the key mirror are filled where the row had none, and a
//     value the row has is kept;
//   - an ambiguous recording is skipped (mirror marked, never re-asked), the
//     master's pick is taken;
//   - nothing is queued for analysis, nothing is re-uploaded.
// Generated temp dirs, fake server and Storage, fake analyzer; never the
// live DB, music files or the network.

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MASTER_DEVICE_SETTING, opSchemaVersion, type TrackMeta } from '@curator/protocol';
import { applyOps } from '../sync-log/apply.js';
import { remoteTrackId } from '../sync-log/stable-ids.js';
import { FakeCatalogueServer, POLICY_D_A, makeTestDevice, pcmMd5, seedAnalysed, sha256, type TestDevice } from '../test-support/catalogue-fakes.js';
import { budgetMs } from '../test-support/timing.js';

const USER = '7a0e5d2c-1b3f-4e6a-9c8d-2f4b6a8c0e1d';

let root: string;
const devices: TestDevice[] = [];
afterEach(() => {
	for (const d of devices.splice(0)) d.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

let ts = 1_760_000_000_000;
const op = (device: string, entity: string, entityId: string, kind: string, payload: unknown): Record<string, unknown> =>
	({ op_id: randomUUID(), device_id: device, client_ts: ts++, schema_version: opSchemaVersion({ entity, kind, entity_id: entityId }), entity, entity_id: entityId, kind, payload });
const meta = (title: string): TrackMeta => ({ source: 'local', title, artists: [{ name: 'A' }], album_title: null, duration_sec: 30, isrc: null, release_date: null, label: null, genre: null, cover_url: null });
const hashClaim = (device: string, rec: string, hash: string): Record<string, unknown> => op(device, 'recording_claim', rec, 'add', { kind: 'audio_hash', value: hash, confidence: 1 });
const rec = (i: number): string => `00000000-0000-4000-8000-${(0xf00 + i).toString(16).padStart(12, '0')}`;

const SLOT = ['bpm', 'beatgrid', 'downbeats', 'key_camelot', 'key_strength', 'brightness', 'power', 'dynamic_complexity', 'loudness_range_lu', 'dissonance', 'density',
	'segments_json', 'intro_length_sec', 'outro_length_sec', 'first_drop_sec', 'drop_count', 'breakdown_count', 'features_json', 'analyzer_version', 'audio_hash'];
function slot(d: TestDevice, trackId: string): Record<string, unknown> | null {
	const r = d.sqlite.prepare(`SELECT * FROM track_analysis WHERE track_id = ?`).get(trackId) as Record<string, unknown> | undefined;
	if (!r) return null;
	const out: Record<string, unknown> = {};
	for (const k of SLOT) {
		const v = r[k];
		out[k] = Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'string' && (v.startsWith('{') || v.startsWith('[')) ? JSON.parse(v) : v;
	}
	return out;
}
const MIRRORS = ['brightness', 'power', 'dynamic_complexity', 'loudness_range_lu', 'dissonance', 'density', 'intro_length_sec', 'outro_length_sec', 'first_drop_sec', 'drop_count', 'breakdown_count'];
const mirrors = (d: TestDevice, trackId: string): Record<string, unknown> =>
	d.sqlite.prepare(`SELECT ${MIRRORS.join(', ')} FROM track WHERE id = ?`).get(trackId) as Record<string, unknown>;

describe('file-less rows take the account\'s analysis through the audio-hash claim', () => {
	it('remote and streaming-only rows hydrate like a device with the file; ambiguity is skipped, the master\'s pick taken; nothing is queued', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-fileless-'));
		const server = new FakeCatalogueServer();
		server.policy = POLICY_D_A;

		// ── A analyses five files and uploads ───────────────────────────
		const a = makeTestDevice(join(root, 'a'), server, USER);
		devices.push(a);
		const ids = ['one', 'stream', 'amb-x', 'amb-y', 'mst-x'];
		const hashes = await seedAnalysed(a, ids.map((id, i) => ({ trackId: id, md5: pcmMd5(i) })), { upload: true });
		const h = (id: string): string => hashes.get(id)!;
		expect(server.items(USER).length).toBeGreaterThan(0);

		// ── B: no file at all ─────────────────────────────────────────────
		const b = makeTestDevice(join(root, 'b'), server, USER);
		devices.push(b);
		applyOps(b.sqlite, [
			// The master device of the account.
			op('dev-a', 'setting', MASTER_DEVICE_SETTING, 'set', { value: 'dev-a' }),
			// A remote row (another device's track) with one claimed hash.
			op('dev-a', 'library_track', rec(1), 'create', { added_at: 1 }), op('dev-a', 'library_track', rec(1), 'set-meta', meta('One')), hashClaim('dev-a', rec(1), h('one')),
			// Two hashes from two devices, neither the master: ambiguous.
			op('dev-c', 'library_track', rec(3), 'create', { added_at: 1 }), op('dev-c', 'library_track', rec(3), 'set-meta', meta('Amb')),
			hashClaim('dev-c', rec(3), h('amb-x')), hashClaim('dev-d', rec(3), h('amb-y')),
			// Two hashes, one the master's: that one.
			op('dev-c', 'library_track', rec(4), 'create', { added_at: 1 }), op('dev-c', 'library_track', rec(4), 'set-meta', meta('Mst')),
			hashClaim('dev-a', rec(4), h('mst-x')), hashClaim('dev-c', rec(4), h('amb-y')),
			// A recording B holds itself, streaming-only (no file): claimed hash.
			hashClaim('dev-a', rec(2), h('stream')),
		]);
		b.sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, bpm, key_camelot) VALUES ('own-stream', ?, 'Stream', '[]', 'unsorted', 30, 123, NULL)`).run(rec(2));
		b.sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES ('sl-sp', 'own-stream', 'spotify', 'sp-stream')`).run();
		const [r1, r3, r4] = [remoteTrackId(rec(1)), remoteTrackId(rec(3)), remoteTrackId(rec(4))];
		expect(b.sqlite.prepare(`SELECT count(*) FROM track WHERE remote_only = 1`).pluck().get()).toBe(3);

		await b.layer.syncNow();

		// The remote row: A's Curator slot, stamped with the claimed hash; its
		// mirrors; the lo waveform byte for byte; bpm and key filled.
		expect(slot(b, r1)).toEqual(slot(a, 'one'));
		expect(mirrors(b, r1)).toEqual(mirrors(a, 'one'));
		expect(sha256(readFileSync(join(b.peaksDir, 'lo', `${r1}.cpk`)))).toBe(sha256(readFileSync(join(a.peaksDir, 'lo', 'one.cpk'))));
		expect(existsSync(join(b.peaksDir, 'hi', `${r1}.cpk`))).toBe(false);
		expect(b.sqlite.prepare(`SELECT bpm, key_camelot FROM track WHERE id = ?`).get(r1)).toEqual({ bpm: 124.5, key_camelot: '8A' });
		// No print: B has no file to hang one on, and none became a claim.
		expect(b.sqlite.prepare(`SELECT count(*) FROM sync_outbox WHERE entity = 'recording_claim'`).pluck().get()).toBe(0);
		// The streaming-only own row: the same, but its own bpm is kept.
		expect(slot(b, 'own-stream')).toEqual(slot(a, 'stream'));
		expect(b.sqlite.prepare(`SELECT bpm, key_camelot FROM track WHERE id = 'own-stream'`).get()).toEqual({ bpm: 123, key_camelot: '8A' });
		// Ambiguous: skipped, and marked so no pass asks for it again.
		expect(slot(b, r3)).toBeNull();
		const states = (hash: string): string[] => b.sqlite.prepare(`SELECT DISTINCT local_state FROM catalogue_entry WHERE audio_hash = ?`).pluck().all(hash) as string[];
		expect(states(h('amb-x'))).toEqual(['skipped']);
		// The master's pick.
		expect(slot(b, r4)).toEqual(slot(a, 'mst-x'));
		const lookups = server.calls.lookup;
		await b.layer.syncNow();
		expect(server.calls.lookup).toBe(lookups);

		// Never queued for analysis; nothing re-uploaded.
		b.queue.enqueue([r1, 'own-stream', r3], { priority: 100, force: true });
		expect(b.sqlite.prepare(`SELECT count(*) FROM analysis_job`).pluck().get()).toBe(0);
		const puts = server.calls.put;
		b.layer.setBackfill('start');
		await b.layer.uploadNow();
		expect(server.calls.put).toBe(puts);
		expect(b.layer.stats().maxSliceMs).toBeLessThan(budgetMs(100, 'fileless slice'));
	});
});

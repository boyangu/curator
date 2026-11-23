// The phone's waveform read path: a recording's claimed hash, the catalogue's
// peaks item for it (hi before lo), the blob checked against the item.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogueBlobPath, type CatalogueLookupInput, type StoredCatalogueItem } from '@curator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';
import { claimedHashes, CPK_MAGIC, cpkVersionOf, fetchPeaks } from './peaks.js';

let dir: TmpDir;
let raw: Database.Database;
const HASH = 'pcm-md5:0123456789abcdef0123456789abcdef';

// A whole v3 .cpk: header, then `n` detail samples (mono, peak + rms, 3 bands).
function cpk(n: number, fill = 7): Uint8Array {
	const b = Buffer.alloc(21 + n * 6, fill);
	CPK_MAGIC.copy(b, 0);
	b[8] = 3; b[9] = 3; b[10] = 1;
	b.writeUInt16LE(100, 11);
	b.writeUInt32LE(n, 13);
	b.writeUInt32LE(0, 17);
	return b;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pathOf = (b: Uint8Array) => catalogueBlobPath('user', 'peaks', sha(b));

function item(variant: 'hi' | 'lo', bytes: Uint8Array, over: Partial<{ sha256: string; size: number }> = {}): StoredCatalogueItem {
	return {
		audioHash: HASH, version: [2, 4, 0], unitSchema: 1, durationSec: 300, licence: null, unit: 'peaks', variant,
		data: { blob: { path: pathOf(bytes), sha256: over.sha256 ?? sha(bytes), bytes: over.size ?? bytes.byteLength }, cpkVersion: 3 },
		rev: 1, deviceId: 'desktop', updatedAt: 1,
	} as StoredCatalogueItem;
}

function claim(rec: string, hash: string, device: string): void {
	raw.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('claims', ?, ?, ?, ?)`)
		.run(`${rec}:audio_hash:${hash}`, rec, `audio_hash:${hash}`, JSON.stringify({ cell: { clock: { device } } }));
}

beforeEach(() => {
	dir = tmpDir('curator-peaks-');
	const path = join(dir.path, 'library.db');
	migrate(path);
	raw = dir.track(new Database(path));
	raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state) VALUES ('t1', 'rec-1', 'One', '[{"name":"A"}]', 'unsorted')`).run();
});
afterEach(() => dir.cleanup());

describe('fetchPeaks', () => {
	it('takes the hi tier when the account has both, checked against its item', async () => {
		claim('rec-1', HASH, 'desktop');
		const hi = cpk(400), lo = cpk(40);
		const blobs = new Map([[pathOf(hi), hi], [pathOf(lo), lo]]);
		const asked: CatalogueLookupInput[] = [];
		const got = await fetchPeaks({
			raw, deviceId: 'phone',
			lookup: async (input) => { asked.push(input); return { items: [item('lo', lo), item('hi', hi)] }; },
			download: async (path) => blobs.get(path)!,
		}, 't1');
		expect(got?.tier).toBe('hi');
		expect(got?.bytes).toEqual(hi);
		expect(asked[0]?.audioHashes).toEqual([HASH]);
	});

	it('falls back to lo, and is null without a claimed hash or an item', async () => {
		const lo = cpk(40);
		const deps = { raw, deviceId: 'phone', lookup: async () => ({ items: [item('lo', lo)] }), download: async () => lo };
		expect(await fetchPeaks(deps, 't1')).toBeNull();
		claim('rec-1', HASH, 'desktop');
		expect((await fetchPeaks(deps, 't1'))?.tier).toBe('lo');
		expect(await fetchPeaks({ ...deps, lookup: async () => ({ items: [] }) }, 't1')).toBeNull();
	});

	it('refuses a blob that does not match its item', async () => {
		claim('rec-1', HASH, 'desktop');
		const lo = cpk(40);
		const deps = { raw, deviceId: 'phone', download: async () => lo };
		await expect(fetchPeaks({ ...deps, lookup: async () => ({ items: [item('lo', lo, { sha256: 'f'.repeat(64) })] }) }, 't1')).rejects.toThrow(/does not match/);
		const cut = lo.subarray(0, 30);
		await expect(fetchPeaks({ raw, deviceId: 'phone', download: async () => cut, lookup: async () => ({ items: [item('lo', cut)] }) }, 't1')).rejects.toThrow(/not a whole/);
	});
});

describe('claimedHashes and the .cpk header', () => {
	it('takes the master device\'s hash when a recording claims several', () => {
		claim('rec-1', HASH, 'desktop');
		claim('rec-1', 'pcm-md5:ffffffffffffffffffffffffffffffff', 'laptop');
		expect(claimedHashes(raw, ['rec-1'], null).get('rec-1')).toEqual({ hash: null, ambiguous: true });
		expect(claimedHashes(raw, ['rec-1'], 'desktop').get('rec-1')).toEqual({ hash: HASH, ambiguous: false });
	});

	it('reads the version of a whole file only', () => {
		expect(cpkVersionOf(cpk(10))).toBe(3);
		expect(cpkVersionOf(cpk(10).subarray(0, 40))).toBeNull();
		expect(cpkVersionOf(Buffer.from('not peaks at all, not at all'))).toBeNull();
	});
});

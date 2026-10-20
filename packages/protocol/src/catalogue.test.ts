import { describe, expect, it } from 'vitest';
import {
	AUDIO_HASH_RE,
	base64ByteLength,
	CATALOGUE_UNITS,
	catalogueAllows,
	catalogueBlobPath,
	compareVersions,
	MAX_CATALOGUE_BLOB_BYTES,
	MAX_CATALOGUE_DATA_BYTES,
	MAX_CATALOGUE_LOOKUP_HASHES,
	parseVersionString,
	safeParseCatalogueItem,
	ZCatalogueInventoryInput,
	ZCatalogueLookupInput,
	type CatalogueItem,
	type CataloguePolicy,
} from './catalogue.js';
import { CALL_ERROR_REASONS, SYNC_FEATURES } from './cloud-service.js';

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const HASH = `pcm-md5:${'a'.repeat(32)}`;
const SHA = 'b'.repeat(64);
const USER = '11111111-2222-4333-8444-555555555555';
const f32b64 = (xs: number[]) => btoa(String.fromCharCode(...new Uint8Array(new Float32Array(xs).buffer)));

const base = { audioHash: HASH, version: [2, 4, 0], unitSchema: 1, durationSec: 312.5, licence: null };

// One valid item per unit: what the desktop uploader will send.
const SAMPLE_ITEMS: Record<(typeof CATALOGUE_UNITS)[number], CatalogueItem> = {
	rhythm: { ...base, unit: 'rhythm', variant: 'default', data: { bpm: 124.02, beatgrid: f32b64([0.1, 0.58, 1.06]), downbeats: f32b64([0.1]) } },
	key: { ...base, unit: 'key', variant: 'default', data: { camelot: '8A', strength: 0.81 } },
	structure: {
		...base,
		unit: 'structure',
		variant: 'default',
		data: {
			segments: [
				{ startSec: 0, endSec: 32, label: 'intro', source: 'analyzer', confidence: 0.9, energy: 0.3 },
				{ startSec: 32, endSec: 64, label: 'drop' },
			],
			introLengthSec: 32,
			outroLengthSec: null,
			firstDropSec: 32,
			dropCount: 1,
			breakdownCount: 0,
		},
	},
	advanced: {
		...base,
		unit: 'advanced',
		variant: 'default',
		data: { brightness: 0.4, power: 0.7, dynamicComplexity: 3.1, loudnessRangeLu: 5.2, dissonance: 0.45, density: 12, features: { lowlevel: { x: [1, 2] } } },
	},
	fingerprint: { ...base, unit: 'fingerprint', variant: 'default', data: { chromaprint: 'AQAAEw==', durationSec: 312 } },
	peaks: {
		...base,
		unit: 'peaks',
		variant: 'lo',
		data: { blob: { path: catalogueBlobPath(USER, 'peaks', SHA), sha256: SHA, bytes: 4096 }, cpkVersion: 3 },
	},
	vectors: {
		...base,
		version: [1],
		unit: 'vectors',
		variant: 'mert-v2-fullsong@1',
		licence: 'CC-BY-NC-4.0',
		data: { blob: { path: catalogueBlobPath(USER, 'vectors', SHA), sha256: SHA, bytes: 150_000 }, dim: 1024, count: 37 },
	},
};

const ok = (raw: unknown) => safeParseCatalogueItem(raw).ok;

describe('catalogue items', () => {
	it('accepts one item per unit and round-trips it through JSON unchanged', () => {
		for (const unit of CATALOGUE_UNITS) {
			const item = SAMPLE_ITEMS[unit];
			const r = safeParseCatalogueItem(roundTrip(item));
			expect(r).toEqual({ ok: true, item });
		}
	});

	it('takes the three hash schemes the desktop writes and nothing else', () => {
		for (const h of [`pcm-md5:${'0'.repeat(32)}`, `mp3-sha256:${'f'.repeat(64)}`, `mp4-sha256:${'9'.repeat(64)}`]) {
			expect(AUDIO_HASH_RE.test(h)).toBe(true);
			expect(ok({ ...SAMPLE_ITEMS.key, audioHash: h })).toBe(true);
		}
		for (const h of [`pcm-md5:${'A'.repeat(32)}`, `pcm-md5:${'a'.repeat(31)}`, `mp3-sha256:${'a'.repeat(32)}`, `flac-md5:${'a'.repeat(32)}`, '', `pcm-md5:${'a'.repeat(32)}\n`]) {
			expect(ok({ ...SAMPLE_ITEMS.key, audioHash: h })).toBe(false);
		}
	});

	it('pins each unit to its variants', () => {
		expect(ok({ ...SAMPLE_ITEMS.rhythm, variant: 'lo' })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.peaks, variant: 'hi' })).toBe(true);
		expect(ok({ ...SAMPLE_ITEMS.peaks, variant: 'default' })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.vectors, variant: 'muq-mulan-large@1' })).toBe(true);
		expect(ok({ ...SAMPLE_ITEMS.vectors, variant: 'MERT@1' })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.vectors, variant: 'mert' })).toBe(false);
	});

	it('requires a licence on vectors only', () => {
		expect(ok({ ...SAMPLE_ITEMS.vectors, licence: null })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.rhythm, licence: 'AGPL-3.0' })).toBe(true);
	});

	it('refuses a data shape from another unit, unknown keys and missing fields', () => {
		expect(ok({ ...SAMPLE_ITEMS.key, data: SAMPLE_ITEMS.rhythm.data })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.key, extra: 1 })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.key, data: { camelot: '8A' } })).toBe(false);
		const { durationSec: _d, ...noDuration } = SAMPLE_ITEMS.key;
		expect(ok(noDuration)).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.key, unit: 'tempo' })).toBe(false);
	});

	it('keeps rekordbox phrases out of structure', () => {
		const seg = { startSec: 0, endSec: 8, label: 'Intro 1', source: 'rekordbox', rbKind: 1 };
		expect(ok({ ...SAMPLE_ITEMS.structure, data: { ...SAMPLE_ITEMS.structure.data, segments: [seg] } })).toBe(false);
	});

	it('checks the edge values', () => {
		const key = SAMPLE_ITEMS.key;
		for (const camelot of ['1A', '9B', '10A', '12B']) expect(ok({ ...key, data: { camelot, strength: null } })).toBe(true);
		for (const camelot of ['0A', '13A', '8C', '08A', 'a8']) expect(ok({ ...key, data: { camelot, strength: null } })).toBe(false);
		expect(ok({ ...key, durationSec: 0 })).toBe(false);
		expect(ok({ ...key, durationSec: 86_400 })).toBe(true);
		expect(ok({ ...key, durationSec: 86_401 })).toBe(false);
		expect(ok({ ...key, version: [] })).toBe(false);
		expect(ok({ ...key, version: [1, 2, 3, 4, 5] })).toBe(false);
		expect(ok({ ...key, version: [65536] })).toBe(false);
		expect(ok({ ...key, version: [2, -1, 0] })).toBe(false);
		expect(ok({ ...key, version: [2.5] })).toBe(false);
		// NaN and Infinity cannot even arrive through JSON, but a direct call
		// with them is refused too.
		expect(ok({ ...key, data: { camelot: '8A', strength: Number.NaN } })).toBe(false);
	});

	it('refuses a unit schema newer than it knows', () => {
		expect(ok({ ...SAMPLE_ITEMS.key, unitSchema: 2 })).toBe(false);
		expect(ok({ ...SAMPLE_ITEMS.key, unitSchema: 0 })).toBe(false);
	});

	it('takes float32 grids only as whole values of padded base64', () => {
		const r = SAMPLE_ITEMS.rhythm;
		expect(ok({ ...r, data: { ...r.data, beatgrid: '' } })).toBe(true);
		// 3 bytes is not a float.
		expect(ok({ ...r, data: { ...r.data, beatgrid: btoa('abc') } })).toBe(false);
		expect(ok({ ...r, data: { ...r.data, beatgrid: 'AAAAAA' } })).toBe(false);
		expect(ok({ ...r, data: { ...r.data, beatgrid: 'AAAA AA==' } })).toBe(false);
		expect(base64ByteLength(f32b64([1, 2, 3]))).toBe(12);
		expect(base64ByteLength(btoa('abcde'))).toBe(5);
	});

	it('caps inline data and blob sizes', () => {
		const big = { ...SAMPLE_ITEMS.advanced, data: { ...SAMPLE_ITEMS.advanced.data, features: { x: 'y'.repeat(MAX_CATALOGUE_DATA_BYTES) } } };
		expect(ok(big)).toBe(false);
		const p = SAMPLE_ITEMS.peaks;
		if (p.unit !== 'peaks') throw new Error('unreachable');
		expect(ok({ ...p, data: { ...p.data, blob: { ...p.data.blob, bytes: MAX_CATALOGUE_BLOB_BYTES } } })).toBe(true);
		expect(ok({ ...p, data: { ...p.data, blob: { ...p.data.blob, bytes: MAX_CATALOGUE_BLOB_BYTES + 1 } } })).toBe(false);
		expect(ok({ ...p, data: { ...p.data, blob: { ...p.data.blob, bytes: 0 } } })).toBe(false);
		expect(ok({ ...p, data: { ...p.data, blob: { ...p.data.blob, sha256: SHA.toUpperCase() } } })).toBe(false);
	});
});

describe('blob paths', () => {
	it('are content-addressed under the user id, lower-cased', () => {
		expect(catalogueBlobPath(USER.toUpperCase(), 'peaks', SHA)).toBe(`${USER}/peaks/${SHA}.cpk`);
		expect(catalogueBlobPath(USER, 'vectors', SHA)).toBe(`${USER}/vec/${SHA}.cvec`);
	});
});

describe('versions', () => {
	it('compare like Postgres int[]', () => {
		expect(compareVersions([2, 10, 0], [2, 9, 9])).toBe(1);
		expect(compareVersions([2, 4, 0], [2, 4, 0])).toBe(0);
		expect(compareVersions([2, 4], [2, 4, 0])).toBe(-1);
		expect(compareVersions([3], [2, 99])).toBe(1);
	});

	it('parse dotted analyzer versions and nothing else', () => {
		expect(parseVersionString('2.4.0')).toEqual([2, 4, 0]);
		expect(parseVersionString('10')).toEqual([10]);
		expect(parseVersionString('rekordbox')).toBeNull();
		expect(parseVersionString('2.4.0-rc1')).toBeNull();
		expect(parseVersionString('1.2.3.4.5')).toBeNull();
		expect(parseVersionString('70000')).toBeNull();
		expect(parseVersionString('')).toBeNull();
	});
});

describe('policy', () => {
	const DA: CataloguePolicy = {
		allow: [
			{ unit: 'rhythm', variants: null },
			{ unit: 'peaks', variants: ['lo'] },
		],
	};
	it('allows listed units, and for a variant list only those variants', () => {
		expect(catalogueAllows(DA, 'rhythm', 'default')).toBe(true);
		expect(catalogueAllows(DA, 'peaks', 'lo')).toBe(true);
		expect(catalogueAllows(DA, 'peaks', 'hi')).toBe(false);
		expect(catalogueAllows(DA, 'vectors', 'mert-v2-fullsong@1')).toBe(false);
	});
});

describe('lookup and inventory inputs', () => {
	const hashes = (n: number) => Array.from({ length: n }, (_, i) => `pcm-md5:${i.toString(16).padStart(32, '0')}`);

	it('take up to 50 hashes and a want list', () => {
		const input = { deviceId: 'd', audioHashes: hashes(MAX_CATALOGUE_LOOKUP_HASHES), want: [{ unit: 'rhythm', minVersion: [2, 3, 0], maxSchema: 1 }, { unit: 'peaks', variant: 'lo' }] };
		expect(ZCatalogueLookupInput.parse(roundTrip(input))).toEqual(input);
		expect(ZCatalogueLookupInput.safeParse({ ...input, audioHashes: hashes(51) }).success).toBe(false);
		expect(ZCatalogueLookupInput.safeParse({ ...input, audioHashes: [] }).success).toBe(false);
		expect(ZCatalogueLookupInput.safeParse({ ...input, want: [] }).success).toBe(false);
		expect(ZCatalogueLookupInput.safeParse({ ...input, want: [{ unit: 'tempo' }] }).success).toBe(false);
		expect(ZCatalogueLookupInput.safeParse({ ...input, extra: true }).success).toBe(false);
	});

	it('cursor the inventory by rev', () => {
		expect(ZCatalogueInventoryInput.parse({ deviceId: 'd', afterRev: 0 })).toEqual({ deviceId: 'd', afterRev: 0 });
		expect(ZCatalogueInventoryInput.safeParse({ deviceId: 'd', afterRev: -1 }).success).toBe(false);
		expect(ZCatalogueInventoryInput.safeParse({ deviceId: 'd', afterRev: 1.5 }).success).toBe(false);
		expect(ZCatalogueInventoryInput.safeParse({ afterRev: 0 }).success).toBe(false);
	});
});

describe('contract lists', () => {
	it('name the catalogue feature and its whole-call errors', () => {
		expect(SYNC_FEATURES).toContain('catalogue');
		expect(CALL_ERROR_REASONS).toEqual(expect.arrayContaining(['catalogue_disabled', 'catalogue_not_entitled']));
	});
});

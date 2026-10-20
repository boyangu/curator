import { describe, expect, it } from 'vitest';
import { decodeVectorPack, encodeVectorPack, VectorPackError, type VectorPack } from './catalogue-pack.js';

function sample(dim = 8, segments = 3): VectorPack {
	const vec = (seed: number) => Float32Array.from({ length: dim }, (_, i) => Math.fround(Math.sin(seed * 31 + i) * 0.5));
	return {
		modelId: 'mert-v2-fullsong@1',
		dim,
		vectors: [
			{ scope: 'track', segIdx: -1, startSec: null, endSec: null, label: null, stem: null, vec: vec(0) },
			...Array.from({ length: segments }, (_, s) => ({
				scope: 'segment' as const,
				segIdx: s,
				startSec: s * 30,
				endSec: s * 30 + 30,
				label: s % 2 ? 'drop' : 'breakdown – ünïcode 🎛',
				stem: null,
				vec: vec(s + 1),
			})),
		],
	};
}

describe('vector pack', () => {
	it('round-trips every field exactly', () => {
		const pack = sample();
		const bytes = encodeVectorPack(pack);
		expect(decodeVectorPack(bytes)).toEqual(pack);
	});

	it('round-trips the real shape: dim 1024, a track vector and 36 segments', () => {
		const pack = sample(1024, 36);
		const bytes = encodeVectorPack(pack);
		// The vectors dominate: 37 × 1024 × 4.
		expect(bytes.length).toBeGreaterThan(37 * 1024 * 4);
		expect(bytes.length).toBeLessThan(37 * 1024 * 4 + 37 * 16 + 200);
		expect(decodeVectorPack(bytes)).toEqual(pack);
	});

	it('keeps edge values: zero, negative zero, extremes, a stem record', () => {
		const pack: VectorPack = {
			modelId: 'clap@1',
			dim: 4,
			vectors: [{ scope: 'stem', segIdx: 32767, startSec: 0, endSec: 3.4028234663852886e38, label: '', stem: 'drums', vec: Float32Array.from([0, -0, 3.4e38, -1.17549435e-38]) }],
		};
		const back = decodeVectorPack(encodeVectorPack(pack));
		expect(back).toEqual(pack);
		expect(Object.is(back.vectors[0]!.vec[1], -0)).toBe(true);
	});

	it('decodes from a view into a larger buffer (unaligned offset)', () => {
		const bytes = encodeVectorPack(sample());
		const host = new Uint8Array(bytes.length + 3);
		host.set(bytes, 3);
		expect(decodeVectorPack(host.subarray(3))).toEqual(sample());
	});

	it('takes an empty pack (header + model id only)', () => {
		const pack: VectorPack = { modelId: 'muq-mulan-large@1', dim: 512, vectors: [] };
		expect(decodeVectorPack(encodeVectorPack(pack))).toEqual(pack);
	});

	it('refuses what it cannot represent', () => {
		const p = sample();
		expect(() => encodeVectorPack({ ...p, dim: 9 })).toThrow(VectorPackError);
		expect(() => encodeVectorPack({ ...p, vectors: [{ ...p.vectors[0]!, segIdx: 40000 }] })).toThrow(VectorPackError);
		expect(() => encodeVectorPack({ ...p, vectors: [{ ...p.vectors[0]!, label: 'bad \ud800' }] })).toThrow(VectorPackError);
		expect(() => encodeVectorPack({ ...p, dim: 0, vectors: [] })).toThrow(VectorPackError);
	});

	it('refuses damaged bytes', () => {
		const good = encodeVectorPack(sample());
		const damaged = (f: (b: Uint8Array) => void) => {
			const b = good.slice();
			f(b);
			return b;
		};
		expect(() => decodeVectorPack(good.subarray(0, 10))).toThrow(/too short/);
		expect(() => decodeVectorPack(good.subarray(0, good.length - 1))).toThrow(/length/);
		expect(() => decodeVectorPack(damaged((b) => (b[0] = 0x58)))).toThrow(/not a vector pack/);
		expect(() => decodeVectorPack(damaged((b) => (b[8] = 2)))).toThrow(/version/);
		expect(() => decodeVectorPack(damaged((b) => (b[10] = 2)))).toThrow(/dtype/);
		// A forged count that would need gigabytes is refused before allocating.
		expect(() => decodeVectorPack(damaged((b) => new DataView(b.buffer).setUint32(16, 0xffffffff, true)))).toThrow(/length/);
		// Scope byte of the first record.
		expect(() => decodeVectorPack(damaged((b) => (b[24] = 9)))).toThrow(/scope/);
		// Label index of the first record pointing past the string table.
		expect(() => decodeVectorPack(damaged((b) => new DataView(b.buffer).setUint16(24 + 12, 500, true)))).toThrow(/out of range/);
	});
});

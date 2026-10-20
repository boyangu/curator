// The `.cvec` vector pack: every vector one model produced for one audio
// hash (the whole-track vector plus its segment vectors), as one immutable
// Storage object `<uid>/vec/<sha256>.cvec`. Binary rather than JSON because
// the vectors are 1.1 GB across a library: base64 text would add a third,
// and parsing a JSON array of floats on the desktop's main loop is the jank
// the hydrator exists to avoid.
//
// DataView and manual UTF-8 only, no Buffer and no TextEncoder: the cloud,
// the desktop and (later) the phone runtime all read it.
//
// Layout, all little-endian, no padding except the one alignment pad:
//
//   offset  size        field
//   ──────  ──────────  ────────────────────────────────────────────────────
//   0       8           magic "CURVECPK"
//   8       2           version u16 (1)
//   10      2           dtype u16 (1 = float32)
//   12      4           dim u32
//   16      4           count u32 (vectors)
//   20      4           strings_bytes u32 (length of the string table)
//   24      count × 16  records:
//                         scope u8 (0 track, 1 segment, 2 stem)
//                         reserved u8 (0)
//                         seg_idx i16 (-1 for the track vector)
//                         start_sec f32 (NaN = null)
//                         end_sec f32 (NaN = null)
//                         label u16 (string index, 0xFFFF = null)
//                         stem u16 (string index, 0xFFFF = null)
//   …       strings     string table: (len u16, UTF-8 bytes) repeated;
//                       string 0 is always the model id
//   …       0–3         zero pad to a multiple of 4
//   …       count×dim×4 vectors, float32, record order

export const VECTOR_PACK_MAGIC = 'CURVECPK';
export const VECTOR_PACK_VERSION = 1;
const DTYPE_F32 = 1;
const HEADER_BYTES = 24;
const RECORD_BYTES = 16;
const NO_STRING = 0xffff;

export const VECTOR_SCOPES = ['track', 'segment', 'stem'] as const;
export type VectorScope = (typeof VECTOR_SCOPES)[number];

export type PackedVector = {
	scope: VectorScope;
	// -1 for the track vector, the segment's index otherwise (mir_vector.seg_idx).
	segIdx: number;
	startSec: number | null;
	endSec: number | null;
	label: string | null;
	stem: string | null;
	vec: Float32Array;
};

export type VectorPack = {
	modelId: string;
	dim: number;
	vectors: PackedVector[];
};

export class VectorPackError extends Error {
	override readonly name = 'VectorPackError';
}

function utf8Encode(s: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				i++;
			}
		}
		// A lone surrogate is not text; refuse it rather than write bytes no
		// strict decoder accepts.
		if (c >= 0xd800 && c <= 0xdfff) throw new VectorPackError('lone surrogate in a string');
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return out;
}

function utf8Decode(b: Uint8Array): string {
	let s = '';
	for (let i = 0; i < b.length; ) {
		const x = b[i]!;
		let c: number;
		let n: number;
		if (x < 0x80) [c, n] = [x, 0];
		else if (x >= 0xc2 && x < 0xe0) [c, n] = [x & 31, 1];
		else if (x >= 0xe0 && x < 0xf0) [c, n] = [x & 15, 2];
		else if (x >= 0xf0 && x < 0xf5) [c, n] = [x & 7, 3];
		else throw new VectorPackError('invalid UTF-8');
		// A continuation byte past the end reads as undefined: truncated.
		for (let k = 1; k <= n; k++) {
			const y = b[i + k];
			if (y === undefined || (y & 0xc0) !== 0x80) throw new VectorPackError('invalid UTF-8');
			c = (c << 6) | (y & 63);
		}
		// Overlong forms and surrogates, which a strict decoder refuses.
		if ((n === 2 && c < 0x800) || (n === 3 && c < 0x10000) || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) {
			throw new VectorPackError('invalid UTF-8');
		}
		s += String.fromCodePoint(c);
		i += n + 1;
	}
	return s;
}

const MAGIC_BYTES = utf8Encode(VECTOR_PACK_MAGIC);

export function encodeVectorPack(pack: VectorPack): Uint8Array {
	const { modelId, dim, vectors } = pack;
	if (!Number.isInteger(dim) || dim < 1 || dim > 0xffff_ffff) throw new VectorPackError(`bad dim ${dim}`);
	const strings: number[][] = [];
	const index = new Map<string, number>();
	const intern = (s: string | null): number => {
		if (s === null) return NO_STRING;
		let i = index.get(s);
		if (i === undefined) {
			const bytes = utf8Encode(s);
			if (bytes.length > 0xffff) throw new VectorPackError('string longer than 65535 bytes');
			i = strings.length;
			if (i >= NO_STRING) throw new VectorPackError('too many distinct strings');
			strings.push(bytes);
			index.set(s, i);
		}
		return i;
	};
	intern(modelId);
	const recs = vectors.map((v) => {
		if (v.vec.length !== dim) throw new VectorPackError(`vector of length ${v.vec.length}, pack dim ${dim}`);
		if (!Number.isInteger(v.segIdx) || v.segIdx < -32768 || v.segIdx > 32767) throw new VectorPackError(`bad segIdx ${v.segIdx}`);
		const scope = VECTOR_SCOPES.indexOf(v.scope);
		if (scope < 0) throw new VectorPackError(`bad scope ${String(v.scope)}`);
		return { scope, v, label: intern(v.label), stem: intern(v.stem) };
	});
	const stringsBytes = strings.reduce((n, b) => n + 2 + b.length, 0);
	const head = HEADER_BYTES + recs.length * RECORD_BYTES + stringsBytes;
	const pad = (4 - (head % 4)) % 4;
	const total = head + pad + recs.length * dim * 4;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	out.set(MAGIC_BYTES, 0);
	dv.setUint16(8, VECTOR_PACK_VERSION, true);
	dv.setUint16(10, DTYPE_F32, true);
	dv.setUint32(12, dim, true);
	dv.setUint32(16, recs.length, true);
	dv.setUint32(20, stringsBytes, true);
	let o = HEADER_BYTES;
	for (const r of recs) {
		dv.setUint8(o, r.scope);
		dv.setUint8(o + 1, 0);
		dv.setInt16(o + 2, r.v.segIdx, true);
		dv.setFloat32(o + 4, r.v.startSec ?? NaN, true);
		dv.setFloat32(o + 8, r.v.endSec ?? NaN, true);
		dv.setUint16(o + 12, r.label, true);
		dv.setUint16(o + 14, r.stem, true);
		o += RECORD_BYTES;
	}
	for (const s of strings) {
		dv.setUint16(o, s.length, true);
		out.set(s, o + 2);
		o += 2 + s.length;
	}
	o += pad;
	for (const r of recs) {
		for (let i = 0; i < dim; i++) dv.setFloat32(o + i * 4, r.v.vec[i]!, true);
		o += dim * 4;
	}
	return out;
}

export function decodeVectorPack(bytes: Uint8Array): VectorPack {
	if (bytes.length < HEADER_BYTES) throw new VectorPackError('too short for a header');
	for (let i = 0; i < MAGIC_BYTES.length; i++) if (bytes[i] !== MAGIC_BYTES[i]) throw new VectorPackError('not a vector pack');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint16(8, true);
	if (version !== VECTOR_PACK_VERSION) throw new VectorPackError(`unsupported pack version ${version}`);
	if (dv.getUint16(10, true) !== DTYPE_F32) throw new VectorPackError('unsupported dtype');
	const dim = dv.getUint32(12, true);
	const count = dv.getUint32(16, true);
	const stringsBytes = dv.getUint32(20, true);
	if (dim < 1) throw new VectorPackError('dim 0');
	// Checked in floating point before anything is allocated, so a forged
	// header cannot ask for gigabytes.
	const head = HEADER_BYTES + count * RECORD_BYTES + stringsBytes;
	const pad = (4 - (head % 4)) % 4;
	if (head + pad + count * dim * 4 !== bytes.length) throw new VectorPackError('length does not match the header');

	const strings: string[] = [];
	let o = HEADER_BYTES + count * RECORD_BYTES;
	const end = o + stringsBytes;
	while (o < end) {
		if (o + 2 > end) throw new VectorPackError('truncated string table');
		const len = dv.getUint16(o, true);
		if (o + 2 + len > end) throw new VectorPackError('truncated string table');
		strings.push(utf8Decode(bytes.subarray(o + 2, o + 2 + len)));
		o += 2 + len;
	}
	const modelId = strings[0];
	if (modelId === undefined) throw new VectorPackError('no model id');
	const str = (i: number): string | null => {
		if (i === NO_STRING) return null;
		const s = strings[i];
		if (s === undefined) throw new VectorPackError(`string index ${i} out of range`);
		return s;
	};
	for (let i = 0; i < pad; i++) if (bytes[end + i] !== 0) throw new VectorPackError('non-zero pad');

	const vectors: PackedVector[] = [];
	let v = end + pad;
	for (let r = 0; r < count; r++) {
		const ro = HEADER_BYTES + r * RECORD_BYTES;
		const scope = VECTOR_SCOPES[dv.getUint8(ro)];
		if (scope === undefined) throw new VectorPackError(`bad scope ${dv.getUint8(ro)}`);
		const start = dv.getFloat32(ro + 4, true);
		const stop = dv.getFloat32(ro + 8, true);
		const vec = new Float32Array(dim);
		for (let i = 0; i < dim; i++) vec[i] = dv.getFloat32(v + i * 4, true);
		v += dim * 4;
		vectors.push({
			scope,
			segIdx: dv.getInt16(ro + 2, true),
			startSec: Number.isNaN(start) ? null : start,
			endSec: Number.isNaN(stop) ? null : stop,
			label: str(dv.getUint16(ro + 12, true)),
			stem: str(dv.getUint16(ro + 14, true)),
			vec,
		});
	}
	return { modelId, dim, vectors };
}

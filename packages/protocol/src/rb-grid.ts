// The wire form of a rekordbox beat grid (`library_track` set-rb-analysis,
// unit 'grid'). Decided 2026-10-20, before anything had emitted the unit.
//
// Why not the plain list of beat times the unit was first sketched as: a
// 7-minute track at 128 BPM has ~900 beats, ~17 KB as JSON seconds — over
// MAX_OP_PAYLOAD_BYTES for an ordinary track, and the sketch carried no
// downbeats, so a grid would have arrived without its bar lines. Rekordbox
// stores beat times as whole milliseconds (PQTZ), so they are carried as
// integer ms, second-differenced: a steady tempo's deltas only wobble by the
// ms rounding (468, 469, 469, 469 at 128 BPM), so the second differences are
// mostly -1, 0 and 1, two or three bytes a beat. Downbeats are indices into
// the beats (the sidecar picks every downbeat from the beat list), first
// differenced, two bytes a bar. A 7-minute track is ~2.5 KB; the cap holds
// roughly 50 minutes at 128 BPM. Longer grids (recorded mixes) do not ride
// the log at all — the emitter checks the size and leaves them device-local;
// rekordbox data stays out of the catalogue, so they have no other route.
//
//   [RB_GRID_FORMAT, n, m, t0, d1, dd2, …, dd(n-1), i0, di1, …, di(m-1)]
//
// n beats, m downbeats; t0 the first beat in ms, d1 = t1 - t0, ddk = (tk -
// tk-1) - (tk-1 - tk-2); i0 the first downbeat's beat index, dik = ik - ik-1.
// Every element an integer. The leading format number lets a later encoding
// be told apart; a reader that does not know it ignores the unit.
//
// Lossless against the desktop's storage: the blob holds Float32 seconds of
// whole-ms times, and rounding a Float32 back to ms recovers the integer for
// any time under ~4.5 hours, so decode → Float32 reproduces the same bytes.
// A time that was not whole ms to begin with (none known) lands on the
// nearest ms; a downbeat that is not exactly one of the beats on the nearest
// beat.

export const RB_GRID_FORMAT = 1;

export type RbGrid = { beatsSec: number[]; downbeatsSec: number[] };

const toMs = (sec: number): number => Math.round(sec * 1000);

// Index of the beat nearest `ms` in an ascending list (ties: the earlier).
function nearest(ms: readonly number[], t: number): number {
	let lo = 0;
	let hi = ms.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ms[mid]! < t) lo = mid + 1;
		else hi = mid;
	}
	if (lo > 0 && Math.abs(ms[lo - 1]! - t) <= Math.abs(ms[lo]! - t)) return lo - 1;
	return lo;
}

// Null for an empty grid: no beats is no grid.
export function encodeRbGrid(beatsSec: readonly number[], downbeatsSec: readonly number[]): number[] | null {
	const ms = beatsSec.filter((t) => Number.isFinite(t)).map(toMs);
	if (ms.length === 0) return null;
	const out: number[] = [RB_GRID_FORMAT, ms.length, 0, ms[0]!];
	if (ms.length > 1) out.push(ms[1]! - ms[0]!);
	for (let k = 2; k < ms.length; k++) out.push(ms[k]! - ms[k - 1]! - (ms[k - 1]! - ms[k - 2]!));

	// Exact match first (the normal case), nearest beat otherwise; the
	// nearest search needs ascending beats, which a rekordbox grid is.
	const at = new Map<number, number>();
	ms.forEach((t, i) => { if (!at.has(t)) at.set(t, i); });
	const ascending = ms.every((t, i) => i === 0 || t > ms[i - 1]!);
	const idx = new Set<number>();
	for (const d of downbeatsSec) {
		if (!Number.isFinite(d)) continue;
		const t = toMs(d);
		const i = at.get(t) ?? (ascending ? nearest(ms, t) : undefined);
		if (i !== undefined) idx.add(i);
	}
	const sorted = [...idx].sort((a, b) => a - b);
	out[2] = sorted.length;
	sorted.forEach((i, k) => out.push(k === 0 ? i : i - sorted[k - 1]!));
	return out;
}

// The shape check the op schema runs: the header agrees with the length,
// every element is an integer, the downbeat indices stay inside the beats.
export function isRbGridValue(v: readonly number[]): boolean {
	if (v.length < 4 || v[0] !== RB_GRID_FORMAT) return false;
	if (!v.every((x) => Number.isSafeInteger(x))) return false;
	const n = v[1]!;
	const m = v[2]!;
	if (n < 1 || m < 0 || m > n || v.length !== 3 + n + m) return false;
	let i = -1;
	for (let k = 0; k < m; k++) {
		const step = v[3 + n + k]!;
		if (k > 0 && step <= 0) return false;
		i = k === 0 ? step : i + step;
		if (i < 0 || i >= n) return false;
	}
	return true;
}

// Null for a value this reader cannot read (another format, a bad shape).
export function decodeRbGrid(v: readonly number[]): RbGrid | null {
	if (!isRbGridValue(v)) return null;
	const n = v[1]!;
	const m = v[2]!;
	const ms: number[] = [v[3]!];
	if (n > 1) ms.push(ms[0]! + v[4]!);
	let d = n > 1 ? v[4]! : 0;
	for (let k = 2; k < n; k++) {
		d += v[3 + k]!;
		ms.push(ms[k - 1]! + d);
	}
	const downs: number[] = [];
	let i = 0;
	for (let k = 0; k < m; k++) {
		i = k === 0 ? v[3 + n]! : i + v[3 + n + k]!;
		downs.push(ms[i]!);
	}
	return { beatsSec: ms.map((t) => t / 1000), downbeatsSec: downs.map((t) => t / 1000) };
}

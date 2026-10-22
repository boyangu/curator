import { describe, it, expect } from 'vitest';
import { parseOp, SCHEMA_VERSION, type Op } from './ops.js';
import { applyOp } from './reduce.js';
import { compareSnapshotKeys, deserializeLibraryState, LIBRARY_STATE_MAPS, serializeLibraryState, serializeLibraryStateChunks, type LibraryStateMapName } from './snapshot.js';
import { createLibraryState, materialize, type LibraryState } from './state.js';

let n = 0;
const op = (o: Pick<Op, 'entity' | 'kind' | 'entity_id' | 'payload'>, ts: number): Op =>
	parseOp({ op_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, device_id: 'd', client_ts: ts, schema_version: SCHEMA_VERSION, ...o });

describe('snapshot codec', () => {
	it('round-trips track state and artist alias rules, raw records and view alike', () => {
		const rec = '00000000-0000-4000-8000-0000000000aa';
		const state = createLibraryState();
		for (const o of [
			op({ entity: 'library_track', kind: 'set-state', entity_id: rec, payload: { state: 'backlog' } }, 10),
			op({ entity: 'artist_alias', kind: 'set', entity_id: 'a', payload: { from: 'A', to: 'B', to_key: 'b' } }, 11),
			op({ entity: 'artist_alias', kind: 'set', entity_id: 'b', payload: { from: 'B', to: 'C', to_key: 'c' } }, 12),
			op({ entity: 'artist_alias', kind: 'remove', entity_id: 'x', payload: {} }, 13),
		]) applyOp(state, o);
		const json = serializeLibraryState(state);
		const back = deserializeLibraryState(json);
		expect(serializeLibraryState(back)).toBe(json);
		expect(materialize(back)).toEqual(materialize(state));
		expect(materialize(back).artistAlias).toEqual({ a: { name: 'C', key: 'c' }, b: { name: 'C', key: 'c' } });
		expect(back.artistAliases.get('x')!.value).toBeNull();
		expect(materialize(back).libraryTracks[0]!.state).toBe('backlog');
	});

	it('round-trips v3 meta cells and the master setting in the unchanged format', () => {
		const rec = '00000000-0000-4000-8000-0000000000bb';
		const meta = { source: 'local' as const, title: 'Lilac', artists: [{ name: 'Bonobo' }], album_title: null, duration_sec: 300, isrc: null, release_date: null, label: null, genre: null, cover_url: null };
		const state = createLibraryState();
		const at = (o: Op, device: string): Op => ({ ...o, device_id: device }) as Op;
		for (const o of [
			at(op({ entity: 'library_track', kind: 'create', entity_id: rec, payload: {} }, 20), 'main'),
			at(op({ entity: 'library_track', kind: 'set-meta', entity_id: rec, payload: meta }, 21), 'main'),
			at(op({ entity: 'library_track', kind: 'set-meta', entity_id: rec, payload: { ...meta, title: 'Lilac (laptop)' } }, 22), 'laptop'),
			at(op({ entity: 'setting', kind: 'set', entity_id: 'library.master_device', payload: { value: 'main' } }, 19), 'main'),
		]) applyOp(state, o);
		const json = serializeLibraryState(state);
		expect(JSON.parse(json).version).toBe(1);
		const back = deserializeLibraryState(json);
		expect(serializeLibraryState(back)).toBe(json);
		expect(materialize(back).libraryTracks[0]!.meta).toMatchObject({ title: 'Lilac', device: 'main' });
	});

	it('reads a snapshot written before the artist alias maps existed', () => {
		const doc = JSON.parse(serializeLibraryState(createLibraryState())) as { maps: Record<string, unknown> };
		delete doc.maps['artistAliases'];
		delete doc.maps['artistAlias'];
		const back = deserializeLibraryState(JSON.stringify(doc));
		expect(back.artistAliases.size).toBe(0);
		delete doc.maps['tags'];
		expect(() => deserializeLibraryState(JSON.stringify(doc))).toThrow(/missing tags/);
	});
});

// ── the streaming writer ────────────────────────────────────────────────────

// A small seeded PRNG, so a failing case reproduces.
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Keys meant to trip an ordering that is not plain code-unit order: astral
// characters (surrogate pairs) beside U+E000..U+FFFF, combining marks, a
// case pair, the empty string, ASCII punctuation around ':'.
const KEY_PARTS = ['a', 'B', 'b', '', ':', '_', '0', '9', 'é', 'é', '', '�', 'Ａ', '😀', '𝄞', '\u{10FFFF}', 'ß', 'ﬀ', '中', ' ', '~'];

function randomKey(r: () => number): string {
	const n = 1 + Math.floor(r() * 4);
	let k = '';
	for (let i = 0; i < n; i++) k += KEY_PARTS[Math.floor(r() * KEY_PARTS.length)]!;
	return k;
}

// Nested JSON-shaped values with keys in random insertion order, undefined
// fields (dropped), arrays (order kept), nulls and the odd numbers.
function randomValue(r: () => number, depth = 0): unknown {
	const pick = r();
	if (depth > 3 || pick < 0.3) {
		const leaf = [null, true, false, 0, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER, 'x', '', '😀́', '\uD800'];
		return leaf[Math.floor(r() * leaf.length)];
	}
	if (pick < 0.5) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
	const out: Record<string, unknown> = {};
	const n = Math.floor(r() * 5);
	for (let i = 0; i < n; i++) out[randomKey(r)] = r() < 0.1 ? undefined : randomValue(r, depth + 1);
	return out;
}

function randomState(seed: number): LibraryState {
	const r = rng(seed);
	const state = createLibraryState();
	for (const map of LIBRARY_STATE_MAPS) {
		// Some maps empty, ADDED_MAPS among them.
		if (r() < 0.2) continue;
		const m = state[map] as Map<string, unknown>;
		const n = Math.floor(r() * 30);
		for (let i = 0; i < n; i++) m.set(randomKey(r), randomValue(r));
	}
	return state;
}

const sortedSource = (state: LibraryState) => (map: LibraryStateMapName): Array<[string, unknown]> =>
	[...(state[map] as Map<string, unknown>).entries()].sort(([a], [b]) => compareSnapshotKeys(a, b));

describe('streaming snapshot writer', () => {
	it('writes exactly serializeLibraryState on random states', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const state = randomState(seed);
			const streamed = [...serializeLibraryStateChunks(sortedSource(state))].join('');
			expect(streamed, `seed ${seed}`).toBe(serializeLibraryState(state));
		}
	});

	it('writes the empty state and a reducer-built state identically', () => {
		const empty = createLibraryState();
		expect([...serializeLibraryStateChunks(sortedSource(empty))].join('')).toBe(serializeLibraryState(empty));
		const rec = '00000000-0000-4000-8000-0000000000cc';
		const state = createLibraryState();
		for (const o of [
			op({ entity: 'library_track', kind: 'set-state', entity_id: rec, payload: { state: 'backlog' } }, 10),
			op({ entity: 'artist_alias', kind: 'set', entity_id: 'a', payload: { from: 'A', to: 'B', to_key: 'b' } }, 11),
			op({ entity: 'tag', kind: 'create', entity_id: 't1', payload: { name: 'Warm', kind: 'user', color: null } }, 12),
			op({ entity: 'tag', kind: 'delete', entity_id: 't1', payload: {} }, 13),
		]) applyOp(state, o);
		const streamed = [...serializeLibraryStateChunks(sortedSource(state))].join('');
		expect(streamed).toBe(serializeLibraryState(state));
		expect(serializeLibraryState(deserializeLibraryState(streamed))).toBe(streamed);
	});

	it('orders by code unit, not by code point: an astral key sorts before U+E000', () => {
		const state = createLibraryState();
		state.settings.set('', { value: 1, clock: { ts: 1, device: 'd', op: 'o' } });
		state.settings.set('😀', { value: 2, clock: { ts: 1, device: 'd', op: 'o' } });
		const json = [...serializeLibraryStateChunks(sortedSource(state))].join('');
		expect(json).toBe(serializeLibraryState(state));
		expect(json.indexOf('😀')).toBeLessThan(json.indexOf(''));
	});

	it('refuses entries out of order or repeated', () => {
		const clock = { ts: 1, device: 'd', op: 'o' };
		const bad = (entries: Array<[string, unknown]>) => () => [...serializeLibraryStateChunks((m) => (m === 'settings' ? entries : []))];
		expect(bad([['b', { value: 1, clock }], ['a', { value: 1, clock }]])).toThrow(/out of order/);
		expect(bad([['a', { value: 1, clock }], ['a', { value: 2, clock }]])).toThrow(/out of order or repeated/);
		// The code-point order SQLite's BINARY collation gives is refused too.
		expect(bad([['', 1], ['😀', 2]])).toThrow(/out of order/);
	});

	it('asks for every map once, in the document order', () => {
		const asked: string[] = [];
		[...serializeLibraryStateChunks((m) => { asked.push(m); return []; })];
		expect(asked).toEqual([...LIBRARY_STATE_MAPS]);
		expect(asked).toEqual(Object.keys((JSON.parse(serializeLibraryState(createLibraryState())) as { maps: object }).maps));
	});
});

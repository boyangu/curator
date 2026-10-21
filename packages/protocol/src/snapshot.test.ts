import { describe, it, expect } from 'vitest';
import { parseOp, SCHEMA_VERSION, type Op } from './ops.js';
import { applyOp } from './reduce.js';
import { deserializeLibraryState, serializeLibraryState } from './snapshot.js';
import { createLibraryState, materialize } from './state.js';

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

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TRACKLIST_ROWS,
	HOME_PINS_SETTING,
	isAccountSettingKey,
	MAX_HOME_PINS,
	opSchemaVersion,
	safeParseOp,
	SCHEMA_VERSION,
	TRACKLIST_ROWS_SETTING,
	ZHomePins,
	ZTracklistRows,
	type TracklistRows,
} from './index.js';

const setOp = (key: string, value: unknown, schema_version = 7) => ({
	op_id: '00000000-0000-4000-8000-000000000999',
	device_id: 'phone',
	client_ts: 1_700_000_000_000,
	schema_version,
	entity: 'setting',
	entity_id: key,
	kind: 'set',
	payload: { value },
});

const rows = (patch: (r: TracklistRows) => void): unknown => {
	const r = structuredClone(DEFAULT_TRACKLIST_ROWS);
	patch(r);
	return r;
};

describe('protocol v7: the phone views\' settings', () => {
	it('stamps both keys 7 and refuses them below (a v6 reader holds them aside)', () => {
		expect(SCHEMA_VERSION).toBe(7);
		for (const key of [TRACKLIST_ROWS_SETTING, HOME_PINS_SETTING]) {
			expect(isAccountSettingKey(key)).toBe(true);
			expect(opSchemaVersion({ entity: 'setting', kind: 'set', entity_id: key })).toBe(7);
		}
		expect(safeParseOp(setOp(TRACKLIST_ROWS_SETTING, DEFAULT_TRACKLIST_ROWS, 6))).toMatchObject({ ok: false, error: { reason: 'invalid_payload' } });
		expect(safeParseOp(setOp(TRACKLIST_ROWS_SETTING, DEFAULT_TRACKLIST_ROWS)).ok).toBe(true);
		expect(safeParseOp(setOp(HOME_PINS_SETTING, [{ kind: 'tag', id: 'interested' }])).ok).toBe(true);
	});

	it('refuses a setting op whose value does not fit its key', () => {
		expect(safeParseOp(setOp(TRACKLIST_ROWS_SETTING, { density: 4 }))).toMatchObject({ ok: false, error: { reason: 'invalid_payload' } });
		expect(safeParseOp(setOp(HOME_PINS_SETTING, [{ kind: 'folder', id: 'x' }]))).toMatchObject({ ok: false, error: { reason: 'invalid_payload' } });
		// Keys without a value schema still take any JSON value.
		expect(safeParseOp(setOp('credit_format', { anything: [1, 'two'] }, 1)).ok).toBe(true);
	});

	describe('tracklist.rows', () => {
		it('takes the defaults', () => {
			expect(ZTracklistRows.safeParse(DEFAULT_TRACKLIST_ROWS).success).toBe(true);
		});

		it('needs the title exactly once per level', () => {
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['2'].l[0] = []; })).success).toBe(false);
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['3'].r[2] = ['title']; })).success).toBe(false);
			// Anywhere in the level is enough.
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['1'] = { l: [['artist']], r: [['title']] }; })).success).toBe(true);
		});

		it('takes a field at most once per level, but again in another level', () => {
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['2'].r[1] = ['time', 'bpm']; })).success).toBe(false);
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['2'].l[0] = ['title', 'title']; })).success).toBe(false);
			// bpm in level 1 and level 2 at once is the default.
			expect(DEFAULT_TRACKLIST_ROWS.levels['1'].r[0]).toContain('bpm');
			expect(DEFAULT_TRACKLIST_ROWS.levels['2'].r[0]).toContain('bpm');
		});

		it('needs as many lines as the level, on both sides', () => {
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['2'].l.push([]); })).success).toBe(false);
			expect(ZTracklistRows.safeParse(rows((r) => { r.levels['3'].r.pop(); })).success).toBe(false);
			expect(ZTracklistRows.safeParse(rows((r) => { delete (r.levels as Record<string, unknown>)['3']; })).success).toBe(false);
		});

		it('refuses unknown fields, densities and keys', () => {
			expect(ZTracklistRows.safeParse(rows((r) => { (r.levels['1'].r[0] as string[]).push('mood'); })).success).toBe(false);
			expect(ZTracklistRows.safeParse(rows((r) => { (r as { density: number }).density = 0; })).success).toBe(false);
			expect(ZTracklistRows.safeParse({ ...DEFAULT_TRACKLIST_ROWS, extra: 1 }).success).toBe(false);
		});
	});

	describe('home.pins', () => {
		it('takes an ordered list of tags and playlists', () => {
			const pins = [{ kind: 'tag', id: 'interested' }, { kind: 'playlist', id: '7d1c…' }, { kind: 'tag', id: 'basket' }];
			expect(ZHomePins.safeParse(pins)).toMatchObject({ success: true, data: pins });
			expect(ZHomePins.safeParse([]).success).toBe(true);
		});

		it('pins a tag or playlist at most once, but a tag and a playlist may share an id', () => {
			expect(ZHomePins.safeParse([{ kind: 'tag', id: 'a' }, { kind: 'tag', id: 'a' }]).success).toBe(false);
			expect(ZHomePins.safeParse([{ kind: 'tag', id: 'a' }, { kind: 'playlist', id: 'a' }]).success).toBe(true);
		});

		it('is bounded and strict', () => {
			const many = Array.from({ length: MAX_HOME_PINS + 1 }, (_, i) => ({ kind: 'tag', id: `t${i}` }));
			expect(ZHomePins.safeParse(many).success).toBe(false);
			expect(ZHomePins.safeParse([{ kind: 'tag', id: '' }]).success).toBe(false);
			expect(ZHomePins.safeParse([{ kind: 'tag', id: 'a', at: 1 }]).success).toBe(false);
		});
	});
});

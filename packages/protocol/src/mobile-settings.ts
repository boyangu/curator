// Account settings the phone's views keep (protocol v7, ops.ts
// SETTING_KEY_SINCE). Both ride the ordinary `setting.set` op; their values
// are validated here so a malformed one is refused at push (invalid_payload)
// instead of reaching another device's lists.
//
// `tracklist.rows`: how every track list draws a row, for all three detail
// levels at once (a level keeps its layout while another is shown). Mobile
// only for now: the desktop's `trackRowLines` is per device and ignores it
// (decided 2026-11-23).
// `home.pins`: the tags and playlists pinned to Home, in their order.

import { z } from 'zod';

export const TRACKLIST_ROWS_SETTING = 'tracklist.rows';
export const HOME_PINS_SETTING = 'home.pins';

export const TRACK_ROW_FIELDS = [
	'title', 'version', 'artist', 'album', 'label', 'genre', 'released', 'added',
	'bpm', 'key', 'time', 'rating', 'power', 'brightness', 'tags', 'source', 'owned',
] as const;
export type TrackRowField = (typeof TRACK_ROW_FIELDS)[number];

export const ROW_DENSITIES = [1, 2, 3] as const;
export type RowDensity = (typeof ROW_DENSITIES)[number];

// One level: `l[i]` and `r[i]` are line i's left (flexible, truncates) and
// right (fixed, right-aligned) sections.
export type RowLevelConfig = { l: TrackRowField[][]; r: TrackRowField[][] };
export type TracklistRows = { density: RowDensity; levels: Record<'1' | '2' | '3', RowLevelConfig> };

const ZField = z.enum(TRACK_ROW_FIELDS);
const ZSection = z.array(ZField).max(TRACK_ROW_FIELDS.length);

function levelSchema(lines: number) {
	return z
		.object({ l: z.array(ZSection).length(lines), r: z.array(ZSection).length(lines) })
		.strict()
		.superRefine((cfg, ctx) => {
			const all = [...cfg.l.flat(), ...cfg.r.flat()];
			if (all.filter((f) => f === 'title').length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the title must appear exactly once' });
			if (new Set(all).size !== all.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a field may appear at most once per level' });
		});
}

export const ZTracklistRows: z.ZodType<TracklistRows> = z
	.object({
		density: z.union([z.literal(1), z.literal(2), z.literal(3)]),
		levels: z.object({ '1': levelSchema(1), '2': levelSchema(2), '3': levelSchema(3) }).strict(),
	})
	.strict();

// The handoff's defaults (mobile basic views §6).
export const DEFAULT_TRACKLIST_ROWS: TracklistRows = {
	density: 2,
	levels: {
		'1': { l: [['title', 'artist']], r: [['bpm', 'key']] },
		'2': { l: [['title'], ['artist', 'label']], r: [['bpm', 'key'], ['time']] },
		'3': { l: [['title', 'version'], ['artist', 'label'], ['tags']], r: [['bpm', 'key'], ['time'], ['power']] },
	},
};

export const HOME_PIN_KINDS = ['tag', 'playlist'] as const;
export type HomePin = { kind: (typeof HOME_PIN_KINDS)[number]; id: string };

// Bounded so the op stays far under MAX_OP_PAYLOAD_BYTES with uuid ids.
export const MAX_HOME_PINS = 64;

export const ZHomePins: z.ZodType<HomePin[]> = z
	.array(z.object({ kind: z.enum(HOME_PIN_KINDS), id: z.string().min(1).max(128) }).strict())
	.max(MAX_HOME_PINS)
	.refine((pins) => new Set(pins.map((p) => `${p.kind}:${p.id}`)).size === pins.length, { message: 'a tag or playlist is pinned at most once' });

// Per-key value schemas for account settings that have one; the others stay
// any JSON value.
export const ACCOUNT_SETTING_VALUES: ReadonlyMap<string, z.ZodTypeAny> = new Map<string, z.ZodTypeAny>([
	[TRACKLIST_ROWS_SETTING, ZTracklistRows],
	[HOME_PINS_SETTING, ZHomePins],
]);

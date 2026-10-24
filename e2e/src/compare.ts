// The cloud round trip check: two libraries' normalised dumps (core
// sync-log/dump.ts — the replica comparison the two-desktop suites use) per
// table. compareDumps gives the verdict; the keyed pairing below only turns
// its one-sided rows into "the same row, two values" for the report.
//
// Every dump table is Curator-owned synced state: dumpLibrary already
// leaves out what is device-local by design (derived WAV copies and their
// playlist, smart playlists, merge losers, non-account settings).

import { createHash } from 'node:crypto';
import { compareDumps, dumpLibrary, type LibraryDump } from '@curator/core/e2e';
import type Database from 'better-sqlite3';

export const DIFF_SAMPLE = 50;

export type DiffRow = { table: string; key: string; left: unknown; right: unknown };
export type TableDiff = { table: string; left: number; right: number; equal: boolean; onlyLeft: number; onlyRight: number; changed: number };
export type DumpDiff = { equal: boolean; tables: TableDiff[]; rows: DiffRow[] };

const KEYS: Record<string, (r: Record<string, unknown>) => string> = {
	tags: (r) => String(r['id']),
	trackTags: (r) => `${r['recordingId']}:${r['tagId']}`,
	playlists: (r) => String(r['id']),
	playlistFolders: (r) => String(r['id']),
	playlistTracks: (r) => String(r['id']),
	cues: (r) => `${r['recordingId']}:${r['kind']}:${r['slot']}`,
	pinnedSearches: (r) => String(r['id']),
	tracks: (r) => String(r['recordingId']),
	rbAnalysis: (r) => String(r['recordingId']),
	settings: (r) => String(r['k']),
	credits: (r) => String(r['recordingId']),
	trackArtists: (r) => `${r['recordingId']}:${r['position']}`,
	artistAliases: (r) => String(r['key']),
};

function rowsOf(d: LibraryDump, table: string): Array<Record<string, unknown>> {
	if (table === 'settings') return Object.entries(d.settings).map(([k, v]) => ({ k, v }));
	return ((d as Record<string, unknown>)[table] as Array<Record<string, unknown>> | null) ?? [];
}

// JSON with every object's keys sorted, recursively. The snapshot load
// re-serialises values with sorted keys (a joiner's rb_segments_json and
// object-valued account settings come back key-sorted), so byte equality of
// those JSON values is not state equality.
function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
	return v;
}

export function canonicalDump(d: LibraryDump): LibraryDump {
	const settings: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(d.settings)) settings[k] = sortKeys(v);
	return {
		...d,
		settings,
		rbAnalysis: d.rbAnalysis.map((r) => {
			if (r.segments === null) return r;
			try { return { ...r, segments: JSON.stringify(sortKeys(JSON.parse(r.segments))) }; } catch { return r; }
		}),
	};
}

// A row as the report shows it: only the fields that differ (plus nothing
// when one side is missing), long arrays and strings shortened to their
// length, a hash and their first values — a beat grid is thousands of numbers.
function brief(v: unknown): unknown {
	if (Array.isArray(v) && v.length > 24) return { length: v.length, sha1: createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12), head: v.slice(0, 12) };
	if (typeof v === 'string' && v.length > 400) return { length: v.length, sha1: createHash('sha1').update(v).digest('hex').slice(0, 12), head: v.slice(0, 200) };
	return v;
}

function changedFields(l: Record<string, unknown>, r: Record<string, unknown>): [Record<string, unknown>, Record<string, unknown>] {
	const a: Record<string, unknown> = {};
	const b: Record<string, unknown> = {};
	for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
		if (JSON.stringify(l[k]) === JSON.stringify(r[k])) continue;
		a[k] = brief(l[k]);
		b[k] = brief(r[k]);
	}
	return [a, b];
}

const briefRow = (r: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, brief(v)]));

// Up to `perTable` sample rows from each differing table, `sample` in all,
// so one table's thousands of rows cannot hide another's few.
export function diffDumps(leftRaw: LibraryDump, rightRaw: LibraryDump, sample = DIFF_SAMPLE, perTable = 10): DumpDiff {
	const left = canonicalDump(leftRaw);
	const right = canonicalDump(rightRaw);
	const reports = compareDumps(left, right, 0);
	const tables: TableDiff[] = [];
	const rows: DiffRow[] = [];
	for (const rep of reports) {
		const key = KEYS[rep.table] ?? ((r: Record<string, unknown>) => JSON.stringify(r));
		const l = new Map(rowsOf(left, rep.table).map((r) => [key(r), r]));
		const r = new Map(rowsOf(right, rep.table).map((x) => [key(x), x]));
		let onlyLeft = 0;
		let onlyRight = 0;
		let changed = 0;
		let taken = 0;
		const take = (row: DiffRow): void => {
			if (taken < perTable && rows.length < sample) { rows.push(row); taken++; }
		};
		if (!rep.equal) {
			for (const [k, lv] of l) {
				const rv = r.get(k);
				if (rv === undefined) { onlyLeft++; take({ table: rep.table, key: k, left: briefRow(lv), right: null }); continue; }
				if (JSON.stringify(lv) === JSON.stringify(rv)) continue;
				changed++;
				const [a, b] = changedFields(lv, rv);
				take({ table: rep.table, key: k, left: a, right: b });
			}
			for (const [k, rv] of r) {
				if (l.has(k)) continue;
				onlyRight++;
				take({ table: rep.table, key: k, left: null, right: briefRow(rv) });
			}
		}
		tables.push({ table: rep.table, left: rep.left, right: rep.right, equal: rep.equal, onlyLeft, onlyRight, changed });
	}
	return { equal: tables.every((t) => t.equal), tables, rows };
}

export function dumpOf(raw: Database.Database): LibraryDump {
	return dumpLibrary(raw);
}

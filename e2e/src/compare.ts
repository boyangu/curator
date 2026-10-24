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
import type { Classified, DiffClass } from './classify.js';

export const DIFF_SAMPLE = 50;

// `class` / `note`: classify.ts, when the check classifies its differences.
export type DiffRow = { table: string; key: string; left: unknown; right: unknown; class?: DiffClass; note?: string };
export type TableDiff = { table: string; left: number; right: number; equal: boolean; onlyLeft: number; onlyRight: number; changed: number; byClass?: Record<DiffClass, number> };
export type DumpDiff = { equal: boolean; tables: TableDiff[]; rows: DiffRow[]; failures: number };
export type DumpClassifier = (table: string, left: Record<string, unknown> | null, right: Record<string, unknown> | null) => Classified;

const CLASS_ORDER: Record<DiffClass, number> = { failure: 0, artefact: 1, expected: 2 };

// Failures first, so a thousand expected rows cannot push the one that
// matters out of the sample; the order within a class is kept.
export function takeSample(rows: readonly DiffRow[], n: number): DiffRow[] {
	return rows.map((r, i) => ({ r, i }))
		.sort((a, b) => CLASS_ORDER[a.r.class ?? 'failure'] - CLASS_ORDER[b.r.class ?? 'failure'] || a.i - b.i)
		.slice(0, n).map((x) => x.r);
}

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
// so one table's thousands of rows cannot hide another's few. With
// `classify`, every differing row is classed (classify.ts) and `failures`
// counts the failures; without, every difference is one.
export function diffDumps(leftRaw: LibraryDump, rightRaw: LibraryDump, sample = DIFF_SAMPLE, perTable = 10, classify?: DumpClassifier): DumpDiff {
	const left = canonicalDump(leftRaw);
	const right = canonicalDump(rightRaw);
	const reports = compareDumps(left, right, 0);
	const tables: TableDiff[] = [];
	const perTableRows: DiffRow[][] = [];
	let failures = 0;
	for (const rep of reports) {
		const key = KEYS[rep.table] ?? ((r: Record<string, unknown>) => JSON.stringify(r));
		const l = new Map(rowsOf(left, rep.table).map((r) => [key(r), r]));
		const r = new Map(rowsOf(right, rep.table).map((x) => [key(x), x]));
		let onlyLeft = 0;
		let onlyRight = 0;
		let changed = 0;
		const byClass: Record<DiffClass, number> = { expected: 0, artefact: 0, failure: 0 };
		const found: DiffRow[] = [];
		const take = (row: Omit<DiffRow, 'class' | 'note'>, lv: Record<string, unknown> | null, rv: Record<string, unknown> | null): void => {
			const c: Classified = classify ? classify(rep.table, lv, rv) : { class: 'failure', note: '' };
			byClass[c.class]++;
			found.push(classify ? { ...row, class: c.class, note: c.note } : row);
		};
		if (!rep.equal) {
			for (const [k, lv] of l) {
				const rv = r.get(k);
				if (rv === undefined) { onlyLeft++; take({ table: rep.table, key: k, left: briefRow(lv), right: null }, lv, null); continue; }
				if (JSON.stringify(lv) === JSON.stringify(rv)) continue;
				changed++;
				const [a, b] = changedFields(lv, rv);
				take({ table: rep.table, key: k, left: a, right: b }, lv, rv);
			}
			for (const [k, rv] of r) {
				if (l.has(k)) continue;
				onlyRight++;
				take({ table: rep.table, key: k, left: null, right: briefRow(rv) }, null, rv);
			}
		}
		// A table that differs only in what compareDumps sees (no keyed row
		// differs) is still a failure.
		if (!rep.equal && found.length === 0) byClass.failure++;
		failures += byClass.failure;
		perTableRows.push(takeSample(found, perTable));
		tables.push({ table: rep.table, left: rep.left, right: rep.right, equal: rep.equal, onlyLeft, onlyRight, changed, ...(classify ? { byClass } : {}) });
	}
	const rows = takeSample(perTableRows.flat(), sample);
	return { equal: tables.every((t) => t.equal), tables, rows, failures };
}

export function dumpOf(raw: Database.Database): LibraryDump {
	return dumpLibrary(raw);
}

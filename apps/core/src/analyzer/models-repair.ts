// One-time repair of the analyses a bundle without its scoring models left
// behind (2026-10-17 14:00–18:00 on the master: 341 tracks). That bundle's
// advanced stage returned no brightness and no power, persist kept the old
// raw-centroid brightness (248–1770 instead of −0.3…4.4) and stamped the row
// 2.4.0 — wrong on the master itself, and refused by the catalogue
// (advancedLegacy). persist.ts now clears such a brightness instead of
// keeping it; this re-runs the advanced stage for the rows already damaged,
// so they get real scores (which then ride set-analysis to every device).
//
// "One-time" with a condition, not a flag set up front: the analysis queue
// discards its backlog on close (queue.ts clearPending), so a launch that
// enqueued the repair and quit before it finished must enqueue the rest next
// time. The key is written once a launch finds nothing left to repair; every
// pass removes its rows from the set either way — real scores, or, with a
// bundle still missing its models, a brightness cleared by the guard.

import type Database from 'better-sqlite3';
import { compareVersions, parseVersionString } from '@curator/protocol';
import { MIN_FULL_REANALYSIS_VERSION } from './queue.js';

type Raw = Database.Database;

export const MODELS_REPAIR_KEY = 'analysis.repair.models_missing_at';

const FLOOR = parseVersionString(MIN_FULL_REANALYSIS_VERSION)!;

// Live tracks with a brightness and no power under a ≥ 2.3 stamp (the
// learned scores start at 2.3.0), whose file is here to analyse again.
export function modelsRepairCandidates(raw: Raw): string[] {
	const rows = raw.prepare(`SELECT ta.track_id AS id, ta.analyzer_version AS version FROM track_analysis ta JOIN track t ON t.id = ta.track_id
		WHERE ta.brightness IS NOT NULL AND ta.power IS NULL AND ta.analyzer_version != 'rekordbox' AND t.deleted_at IS NULL
			AND EXISTS (SELECT 1 FROM source_link s WHERE s.track_id = t.id AND s.source = 'local' AND s.missing_at IS NULL)`).all() as Array<{ id: string; version: string }>;
	return rows.filter((r) => {
		const v = parseVersionString(r.version);
		return v !== null && compareVersions(v, FLOOR) >= 0;
	}).map((r) => r.id);
}

export function modelsRepairDone(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(MODELS_REPAIR_KEY) !== undefined;
}

// `enqueue` re-analyses the given tracks with the advanced stage (the
// service's enqueueAnalysis with the Analyze modal's advanced flag). Returns
// how many it enqueued; marks the repair done when nothing is left.
export async function runModelsRepair(raw: Raw, enqueue: (trackIds: string[]) => Promise<void>): Promise<number> {
	if (modelsRepairDone(raw)) return 0;
	const ids = modelsRepairCandidates(raw);
	if (ids.length === 0) {
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`).run(MODELS_REPAIR_KEY, JSON.stringify(Date.now()), Date.now());
		return 0;
	}
	await enqueue(ids);
	return ids.length;
}

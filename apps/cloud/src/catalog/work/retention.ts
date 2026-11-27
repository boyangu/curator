// What device work stops keeping ('catalog_device_work'; Guy, 2026-11-27).
//
// Kept for good: every report and what each of its results put into the
// catalogue (catalog_work_report, catalog_work_item) — who said a page is a
// release's, by account, device and job.
//
// Dropped:
//   - a report's stored answer after a day: it is there for a resend, and a
//     device gives up on one within seconds;
//   - what was last learned of a release, a page or a track
//     (catalog_work_state) once it is older than every age it is read
//     against: the planner treats such a row and no row alike — due. Not a
//     listing's row (job 'find'): it carries the reader's cursor, and the
//     word that a probe did not agree.
//
// Run by the API once a day (server.ts), one instance at a time.

import type { Db } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import { loadWorkSettings } from './settings.js';

const ANSWER_KEEP_HOURS = 24;
// Past the longest age (the 90-day confirmation), with room to spare.
const STATE_KEEP_DAYS = 100;

export type PruneReport = { answers: number; state: number };

export async function pruneWork(db: Db): Promise<PruneReport> {
	return withSystemTx(db, async (tx) => {
		const [lock] = await tx.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtext('curator.catalog_work_prune')) as ok`);
		if (!lock?.ok) return { answers: 0, state: 0 };
		// Never younger than an age someone set longer than the default.
		const s = await loadWorkSettings(tx, '*');
		const days = Math.max(STATE_KEEP_DAYS, Math.ceil(s.checkDays) + 10, Math.ceil(s.retryDays) + 10);
		const [answers] = await tx.query<{ n: number }>(
			`with gone as (update curator.catalog_work_report set result = null where result is not null and at < now() - make_interval(hours => ${ANSWER_KEEP_HOURS}) returning 1)
			select count(*)::int as n from gone`,
		);
		// No index on answered_at: it would be rewritten with every answer, to
		// spare one walk of a narrow table a day.
		const [state] = await tx.query<{ n: number }>(
			`with gone as (delete from curator.catalog_work_state where job <> 'find' and answered_at < now() - make_interval(days => $1::int) returning 1)
			select count(*)::int as n from gone`,
			[String(days)],
		);
		return { answers: answers?.n ?? 0, state: state?.n ?? 0 };
	});
}

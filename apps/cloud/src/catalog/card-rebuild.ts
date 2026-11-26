// Event cards kept current: the queue of touched objects (sql/0037, written
// by the catalogue's own tables as they change) drained into refreshEvents.
//
// Run by the API on a timer (server.ts) and by the local catalogue
// (cli/local.ts), never by the upkeep worker alone: a device's finding or a
// tracker's report must reach the other devices whether or not anyone's
// machine is running a pass. Marking is the writers' whole cost; a release
// written ten times in a minute is rebuilt once here.
//
// One drainer at a time (a transaction-scoped advisory lock): two machines
// rebuilding the same event would both delete it and one would find it gone.

import type { Db } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { refreshEvents } from './events.js';

// Marks taken per transaction, and transactions per run: a label's back
// catalogue landing leaves tens of thousands of marks, nearly all for
// releases no event is about.
const BATCH = 5000;
const ROUNDS = 10;

export type CardRebuildReport = { taken: number; moved: number };

export async function rebuildCards(db: Db, opts: { batch?: number; rounds?: number } = {}): Promise<CardRebuildReport> {
	const batch = opts.batch ?? BATCH;
	const report: CardRebuildReport = { taken: 0, moved: 0 };
	for (let round = 0; round < (opts.rounds ?? ROUNDS); round++) {
		const taken = await withSystemTx(db, async (tx) => {
			const [lock] = await tx.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtext('curator.catalog_card_dirty')) as ok`);
			if (!lock?.ok) return -1;
			const marks = await tx.query<{ object_id: string; force: boolean; n: unknown }>(
				`with taken as (
					delete from curator.catalog_card_dirty where id in (select id from curator.catalog_card_dirty order by id limit $1::int)
					returning object_id, force)
				select object_id, bool_or(force) as force, count(*) as n from taken group by object_id`,
				[String(batch)],
			);
			if (!marks.length) return 0;
			const moved = await refreshEvents(tx, new Map(marks.map((m) => [m.object_id, m.force === true])));
			report.moved += moved.length;
			return marks.reduce((n, m) => n + num(m.n), 0);
		});
		if (taken <= 0) break;
		report.taken += taken;
		if (taken < batch) break;
	}
	return report;
}

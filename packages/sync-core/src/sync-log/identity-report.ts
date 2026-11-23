// What the streaming identity tier and the playlist dedupe would do to a
// library, without doing it (cloud plan: streaming identity §5, the
// measurement before main heals the 2026-10-20 incident). Reads only: the
// caller opens the database read-only (scripts/identity-report.ts) and every
// function used here is a planner — nothing is emitted, projected or
// written.

import type Database from 'better-sqlite3';
import { recordsComplete } from './apply.js';
import { planIdentityMerges } from './identity.js';
import { planStreamingDedupe } from './playlist-dedupe.js';

type Raw = Database.Database;

export type IdentityReport = {
	recordsComplete: boolean;
	deviceId: string | null;
	library: { liveTracks: number; deletedTracks: number; streamingPlaylists: number; streamingPlaylistRows: number };
	// Recordings by the device whose create the records hold (who minted).
	recordingsByDevice: Array<{ device: string; recordings: number }>;
	identity: {
		groups: number;
		streamingGroups: number;
		audioGroups: number;
		// The merges THIS device would emit, by tier, and by which device
		// minted the loser and the winner.
		merges: { total: number; streaming: number; audio: number; byDevice: Array<{ loserDevice: string; winnerDevice: string; merges: number }> };
		// Groups where this device holds the survivor's row (its rows stay put)
		// vs a loser's (its row re-points).
		holdsSurvivor: number;
		holdsLoser: number;
		held: { localDuplicate: number; sameDevice: number; oversized: number; sample: Array<{ reason: string; recordings: string[]; trackIds: string[]; blockers: string[] }> };
	};
	dedupe: {
		// Doubled streaming playlist rows as the records stand now, and as they
		// would after this device's planned merges.
		now: { groups: number; removes: number };
		afterMerges: { groups: number; removes: number; perPlaylist: Array<{ playlistId: string; name: string | null; excessRows: number }> };
	};
	// Live library_track records with no row on this device (another
	// device's recordings: what stage 2 materialises).
	recordsWithoutRows: number;
	remoteOnly: number | null;
	// Live recordings that share an ISRC claim, are not one identity group,
	// and whose rows here (when both have one) are within 2 s: listed for a
	// human, never merged by anything.
	isrcLookalikes: { pairs: number; sample: Array<{ isrc: string; recordings: string[]; titles: Array<string | null>; durations: Array<number | null> }> };
};

const DURATION_TOLERANCE_S = 2;

export function identityReport(raw: Raw): IdentityReport {
	const one = <T>(sql: string, ...p: unknown[]): T => raw.prepare(sql).pluck().get(...p) as T;
	const deviceRow = raw.prepare(`SELECT value FROM app_setting WHERE key = 'device.id'`).pluck().get() as string | undefined;
	const deviceId = deviceRow ? (JSON.parse(deviceRow) as string) : null;

	const createdBy = new Map<string, string>();
	for (const r of raw.prepare(`SELECT key, json_extract(value, '$.created.device') AS d FROM sync_state WHERE map = 'libraryTracks'`).all() as Array<{ key: string; d: string | null }>) {
		if (r.d) createdBy.set(r.key, r.d);
	}
	const perDevice = new Map<string, number>();
	for (const d of createdBy.values()) perDevice.set(d, (perDevice.get(d) ?? 0) + 1);

	const plan = planIdentityMerges(raw);
	const byDevice = new Map<string, number>();
	const losersHeld = new Set<string>();
	for (const m of plan.merges) {
		const k = `${createdBy.get(m.loser) ?? '?'}\u0000${createdBy.get(m.winner) ?? '?'}`;
		byDevice.set(k, (byDevice.get(k) ?? 0) + 1);
		if (m.trackId) losersHeld.add(m.winner);
	}
	const winners = new Set(plan.merges.map((m) => m.winner));

	const alias = new Map(plan.merges.map((m) => [m.loser, m.winner]));
	const now = planStreamingDedupe(raw);
	const after = planStreamingDedupe(raw, { alias });
	const nameOf = raw.prepare(`SELECT name FROM playlist WHERE id = ?`).pluck();

	// Live records with no catalogue row here.
	const recordsWithoutRows = one<number>(`SELECT count(*) FROM sync_state s WHERE s.map = 'libraryTracks'
		AND json_extract(s.value, '$.fields.deleted_at.value') IS NULL
		AND NOT EXISTS (SELECT 1 FROM recording_alias a WHERE a.loser = s.key)
		AND NOT EXISTS (SELECT 1 FROM track t WHERE t.recording_id = s.key)`);
	const hasRemoteOnly = (raw.prepare(`PRAGMA table_info(track)`).all() as Array<{ name: string }>).some((c) => c.name === 'remote_only');

	// ISRC lookalikes: recordings sharing an isrc claim, outside one group.
	const groupOf = new Map<string, string>();
	for (const m of plan.merges) { groupOf.set(m.loser, m.winner); groupOf.set(m.winner, m.winner); }
	const aliasTable = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
	const deleted = new Set(raw.prepare(`SELECT key FROM sync_state WHERE map = 'libraryTracks' AND json_extract(value, '$.fields.deleted_at.value') IS NOT NULL`).pluck().all() as string[]);
	const byIsrc = new Map<string, Set<string>>();
	for (const r of raw.prepare(`SELECT parent_id AS p, recording_id AS rec FROM sync_state WHERE map = 'claims' AND parent_id IN (
		SELECT parent_id FROM sync_state WHERE map = 'claims' AND parent_id >= 'isrc:' AND parent_id < 'isrc;' GROUP BY parent_id HAVING count(*) > 1)`).all() as Array<{ p: string; rec: string }>) {
		const rec = aliasTable.get(r.rec) ?? r.rec;
		if (deleted.has(rec)) continue;
		let set = byIsrc.get(r.p);
		if (!set) byIsrc.set(r.p, (set = new Set()));
		set.add(rec);
	}
	const rowOf = raw.prepare(`SELECT title, duration FROM track WHERE recording_id = ? AND derived_from_track_id IS NULL ORDER BY deleted_at IS NOT NULL, created_at, id LIMIT 1`);
	const lookalikes: IdentityReport['isrcLookalikes'] = { pairs: 0, sample: [] };
	for (const [p, set] of byIsrc) {
		// One recording per planned identity group: members of one group are
		// already becoming one recording.
		const byGroup = new Map<string, string>();
		for (const r of [...set].sort()) { const g = groupOf.get(r) ?? r; if (!byGroup.has(g)) byGroup.set(g, r); }
		const recs = [...byGroup.values()];
		if (recs.length < 2) continue;
		const rows = recs.map((r) => rowOf.get(r) as { title: string | null; duration: number | null } | undefined);
		const durations = rows.map((r) => r?.duration ?? null);
		const known = durations.filter((d): d is number => d !== null);
		if (known.length >= 2 && Math.max(...known) - Math.min(...known) > DURATION_TOLERANCE_S) continue;
		lookalikes.pairs++;
		if (lookalikes.sample.length < 25) lookalikes.sample.push({ isrc: p.slice('isrc:'.length), recordings: recs, titles: rows.map((r) => r?.title ?? null), durations });
	}

	return {
		recordsComplete: recordsComplete(raw),
		deviceId,
		library: {
			liveTracks: one(`SELECT count(*) FROM track WHERE deleted_at IS NULL AND derived_from_track_id IS NULL`),
			deletedTracks: one(`SELECT count(*) FROM track WHERE deleted_at IS NOT NULL`),
			streamingPlaylists: one(`SELECT count(*) FROM playlist WHERE source IN ('spotify', 'tidal')`),
			streamingPlaylistRows: one(`SELECT count(*) FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id WHERE p.source IN ('spotify', 'tidal')`),
		},
		recordingsByDevice: [...perDevice].map(([device, recordings]) => ({ device, recordings })).sort((a, b) => b.recordings - a.recordings),
		identity: {
			groups: plan.groups,
			streamingGroups: plan.streamingGroups,
			audioGroups: plan.groups - plan.streamingGroups,
			merges: {
				total: plan.merges.length,
				streaming: plan.merges.filter((m) => m.tier === 'streaming').length,
				audio: plan.merges.filter((m) => m.tier === 'audio').length,
				byDevice: [...byDevice].map(([k, merges]) => { const [loserDevice, winnerDevice] = k.split('\u0000') as [string, string]; return { loserDevice, winnerDevice, merges }; }).sort((a, b) => b.merges - a.merges),
			},
			holdsSurvivor: [...winners].filter((w) => !losersHeld.has(w)).length,
			holdsLoser: losersHeld.size,
			held: {
				localDuplicate: plan.held.filter((h) => h.reason === 'local-duplicate').length,
				sameDevice: plan.held.filter((h) => h.reason === 'same-device').length,
				oversized: plan.held.filter((h) => h.reason === 'oversized').length,
				sample: plan.held.slice(0, 20).map((h) => ({ reason: h.reason, recordings: h.recordings, trackIds: h.trackIds, blockers: h.blockers })),
			},
		},
		dedupe: {
			now: { groups: now.groups, removes: now.removes.length },
			afterMerges: {
				groups: after.groups,
				removes: after.removes.length,
				perPlaylist: [...after.byPlaylist].map(([playlistId, excessRows]) => ({ playlistId, name: (nameOf.get(playlistId) as string | undefined) ?? null, excessRows })).sort((a, b) => b.excessRows - a.excessRows),
			},
		},
		recordsWithoutRows,
		remoteOnly: hasRemoteOnly ? one(`SELECT count(*) FROM track WHERE remote_only = 1`) : null,
		isrcLookalikes: lookalikes,
	};
}

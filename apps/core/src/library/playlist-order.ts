// Order keys and derived positions for playlist_track (cloud design:
// "Ordered playlists"). Every writer of playlist_track goes through here so
// the two invariants hold everywhere:
//
//   1. A row's place is (order_key, id). Keys are fractional (base-62,
//      @curator/protocol), so an insert or a drag rewrites only the rows that
//      actually moved — the property the op log needs, since one drag must be
//      one `move` op and not a renumbering of the whole playlist.
//   2. `position` is 0..n-1 in that order. It is derived, but every reader
//      (the "#" column, the renderer's reorder wire format, the rekordbox
//      exporter, Spotify's positional moves) speaks it, so it is restamped
//      after each membership change rather than computed on read.
//
// The functions take the raw better-sqlite3 handle. Inside a Drizzle
// transaction they run on the same connection and so join it; on their own
// the writes that must be atomic open their own (a savepoint when nested).

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { keysBetween, needsRekey, rebalance } from '@curator/protocol';
import { unmovedIndices } from '@curator/library-logic';
import type { NewPlaylistTrack } from '@curator/shared/schema';

type Raw = Database.Database;

// A membership row before the order fields are assigned.
export type MemberDraft = Omit<NewPlaylistTrack, 'id' | 'orderKey' | 'position'>;

// `n` keys after the playlist's current last row.
export function appendKeys(raw: Raw, playlistId: string, n: number): string[] {
	const last = raw
		.prepare('SELECT order_key AS k FROM playlist_track WHERE playlist_id = ? ORDER BY order_key DESC, id DESC LIMIT 1')
		.get(playlistId) as { k: string } | undefined;
	return keysBetween(last?.k ?? null, null, n);
}

// Evenly spaced keys for a playlist written from scratch.
export function keysForReplace(n: number): string[] {
	return rebalance(n);
}

// Full rows for a playlist written from scratch, in `drafts` order.
export function replaceRows(drafts: MemberDraft[]): NewPlaylistTrack[] {
	const keys = keysForReplace(drafts.length);
	return drafts.map((d, i) => ({ ...d, id: randomUUID(), orderKey: keys[i]!, position: i }));
}

// Full rows appended after the playlist's current members. Positions start
// past the current maximum so the insert cannot collide with the unique
// (playlist_id, position) index even if an older writer left a gap; the
// caller runs recomputePositions afterwards to close it.
export function appendRows(raw: Raw, playlistId: string, drafts: MemberDraft[]): NewPlaylistTrack[] {
	if (drafts.length === 0) return [];
	const keys = appendKeys(raw, playlistId, drafts.length);
	const max = raw
		.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_track WHERE playlist_id = ?')
		.get(playlistId) as { m: number };
	return drafts.map((d, i) => ({ ...d, playlistId, id: randomUUID(), orderKey: keys[i]!, position: max.m + 1 + i }));
}

// Restamp positions to 0..n-1 in (order_key, id) order, touching only rows
// whose position changes. The unique (playlist_id, position) index is checked
// per row, so a changed row cannot be written straight to its target while
// another changed row still holds it: every changed row is first parked on a
// distinct negative position (which no row keeps — unchanged rows sit on
// their own non-negative target), then written to its target.
export function recomputePositions(raw: Raw, playlistId: string): number {
	const rows = raw
		.prepare('SELECT id, position FROM playlist_track WHERE playlist_id = ? ORDER BY order_key, id')
		.all(playlistId) as Array<{ id: string; position: number }>;
	const changed: Array<{ id: string; target: number }> = [];
	rows.forEach((r, i) => { if (r.position !== i) changed.push({ id: r.id, target: i }); });
	if (changed.length === 0) return 0;
	const setPos = raw.prepare('UPDATE playlist_track SET position = ? WHERE id = ?');
	raw.transaction(() => {
		if (changed.length > 32) {
			// Bulk park in a few statements: `-1 - position` is distinct per
			// row (positions are unique) and lands outside 0..n-1. A reverse
			// sort restamps every row, and one UPDATE per park was half its cost.
			for (let i = 0; i < changed.length; i += 400) {
				const chunk = changed.slice(i, i + 400);
				raw.prepare(`UPDATE playlist_track SET position = -1 - position WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk.map((c) => c.id));
			}
		} else {
			changed.forEach((c, i) => setPos.run(-1 - i, c.id));
		}
		for (const c of changed) setPos.run(c.target, c.id);
	})();
	return changed.length;
}

// New keys for a reorder. `current` is the playlist in its current order;
// `perm[k]` is the index in `current` of the row that should end up at k.
// Rows on one longest increasing subsequence of `perm` keep their keys (the
// same minimal move set the Spotify push uses); each run of moved rows gets
// fresh keys between its new neighbours. Returns only the rows whose key
// changes, so a single drag yields one entry.
//
// Falls back to rekeying the whole playlist evenly when the minimal plan is
// impossible or degenerate: neighbouring kept rows that share a key (two
// devices inserted into one gap) leave no room between them, keys past the
// design's length threshold are due a rekey anyway, and a `current` whose
// order disagrees with its keys (a writer that bypassed this module) cannot
// be patched locally.
export function planReorderKeys(current: Array<{ id: string; orderKey: string }>, perm: number[]): Map<string, string> {
	const next = perm.map((i) => current[i]!);
	const keys = minimalKeys(next, perm);
	const out = new Map<string, string>();
	const final = keys ?? rebalance(next.length);
	next.forEach((r, k) => { if (final[k] !== r.orderKey) out.set(r.id, final[k]!); });
	return out;
}

function minimalKeys(next: Array<{ id: string; orderKey: string }>, perm: number[]): string[] | null {
	const n = next.length;
	const keep = unmovedIndices(perm);
	const keys = new Array<string>(n);
	try {
		let k = 0;
		while (k < n) {
			if (keep.has(k)) {
				keys[k] = next[k]!.orderKey;
				k++;
				continue;
			}
			let j = k;
			while (j < n && !keep.has(j)) j++;
			const lo = k > 0 ? keys[k - 1]! : null;
			const hi = j < n ? next[j]!.orderKey : null;
			if (lo !== null && hi !== null && lo >= hi) return null;
			const fresh = keysBetween(lo, hi, j - k);
			for (let m = 0; m < fresh.length; m++) keys[k + m] = fresh[m]!;
			k = j;
		}
	} catch {
		return null; // a malformed stored key — rekey rather than fail the drag
	}
	for (let k = 1; k < n; k++) {
		const a = keys[k - 1]!, b = keys[k]!;
		if (a > b || (a === b && next[k - 1]!.id >= next[k]!.id)) return null;
	}
	return needsRekey(keys) ? null : keys;
}

// The recording identity resolver (cloud plan E: "the same audio file scanned
// on two desktops stays two recordings"). Each desktop's scanner mints its
// own recording for a file and claims it by the file's audio hash; both
// claims reach every device through the op log, and this is what turns them
// into one recording: a `recording.merge` op, through the same reducer fold
// and projection as any other merge, so tags, ratings, cues, playlist rows,
// plays and overrides from both copies end up on one recording everywhere.
//
// THE RULE — computed from the synced records only, so every device that
// looks at the same claims reaches the same answer on its own:
//
//   Evidence. Exact audio identity only: two LIVE recordings that carry the
//   same `audio_hash` claim (the same decoded PCM for FLAC/WAV/AIFF, the same
//   encoded frames for MP3/M4A; ingest/audio-hash.ts) are one recording.
//   Groups are connected components over those claims, so a recording that
//   carries two hashes (its file's audio changed under the same path) joins
//   both groups into one rather than being merged two ways.
//
//   Not evidence, on purpose (AUTO_MERGE_CLAIM_KINDS is the seam for later
//   tiers): an ISRC names a recording as a label registered it, not a file.
//   Remasters, radio and extended edits, clean/explicit versions and
//   regional releases routinely share one ISRC, and the same audio is
//   re-issued under several (a compilation, a label move), so ISRC equality
//   both merges different audio and misses the same audio. A Chromaprint
//   match is a similarity, so it needs a threshold and a duration check, and
//   title/duration agreement is a guess. Each of those wants its own tier
//   with a confirmation path; none of them may merge silently.
//
//   Survivor. The code-unit-smallest recording id of the group. Adding a
//   member can only lower a minimum and merging only removes non-minimum
//   members, so two devices that see the group at different moments never
//   merge one pair in opposite directions; a chain (Z→Y seen before X
//   arrived, then Y→X) flattens through the alias map. Several devices
//   emitting the same merge is idempotent: the reducer keeps the later merge
//   record per loser, with the same winner, and the second fold finds the
//   loser empty.
//
//   Live. Not deleted and not already merged away, by the records. A deleted
//   recording never joins a group: merging it into a live one would carry
//   its deleted_at into the survivor (a fold takes the later write per
//   field) and delete the live copy, and merging a live one into it would
//   hide the live copy the same way. Undeleting it brings it back into play
//   (its claim is still on record). This mirrors the scanner's
//   deletedOwnerOf, which binds a NEW file with a deleted recording's audio
//   to that deleted row instead of minting a live one: here, a copy that
//   was already live on another desktop before the delete stays live.
//   A recording that was live when merged and deleted concurrently on
//   another device ends deleted, the same as had the delete come after.
//
//   Who emits. Only a device that holds a live row for exactly one member
//   of the group, and that member is not the survivor: its row is the one
//   that moves (re-pointed to the survivor, project.ts), so it is the device
//   whose library changes. A device holding the survivor, or none, waits for
//   the holder; the holder's merge reaches it like any other op.
//
//   Held, not merged. A device holding live rows for two or more members
//   has byte-identical copies of one file as separate rows: the scanner
//   keeps those apart on purpose (a track holds one rekordbox content, and
//   the user resolves the pair from Settings → Library's duplicate groups),
//   and a merge of two rows that both have a rekordbox entry is refused by
//   merge-tracks anyway. This device emits nothing for such a group and
//   reports it (`held`, with what merge-tracks says about the pair).
//   Another desktop's single copy still joins when it is the one that moves
//   (onto the smallest member, which may be one of the held rows); when it
//   is the survivor, it waits until the user has resolved the duplicates
//   here. Another device can fold the held rows themselves in one narrow
//   sequence only: its copy already joined one of them, and this device's
//   second copy arrived later under a smaller id; then that device holds
//   the larger one alone and moves it. The merge reaches this device like
//   a merge made in the dialog elsewhere, and merge-tracks' blockers still
//   decide the local rows (both rekordbox entries: they stay apart, logged
//   by project.ts). Groups larger than
//   MAX_AUTO_MERGE_GROUP are held too: one audio hash on that many
//   recordings is more likely a bad hash (a silent intro, an encoder that
//   writes a fixed signature) than one song, and an automatic merge there
//   is not reversible from the UI.
//
// Runs where claims arrive and where they are made, off the hot path: the
// sync client calls it after the initial push and its backfills, before
// each push (claims this device's scanner just made: the outbox append
// wakes the cycle) and after each pull (claims from other devices), and
// only when the op log moved since the last run. The plan is a range read
// of the claim index (store.ts claimParentId); the merges apply in chunks
// with yields, each chunk one transaction of merge ops plus projection.

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { EntityRef } from '@curator/protocol';
import * as schema from '@curator/shared/schema';
import { applyTrackMerge, planTrackMerge } from '../library/merge-tracks.js';
import { recordsComplete } from './apply.js';
import { emitOps } from './outbox.js';
import { project } from './project.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

// Claim kinds whose equality alone merges recordings. See the header for
// why ISRC, fingerprints and tags are not here.
export const AUTO_MERGE_CLAIM_KINDS = ['audio_hash'] as const;
export type AutoMergeClaimKind = (typeof AUTO_MERGE_CLAIM_KINDS)[number];

export const MAX_AUTO_MERGE_GROUP = 8;

export type IdentityClaim = { kind: AutoMergeClaimKind; value: string };

export type IdentityMerge = {
	loser: string;
	winner: string;
	// This device's row for the loser (the row that moves).
	trackId: string;
	claims: IdentityClaim[];
};

export type IdentityHold = {
	reason: 'local-duplicate' | 'oversized';
	claims: IdentityClaim[];
	recordings: string[];
	// This device's live rows among them.
	trackIds: string[];
	// What merge-tracks says about the first two rows (local duplicates).
	blockers: string[];
};

export type IdentityPlan = {
	// Groups of two or more live recordings sharing exact audio.
	groups: number;
	merges: IdentityMerge[];
	held: IdentityHold[];
};

export type IdentityResult = IdentityPlan & {
	// Merges written (a planned merge whose rows changed before its chunk
	// ran is dropped, not forced).
	merged: number;
	tracksTouched: string[];
	playlistsTouched: string[];
	chunks: number;
	maxSliceMs: number;
	ms: number;
};

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── plan ────────────────────────────────────────────────────────────────────

type Reader = {
	alias: Map<string, string>;
	resolve(id: string): string;
	live(recordingId: string): boolean;
	rows(recordingId: string): string[];
};

function reader(raw: Raw): Reader {
	const alias = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
	const record = raw.prepare(`SELECT value FROM sync_state WHERE map = 'libraryTracks' AND key = ?`).pluck();
	const rowsOf = raw.prepare(`SELECT id FROM track WHERE recording_id = ? AND deleted_at IS NULL AND derived_from_track_id IS NULL ORDER BY created_at, id`).pluck();
	return {
		alias,
		resolve: (id) => alias.get(id) ?? id,
		live(recordingId) {
			if (alias.has(recordingId)) return false;
			const json = record.get(recordingId) as string | undefined;
			if (!json) return true; // claimed, never deleted
			const cell = (JSON.parse(json) as { fields?: Record<string, { value: unknown }> }).fields?.['deleted_at'];
			return cell === undefined || cell.value === null;
		},
		rows: (recordingId) => rowsOf.all(recordingId) as string[],
	};
}

export function planIdentityMerges(raw: Raw): IdentityPlan {
	const plan: IdentityPlan = { groups: 0, merges: [], held: [] };
	// Before the initial push the records do not hold this library's own
	// claims yet: a group would look smaller than it is.
	if (!recordsComplete(raw)) return plan;
	const r = reader(raw);

	// Recordings per claim value held by two or more, in one indexed read.
	// parent_id is `${kind}:${value}`; ';' is the code unit after ':'.
	const byValue = new Map<string, { claim: IdentityClaim; members: Set<string> }>();
	for (const kind of AUTO_MERGE_CLAIM_KINDS) {
		const rows = raw.prepare(`SELECT parent_id AS p, recording_id AS rec FROM sync_state
			WHERE map = 'claims' AND parent_id IN (
				SELECT parent_id FROM sync_state WHERE map = 'claims' AND parent_id >= ? AND parent_id < ? GROUP BY parent_id HAVING count(*) > 1
			)`).all(`${kind}:`, `${kind};`) as Array<{ p: string; rec: string | null }>;
		for (const row of rows) {
			if (!row.rec) continue;
			let e = byValue.get(row.p);
			if (!e) byValue.set(row.p, (e = { claim: { kind, value: row.p.slice(kind.length + 1) }, members: new Set() }));
			e.members.add(r.resolve(row.rec));
		}
	}
	// Liveness and this device's rows, batched over every member at once
	// (a second desktop's first scan can form thousands of groups).
	const candidates = [...new Set([...byValue.values()].flatMap((e) => [...e.members]))];
	const deleted = new Set<string>();
	const rowsOf = new Map<string, string[]>();
	for (let i = 0; i < candidates.length; i += 400) {
		const chunk = candidates.slice(i, i + 400);
		const marks = chunk.map(() => '?').join(',');
		for (const k of raw.prepare(`SELECT key FROM sync_state WHERE map = 'libraryTracks' AND key IN (${marks})
			AND json_extract(value, '$.fields.deleted_at.value') IS NOT NULL`).pluck().all(...chunk) as string[]) deleted.add(k);
		for (const t of raw.prepare(`SELECT recording_id AS rec, id FROM track WHERE recording_id IN (${marks})
			AND deleted_at IS NULL AND derived_from_track_id IS NULL ORDER BY created_at, id`).all(...chunk) as Array<{ rec: string; id: string }>) {
			let list = rowsOf.get(t.rec);
			if (!list) rowsOf.set(t.rec, (list = []));
			list.push(t.id);
		}
	}
	const edges: Array<{ claim: IdentityClaim; members: string[] }> = [];
	for (const e of byValue.values()) {
		const members = [...e.members].filter((m) => !r.alias.has(m) && !deleted.has(m));
		if (members.length > 1) edges.push({ claim: e.claim, members });
	}

	// Connected components (union-find), so a recording in two groups is
	// decided once, against one survivor.
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		let cur = x;
		while (cur !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
		return root;
	};
	for (const e of edges) {
		for (const m of e.members) if (!parent.has(m)) parent.set(m, m);
		for (const m of e.members.slice(1)) {
			const a = find(e.members[0]!);
			const b = find(m);
			if (a !== b) parent.set(byCodeUnit(a, b) <= 0 ? b : a, byCodeUnit(a, b) <= 0 ? a : b);
		}
	}
	const components = new Map<string, { members: Set<string>; claims: IdentityClaim[] }>();
	for (const e of edges) {
		const root = find(e.members[0]!);
		let c = components.get(root);
		if (!c) components.set(root, (c = { members: new Set(), claims: [] }));
		for (const m of e.members) c.members.add(m);
		c.claims.push(e.claim);
	}

	const db = drizzle(raw, { schema });
	for (const c of components.values()) {
		plan.groups++;
		const members = [...c.members].sort(byCodeUnit);
		const winner = members[0]!;
		const rows = new Map<string, string[]>();
		for (const m of members) { const ids = rowsOf.get(m); if (ids) rows.set(m, ids); }
		const trackIds = [...rows.values()].flat();
		if (members.length > MAX_AUTO_MERGE_GROUP) {
			plan.held.push({ reason: 'oversized', claims: c.claims, recordings: members, trackIds, blockers: [] });
			continue;
		}
		if (rows.size >= 2) {
			const [a, b] = [...rows.values()];
			plan.held.push({ reason: 'local-duplicate', claims: c.claims, recordings: members, trackIds, blockers: planTrackMerge(db, a![0]!, b![0]!).blockers });
			continue;
		}
		const [held] = [...rows.entries()];
		if (!held || held[0] === winner) continue;
		plan.merges.push({ loser: held[0], winner, trackId: held[1][0]!, claims: c.claims });
	}
	return plan;
}

// ── apply ───────────────────────────────────────────────────────────────────

// One transaction: the merge ops (outbox + records, emitOps folds them like
// any local op) and the projection a pulled merge would get, so this
// device's row moves exactly as it would had another device emitted the
// merge. No re-assert of the survivor's fields (unlike the merge dialog,
// mutators.ts mergeRecordingRaw): there is no "kept side" here, and several
// devices may emit the same merge from different views — a re-assert from a
// device that had not yet pulled a newer rating would overwrite it. The
// reducer's fold (later write per field and cue slot, sets unioned) is the
// whole rule.
function applyChunk(raw: Raw, merges: readonly IdentityMerge[]): { merged: number; tracksTouched: string[]; playlistsTouched: string[] } {
	return raw.transaction(() => {
		// Re-checked against the tables as they are now: a chunk runs after
		// earlier ones yielded, and the user may have deleted or merged a row
		// in between. What no longer holds is dropped; the next run re-plans.
		const r = reader(raw);
		const valid = merges.filter((m) => r.resolve(m.loser) === m.loser && r.resolve(m.winner) === m.winner
			&& r.live(m.loser) && r.live(m.winner) && r.rows(m.loser).length > 0 && r.rows(m.winner).length === 0);
		if (valid.length === 0) return { merged: 0, tracksTouched: [], playlistsTouched: [] };
		emitOps(raw, valid.map((m) => ({ entity: 'recording' as const, entity_id: m.loser, kind: 'merge' as const, payload: { winner: m.winner } })));
		const changed: EntityRef[] = valid.flatMap((m) => [{ entity: 'recording' as const, id: m.loser }, { entity: 'recording' as const, id: m.winner }]);
		const db = drizzle(raw, { schema });
		const summary = project(raw, new SyncStateStore(raw), changed, { removed: [], removedTombstones: [], aliasChanged: true }, {
			// Never reached by construction (the survivor has no row here),
			// kept so a row that appears in between still merges, not drops.
			mergeRows: (loser, winner) => { applyTrackMerge(db, raw, winner, loser, { emit: false }); },
		});
		return { merged: valid.length, tracksTouched: summary.tracksTouched, playlistsTouched: summary.playlistsTouched };
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The chunked driver: the plan in one slice (reads only), then `chunk`
// merges per transaction with a yield between. A second desktop that
// scanned the same 5,000 files as the first plans 5,000 merges at once:
// measured 2026-10-20 on a generated library at ~180 ms for that plan and
// ~0.5-1 ms per merge including the commit, so 50 per slice keeps each one
// to tens of ms. With nothing to merge the plan is one empty index range.
export async function resolveRecordingIdentitiesAsync(raw: Raw, opts: { chunk?: number; signal?: { aborted: boolean } } = {}): Promise<IdentityResult> {
	const started = Date.now();
	const chunk = Math.max(1, Math.min(1_000, opts.chunk ?? 50));
	let t0 = performance.now();
	const plan = planIdentityMerges(raw);
	const out: IdentityResult = { ...plan, merged: 0, tracksTouched: [], playlistsTouched: [], chunks: 0, maxSliceMs: performance.now() - t0, ms: 0 };
	const tracks = new Set<string>();
	const playlists = new Set<string>();
	for (let i = 0; i < plan.merges.length; i += chunk) {
		if (opts.signal?.aborted) break;
		await yieldToLoop();
		t0 = performance.now();
		const r = applyChunk(raw, plan.merges.slice(i, i + chunk));
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.chunks++;
		out.merged += r.merged;
		for (const t of r.tracksTouched) tracks.add(t);
		for (const p of r.playlistsTouched) playlists.add(p);
	}
	out.tracksTouched = [...tracks];
	out.playlistsTouched = [...playlists];
	out.ms = Date.now() - started;
	return out;
}

// Synchronous form (tests, scripts).
export function resolveRecordingIdentities(raw: Raw): IdentityResult {
	const started = Date.now();
	const plan = planIdentityMerges(raw);
	const r = plan.merges.length > 0 ? applyChunk(raw, plan.merges) : { merged: 0, tracksTouched: [], playlistsTouched: [] };
	return { ...plan, ...r, chunks: plan.merges.length > 0 ? 1 : 0, maxSliceMs: Date.now() - started, ms: Date.now() - started };
}

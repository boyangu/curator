// The recording identity resolver (cloud plan E: "the same audio file scanned
// on two desktops stays two recordings"). Each desktop's scanner mints its
// own recording for a file and claims it by the file's audio hash; both
// claims reach every device through the op log, and this is what turns them
// into one recording: a `recording.merge` op, through the same reducer fold
// and projection as any other merge, so tags, ratings, cues, playlist rows,
// plays and overrides from both copies end up on one recording everywhere.
//
// THE RULE — computed from the synced records only, so every device that
// looks at the same claims reaches the same answer on its own. Two tiers.
//
// Audio tier (`audio_hash`).
//
//   Evidence. Exact audio identity only: two LIVE recordings that carry the
//   same `audio_hash` claim (the same decoded PCM for FLAC/WAV/AIFF, the same
//   encoded frames for MP3/M4A; ingest/audio-hash.ts) are one recording.
//   Groups are connected components over those claims, so a recording that
//   carries two hashes (its file's audio changed under the same path) joins
//   both groups into one rather than being merged two ways.
//
//   Live. Not deleted and not already merged away, by the records. A deleted
//   recording never joins an audio group: merging it into a live one would
//   carry its deleted_at into the survivor (a fold takes the later write per
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
// Streaming tier (`spotify`, `tidal`; cloud plan: streaming identity §4).
//
//   Evidence. Recordings that claim one provider track id are one recording
//   — the provider says so — but only when at least one of the claims is an
//   anchor: confidence 1, a recording minted from (or found by) that very id.
//   A 0.9 (bound through an ISRC) or 0.7 (title/artist/duration) claim is a
//   device's judgement that its row is that track; it joins an anchor, the
//   same judgement claim-bind.ts makes when it binds an import to the
//   anchored recording, but two judgements alone never merge. Beatport ids
//   are not evidence at all: they come from fuzzy enrichment searches.
//   Before 2026-10-20 every streaming claim was stated at 1.0, which is what
//   lets this tier heal the second-desktop incident's ~3.5k duplicates.
//
//   Deleted members join (the fold's LWW decides): a provider track the
//   user deleted on one device and another device imported again is the
//   same track, deleted — the claim-bind rule for a new import of it.
//
//   Who emits. Any device with its own row for exactly one member (live or
//   deleted), survivor or not: the merges are deterministic and idempotent,
//   so the desktop that holds the original rows heals the duplicates
//   another one minted without that one being online. Each run re-asserts
//   the survivor's create with the earliest added_at of the group (the fold
//   would keep the later import's).
//
//   Held when one device minted two members (`same-device`, decided from
//   the records' creates, so every device holds it alike). A device does
//   not mint a second recording for an id it already holds, so two of its
//   own in one group means a bridge: before 2026-10-20 every streaming
//   claim was stated at 1.0, including a content bind (title/artist/
//   duration) that attached several provider tracks — different versions
//   of a song — to one row, and that row would chain the other device's
//   distinct recordings into one. Measured on the incident's libraries: a
//   handful of groups out of ~3.3k. They wait for the user (merging or
//   splitting the rows there), like a device's own duplicates.
//
// Both tiers:
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
//   Held, not merged. A device holding rows for two or more members has
//   two copies as separate rows: the scanner keeps byte-identical files
//   apart on purpose (a track holds one rekordbox content, and the user
//   resolves the pair from Settings → Library's duplicate groups), and a
//   merge of two rows that both have a rekordbox entry is refused by
//   merge-tracks anyway. This device emits nothing for such a group and
//   reports it (`held`, with what merge-tracks says about the pair).
//   Another desktop's single copy still joins when it is the one that moves
//   (onto the smallest member, which may be one of the held rows); when it
//   is the survivor, it waits until the user has resolved the duplicates
//   here. Groups larger than MAX_AUTO_MERGE_GROUP are held too: one audio
//   hash on that many recordings is more likely a bad hash (a silent intro,
//   an encoder that writes a fixed signature) than one song, and an
//   automatic merge there is not reversible from the UI.
//
//   Doubled playlist rows. Two devices' imports of one streaming playlist
//   leave a row per device for each merged track; each merge chunk folds
//   them in its own transaction (playlist-dedupe.ts), so a merge never
//   shows the doubles even for a moment.
//
// Not evidence, on purpose: an ISRC names a recording as a label registered
// it, not a file. Remasters, radio and extended edits, clean/explicit
// versions and regional releases routinely share one ISRC, and the same
// audio is re-issued under several, so ISRC equality both merges different
// audio and misses the same audio. A Chromaprint match is a similarity, so
// it needs a threshold and a duration check, and title/duration agreement
// is a guess. Each of those wants its own tier with a confirmation path;
// none of them may merge silently.
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
import { refsOfRecordings } from './claim-bind.js';
import { emitOps, type EmitOp } from './outbox.js';
import { emitStreamingDedupe } from './playlist-dedupe.js';
import { project } from './project.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

// Claim kinds whose equality merges recordings (with the streaming tier's
// anchor rule). See the header for why ISRC, fingerprints, beatport and
// tags are not here.
export const AUTO_MERGE_CLAIM_KINDS = ['audio_hash', 'spotify', 'tidal'] as const;
export type AutoMergeClaimKind = (typeof AUTO_MERGE_CLAIM_KINDS)[number];
const STREAMING_KINDS: ReadonlySet<string> = new Set(['spotify', 'tidal']);

// A streaming claim at this confidence names the recording the provider id
// itself minted or found (sync/spotify.ts, sync/tidal.ts).
export const ANCHOR_CONFIDENCE = 1;

export const MAX_AUTO_MERGE_GROUP = 8;

export type IdentityClaim = { kind: AutoMergeClaimKind; value: string };

export type IdentityMerge = {
	loser: string;
	winner: string;
	tier: 'audio' | 'streaming';
	// This device's row for the loser (the row that moves), or null when
	// this device holds the survivor's row or none of the loser (streaming).
	trackId: string | null;
	claims: IdentityClaim[];
};

export type IdentityHold = {
	reason: 'local-duplicate' | 'oversized' | 'same-device';
	claims: IdentityClaim[];
	recordings: string[];
	// This device's rows among them.
	trackIds: string[];
	// What merge-tracks says about the first two rows (local duplicates).
	blockers: string[];
};

export type IdentityPlan = {
	// Groups of two or more recordings sharing exact evidence.
	groups: number;
	// Of which with streaming evidence.
	streamingGroups: number;
	merges: IdentityMerge[];
	held: IdentityHold[];
};

export type IdentityResult = IdentityPlan & {
	// Merges written (a planned merge whose rows changed before its chunk
	// ran is dropped, not forced).
	merged: number;
	// Doubled streaming playlist rows removed in the merge chunks.
	dedupeRemoved: number;
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
	// Live catalogue rows (the audio tier's).
	rows(recordingId: string): string[];
	// Every catalogue row, deleted ones too (the streaming tier's).
	ownRows(recordingId: string): string[];
	addedAt(recordingId: string): number | null;
};

function reader(raw: Raw): Reader {
	const alias = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
	const record = raw.prepare(`SELECT value FROM sync_state WHERE map = 'libraryTracks' AND key = ?`).pluck();
	// Own rows only: a remote row (remote-rows.ts) is a projection of the
	// records, not a copy this device holds — counted, a fresh device that
	// materialised both members of a group would hold every group as its
	// own duplicate, or emit merges for rows it has no source of.
	const rowsOf = raw.prepare(`SELECT id FROM track WHERE recording_id = ? AND deleted_at IS NULL AND derived_from_track_id IS NULL AND remote_only = 0 ORDER BY created_at, id`).pluck();
	const ownOf = raw.prepare(`SELECT id FROM track WHERE recording_id = ? AND derived_from_track_id IS NULL AND remote_only = 0 ORDER BY deleted_at IS NOT NULL, created_at, id`).pluck();
	const fields = (recordingId: string): Record<string, { value: unknown }> | undefined => {
		const json = record.get(recordingId) as string | undefined;
		return json ? (JSON.parse(json) as { fields?: Record<string, { value: unknown }> }).fields : undefined;
	};
	return {
		alias,
		resolve: (id) => alias.get(id) ?? id,
		live(recordingId) {
			if (alias.has(recordingId)) return false;
			const cell = fields(recordingId)?.['deleted_at'];
			return cell === undefined || cell.value === null;
		},
		rows: (recordingId) => rowsOf.all(recordingId) as string[],
		ownRows: (recordingId) => ownOf.all(recordingId) as string[],
		addedAt(recordingId) {
			const v = fields(recordingId)?.['added_at']?.value;
			return typeof v === 'number' ? v : null;
		},
	};
}

// The plan as steps: each `yield` is a point where the async driver may
// hand the event loop back (planIdentityMergesAsync); the synchronous form
// runs them back to back (planIdentityMerges: tests, identity-report.ts).
// The plan reads only, and every merge it produces is re-checked in its
// chunk's transaction (applyChunk), so a write landing between two steps
// (the user's merge dialog, the scanner's claims) at worst drops a merge
// for the next run to re-plan; it never forces a stale one.
//
// Measured 2026-10-20 on the generated 40k-track library
// (sync-slices-perf.test.ts: 3,500 streaming groups, 7,000 members): the
// plan as one slice took ~540 ms, 409 ms of it the row lookup below
// planned onto track_derived_from_idx (`derived_from_track_id IS NULL`
// matches nearly every row, so each 400-id batch scanned the table — on the
// live 600 MB library, cold, that is most of the 1,394 ms slice). With the
// lookup on track_recording_idx the plan is 90-190 ms in all (the spread is
// CPU load from other processes), and the steps keep each slice to
// PLAN_SLICE_MS plus one step (a 400-id batch: a few ms) as the group count
// grows: longest slice 25-60 ms over 4-13 slices.
const PLAN_BATCH = 400;
const PLAN_SLICE_MS = 25;

function* planSteps(raw: Raw): Generator<void, IdentityPlan, void> {
	const plan: IdentityPlan = { groups: 0, streamingGroups: 0, merges: [], held: [] };
	// Before the initial push the records do not hold this library's own
	// claims yet: a group would look smaller than it is.
	if (!recordsComplete(raw)) return plan;
	const r = reader(raw);

	// Recordings per claim value held by two or more. parent_id is
	// `${kind}:${value}`; ';' is the code unit after ':'. The values come
	// from one index-only GROUP BY per kind (8 ms over 31,500 Spotify claims
	// on the generated library); their records, whose JSON is the costly
	// part, are read in batches. The confidence only matters for the
	// streaming anchor.
	const byValue = new Map<string, { claim: IdentityClaim; members: Set<string>; anchored: boolean }>();
	for (const kind of AUTO_MERGE_CLAIM_KINDS) {
		const values = raw.prepare(`SELECT parent_id FROM sync_state WHERE map = 'claims' AND parent_id >= ? AND parent_id < ? GROUP BY parent_id HAVING count(*) > 1`)
			.pluck().all(`${kind}:`, `${kind};`) as string[];
		yield;
		for (let i = 0; i < values.length; i += PLAN_BATCH) {
			const chunk = values.slice(i, i + PLAN_BATCH);
			const rows = raw.prepare(`SELECT parent_id AS p, recording_id AS rec, json_extract(value, '$.cell.value.confidence') AS conf FROM sync_state
				WHERE map = 'claims' AND parent_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ p: string; rec: string | null; conf: number | null }>;
			for (const row of rows) {
				if (!row.rec) continue;
				let e = byValue.get(row.p);
				if (!e) byValue.set(row.p, (e = { claim: { kind, value: row.p.slice(kind.length + 1) }, members: new Set(), anchored: false }));
				e.members.add(r.resolve(row.rec));
				if ((row.conf ?? 0) >= ANCHOR_CONFIDENCE) e.anchored = true;
			}
			yield;
		}
	}
	// Liveness and this device's rows, batched over every member at once
	// (a second desktop's first scan can form thousands of groups).
	const candidates = [...new Set([...byValue.values()].flatMap((e) => [...e.members]))];
	const deleted = new Set<string>();
	const mintedBy = new Map<string, string>();
	const liveRows = new Map<string, string[]>();
	const anyRows = new Map<string, string[]>();
	for (let i = 0; i < candidates.length; i += PLAN_BATCH) {
		const chunk = candidates.slice(i, i + PLAN_BATCH);
		const marks = chunk.map(() => '?').join(',');
		for (const t of raw.prepare(`SELECT key, json_extract(value, '$.fields.deleted_at.value') AS d, json_extract(value, '$.created.device') AS dev
			FROM sync_state WHERE map = 'libraryTracks' AND key IN (${marks})`).all(...chunk) as Array<{ key: string; d: number | null; dev: string | null }>) {
			if (t.d !== null) deleted.add(t.key);
			if (t.dev) mintedBy.set(t.key, t.dev);
		}
		// `+derived_from_track_id`: keeps the planner off
		// track_derived_from_idx (see PLAN_BATCH above); the IN list is
		// what narrows, through track_recording_idx.
		for (const t of raw.prepare(`SELECT recording_id AS rec, id, deleted_at FROM track WHERE recording_id IN (${marks})
			AND +derived_from_track_id IS NULL AND remote_only = 0 ORDER BY deleted_at IS NOT NULL, created_at, id`).all(...chunk) as Array<{ rec: string; id: string; deleted_at: number | null }>) {
			const into = (m: Map<string, string[]>): void => {
				let list = m.get(t.rec);
				if (!list) m.set(t.rec, (list = []));
				list.push(t.id);
			};
			into(anyRows);
			if (t.deleted_at === null) into(liveRows);
		}
		yield;
	}
	const edges: Array<{ claim: IdentityClaim; members: string[]; streaming: boolean }> = [];
	for (const e of byValue.values()) {
		const streaming = STREAMING_KINDS.has(e.claim.kind);
		if (streaming && !e.anchored) continue;
		const members = [...e.members].filter((m) => !r.alias.has(m) && (streaming || !deleted.has(m)));
		if (members.length > 1) edges.push({ claim: e.claim, members, streaming });
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
	const components = new Map<string, { members: Set<string>; claims: IdentityClaim[]; streaming: boolean }>();
	for (const e of edges) {
		const root = find(e.members[0]!);
		let c = components.get(root);
		if (!c) components.set(root, (c = { members: new Set(), claims: [], streaming: false }));
		for (const m of e.members) c.members.add(m);
		c.claims.push(e.claim);
		if (e.streaming) c.streaming = true;
	}

	yield;

	const db = drizzle(raw, { schema });
	for (const c of components.values()) {
		// A step per group: a held local duplicate reads merge-tracks'
		// blockers for its pair.
		yield;
		plan.groups++;
		if (c.streaming) plan.streamingGroups++;
		const members = [...c.members].sort(byCodeUnit);
		const winner = members[0]!;
		// The streaming tier counts every own row (a deleted member is a
		// member); the audio tier only live ones (deleted never join it).
		const rowsOf = c.streaming ? anyRows : liveRows;
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
		// After the local-duplicate check: a device's own pair reports its
		// merge-tracks blockers.
		if (c.streaming) {
			const minters = members.map((m) => mintedBy.get(m)).filter((d): d is string => !!d);
			if (new Set(minters).size < minters.length) {
				plan.held.push({ reason: 'same-device', claims: c.claims, recordings: members, trackIds, blockers: [] });
				continue;
			}
		}
		const [held] = [...rows.entries()];
		if (!held) continue;
		if (c.streaming) {
			// Every member onto the survivor, from whichever one this device
			// holds: the merges are the same on every device that emits them.
			for (const m of members.slice(1)) {
				plan.merges.push({ loser: m, winner, tier: 'streaming', trackId: held[0] === m ? held[1][0]! : null, claims: c.claims });
			}
			continue;
		}
		if (held[0] === winner) continue;
		plan.merges.push({ loser: held[0], winner, tier: 'audio', trackId: held[1][0]!, claims: c.claims });
	}
	return plan;
}

export function planIdentityMerges(raw: Raw): IdentityPlan {
	const steps = planSteps(raw);
	for (;;) {
		const s = steps.next();
		if (s.done) return s.value;
	}
}

// The same plan, handing the event loop back whenever a slice has run
// PLAN_SLICE_MS (checked at each step).
export async function planIdentityMergesAsync(raw: Raw, opts: { sliceMs?: number } = {}): Promise<{ plan: IdentityPlan; maxSliceMs: number; slices: number }> {
	const budget = opts.sliceMs ?? PLAN_SLICE_MS;
	const steps = planSteps(raw);
	let maxSliceMs = 0;
	let slices = 1;
	let t0 = performance.now();
	for (;;) {
		const s = steps.next();
		const now = performance.now();
		if (s.done) return { plan: s.value, maxSliceMs: Math.max(maxSliceMs, now - t0), slices };
		if (now - t0 < budget) continue;
		maxSliceMs = Math.max(maxSliceMs, now - t0);
		await yieldToLoop();
		slices++;
		t0 = performance.now();
	}
}

// ── apply ───────────────────────────────────────────────────────────────────

// One transaction: the merge ops (outbox + records, emitOps folds them like
// any local op), the survivor's re-asserted create (streaming tier), the
// doubled streaming playlist rows the merges brought together
// (playlist-dedupe.ts), and the projection a pulled merge would get, so this
// device's row moves exactly as it would had another device emitted the
// merge. No re-assert of the survivor's other fields (unlike the merge
// dialog, mutators.ts mergeRecordingRaw): there is no "kept side" here, and
// several devices may emit the same merge from different views — a
// re-assert from a device that had not yet pulled a newer rating would
// overwrite it. The reducer's fold (later write per field and cue slot,
// sets unioned) is the whole rule. added_at is the exception: the earliest
// of the group is a fact every emitter agrees on, and the fold alone would
// keep the duplicate's later import time.
function applyChunk(raw: Raw, merges: readonly IdentityMerge[]): { merged: number; dedupeRemoved: number; tracksTouched: string[]; playlistsTouched: string[] } {
	return raw.transaction(() => {
		// Re-checked against the tables as they are now: a chunk runs after
		// earlier ones yielded, and the user may have deleted or merged a row
		// in between. What no longer holds is dropped; the next run re-plans.
		const r = reader(raw);
		const valid = merges.filter((m) => {
			if (r.resolve(m.loser) !== m.loser || r.resolve(m.winner) !== m.winner) return false;
			if (m.tier === 'audio') return r.live(m.loser) && r.live(m.winner) && r.rows(m.loser).length > 0 && r.rows(m.winner).length === 0;
			// Streaming: this device must still hold rows for at most one side.
			return !(r.ownRows(m.loser).length > 0 && r.ownRows(m.winner).length > 0);
		});
		if (valid.length === 0) return { merged: 0, dedupeRemoved: 0, tracksTouched: [], playlistsTouched: [] };
		// The group's earliest added_at, read before the fold moves it.
		const earliest = new Map<string, number>();
		for (const m of valid) {
			if (m.tier !== 'streaming') continue;
			for (const rec of [m.loser, m.winner]) {
				const at = r.addedAt(rec);
				if (at !== null && at < (earliest.get(m.winner) ?? Infinity)) earliest.set(m.winner, at);
			}
		}
		emitOps(raw, valid.map((m) => ({ entity: 'recording' as const, entity_id: m.loser, kind: 'merge' as const, payload: { winner: m.winner } })));
		const reassert: EmitOp[] = [...earliest].map(([winner, at]) => ({ entity: 'library_track' as const, entity_id: winner, kind: 'create' as const, payload: { added_at: at } }));
		if (reassert.length > 0) emitOps(raw, reassert);
		const winners = [...new Set(valid.map((m) => m.winner))];
		const dedupe = emitStreamingDedupe(raw, { recordings: winners });

		const changed: EntityRef[] = valid.flatMap((m) => [{ entity: 'recording' as const, id: m.loser }, { entity: 'recording' as const, id: m.winner }]);
		// A survivor this device already shows takes on the loser's records
		// (another device's playlist rows, tags, cues): project.ts re-points
		// a loser's row and shows the survivor's records, but a loser with no
		// row here is skipped there.
		const shown = winners.filter((w) => r.ownRows(w).length > 0);
		changed.push(...refsOfRecordings(raw, shown), ...dedupe.refs);
		const db = drizzle(raw, { schema });
		const summary = project(raw, new SyncStateStore(raw), changed, { removed: [], removedTombstones: [], aliasChanged: true }, {
			// Never reached by construction (the plan holds groups where this
			// device has rows on both sides), kept so a row that appears in
			// between still merges, not drops.
			mergeRows: (loser, winner) => { applyTrackMerge(db, raw, winner, loser, { emit: false }); },
		});
		return { merged: valid.length, dedupeRemoved: dedupe.removed.length, tracksTouched: summary.tracksTouched, playlistsTouched: [...new Set([...summary.playlistsTouched, ...dedupe.playlists])] };
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The chunked driver: the plan in slices (reads only, planSteps), then
// `chunk` merges per transaction with a yield between. A second desktop
// that scanned the same 5,000 files as the first plans 5,000 merges at
// once. On a 5,000-track library a merge measured ~0.5-1 ms with its
// commit (2026-10-20). On the generated 40k library with the incident's
// shape (sync-slices-perf.test.ts: 3,500 streaming merges, the profile's
// rows as remote rows in a 5,000-row playlist) a chunk costs ~17 ms fixed
// (the commit, SyncStateStore loading every merge record — thousands
// after a heal — per emit and projection) plus ~1-2 ms per merge (the
// remote row's drop and the survivor's projection), measured 2026-10-20:
// 50 per chunk ran median 71 ms, worst 138 ms (under heavy CPU load from
// unrelated processes: median 118, worst 210-430); 20 per chunk median
// 44 ms, p90 79 ms, worst 113 ms, for ~1.7× the total time; 10 per chunk
// gained nothing on the worst slice (fixed cost, load spikes).
// With nothing to merge the plan is one empty index range per kind.
const MERGE_CHUNK = 20;

export async function resolveRecordingIdentitiesAsync(raw: Raw, opts: { chunk?: number; signal?: { aborted: boolean } } = {}): Promise<IdentityResult> {
	const started = Date.now();
	const chunk = Math.max(1, Math.min(1_000, opts.chunk ?? MERGE_CHUNK));
	const planned = await planIdentityMergesAsync(raw);
	const plan = planned.plan;
	const out: IdentityResult = { ...plan, merged: 0, dedupeRemoved: 0, tracksTouched: [], playlistsTouched: [], chunks: 0, maxSliceMs: planned.maxSliceMs, ms: 0 };
	const tracks = new Set<string>();
	const playlists = new Set<string>();
	for (let i = 0; i < plan.merges.length; i += chunk) {
		if (opts.signal?.aborted) break;
		await yieldToLoop();
		const t0 = performance.now();
		const r = applyChunk(raw, plan.merges.slice(i, i + chunk));
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.chunks++;
		out.merged += r.merged;
		out.dedupeRemoved += r.dedupeRemoved;
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
	const r = plan.merges.length > 0 ? applyChunk(raw, plan.merges) : { merged: 0, dedupeRemoved: 0, tracksTouched: [], playlistsTouched: [] };
	return { ...plan, ...r, chunks: plan.merges.length > 0 ? 1 : 0, maxSliceMs: Date.now() - started, ms: Date.now() - started };
}

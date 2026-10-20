// Bind an ingest to the recording that already claims its exact identity
// (cloud plan: streaming identity §1). The claim index (store.ts
// claimParentId: parent_id = `${kind}:${value}`) holds every device's
// provider-id and audio-hash claims; before this, nothing read it at ingest,
// so a second desktop importing the same Spotify playlist minted a new
// recording per track (the 2026-10-20 incident: ~3.5k duplicates) and left
// the identity resolver to merge them afterwards, if it could.
//
// The claimant choice, when several recordings claim one value:
//   1. a recording this device holds a live row for (smallest recording id):
//      the import attaches to the row the user already sees;
//   2. else the smallest live recording id — the one the identity resolver
//      (identity.ts) keeps when it merges the claimants, so binding to it
//      now is binding to where they all end;
//   3. else the most recently deleted one (by its delete's value): a track
//      the user deleted stays deleted when it shows up again, the same rule
//      as the scanner's deletedOwnerOf. `liveOnly` binders (the scanner,
//      which has deletedOwnerOf for this) skip this step.
// Liveness is the records' (identity.ts reader): not merged away, no
// deleted_at in its library_track record.
//
// Reads only. The caller attaches the import to `trackId` when it is set,
// or inserts a row with recording_id = `recordingId` — WITHOUT a
// library_track create (the recording exists; another device created it) —
// and then projects the recording's records onto the new row with
// projectAdoptedRecordings, once per batch.

import type Database from 'better-sqlite3';
import type { EntityRef } from '@curator/protocol';
import { project, type ProjectSummary } from './project.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

export type BindKind = 'spotify' | 'tidal' | 'audio_hash';

export type ClaimBinding = {
	recordingId: string;
	// This device's row for it (live first), or null: none here yet.
	trackId: string | null;
	// The recording is deleted by the records (step 3).
	deleted: boolean;
};

const CHUNK = 400;

export class ClaimBinder {
	private readonly claimants = new Map<string, string[]>();
	// recording id → deleted_at value (null = live), for claimants seen.
	private readonly deletedAt = new Map<string, number | null>();
	private readonly alias: Map<string, string>;
	private readonly ownRows: Database.Statement;

	constructor(private readonly raw: Raw, private readonly opts: { liveOnly?: boolean } = {}) {
		this.alias = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
		// Read per bind, not cached: rows appear during the batch the binder
		// serves (an import inserting the row for a claimed recording).
		this.ownRows = raw.prepare(`SELECT id, deleted_at FROM track WHERE recording_id = ? AND derived_from_track_id IS NULL ORDER BY deleted_at IS NOT NULL, created_at, id`);
	}

	private resolve(id: string): string {
		return this.alias.get(id) ?? id;
	}

	// Batched load of the claimants of these values and their liveness:
	// 400 values per query, so a 2,000-track import costs a handful of
	// indexed reads instead of one per track.
	prefetch(kind: BindKind, values: readonly string[]): void {
		const parents = [...new Set(values.filter((v) => v).map((v) => `${kind}:${v}`))].filter((p) => !this.claimants.has(p));
		const recordings = new Set<string>();
		for (let i = 0; i < parents.length; i += CHUNK) {
			const chunk = parents.slice(i, i + CHUNK);
			for (const p of chunk) this.claimants.set(p, []);
			const rows = this.raw.prepare(`SELECT parent_id AS p, recording_id AS rec FROM sync_state
				WHERE map = 'claims' AND parent_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ p: string; rec: string | null }>;
			for (const r of rows) {
				if (!r.rec) continue;
				const rec = this.resolve(r.rec);
				const list = this.claimants.get(r.p)!;
				if (!list.includes(rec)) list.push(rec);
				recordings.add(rec);
			}
		}
		this.loadLiveness([...recordings]);
	}

	private loadLiveness(recordings: readonly string[]): void {
		const want = recordings.filter((r) => !this.deletedAt.has(r));
		for (let i = 0; i < want.length; i += CHUNK) {
			const chunk = want.slice(i, i + CHUNK);
			for (const r of chunk) this.deletedAt.set(r, null);
			const rows = this.raw.prepare(`SELECT key, json_extract(value, '$.fields.deleted_at.value') AS d FROM sync_state
				WHERE map = 'libraryTracks' AND key IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ key: string; d: number | null }>;
			for (const r of rows) this.deletedAt.set(r.key, r.d ?? null);
		}
	}

	bind(kind: BindKind, value: string): ClaimBinding | null {
		if (!value) return null;
		const parent = `${kind}:${value}`;
		if (!this.claimants.has(parent)) this.prefetch(kind, [value]);
		const claimants = this.claimants.get(parent) ?? [];
		if (claimants.length === 0) return null;
		const rowsOf = (rec: string): Array<{ id: string; deleted_at: number | null }> => this.ownRows.all(rec) as Array<{ id: string; deleted_at: number | null }>;
		const sorted = [...claimants].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const live = sorted.filter((r) => this.deletedAt.get(r) == null);

		// 1. A recording this device already shows.
		for (const rec of live) {
			const rows = rowsOf(rec);
			const shown = rows.find((r) => r.deleted_at === null);
			if (shown) return { recordingId: rec, trackId: shown.id, deleted: false };
		}
		// 2. The resolver's survivor among the live claimants.
		if (live.length > 0) {
			const rec = live[0]!;
			return { recordingId: rec, trackId: rowsOf(rec)[0]?.id ?? null, deleted: false };
		}
		if (this.opts.liveOnly) return null;
		// 3. The latest delete.
		const deleted = sorted
			.map((rec) => ({ rec, at: this.deletedAt.get(rec) ?? 0 }))
			.sort((a, b) => b.at - a.at || (a.rec < b.rec ? -1 : a.rec > b.rec ? 1 : 0));
		const rec = deleted[0]!.rec;
		return { recordingId: rec, trackId: rowsOf(rec)[0]?.id ?? null, deleted: true };
	}
}

// One-off form.
export function bindByClaim(raw: Raw, kind: BindKind, value: string, opts: { liveOnly?: boolean } = {}): ClaimBinding | null {
	return new ClaimBinder(raw, opts).bind(kind, value);
}

// Refs to every projectable record and tombstone of these recordings, read
// through the recording_id indexes in batches (store.recordingRefs walks
// every loaded record per call, which a 2,000-track import cannot afford).
// Claims are not projected and are left out.
const REF_ENTITY: Record<string, EntityRef['entity'] | undefined> = {
	libraryTracks: 'library_track',
	trackTags: 'track_tag',
	cues: 'cue',
	playlistTracks: 'playlist_track',
	playEvents: 'play_event',
};

export function refsOfRecordings(raw: Raw, recordingIds: Iterable<string>): EntityRef[] {
	const ids = [...new Set(recordingIds)];
	const refs: EntityRef[] = [];
	const seen = new Set<string>();
	const push = (entity: EntityRef['entity'], id: string): void => {
		const k = `${entity}:${id}`;
		if (seen.has(k)) return;
		seen.add(k);
		refs.push({ entity, id });
	};
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const marks = chunk.map(() => '?').join(',');
		for (const r of raw.prepare(`SELECT map, key FROM sync_state WHERE recording_id IN (${marks})`).all(...chunk) as Array<{ map: string; key: string }>) {
			const entity = REF_ENTITY[r.map];
			if (entity) push(entity, r.key);
		}
		// A removal with no live record left still has to reach the row.
		for (const t of raw.prepare(`SELECT entity, entity_id FROM tombstone WHERE recording_id IN (${marks})`).all(...chunk) as Array<{ entity: string; entity_id: string }>) {
			if (t.entity === 'track_tag' || t.entity === 'cue') push(t.entity, t.entity_id);
		}
	}
	return refs;
}

// Show what the records hold for recordings that just got their first row
// here (a bound import): rating, state, overrides and the delete, tags,
// cues, plays and every playlist row of them — none of which had a row to
// land on before (project.ts keeps a recording's records without one). One
// projection for the whole batch; runs inside the caller's transaction,
// before a read-sync reconciles membership, so the rows another device
// already added count as present instead of being added a second time.
export function projectAdoptedRecordings(raw: Raw, recordingIds: Iterable<string>): ProjectSummary {
	const refs = refsOfRecordings(raw, recordingIds);
	if (refs.length === 0) return { tracksTouched: [], playlistsTouched: [], skipped: [] };
	return project(raw, new SyncStateStore(raw), refs, { removed: [], removedTombstones: [], aliasChanged: false });
}

// Three-way merge engine for bidirectional DJ-app sync. Pure functions —
// no DB, no provider knowledge: callers supply `base` (the external app's
// state as of the last sync, from rekordbox_link.fields_seen / cues_seen),
// `theirs` (the app's current state, from the pull delta), and `ours`
// (Curator's current effective values).
//
// Per-field decision (value equality, no wall clocks):
//
//   theirs vs base | ours vs base | outcome
//   ---------------+--------------+---------------------------------------
//   equal          | equal        | no-op
//   changed        | equal        | PULL theirs into Curator
//   equal          | changed      | no-op (the push phase writes ours)
//   changed        | changed      | equal values → converged, no-op
//                  |              | different    → CONFLICT (user decides)
//
// `seenAdvance` returns the new baseline per field: theirs' value for
// every key EXCEPT conflicted ones — a conflict's baseline must stay put
// so re-running the merge before resolution re-detects it rather than
// silently adopting one side.
//
// A key missing from a partial `base` means "no baseline for this field
// yet". The caller decides the bootstrap bias (legacy whole-row LMW); the
// engine just reports those fields separately instead of guessing.

import {
	cueUnitKey,
	SYNC_FIELD_KEYS,
	type CueUnit,
	type FieldsSeen,
	type SyncFieldKey,
} from '@curator/shared/sync';

// ──────────────────────────────────────────────────────────────────────────────
// Normalization — mirrors writer.py's _set_if_changed diff rules so the
// merge engine and the rb write path can never disagree about "changed":
// null ≡ '' for text fields, null ≡ 0 for rating. Without this, a track
// whose comment went NULL→'' on the rb side would look like a change and
// ping-pong forever.

function norm(field: SyncFieldKey, value: unknown): string | number | null {
	if (field === 'rating') {
		const n = typeof value === 'number' ? value : value == null ? 0 : Number(value);
		return Number.isFinite(n) ? n : 0;
	}
	if (value == null || value === '') return null;
	return value as string | number;
}

function fieldEq(field: SyncFieldKey, a: unknown, b: unknown): boolean {
	return norm(field, a) === norm(field, b);
}

// ──────────────────────────────────────────────────────────────────────────────
// Track metadata merge.

export interface FieldConflict {
	field: SyncFieldKey;
	base: string | number | null;
	theirs: string | number | null;
	ours: string | number | null;
}

export interface FieldMergeResult {
	// theirs→Curator writes to apply now (only fields where theirs changed
	// and ours didn't).
	pull: FieldsSeen;
	conflicts: FieldConflict[];
	// New baseline entries (merge into the stored snapshot). Excludes
	// conflicted fields.
	seenAdvance: FieldsSeen;
	// Fields present in theirs but absent from base — no baseline exists,
	// the caller must apply its bootstrap policy and then seed these.
	unseeded: SyncFieldKey[];
}

export function mergeTrackFields(
	base: FieldsSeen | null,
	theirs: FieldsSeen,
	ours: FieldsSeen
): FieldMergeResult {
	const pull: FieldsSeen = {};
	const conflicts: FieldConflict[] = [];
	const seenAdvance: FieldsSeen = {};
	const unseeded: SyncFieldKey[] = [];

	for (const field of SYNC_FIELD_KEYS) {
		if (!(field in theirs)) continue; // provider sent no opinion — leave everything alone
		const theirsVal = norm(field, theirs[field]);
		if (base == null || !(field in base)) {
			unseeded.push(field);
			continue;
		}
		const baseVal = norm(field, base[field]);
		const oursVal = norm(field, ours[field]);
		const theirsChanged = theirsVal !== baseVal;
		const oursChanged = oursVal !== baseVal;

		if (!theirsChanged) {
			// ours-changed or not, theirs is stable — baseline can restate it.
			seenAdvance[field] = theirsVal;
			continue;
		}
		if (!oursChanged) {
			pull[field] = theirsVal;
			seenAdvance[field] = theirsVal;
			continue;
		}
		if (theirsVal === oursVal) {
			// Both edited to the same value — converged.
			seenAdvance[field] = theirsVal;
			continue;
		}
		conflicts.push({ field, base: baseVal, theirs: theirsVal, ours: oursVal });
	}

	return { pull, conflicts, seenAdvance, unseeded };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cue merge — per cue unit. A unit's value is (positionSec, lengthSec,
// color, name); presence/absence encodes add/delete, so each identity key
// resolves to CueUnit | null on each of base/theirs/ours and the same
// three-way table applies with "null" as just another value.

function cueValueEq(a: CueUnit | null, b: CueUnit | null): boolean {
	if (a == null || b == null) return a == null && b == null;
	return (
		Math.round(a.positionSec * 1000) === Math.round(b.positionSec * 1000) &&
		// length null ≡ 0 — both mean "point cue, not a loop".
		Math.round((a.lengthSec ?? 0) * 1000) === Math.round((b.lengthSec ?? 0) * 1000) &&
		(a.color ?? null) === (b.color ?? null) &&
		(a.name ?? '') === (b.name ?? '') &&
		a.kind === b.kind &&
		// Memory cues are identified by position, so two units sharing a key
		// always share positionSec; slot is the renderer-facing ordinal and
		// participates for hot cues only (where it IS the identity anyway).
		(a.kind !== 'hot' || a.slot === b.slot)
	);
}

export interface CueConflict {
	key: string; // cueUnitKey
	base: CueUnit | null;
	theirs: CueUnit | null;
	ours: CueUnit | null;
}

export interface CueMergeResult {
	// theirs→Curator cue writes to apply now.
	apply: Array<{ op: 'upsert' | 'delete'; unit: CueUnit }>;
	conflicts: CueConflict[];
	// Full new baseline set (replaces the stored snapshot). For conflicted
	// keys the OLD base unit is carried forward (or omitted when base had
	// none) so re-merging before resolution re-detects the conflict.
	seenAdvance: CueUnit[];
}

// Callers must handle the no-snapshot bootstrap (cuesSeen == null) BEFORE
// calling — passing an empty base here would read as "the app had zero
// cues at last sync" and turn every pre-existing cue into an add/conflict.
export function mergeCues(base: CueUnit[], theirs: CueUnit[], ours: CueUnit[]): CueMergeResult {
	const baseMap = new Map(base.map((u) => [cueUnitKey(u), u]));
	const theirsMap = new Map(theirs.map((u) => [cueUnitKey(u), u]));
	const oursMap = new Map(ours.map((u) => [cueUnitKey(u), u]));

	const keys = new Set<string>([...baseMap.keys(), ...theirsMap.keys(), ...oursMap.keys()]);
	const apply: CueMergeResult['apply'] = [];
	const conflicts: CueConflict[] = [];
	const seenAdvance: CueUnit[] = [];

	for (const key of keys) {
		const b = baseMap.get(key) ?? null;
		const t = theirsMap.get(key) ?? null;
		const o = oursMap.get(key) ?? null;
		const theirsChanged = !cueValueEq(t, b);
		const oursChanged = !cueValueEq(o, b);

		if (!theirsChanged) {
			if (t) seenAdvance.push(t);
			continue;
		}
		if (!oursChanged) {
			if (t) {
				apply.push({ op: 'upsert', unit: t });
				seenAdvance.push(t);
			} else if (o) {
				// Deleted on their side, untouched on ours — delete ours.
				apply.push({ op: 'delete', unit: o });
			}
			continue;
		}
		if (cueValueEq(t, o)) {
			if (t) seenAdvance.push(t);
			continue;
		}
		conflicts.push({ key, base: b, theirs: t, ours: o });
		if (b) seenAdvance.push(b); // baseline stays put for conflicted keys
	}

	return { apply, conflicts, seenAdvance };
}

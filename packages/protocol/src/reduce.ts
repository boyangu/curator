// The pure reducer: one op in, the state's records updated by that entity's
// merge rule (design: the entity × kinds × merge-rule table; "Tombstones,
// merges and undelete"). Server materialisation and client apply both run it,
// which is what makes them agree.
//
// Two properties hold for every rule here, and the tests check them in every
// op order: re-applying an op changes nothing (every write is a max over
// clocks), and the raw records never depend on arrival order (each is a
// function of the ops' own fields, never of `seq`). That includes a recording
// merge's fold, which is why `fold` resolves per field by clock, see there.
//
// The reducer mutates `state` in place and returns it; it is "pure" in that
// it touches nothing else. Clone first (`cloneLibraryState`) if the old state
// must survive.

import {
	parseCueEntityId,
	parseTrackTagEntityId,
	type Entity,
	type NewOp,
	type Op,
	type OpOf,
} from './ops.js';
import {
	clockOf,
	compareClock,
	laterClock,
	resolveRecording,
	tombstoneKey,
	type ArtistAliasRule,
	type ArtistAliasTarget,
	type Cell,
	type Clock,
	type EntityRef,
	type LibraryState,
	type LwwRecord,
	type PlaylistTrackRecord,
} from './state.js';

export type ApplyResult = { state: LibraryState; changed: EntityRef[] };

// ── primitives ──────────────────────────────────────────────────────────────

function recordOf(map: Map<string, LwwRecord>, id: string): LwwRecord {
	let rec = map.get(id);
	if (!rec) {
		rec = { id, created: null, fields: {} };
		map.set(id, rec);
	}
	return rec;
}

// Per-field LWW: the write lands only if its clock is later than the cell's.
function writeCell(fields: Record<string, Cell>, name: string, value: unknown, clock: Clock): boolean {
	const cur = fields[name];
	if (cur && compareClock(cur.clock, clock) >= 0) return false;
	fields[name] = { value, clock };
	return true;
}

function markCreated(rec: LwwRecord, clock: Clock): boolean {
	if (rec.created && compareClock(rec.created, clock) >= 0) return false;
	rec.created = clock;
	return true;
}

function setTombstone(state: LibraryState, key: string, clock: Clock): boolean {
	const cur = state.tombstones.get(key);
	if (cur && compareClock(cur, clock) >= 0) return false;
	state.tombstones.set(key, clock);
	return true;
}

// Writes every defined payload field as a cell. Undefined (omitted) fields
// write nothing, so an omitted `color` on create never beats a set-colour
// that happens to carry an earlier clock.
function writeFields(rec: LwwRecord, payload: Record<string, unknown>, clock: Clock): boolean {
	let changed = false;
	for (const [name, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		if (writeCell(rec.fields, name, value, clock)) changed = true;
	}
	return changed;
}

const ref = (entity: Entity, id: string): EntityRef => ({ entity, id });

// ── per-entity handlers ─────────────────────────────────────────────────────

// tag / playlist / playlist_folder / pinned_search share one shape: create +
// field edits + a tombstone that wins over every later field edit.
function applyContainer(state: LibraryState, map: Map<string, LwwRecord>, entity: Entity, op: Op, clock: Clock): EntityRef[] {
	const id = op.entity_id;
	let changed = false;
	switch (op.kind) {
		case 'create': {
			const rec = recordOf(map, id);
			changed = markCreated(rec, clock);
			if (writeFields(rec, op.payload as Record<string, unknown>, clock)) changed = true;
			break;
		}
		case 'delete':
			changed = setTombstone(state, tombstoneKey(entity, id), clock);
			break;
		default:
			// rename / set-colour / move-to-folder / set-source-link /
			// set-favourite / set-query: each payload key is one LWW field.
			changed = writeFields(recordOf(map, id), op.payload as Record<string, unknown>, clock);
	}
	return changed ? [ref(entity, id)] : [];
}

function applyTrackTag(state: LibraryState, op: OpOf<'track_tag'>, clock: Clock): EntityRef[] {
	const parts = parseTrackTagEntityId(op.entity_id)!;
	const recordingId = resolveRecording(state, parts.recordingId);
	const key = `${recordingId}:${parts.tagId}`;
	let changed = false;
	if (op.kind === 'add') {
		const row = state.trackTags.get(key);
		if (!row) {
			state.trackTags.set(key, { recordingId, tagId: parts.tagId, added: clock });
			changed = true;
		} else if (compareClock(clock, row.added) > 0) {
			row.added = clock;
			changed = true;
		}
	} else {
		changed = setTombstone(state, tombstoneKey('track_tag', key), clock);
	}
	return changed ? [ref('track_tag', key)] : [];
}

function playlistTrackRow(state: LibraryState, id: string): PlaylistTrackRecord {
	let row = state.playlistTracks.get(id);
	if (!row) {
		row = { id, playlistId: null, recordingId: null, added: null, orderKey: null };
		state.playlistTracks.set(id, row);
	}
	return row;
}

function writeOrderKey(row: PlaylistTrackRecord, key: string, clock: Clock): boolean {
	if (row.orderKey && compareClock(row.orderKey.clock, clock) >= 0) return false;
	row.orderKey = { value: key, clock };
	return true;
}

function applyPlaylistTrack(state: LibraryState, op: OpOf<'playlist_track'>, clock: Clock): EntityRef[] {
	switch (op.kind) {
		case 'add': {
			const row = playlistTrackRow(state, op.entity_id);
			let changed = false;
			// The latest add binds the row to its playlist and recording; a
			// re-add after a remove (later ts) revives it.
			if (!row.added || compareClock(clock, row.added) > 0) {
				row.added = clock;
				row.playlistId = op.payload.playlist_id;
				row.recordingId = resolveRecording(state, op.payload.recording_id);
				changed = true;
			}
			if (writeOrderKey(row, op.payload.order_key, clock)) changed = true;
			return changed ? [ref('playlist_track', op.entity_id)] : [];
		}
		case 'move':
			return writeOrderKey(playlistTrackRow(state, op.entity_id), op.payload.order_key, clock) ? [ref('playlist_track', op.entity_id)] : [];
		case 'remove':
			return setTombstone(state, tombstoneKey('playlist_track', op.entity_id), clock) ? [ref('playlist_track', op.entity_id)] : [];
		case 'rekey': {
			// entity_id is the playlist. Each row's key is LWW against any
			// concurrent move of that row; rows known to belong to another
			// playlist are ignored (a stale client), unknown rows get a shadow.
			const changed: EntityRef[] = [];
			for (const [rowId, key] of Object.entries(op.payload.keys)) {
				const row = playlistTrackRow(state, rowId);
				if (row.playlistId !== null && row.playlistId !== op.entity_id) continue;
				if (writeOrderKey(row, key, clock)) changed.push(ref('playlist_track', rowId));
			}
			return changed;
		}
	}
}

function applyLibraryTrack(state: LibraryState, op: OpOf<'library_track'>, clock: Clock): EntityRef[] {
	const id = resolveRecording(state, op.entity_id);
	const rec = recordOf(state.libraryTracks, id);
	let changed = false;
	switch (op.kind) {
		case 'create':
			changed = markCreated(rec, clock);
			if (op.payload.added_at !== undefined && writeCell(rec.fields, 'added_at', op.payload.added_at, clock)) changed = true;
			break;
		case 'set-rating':
			changed = writeCell(rec.fields, 'rating', op.payload.rating, clock);
			break;
		case 'set-favourite':
			changed = writeCell(rec.fields, 'favourite', op.payload.favourite, clock);
			break;
		case 'set-state':
			changed = writeCell(rec.fields, 'state', op.payload.state, clock);
			break;
		case 'set-override':
			changed = writeCell(rec.fields, `override.${op.payload.field}`, op.payload.value, clock);
			break;
		case 'set-rb-analysis':
			changed = writeCell(rec.fields, `rb.${op.payload.unit}`, op.payload.value, clock);
			break;
		// delete and undelete are LWW on one field, so the later of the two
		// wins whatever order they arrive in.
		case 'delete':
			changed = writeCell(rec.fields, 'deleted_at', op.client_ts, clock);
			break;
		case 'undelete':
			changed = writeCell(rec.fields, 'deleted_at', null, clock);
			break;
	}
	return changed ? [ref('library_track', id)] : [];
}

function applyCue(state: LibraryState, op: OpOf<'cue'>, clock: Clock): EntityRef[] {
	const parts = parseCueEntityId(op.entity_id)!;
	const recordingId = resolveRecording(state, parts.recordingId);
	const key = `${recordingId}:${parts.slot}:${parts.kind}`;
	let changed = false;
	if (op.kind === 'upsert') {
		const { slot: _s, kind: _k, ...body } = op.payload;
		const rec = state.cues.get(key);
		if (!rec) {
			state.cues.set(key, { recordingId, slot: parts.slot, kind: parts.kind, cell: { value: body, clock } });
			changed = true;
		} else if (compareClock(clock, rec.cell.clock) > 0) {
			rec.cell = { value: body, clock };
			changed = true;
		}
	} else {
		changed = setTombstone(state, tombstoneKey('cue', key), clock);
	}
	return changed ? [ref('cue', key)] : [];
}

function applyPlaySession(state: LibraryState, op: OpOf<'play_session'>, clock: Clock): EntityRef[] {
	const rec = recordOf(state.playSessions, op.entity_id);
	let changed = false;
	if (op.kind === 'append') {
		changed = markCreated(rec, clock);
		if (writeFields(rec, op.payload, clock)) changed = true;
	} else {
		changed = writeFields(rec, { kind: op.payload.kind, kind_source: 'user' }, clock);
	}
	return changed ? [ref('play_session', op.entity_id)] : [];
}

function applyPlayEvent(state: LibraryState, op: OpOf<'play_event'>, clock: Clock): EntityRef[] {
	// Append-only, but keyed by id and LWW on the clock so a duplicate append
	// (a retried import) is a no-op whichever copy lands first.
	const value = { ...op.payload, recording_id: op.payload.recording_id === null ? null : resolveRecording(state, op.payload.recording_id) };
	const cur = state.playEvents.get(op.entity_id);
	if (cur && compareClock(cur.clock, clock) >= 0) return [];
	state.playEvents.set(op.entity_id, { value, clock });
	return [ref('play_event', op.entity_id)];
}

function applySetting(state: LibraryState, op: OpOf<'setting'>, clock: Clock): EntityRef[] {
	const cur = state.settings.get(op.entity_id);
	if (cur && compareClock(cur.clock, clock) >= 0) return [];
	state.settings.set(op.entity_id, { value: op.payload.value, clock });
	return [ref('setting', op.entity_id)];
}

function applyClaim(state: LibraryState, op: OpOf<'recording_claim'>, clock: Clock): EntityRef[] {
	const recordingId = resolveRecording(state, op.entity_id);
	const key = `${recordingId}:${op.payload.kind}:${op.payload.value}`;
	const cur = state.claims.get(key);
	if (cur && compareClock(cur.cell.clock, clock) >= 0) return [];
	state.claims.set(key, {
		recordingId,
		kind: op.payload.kind,
		value: op.payload.value,
		cell: { value: { confidence: op.payload.confidence, duration_sec: op.payload.duration_sec ?? null }, clock },
	});
	return [ref('recording_claim', recordingId)];
}

function applyUpstream(state: LibraryState, op: OpOf<'upstream'>, clock: Clock): EntityRef[] {
	const cur = state.upstreamAcks.get(op.entity_id);
	if (cur && compareClock(cur.clock, clock) >= 0) return [];
	state.upstreamAcks.set(op.entity_id, { value: op.payload, clock });
	return [ref('upstream', op.entity_id)];
}

// ── artist aliases ──────────────────────────────────────────────────────────

// Rebuilds the resolved map from the per-key rules. Order-independent: it
// reads only the rules, which are LWW per key.
//
// Rules are taken latest first, and a rename rule (to_key ≠ its own key) is
// dropped when, with the later rules already in, following its target would
// lead back to its own key: of A→B and B→A the later stands and the earlier
// is ignored, as with opposite recording merges. Every kept rename edge then
// forms an acyclic graph, so following it terminates. A key resolves to the
// end of its chain; the spelling is that key's own spelling rule (to_key =
// key) when it has one, else the `to` of the last rename hop.
export function rebuildArtistAlias(state: LibraryState): void {
	const live = [...state.artistAliases.entries()]
		.filter((e): e is [string, Cell<ArtistAliasRule>] => e[1].value !== null)
		.sort((a, b) => -compareClock(a[1].clock, b[1].clock));
	const edges = new Map<string, ArtistAliasRule>();
	const spelling = new Map<string, ArtistAliasRule>();
	for (const [key, cell] of live) {
		const rule = cell.value;
		if (rule.to_key === key) {
			spelling.set(key, rule);
			continue;
		}
		let cur = rule.to_key;
		while (cur !== key && edges.has(cur)) cur = edges.get(cur)!.to_key;
		if (cur === key) continue;
		edges.set(key, rule);
	}
	const out = new Map<string, ArtistAliasTarget>();
	for (const key of [...edges.keys(), ...spelling.keys()]) {
		let cur = key;
		let last: ArtistAliasRule | null = null;
		while (edges.has(cur)) {
			last = edges.get(cur)!;
			cur = last.to_key;
		}
		out.set(key, { name: spelling.get(cur)?.to ?? last!.to, key: cur });
	}
	state.artistAlias = out;
}

export function resolveArtistKey(state: LibraryState, key: string): ArtistAliasTarget | null {
	return state.artistAlias.get(key) ?? null;
}

function applyArtistAlias(state: LibraryState, op: OpOf<'artist_alias'>, clock: Clock): EntityRef[] {
	const cur = state.artistAliases.get(op.entity_id);
	if (cur && compareClock(cur.clock, clock) >= 0) return [];
	state.artistAliases.set(op.entity_id, { value: op.kind === 'set' ? { ...op.payload } : null, clock });
	rebuildArtistAlias(state);
	return [ref('artist_alias', op.entity_id)];
}

// ── recording merge ─────────────────────────────────────────────────────────

// Rebuilds the flattened alias map from the per-loser merge records. Latest
// merge first, so when two devices merged the same pair in opposite
// directions the later op's direction stands and the earlier one, which
// would now close a cycle, is skipped. Built as parent pointers resolved to
// their roots (union-find with path compression), then flattened so every
// lookup is one hop: O(M log M) for the sort. It used to re-point every
// alias on each insert, O(M²) per rebuild and so O(M³) over a log, which
// was fine for hand merges and is not for the identity resolver, which can
// emit one merge per file a second desktop shares with the first.
function rebuildAlias(state: LibraryState): void {
	const entries = [...state.merges.entries()].filter(([, m]) => m.winner !== null).sort((a, b) => -compareClock(a[1].clock, b[1].clock));
	const parent = new Map<string, string>();
	const root = (x: string): string => {
		let r = x;
		for (let next = parent.get(r); next !== undefined; next = parent.get(r)) r = next;
		for (let c = x; c !== r;) { const next = parent.get(c)!; parent.set(c, r); c = next; }
		return r;
	};
	for (const [loser, m] of entries) {
		const winner = root(m.winner!);
		if (winner === loser) continue;
		parent.set(loser, winner);
	}
	const alias = new Map<string, string>();
	for (const loser of parent.keys()) alias.set(loser, root(loser));
	state.recordingAlias = alias;
}

// The common case without the rebuild: a merge newer than every merge on
// record, for a loser with no record of its own. The rebuild would process
// it first, before every older merge; that gives the same roots as adding
// it last, unless its winner already resolves to its loser (then the older
// merges that close that cycle are the ones the rebuild skips, so it must
// run). Returns false when the rebuild is needed.
function extendAlias(state: LibraryState, loser: string, winner: string, clock: Clock): boolean {
	for (const [l, m] of state.merges) {
		if (l !== loser && compareClock(m.clock, clock) >= 0) return false;
	}
	const target = state.recordingAlias.get(winner) ?? winner;
	if (target === loser) return false;
	const alias = state.recordingAlias;
	for (const [l, w] of alias) if (w === loser) alias.set(l, target);
	alias.set(loser, target);
	return true;
}

// Moves every row of `loser` onto `winner`. Every rule here must give the same
// result whether a loser row arrived before the merge (and is folded here) or
// after it (and is redirected through the alias into an ordinary write on the
// winner). A device applies its own ops before the server orders them, so an
// offline edit to the loser can land on either side of the merge on different
// devices; any rule that is not commutative makes those devices diverge.
//
// So per-field data folds by clock exactly as a redirected write would land:
// rating, overrides and each cue slot take the later write of the two sides.
// Sets (tag assignments, playlist rows, claims, play events) union. The
// desktop merge dialog's "kept side wins" (`applyTrackMerge`) is therefore not
// a reducer rule: the device that merges re-asserts the kept side's fields and
// cues as ordinary ops stamped with the merge's clock, which beats every loser
// write made before the merge and loses to any made after it, in every order.
function fold(state: LibraryState, loser: string, winner: string): EntityRef[] {
	const changed: EntityRef[] = [];

	const lt = state.libraryTracks.get(loser);
	if (lt) {
		const wt = state.libraryTracks.get(winner) ?? { id: winner, created: null, fields: {} };
		state.libraryTracks.set(winner, wt);
		if (lt.created) wt.created = laterClock(wt.created, lt.created);
		for (const [name, cell] of Object.entries(lt.fields)) writeCell(wt.fields, name, cell.value, cell.clock);
		state.libraryTracks.delete(loser);
		changed.push(ref('library_track', winner));
	}

	for (const [key, row] of [...state.trackTags]) {
		if (row.recordingId !== loser) continue;
		const newKey = `${winner}:${row.tagId}`;
		const cur = state.trackTags.get(newKey);
		if (cur) cur.added = laterClock(cur.added, row.added);
		else state.trackTags.set(newKey, { recordingId: winner, tagId: row.tagId, added: row.added });
		state.trackTags.delete(key);
		moveTombstone(state, tombstoneKey('track_tag', key), tombstoneKey('track_tag', newKey));
		changed.push(ref('track_tag', newKey));
	}

	// Duplicate rows of one track in a playlist stay allowed (identity is the
	// row), so a loser row is re-pointed, never dropped: dropping would make
	// the outcome depend on whether the row arrived before or after the merge.
	for (const row of state.playlistTracks.values()) {
		if (row.recordingId !== loser) continue;
		row.recordingId = winner;
		changed.push(ref('playlist_track', row.id));
	}

	// Whole-cue LWW per slot across both sides, and the delete clocks travel
	// with the slot, the same outcome a redirected upsert or delete would have.
	for (const [key, rec] of [...state.cues]) {
		if (rec.recordingId !== loser) continue;
		const newKey = `${winner}:${rec.slot}:${rec.kind}`;
		const cur = state.cues.get(newKey);
		if (!cur || compareClock(rec.cell.clock, cur.cell.clock) > 0) state.cues.set(newKey, { ...rec, recordingId: winner });
		moveTombstone(state, tombstoneKey('cue', key), tombstoneKey('cue', newKey));
		state.cues.delete(key);
		changed.push(ref('cue', newKey));
	}
	// A cue delete or tag removal aimed at the loser with no live loser row
	// left still has to reach the winner's key, as it would had it arrived
	// after the merge and been redirected.
	for (const entity of ['cue', 'track_tag'] as const) {
		const prefix = tombstoneKey(entity, `${loser}:`);
		for (const tk of [...state.tombstones.keys()]) {
			if (!tk.startsWith(prefix)) continue;
			const rest = tk.slice(prefix.length);
			moveTombstone(state, tk, tombstoneKey(entity, `${winner}:${rest}`));
			changed.push(ref(entity, `${winner}:${rest}`));
		}
	}

	for (const [key, rec] of [...state.claims]) {
		if (rec.recordingId !== loser) continue;
		const newKey = `${winner}:${rec.kind}:${rec.value}`;
		const cur = state.claims.get(newKey);
		if (!cur || compareClock(rec.cell.clock, cur.cell.clock) > 0) state.claims.set(newKey, { ...rec, recordingId: winner });
		state.claims.delete(key);
		changed.push(ref('recording_claim', winner));
	}

	for (const [id, cell] of state.playEvents) {
		if (cell.value.recording_id !== loser) continue;
		cell.value = { ...cell.value, recording_id: winner };
		changed.push(ref('play_event', id));
	}

	return changed;
}

function moveTombstone(state: LibraryState, from: string, to: string): void {
	const t = state.tombstones.get(from);
	if (t === undefined) return;
	state.tombstones.delete(from);
	state.tombstones.set(to, laterClock(state.tombstones.get(to), t));
}

function applyRecording(state: LibraryState, op: OpOf<'recording'>, clock: Clock): EntityRef[] {
	const loser = op.entity_id;
	const cur = state.merges.get(loser);
	if (cur && compareClock(cur.clock, clock) >= 0) return [];
	state.merges.set(loser, { winner: op.kind === 'merge' ? op.payload.winner : null, clock });
	if (cur || op.kind !== 'merge' || !extendAlias(state, loser, op.payload.winner, clock)) rebuildAlias(state);
	const changed: EntityRef[] = [ref('recording', loser), ref('recording', op.payload.winner)];
	const target = state.recordingAlias.get(loser);
	// A split withdraws the alias only; rows already folded stay where they
	// are, the user moves them back with ordinary ops (P2).
	if (op.kind === 'merge' && target !== undefined) changed.push(...fold(state, loser, target));
	return changed;
}

// ── restatement (emit-side no-op suppression) ───────────────────────────────
// `applyOp` reports a change whenever an op's clock is later than the cell's,
// so a freshly stamped local op always "changes" the raw records, even when
// it only repeats the value already there (a rekordbox re-import restating
// every play it read last time). The emit side needs the other question:
// would this op change any VALUE the state materialises, as opposed to only
// re-stamping a clock? When it would not, the op is redundant on every
// device: the cell's current value came from an op that is already in this
// device's outbox or was pulled from the log, so every replica converges on
// that value without this one.
//
// Conservative by construction: a record or cell this state has never seen
// is a change (a row from before the op log, not yet recorded by the initial
// push, must still emit), and so is anything whose visibility a tombstone
// decides the other way. Never a restatement: recording merges/splits and
// artist alias rules (their effect depends on clock ORDER among rules, so
// restating an older rule with a newer clock changes which rule stands) and
// upstream acks (one per acked op). Callers that restate on purpose — a
// merge's re-assert at the merge clock, the initial push's historical stamps
// — must not ask.

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((x, i) => sameValue(x, b[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	// An omitted key and an undefined one are the same value: records are
	// persisted as JSON, which drops undefined.
	for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
		if (ao[k] === undefined && bo[k] === undefined) continue;
		if (!sameValue(ao[k], bo[k])) return false;
	}
	return true;
}

// Every defined payload field already holds that value (writeFields' view).
function fieldsHold(rec: LwwRecord | undefined, payload: Record<string, unknown>): boolean {
	if (!rec) return false;
	for (const [name, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		const cell = rec.fields[name];
		if (!cell || !sameValue(cell.value, value)) return false;
	}
	return true;
}

function cellHolds(rec: LwwRecord | undefined, name: string, value: unknown): boolean {
	const cell = rec?.fields[name];
	return cell !== undefined && sameValue(cell.value, value);
}

export function isRestatement(state: LibraryState, op: NewOp): boolean {
	switch (op.entity) {
		case 'tag':
		case 'playlist':
		case 'playlist_folder':
		case 'pinned_search': {
			const map = op.entity === 'tag' ? state.tags : op.entity === 'playlist' ? state.playlists : op.entity === 'playlist_folder' ? state.playlistFolders : state.pinnedSearches;
			const tomb = state.tombstones.has(tombstoneKey(op.entity, op.entity_id));
			if (op.kind === 'delete') return tomb;
			const rec = map.get(op.entity_id);
			if (op.kind === 'create' && (!rec?.created || tomb)) return false;
			return fieldsHold(rec, op.payload as Record<string, unknown>);
		}
		case 'track_tag': {
			const parts = parseTrackTagEntityId(op.entity_id);
			if (!parts) return false;
			const key = `${resolveRecording(state, parts.recordingId)}:${parts.tagId}`;
			const row = state.trackTags.get(key);
			const tomb = state.tombstones.get(tombstoneKey('track_tag', key));
			// addWins: a remove cancels only adds with an earlier ts.
			if (op.kind === 'add') return row !== undefined && (tomb === undefined || row.added.ts >= tomb.ts);
			return tomb !== undefined && (row === undefined || tomb.ts > row.added.ts);
		}
		case 'playlist_track': {
			if (op.kind === 'rekey') {
				for (const [rowId, key] of Object.entries(op.payload.keys)) {
					if (state.playlistTracks.get(rowId)?.orderKey?.value !== key) return false;
				}
				return true;
			}
			const row = state.playlistTracks.get(op.entity_id);
			const tomb = state.tombstones.get(tombstoneKey('playlist_track', op.entity_id));
			if (op.kind === 'move') return row?.orderKey?.value === op.payload.order_key;
			if (op.kind === 'remove') return tomb !== undefined && (!row?.added || tomb.ts > row.added.ts);
			return (
				row !== undefined && row.added !== null &&
				row.playlistId === op.payload.playlist_id &&
				row.recordingId === resolveRecording(state, op.payload.recording_id) &&
				row.orderKey?.value === op.payload.order_key &&
				(tomb === undefined || row.added.ts >= tomb.ts)
			);
		}
		case 'library_track': {
			const rec = state.libraryTracks.get(resolveRecording(state, op.entity_id));
			switch (op.kind) {
				case 'create': return !!rec?.created && (op.payload.added_at === undefined || cellHolds(rec, 'added_at', op.payload.added_at));
				case 'set-rating': return cellHolds(rec, 'rating', op.payload.rating);
				case 'set-favourite': return cellHolds(rec, 'favourite', op.payload.favourite);
				case 'set-state': return cellHolds(rec, 'state', op.payload.state);
				case 'set-override': return cellHolds(rec, `override.${op.payload.field}`, op.payload.value);
				case 'set-rb-analysis': return cellHolds(rec, `rb.${op.payload.unit}`, op.payload.value);
				// The delete's value is its own client_ts; already deleted at any
				// time is the same visible state.
				case 'delete': { const c = rec?.fields['deleted_at']; return c !== undefined && c.value !== null; }
				case 'undelete': return cellHolds(rec, 'deleted_at', null);
			}
			return false;
		}
		case 'cue': {
			const parts = parseCueEntityId(op.entity_id);
			if (!parts) return false;
			const key = `${resolveRecording(state, parts.recordingId)}:${parts.slot}:${parts.kind}`;
			const rec = state.cues.get(key);
			const tomb = state.tombstones.get(tombstoneKey('cue', key));
			const alive = rec !== undefined && (tomb === undefined || compareClock(rec.cell.clock, tomb) > 0);
			if (op.kind === 'delete') return tomb !== undefined && !alive;
			const { slot: _s, kind: _k, ...body } = op.payload;
			return alive && sameValue(rec.cell.value, body);
		}
		case 'play_session': {
			const rec = state.playSessions.get(op.entity_id);
			if (op.kind === 'append') return !!rec?.created && fieldsHold(rec, op.payload);
			return fieldsHold(rec, { kind: op.payload.kind, kind_source: 'user' });
		}
		case 'play_event': {
			const cur = state.playEvents.get(op.entity_id);
			const value = { ...op.payload, recording_id: op.payload.recording_id === null ? null : resolveRecording(state, op.payload.recording_id) };
			return cur !== undefined && sameValue(cur.value, value);
		}
		case 'setting': {
			const cur = state.settings.get(op.entity_id);
			return cur !== undefined && sameValue(cur.value, op.payload.value);
		}
		case 'recording_claim': {
			const cur = state.claims.get(`${resolveRecording(state, op.entity_id)}:${op.payload.kind}:${op.payload.value}`);
			return cur !== undefined && sameValue(cur.cell.value, { confidence: op.payload.confidence, duration_sec: op.payload.duration_sec ?? null });
		}
		case 'recording':
		case 'artist_alias':
		case 'upstream':
			return false;
	}
}

// ── entry points ────────────────────────────────────────────────────────────

export function applyOp(state: LibraryState, op: Op): ApplyResult {
	const clock = clockOf(op);
	let changed: EntityRef[];
	switch (op.entity) {
		case 'tag':
			changed = applyContainer(state, state.tags, 'tag', op, clock);
			break;
		case 'track_tag':
			changed = applyTrackTag(state, op, clock);
			break;
		case 'playlist':
			changed = applyContainer(state, state.playlists, 'playlist', op, clock);
			break;
		case 'playlist_folder':
			changed = applyContainer(state, state.playlistFolders, 'playlist_folder', op, clock);
			break;
		case 'playlist_track':
			changed = applyPlaylistTrack(state, op, clock);
			break;
		case 'library_track':
			changed = applyLibraryTrack(state, op, clock);
			break;
		case 'cue':
			changed = applyCue(state, op, clock);
			break;
		case 'play_session':
			changed = applyPlaySession(state, op, clock);
			break;
		case 'play_event':
			changed = applyPlayEvent(state, op, clock);
			break;
		case 'pinned_search':
			changed = applyContainer(state, state.pinnedSearches, 'pinned_search', op, clock);
			break;
		case 'setting':
			changed = applySetting(state, op, clock);
			break;
		case 'recording_claim':
			changed = applyClaim(state, op, clock);
			break;
		case 'recording':
			changed = applyRecording(state, op, clock);
			break;
		case 'upstream':
			changed = applyUpstream(state, op, clock);
			break;
		case 'artist_alias':
			changed = applyArtistAlias(state, op, clock);
			break;
	}
	return { state, changed };
}

// A batch: merges first (design: "applied before any other op in its batch"),
// then the rest in the given order. `changed` is deduplicated.
export function applyOps(state: LibraryState, ops: readonly Op[]): ApplyResult {
	const merges = ops.filter((o) => o.entity === 'recording');
	const rest = ops.filter((o) => o.entity !== 'recording');
	const seen = new Set<string>();
	const changed: EntityRef[] = [];
	for (const op of [...merges, ...rest]) {
		for (const r of applyOp(state, op).changed) {
			const key = `${r.entity}:${r.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			changed.push(r);
		}
	}
	return { state, changed };
}

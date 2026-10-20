// The sixteen conflict scenarios from the design (planning/tech/cloud.md,
// "Conflict scenarios and expected outcomes"), each built as a small set of
// ops and applied in every permutation of arrival order: the raw state and
// the materialised view must come out identical every time. Scenarios that
// are about transport (9 clock clamp, 10 retry, 11 interrupted pull, 15
// bootstrap) are expressed as reducer invariants where the reducer has a
// part in them and documented as out of its scope otherwise.

import { describe, it, expect } from 'vitest';
import { cueEntityId, parseOp, SCHEMA_VERSION, trackTagEntityId, type Entity, type KindOf, type Op, type PayloadOf } from './ops.js';
import { keyBetween } from './order-key.js';
import { applyOp, applyOps, isRestatement } from './reduce.js';
import { cloneLibraryState, createLibraryState, materialize, type LibraryState, type LibraryView } from './state.js';

// ── helpers ─────────────────────────────────────────────────────────────────

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const T = (h: number, m: number) => Date.UTC(2026, 9, 17, h, m);

type Stamp = { ts: number; device?: string };

function op<E extends Entity, K extends KindOf<E>>(entity: E, kind: K, entityId: string, payload: PayloadOf<E, K>, at: Stamp): Op {
	return parseOp({
		op_id: uuid(),
		device_id: at.device ?? 'desktop',
		client_ts: at.ts,
		schema_version: SCHEMA_VERSION,
		entity,
		entity_id: entityId,
		kind,
		payload,
	});
}

function permutations<T>(xs: T[]): T[][] {
	if (xs.length <= 1) return [xs];
	const out: T[][] = [];
	xs.forEach((x, i) => {
		for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
	});
	return out;
}

// Maps → sorted entry lists so a mismatch prints a readable diff.
function canonical(state: LibraryState): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, map] of Object.entries(state)) {
		out[name] = [...(map as Map<string, unknown>).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	}
	return out;
}

function reduceAll(ops: readonly Op[]): LibraryState {
	const state = createLibraryState();
	for (const o of ops) applyOp(state, o);
	return state;
}

// Applies `ops` in every order, one op at a time and as one batch, and
// asserts every run reaches the same raw state and view.
function converge(ops: Op[]): { state: LibraryState; view: LibraryView } {
	if (ops.length > 6) throw new Error(`scenario too large to permute: ${ops.length} ops`);
	const first = reduceAll(ops);
	const expectedRaw = canonical(first);
	const expectedView = materialize(first);
	for (const order of permutations(ops)) {
		const label = order.map((o) => `${o.entity}.${o.kind}@${o.client_ts}`).join(' → ');
		const s = reduceAll(order);
		expect(canonical(s), label).toEqual(expectedRaw);
		expect(materialize(s), label).toEqual(expectedView);
		const batched = createLibraryState();
		applyOps(batched, order);
		expect(canonical(batched), `batch ${label}`).toEqual(expectedRaw);
	}
	return { state: first, view: expectedView };
}

const A = uuid();
const B = uuid();
const C = uuid();
const TAG = uuid();
const PL = uuid();

const tagCreate = (id = TAG, at: Stamp = { ts: T(9, 0) }) => op('tag', 'create', id, { name: 'Peak', kind: 'user' }, at);
const playlistCreate = (id = PL, at: Stamp = { ts: T(9, 0) }, name = 'Warm up') => op('playlist', 'create', id, { name }, at);
const addRow = (row: string, key: string, at: Stamp, recording = A, playlist = PL) =>
	op('playlist_track', 'add', row, { playlist_id: playlist, recording_id: recording, order_key: key }, at);
const rowOrder = (view: LibraryView, playlist = PL) => view.playlistTracks.filter((r) => r.playlistId === playlist).map((r) => r.id);

// ── the sixteen scenarios ───────────────────────────────────────────────────

describe('conflict scenarios, every op order', () => {
	it('1. offline rating 4 at 10:00 loses to 5 at 10:05 whenever it arrives', () => {
		const { view } = converge([
			op('library_track', 'set-rating', A, { rating: 4 }, { ts: T(10, 0), device: 'desktop' }),
			op('library_track', 'set-rating', A, { rating: 5 }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: A, rating: 5 })]);
	});

	it('2. concurrent tag add and remove: the later client_ts wins', () => {
		const key = trackTagEntityId(A, TAG);
		// Older remove cannot cancel a newer add.
		const added = converge([
			tagCreate(),
			op('track_tag', 'add', key, {}, { ts: T(10, 5), device: 'phone' }),
			op('track_tag', 'remove', key, {}, { ts: T(10, 0), device: 'desktop' }),
		]);
		expect(added.view.trackTags).toEqual([{ recordingId: A, tagId: TAG }]);
		// A newer remove does.
		const removed = converge([
			tagCreate(),
			op('track_tag', 'add', key, {}, { ts: T(10, 0), device: 'phone' }),
			op('track_tag', 'remove', key, {}, { ts: T(10, 5), device: 'desktop' }),
		]);
		expect(removed.view.trackTags).toEqual([]);
		// Same millisecond: add wins (a remove only cancels EARLIER adds).
		const tie = converge([
			tagCreate(),
			op('track_tag', 'add', key, {}, { ts: T(10, 0), device: 'phone' }),
			op('track_tag', 'remove', key, {}, { ts: T(10, 0), device: 'desktop' }),
		]);
		expect(tie.view.trackTags).toEqual([{ recordingId: A, tagId: TAG }]);
	});

	it('3. two devices move different rows of one playlist: both apply', () => {
		const [r1, r2, r3] = [uuid(), uuid(), uuid()];
		const { view } = converge([
			playlistCreate(),
			addRow(r1, 'a0', { ts: T(9, 1) }),
			addRow(r2, 'a1', { ts: T(9, 1) }),
			addRow(r3, 'a2', { ts: T(9, 1) }),
			op('playlist_track', 'move', r1, { order_key: keyBetween('a2', null) }, { ts: T(10, 0), device: 'desktop' }),
			op('playlist_track', 'move', r2, { order_key: keyBetween(null, 'a0') }, { ts: T(10, 0), device: 'phone' }),
		]);
		expect(rowOrder(view)).toEqual([r2, r3, r1]);
		expect(view.playlistTracks.map((r) => r.position)).toEqual([0, 1, 2]);
	});

	it('4. two devices move the same row: the later move wins, the other key is discarded', () => {
		const [r1, r2, r3] = [uuid(), uuid(), uuid()];
		const { view } = converge([
			playlistCreate(),
			addRow(r1, 'a0', { ts: T(9, 1) }),
			addRow(r2, 'a1', { ts: T(9, 1) }),
			addRow(r3, 'a2', { ts: T(9, 1) }),
			op('playlist_track', 'move', r1, { order_key: keyBetween('a2', null) }, { ts: T(10, 0), device: 'desktop' }),
			op('playlist_track', 'move', r1, { order_key: keyBetween('a1', 'a2') }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(rowOrder(view)).toEqual([r2, r1, r3]);
		expect(view.playlistTracks.find((r) => r.id === r1)!.orderKey).toBe(keyBetween('a1', 'a2'));
	});

	it('5. two devices insert into the same gap: both land, ordered by key then row id', () => {
		const [r1, r3] = [uuid(), uuid()];
		const [x, y] = [uuid(), uuid()].sort() as [string, string];
		const gap = keyBetween('a0', 'a2');
		const { view } = converge([
			playlistCreate(),
			addRow(r1, 'a0', { ts: T(9, 1) }),
			addRow(r3, 'a2', { ts: T(9, 1) }),
			addRow(y, gap, { ts: T(10, 0), device: 'phone' }, B),
			addRow(x, gap, { ts: T(10, 0), device: 'desktop' }, C),
		]);
		expect(rowOrder(view)).toEqual([r1, x, y, r3]);
		expect(view.playlistTracks.map((r) => r.position)).toEqual([0, 1, 2, 3]);
	});

	it('6. phone adds to a Spotify-linked playlist; the desktop acks the upstream push', () => {
		// The reducer's part: the add is state the moment it lands and the ack
		// is keyed by that op's id, in any order. The three-way diff that keeps
		// a read-sync from treating the pending row as a provider removal is
		// the desktop's `reconcileMembership` (plan B4), outside the reducer.
		const row = uuid();
		const add = addRow(row, 'a0', { ts: T(10, 0), device: 'phone' });
		const { view } = converge([
			op('playlist', 'create', PL, { name: 'Gig', source_link: { source: 'spotify', source_id: '37i9dQ' } }, { ts: T(9, 0) }),
			add,
			op('upstream', 'ack', add.op_id, { provider: 'spotify', status: 'pushed' }, { ts: T(10, 30), device: 'desktop' }),
		]);
		expect(rowOrder(view)).toEqual([row]);
		expect(view.upstreamAcks).toEqual([{ opId: add.op_id, provider: 'spotify', status: 'pushed' }]);
	});

	it('7. desktop merges A into B; the phone, offline, had tagged A', () => {
		const { view, state } = converge([
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(10, 0), device: 'phone' }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 5), device: 'desktop' }),
		]);
		expect(view.trackTags).toEqual([{ recordingId: B, tagId: TAG }]);
		expect(view.recordingAlias).toEqual({ [A]: B });
		expect([...state.trackTags.keys()]).toEqual([trackTagEntityId(B, TAG)]);
	});

	it('8. desktop deletes a playlist; the phone, offline, adds to it: stays deleted, add kept in history', () => {
		const row = uuid();
		const { view, state } = converge([
			playlistCreate(),
			op('playlist', 'delete', PL, {}, { ts: T(10, 0), device: 'desktop' }),
			addRow(row, 'a0', { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.playlists).toEqual([]);
		expect(view.playlistTracks).toEqual([]);
		// Not an error, not lost: the row's record is there for an undelete
		// replay (no `playlist.undelete` kind exists in schema v1; the design
		// replays membership from the op log).
		expect(state.playlistTracks.get(row)).toMatchObject({ playlistId: PL, recordingId: A });
	});

	it('9. a fast device clock: the reducer takes client_ts as given; clamping is the server', () => {
		// clock.test.ts covers `clampClientTs`. Here: an unclamped future stamp
		// would win LWW, which is exactly why the server clamps before append.
		const { view } = converge([
			op('library_track', 'set-rating', A, { rating: 5 }, { ts: T(10, 5), device: 'phone' }),
			op('library_track', 'set-rating', A, { rating: 4 }, { ts: T(11, 5), device: 'fast-desktop' }),
		]);
		expect(view.libraryTracks[0]!.rating).toBe(4);
	});

	it('10. a retried push: the same op applied twice changes nothing', () => {
		const ops = [
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(10, 0) }),
			addRow(uuid(), 'a0', { ts: T(10, 0) }),
			op('cue', 'upsert', cueEntityId(A, 1, 'hot'), { slot: 1, kind: 'hot', position_sec: 30, length_sec: null, color: null, name: null }, { ts: T(10, 0) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 1) }),
		];
		const state = reduceAll(ops);
		const before = canonical(state);
		for (const o of ops) {
			const r = applyOp(state, o);
			expect(r.changed, `${o.entity}.${o.kind} re-applied`).toEqual([]);
		}
		expect(canonical(state)).toEqual(before);
		// A batch that contains an op twice is the same as once.
		const doubled = createLibraryState();
		applyOps(doubled, [...ops, ...ops]);
		expect(canonical(doubled)).toEqual(before);
	});

	it('11. an interrupted pull: re-applying a batch after a prefix of it lands on the same state', () => {
		const ops = [
			playlistCreate(),
			addRow(uuid(), 'a0', { ts: T(9, 1) }),
			op('playlist', 'rename', PL, { name: 'Renamed' }, { ts: T(10, 0) }),
			op('library_track', 'set-rating', A, { rating: 3 }, { ts: T(10, 0) }),
			op('library_track', 'delete', A, {}, { ts: T(10, 1) }),
		];
		const whole = canonical(reduceAll(ops));
		for (let k = 0; k <= ops.length; k++) {
			const state = reduceAll(ops.slice(0, k)); // the batch died after k ops, cursor unmoved
			applyOps(state, ops); // the batch is re-pulled whole
			expect(canonical(state), `prefix ${k}`).toEqual(whole);
		}
	});

	it('12. two devices create playlists with the same name: two playlists', () => {
		const p1 = uuid();
		const p2 = uuid();
		const { view } = converge([playlistCreate(p1, { ts: T(10, 0), device: 'desktop' }, 'Gigs'), playlistCreate(p2, { ts: T(10, 0), device: 'phone' }, 'Gigs')]);
		expect(view.playlists.map((p) => p.name)).toEqual(['Gigs', 'Gigs']);
		expect(new Set(view.playlists.map((p) => p.id)).size).toBe(2);
	});

	it('13. a playlist renamed on both devices: LWW on name, membership untouched', () => {
		const row = uuid();
		const { view } = converge([
			playlistCreate(),
			addRow(row, 'a0', { ts: T(9, 1) }),
			op('playlist', 'rename', PL, { name: 'Desktop name' }, { ts: T(10, 0), device: 'desktop' }),
			op('playlist', 'rename', PL, { name: 'Phone name' }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.playlists).toEqual([expect.objectContaining({ id: PL, name: 'Phone name' })]);
		expect(rowOrder(view)).toEqual([row]);
	});

	it('14. startup ISRC dedup folds two rows: the merge op folds them identically on every device', () => {
		const { view } = converge([
			op('library_track', 'create', A, { added_at: T(8, 0) }, { ts: T(8, 0) }),
			op('library_track', 'set-rating', A, { rating: 3 }, { ts: T(8, 30) }),
			op('library_track', 'create', B, {}, { ts: T(9, 0) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0), device: 'desktop-1' }),
		]);
		// A's rating fills B's empty field; A's row is gone; the alias lives on.
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: B, rating: 3 })]);
		expect(view.recordingAlias).toEqual({ [A]: B });
	});

	it('15. a device rejoining after 120 days: its old outbox ops still merge by client_ts', () => {
		// The snapshot/bootstrap exchange is transport (cloud-service.ts); the
		// reducer's part is that stale ops lose to anything newer, however late
		// they arrive.
		const days = 24 * 3_600_000;
		const now = T(12, 0);
		const key = trackTagEntityId(A, TAG);
		const { view } = converge([
			tagCreate(TAG, { ts: now - 200 * days }),
			op('library_track', 'set-rating', A, { rating: 4 }, { ts: now - 120 * days, device: 'laptop' }),
			op('library_track', 'set-rating', A, { rating: 5 }, { ts: now - 1 * days, device: 'desktop' }),
			op('track_tag', 'add', key, {}, { ts: now - 120 * days, device: 'laptop' }),
			op('track_tag', 'remove', key, {}, { ts: now - 2 * days, device: 'desktop' }),
		]);
		expect(view.libraryTracks[0]!.rating).toBe(5);
		expect(view.trackTags).toEqual([]);
	});

	it('16. the same cue slot edited on both devices: whole-cue LWW', () => {
		const id = cueEntityId(A, 2, 'hot');
		const { view } = converge([
			op('cue', 'upsert', id, { slot: 2, kind: 'hot', position_sec: 60, length_sec: null, color: '#ff0000', name: 'Desktop' }, { ts: T(10, 0), device: 'desktop' }),
			op('cue', 'upsert', id, { slot: 2, kind: 'hot', position_sec: 61.5, length_sec: 8, color: null, name: 'Phone' }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.cues).toEqual([{ recordingId: A, slot: 2, kind: 'hot', position_sec: 61.5, length_sec: 8, color: null, name: 'Phone' }]);
		// Delete is one more version of the cue: later delete removes, later
		// upsert revives.
		const upsert = (at: Stamp) => op('cue', 'upsert', id, { slot: 2, kind: 'hot', position_sec: 1, length_sec: null, color: null, name: null }, at);
		expect(converge([upsert({ ts: T(10, 0) }), op('cue', 'delete', id, {}, { ts: T(10, 5) })]).view.cues).toEqual([]);
		expect(converge([op('cue', 'delete', id, {}, { ts: T(10, 0) }), upsert({ ts: T(10, 5) })]).view.cues).toHaveLength(1);
	});
});

// ── further rules from the table ────────────────────────────────────────────

describe('merge rules', () => {
	it('a container tombstone wins over later field edits and hides assignments', () => {
		const { view, state } = converge([
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(9, 30) }),
			op('tag', 'delete', TAG, {}, { ts: T(10, 0), device: 'desktop' }),
			op('tag', 'rename', TAG, { name: 'Later rename' }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.tags).toEqual([]);
		expect(view.trackTags).toEqual([]);
		// History kept: the rename's cell is in the raw record.
		expect(state.tags.get(TAG)!.fields.name!.value).toBe('Later rename');
	});

	it('a field edit that arrives before its create is a shadow until the create lands', () => {
		const state = createLibraryState();
		applyOp(state, op('tag', 'rename', TAG, { name: 'Early' }, { ts: T(10, 5) }));
		expect(materialize(state).tags).toEqual([]);
		applyOp(state, tagCreate(TAG, { ts: T(10, 0) }));
		expect(materialize(state).tags).toEqual([{ id: TAG, name: 'Early', kind: 'user', color: null }]);
	});

	it('library_track delete and undelete are LWW on deleted_at', () => {
		const del = op('library_track', 'delete', A, {}, { ts: T(10, 0), device: 'desktop' });
		const undel = op('library_track', 'undelete', A, {}, { ts: T(10, 5), device: 'phone' });
		expect(converge([del, undel]).view.libraryTracks[0]!.deletedAt).toBeNull();
		const del2 = op('library_track', 'delete', A, {}, { ts: T(10, 10), device: 'desktop' });
		expect(converge([del, undel, del2]).view.libraryTracks[0]!.deletedAt).toBe(T(10, 10));
	});

	it('per-field LWW keeps unrelated fields: overrides, rb units and rating are independent', () => {
		const { view } = converge([
			op('library_track', 'set-override', A, { field: 'title', value: 'Edited title' }, { ts: T(10, 0), device: 'desktop' }),
			op('library_track', 'set-override', A, { field: 'bpm', value: 124 }, { ts: T(10, 1), device: 'phone' }),
			op('library_track', 'set-override', A, { field: 'title', value: null }, { ts: T(10, 2), device: 'phone' }),
			op('library_track', 'set-rb-analysis', A, { unit: 'key', value: '8A' }, { ts: T(10, 0) }),
			op('library_track', 'set-rating', A, { rating: 2 }, { ts: T(9, 0) }),
		]);
		expect(view.libraryTracks).toEqual([
			{ recordingId: A, addedAt: null, rating: 2, state: null, favourite: false, deletedAt: null, overrides: { bpm: 124 }, rb: { key: '8A' } },
		]);
	});

	it('rekey is LWW per row against a concurrent move', () => {
		const [r1, r2] = [uuid(), uuid()];
		const { view } = converge([
			playlistCreate(),
			addRow(r1, 'a0', { ts: T(9, 1) }),
			addRow(r2, 'a1', { ts: T(9, 1) }),
			op('playlist_track', 'rekey', PL, { keys: { [r1]: 'a5', [r2]: 'a6' } }, { ts: T(10, 0), device: 'desktop' }),
			op('playlist_track', 'move', r1, { order_key: 'a7' }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.playlistTracks.map((r) => [r.id, r.orderKey])).toEqual([
			[r2, 'a6'],
			[r1, 'a7'],
		]);
	});

	it('a removed row revives on a later add of the same row id, not an earlier one', () => {
		const row = uuid();
		const remove = op('playlist_track', 'remove', row, {}, { ts: T(10, 0) });
		expect(converge([playlistCreate(), addRow(row, 'a0', { ts: T(9, 1) }), remove]).view.playlistTracks).toEqual([]);
		expect(converge([playlistCreate(), addRow(row, 'a0', { ts: T(10, 5) }), remove]).view.playlistTracks).toHaveLength(1);
	});

	it('settings are LWW per key; append-only rows insert by id', () => {
		const session = uuid();
		const event = uuid();
		const { view } = converge([
			op('setting', 'set', 'credit_format', { value: 'a' }, { ts: T(10, 0), device: 'desktop' }),
			op('setting', 'set', 'credit_format', { value: 'b' }, { ts: T(10, 5), device: 'phone' }),
			op('setting', 'set', 'mir.settings', { value: { models: ['muq'] } }, { ts: T(9, 0) }),
			op(
				'play_session',
				'append',
				session,
				{ origin: 'curator', kind: 'prep', kind_source: 'auto', name: null, started_at: T(8, 0), ended_at: null, rb_history_id: null },
				{ ts: T(8, 0) },
			),
			op('play_session', 'set-kind', session, { kind: 'set' }, { ts: T(9, 0) }),
			op(
				'play_event',
				'append',
				event,
				{
					session_id: session,
					recording_id: A,
					source: 'local',
					played_at: T(8, 1),
					played_ms: 1000,
					duration_ms: 2000,
					max_position_ms: 1500,
					played75: false,
					ended_reason: 'stopped',
					context_type: null,
					context_id: null,
					track_no: null,
					rb_song_history_id: null,
				},
				{ ts: T(8, 1) },
			),
		]);
		expect(view.settings).toEqual({ credit_format: 'b', 'mir.settings': { models: ['muq'] } });
		expect(view.playSessions).toEqual([expect.objectContaining({ id: session, kind: 'set', kind_source: 'user', origin: 'curator' })]);
		expect(view.playEvents).toEqual([expect.objectContaining({ id: event, recording_id: A })]);
	});

	it('changed lists what an op touched and is empty for a losing write', () => {
		const state = createLibraryState();
		expect(applyOp(state, op('library_track', 'set-rating', A, { rating: 5 }, { ts: T(10, 5) })).changed).toEqual([{ entity: 'library_track', id: A }]);
		expect(applyOp(state, op('library_track', 'set-rating', A, { rating: 4 }, { ts: T(10, 0) })).changed).toEqual([]);
		const key = trackTagEntityId(A, TAG);
		expect(applyOp(state, op('track_tag', 'add', key, {}, { ts: T(10, 0) })).changed).toEqual([{ entity: 'track_tag', id: key }]);
		const r = applyOps(state, [op('recording', 'merge', A, { winner: B }, { ts: T(11, 0) })]);
		expect(r.changed).toEqual(
			expect.arrayContaining([
				{ entity: 'recording', id: A },
				{ entity: 'recording', id: B },
				{ entity: 'library_track', id: B },
				{ entity: 'track_tag', id: trackTagEntityId(B, TAG) },
			]),
		);
	});
});

describe('recording aliases', () => {
	it('chains flatten to one hop in either order, and rows follow', () => {
		const { view } = converge([
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(9, 30) }),
			op('cue', 'upsert', cueEntityId(A, 0, 'memory'), { slot: 0, kind: 'memory', position_sec: 5, length_sec: null, color: null, name: null }, { ts: T(9, 31) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) }),
			op('recording', 'merge', B, { winner: C }, { ts: T(10, 5) }),
		]);
		expect(view.recordingAlias).toEqual({ [A]: C, [B]: C });
		expect(view.trackTags).toEqual([{ recordingId: C, tagId: TAG }]);
		expect(view.cues).toEqual([expect.objectContaining({ recordingId: C, slot: 0 })]);
	});

	it('the reverse chain order (B→C first, then A→B) also flattens', () => {
		const { view } = converge([
			op('recording', 'merge', B, { winner: C }, { ts: T(10, 0) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 5) }),
			op('library_track', 'set-rating', A, { rating: 1 }, { ts: T(11, 0) }),
		]);
		expect(view.recordingAlias).toEqual({ [A]: C, [B]: C });
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: C, rating: 1 })]);
	});

	it('opposite merges of one pair: the later op decides the direction, no cycle', () => {
		const { view } = converge([
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(9, 30) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0), device: 'desktop' }),
			op('recording', 'merge', B, { winner: A }, { ts: T(10, 5), device: 'phone' }),
		]);
		expect(view.recordingAlias).toEqual({ [B]: A });
		expect(view.trackTags).toEqual([{ recordingId: A, tagId: TAG }]);
	});

	// The alias rebuild was rewritten from re-pointing every alias per insert
	// to parent pointers (and a fast path for a merge newer than all others);
	// this is the old algorithm, kept as the reference it must match.
	function referenceAlias(state: LibraryState): Map<string, string> {
		const entries = [...state.merges.entries()].filter(([, m]) => m.winner !== null)
			.sort((a, b) => (a[1].clock.ts !== b[1].clock.ts ? b[1].clock.ts - a[1].clock.ts : a[1].clock.device !== b[1].clock.device ? (a[1].clock.device < b[1].clock.device ? 1 : -1) : a[1].clock.op < b[1].clock.op ? 1 : -1));
		const alias = new Map<string, string>();
		for (const [loser, m] of entries) {
			const winner = alias.get(m.winner!) ?? m.winner!;
			if (winner === loser) continue;
			alias.set(loser, winner);
			for (const [l, w] of alias) if (w === loser) alias.set(l, winner);
		}
		return alias;
	}
	const sortedEntries = (m: Map<string, string>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

	it('random merge and split sets: the alias map matches the reference in every arrival order', () => {
		let seed = 7;
		const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
		const ids = Array.from({ length: 7 }, () => uuid());
		for (let trial = 0; trial < 300; trial++) {
			const ops: Op[] = [];
			const n = 1 + rand(12);
			for (let i = 0; i < n; i++) {
				const loser = ids[rand(ids.length)]!;
				let winner = ids[rand(ids.length)]!;
				if (winner === loser) winner = ids[(ids.indexOf(loser) + 1) % ids.length]!;
				ops.push(op('recording', rand(6) === 0 ? 'split' : 'merge', loser, { winner }, { ts: T(10, rand(20)), device: rand(2) ? 'desktop' : 'phone' }));
			}
			let first: Array<[string, string]> | null = null;
			for (let shuffle = 0; shuffle < 4; shuffle++) {
				const order = shuffle === 0 ? ops : [...ops].sort(() => rand(3) - 1);
				const state = reduceAll(order);
				const got = sortedEntries(state.recordingAlias);
				expect(got, `trial ${trial}`).toEqual(sortedEntries(referenceAlias(state)));
				if (first === null) first = got;
				else expect(got, `trial ${trial} shuffle ${shuffle}`).toEqual(first);
			}
		}
	});

	it('the same merge from several devices folds once: the duplicates change nothing', () => {
		const ops = [
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(9, 30) }),
			op('library_track', 'set-rating', A, { rating: 4 }, { ts: T(9, 31) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0), device: 'desktop-1' }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 2), device: 'desktop-2' }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 1), device: 'desktop-3' }),
		];
		const { state, view } = converge(ops);
		const once = reduceAll(ops.slice(0, 4));
		expect(view).toEqual(materialize(once));
		expect(state.merges.get(A)!.clock.device).toBe('desktop-2');
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: B, rating: 4 })]);
	});

	it('thousands of merges in clock order apply in linear-ish time', () => {
		const state = createLibraryState();
		const losers = Array.from({ length: 5_000 }, () => uuid());
		const winners = Array.from({ length: 5_000 }, () => uuid());
		const t0 = performance.now();
		losers.forEach((l, i) => applyOp(state, op('recording', 'merge', l, { winner: winners[i]! }, { ts: T(10, 0) + i })));
		const ms = performance.now() - t0;
		expect(state.recordingAlias.size).toBe(5_000);
		// The old rebuild was O(M²) per merge: minutes here.
		expect(ms).toBeLessThan(5_000);
	});

	it('every later op addressed to the loser is redirected', () => {
		const state = reduceAll([op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) })]);
		const row = uuid();
		const event = uuid();
		applyOps(state, [
			op('library_track', 'set-rating', A, { rating: 5 }, { ts: T(10, 1) }),
			op('cue', 'upsert', cueEntityId(A, 1, 'hot'), { slot: 1, kind: 'hot', position_sec: 2, length_sec: null, color: null, name: null }, { ts: T(10, 1) }),
			op('recording_claim', 'add', A, { kind: 'isrc', value: 'GBAYE0000001', confidence: 1 }, { ts: T(10, 1) }),
			playlistCreate(),
			addRow(row, 'a0', { ts: T(10, 1) }, A),
			op(
				'play_event',
				'append',
				event,
				{
					session_id: uuid(),
					recording_id: A,
					source: 'spotify',
					played_at: T(10, 1),
					played_ms: null,
					duration_ms: null,
					max_position_ms: null,
					played75: null,
					ended_reason: null,
					context_type: null,
					context_id: null,
					track_no: null,
					rb_song_history_id: null,
				},
				{ ts: T(10, 1) },
			),
		]);
		const view = materialize(state);
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: B, rating: 5 })]);
		expect(view.cues).toEqual([expect.objectContaining({ recordingId: B })]);
		expect(view.claims).toEqual([expect.objectContaining({ recordingId: B, kind: 'isrc' })]);
		expect(view.playlistTracks).toEqual([expect.objectContaining({ id: row, recordingId: B })]);
		expect(view.playEvents).toEqual([expect.objectContaining({ id: event, recording_id: B })]);
		expect(state.libraryTracks.has(A)).toBe(false);
	});

	// A device applies its own ops before the server orders them, so a loser
	// edit can land before the merge on one device and after it on another.
	// `converge` applies one op at a time in every order as well as batched,
	// which is exactly that situation.
	const cueBody = (name: string, slot = 0) => ({ slot, kind: 'hot' as const, position_sec: 1, length_sec: null, color: null, name });

	it('fold: per-field data resolves by clock on either side of the merge, sets union', () => {
		const { view } = converge([
			op('library_track', 'set-rating', B, { rating: 2 }, { ts: T(9, 0) }),
			op('library_track', 'set-rating', A, { rating: 5 }, { ts: T(9, 5), device: 'phone' }),
			op('cue', 'upsert', cueEntityId(B, 0, 'hot'), cueBody('from B'), { ts: T(9, 0) }),
			op('cue', 'upsert', cueEntityId(A, 0, 'hot'), cueBody('from A'), { ts: T(9, 5), device: 'phone' }),
			op('cue', 'upsert', cueEntityId(A, 1, 'hot'), cueBody('A only', 1), { ts: T(9, 1) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) }),
		]);
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: B, rating: 5 })]);
		expect(view.cues.map((c) => [c.recordingId, c.slot, c.name])).toEqual([
			[B, 0, 'from A'],
			[B, 1, 'A only'],
		]);
	});

	it('fold: the merging device re-asserts the kept side, which beats earlier loser writes and loses to later ones', () => {
		const before = [
			op('library_track', 'set-rating', B, { rating: 2 }, { ts: T(9, 0) }),
			op('library_track', 'set-rating', A, { rating: 5 }, { ts: T(9, 5), device: 'phone' }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) }),
			// What the desktop's merge mutator emits with the merge: B's kept values.
			op('library_track', 'set-rating', B, { rating: 2 }, { ts: T(10, 0) }),
		];
		expect(converge(before).view.libraryTracks).toEqual([expect.objectContaining({ recordingId: B, rating: 2 })]);
		// The phone, still offline, rates the old row after the merge happened.
		const after = [...before, op('library_track', 'set-rating', A, { rating: 4 }, { ts: T(10, 30), device: 'phone' })];
		expect(converge(after).view.libraryTracks).toEqual([expect.objectContaining({ recordingId: B, rating: 4 })]);
	});

	it('fold: a cue delete or tag removal aimed at the loser reaches the winner in every order', () => {
		const cues = converge([
			op('cue', 'upsert', cueEntityId(A, 0, 'hot'), cueBody('from A'), { ts: T(9, 0) }),
			op('cue', 'upsert', cueEntityId(B, 0, 'hot'), cueBody('from B'), { ts: T(9, 10) }),
			op('cue', 'delete', cueEntityId(A, 0, 'hot'), {}, { ts: T(9, 30), device: 'phone' }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) }),
		]);
		expect(cues.view.cues).toEqual([]);
		const tags = converge([
			tagCreate(),
			op('track_tag', 'add', trackTagEntityId(A, TAG), {}, { ts: T(9, 5) }),
			op('track_tag', 'add', trackTagEntityId(B, TAG), {}, { ts: T(9, 15) }),
			op('track_tag', 'remove', trackTagEntityId(A, TAG), {}, { ts: T(9, 30), device: 'phone' }),
			op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) }),
		]);
		expect(tags.view.trackTags).toEqual([]);
	});

	it('split withdraws the alias by LWW against the merge; a stale split is ignored', () => {
		const merge = op('recording', 'merge', A, { winner: B }, { ts: T(10, 0) });
		expect(converge([merge, op('recording', 'split', A, { winner: B }, { ts: T(10, 5) })]).view.recordingAlias).toEqual({});
		expect(converge([merge, op('recording', 'split', A, { winner: B }, { ts: T(9, 55) })]).view.recordingAlias).toEqual({ [A]: B });
	});

	it('cloneLibraryState is a deep copy', () => {
		const state = reduceAll([tagCreate(), op('library_track', 'set-rating', A, { rating: 1 }, { ts: T(9, 0) })]);
		const copy = cloneLibraryState(state);
		expect(canonical(copy)).toEqual(canonical(state));
		applyOp(copy, op('tag', 'rename', TAG, { name: 'changed' }, { ts: T(10, 0) }));
		expect(state.tags.get(TAG)!.fields.name!.value).toBe('Peak');
		expect(copy.tags.get(TAG)!.fields.name!.value).toBe('changed');
	});
});

describe('track state (v2)', () => {
	it('set-state is per-field LWW in every order, independent of rating', () => {
		const { view } = converge([
			op('library_track', 'create', A, { added_at: T(8, 0) }, { ts: T(8, 0) }),
			op('library_track', 'set-state', A, { state: 'backlog' }, { ts: T(10, 0), device: 'desktop' }),
			op('library_track', 'set-state', A, { state: 'purchased' }, { ts: T(10, 5), device: 'phone' }),
			op('library_track', 'set-rating', A, { rating: 3 }, { ts: T(10, 1) }),
		]);
		expect(view.libraryTracks).toEqual([expect.objectContaining({ recordingId: A, state: 'purchased', rating: 3 })]);
	});

	it('a track never given a state reads null (the default); a merge folds the state by clock', () => {
		const { view } = converge([
			op('library_track', 'set-state', A, { state: 'backlog' }, { ts: T(10, 0) }),
			op('library_track', 'set-state', B, { state: 'progress' }, { ts: T(9, 0) }),
			op('library_track', 'set-rating', C, { rating: 1 }, { ts: T(9, 0) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(11, 0) }),
		]);
		const byId = Object.fromEntries(view.libraryTracks.map((t) => [t.recordingId, t]));
		expect(byId[B]!.state).toBe('backlog');
		expect(byId[C]!.state).toBeNull();
	});

	it('rejects an unknown state, and a v2 kind stamped v1', () => {
		expect(() => op('library_track', 'set-state', A, { state: 'archived' } as never, { ts: T(9, 0) })).toThrow(/invalid_payload/);
		expect(() =>
			parseOp({ op_id: uuid(), device_id: 'd', client_ts: 1, schema_version: 1, entity: 'library_track', entity_id: A, kind: 'set-state', payload: { state: 'backlog' } }),
		).toThrow(/schema_version/);
		// v1 kinds keep validating at v1.
		expect(parseOp({ op_id: uuid(), device_id: 'd', client_ts: 1, schema_version: 1, entity: 'library_track', entity_id: A, kind: 'set-rating', payload: { rating: 2 } }).kind).toBe('set-rating');
	});
});

describe('artist aliases (v2)', () => {
	// Keys here are lowercase names; the desktop uses @curator/shared artistKey.
	const rule = (from: string, to: string, at: Stamp) => op('artist_alias', 'set', from.toLowerCase(), { from, to, to_key: to.toLowerCase() }, at);
	const remove = (from: string, at: Stamp) => op('artist_alias', 'remove', from.toLowerCase(), {}, at);

	it('set then remove of one key is LWW in every order', () => {
		const later = converge([rule('Old', 'New', { ts: T(10, 0) }), remove('Old', { ts: T(10, 5), device: 'phone' })]);
		expect(later.view.artistAlias).toEqual({});
		const earlier = converge([rule('Old', 'New', { ts: T(10, 5) }), remove('Old', { ts: T(10, 0), device: 'phone' })]);
		expect(earlier.view.artistAlias).toEqual({ old: { name: 'New', key: 'new' } });
	});

	it('two devices renaming one artist differently: the later rule wins', () => {
		const { view } = converge([rule('Old', 'Desk', { ts: T(10, 0), device: 'desktop' }), rule('Old', 'Phone', { ts: T(10, 1), device: 'phone' })]);
		expect(view.artistAlias).toEqual({ old: { name: 'Phone', key: 'phone' } });
	});

	it('A→B and B→C resolve A to C in every order, whichever rule is later', () => {
		for (const [ab, bc] of [[T(10, 0), T(10, 5)], [T(10, 5), T(10, 0)]] as const) {
			const { view } = converge([rule('A', 'B', { ts: ab }), rule('B', 'C', { ts: bc })]);
			expect(view.artistAlias).toEqual({ a: { name: 'C', key: 'c' }, b: { name: 'C', key: 'c' } });
		}
	});

	it('a cycle keeps the later rules and drops the one that closes it, never looping', () => {
		const ab = converge([rule('A', 'B', { ts: T(10, 0) }), rule('B', 'A', { ts: T(10, 5), device: 'phone' })]);
		expect(ab.view.artistAlias).toEqual({ b: { name: 'A', key: 'a' } });
		const ba = converge([rule('A', 'B', { ts: T(10, 5) }), rule('B', 'A', { ts: T(10, 0), device: 'phone' })]);
		expect(ba.view.artistAlias).toEqual({ a: { name: 'B', key: 'b' } });
		const abc = converge([rule('A', 'B', { ts: T(10, 0) }), rule('B', 'C', { ts: T(10, 1) }), rule('C', 'A', { ts: T(10, 2) })]);
		expect(abc.view.artistAlias).toEqual({ b: { name: 'A', key: 'a' }, c: { name: 'A', key: 'a' } });
	});

	it('a spelling rule (to_key = its own key) ends a chain and gives the spelling', () => {
		const { view } = converge([
			op('artist_alias', 'set', 'bohmer', { from: 'Böhmer', to: 'Ben Bohmer', to_key: 'benbohmer' }, { ts: T(10, 0) }),
			op('artist_alias', 'set', 'benbohmer', { from: 'Ben Bohmer', to: 'Ben Böhmer', to_key: 'benbohmer' }, { ts: T(10, 1) }),
		]);
		expect(view.artistAlias).toEqual({ bohmer: { name: 'Ben Böhmer', key: 'benbohmer' }, benbohmer: { name: 'Ben Böhmer', key: 'benbohmer' } });
	});

	it('removing the middle of a chain re-resolves the head', () => {
		const { view } = converge([rule('A', 'B', { ts: T(10, 0) }), rule('B', 'C', { ts: T(10, 1) }), remove('B', { ts: T(10, 2) })]);
		expect(view.artistAlias).toEqual({ a: { name: 'B', key: 'b' } });
	});
});

// The emit side's no-op check: a fresh local op always carries a later clock,
// so applyOp always reports it as a change; isRestatement asks instead
// whether it would change a VALUE (see reduce.ts).
describe('isRestatement', () => {
	const at = { ts: T(9, 0) };
	const later = { ts: T(9, 30) };
	const fresh = (ops: Op[]): LibraryState => reduceAll(ops);
	const strip = (o: Op) => {
		const { op_id: _a, device_id: _b, client_ts: _c, schema_version: _d, ...rest } = o;
		return rest as Parameters<typeof isRestatement>[1];
	};

	it('an unseen record or cell is always a change (rows from before the op log must emit)', () => {
		const s = createLibraryState();
		expect(isRestatement(s, strip(op('library_track', 'set-rating', 'r1', { rating: null }, at)))).toBe(false);
		expect(isRestatement(s, strip(op('tag', 'delete', 't1', {}, at)))).toBe(false);
		expect(isRestatement(s, strip(op('track_tag', 'remove', trackTagEntityId('r1', 't1'), {}, at)))).toBe(false);
		expect(isRestatement(s, strip(op('cue', 'delete', cueEntityId('r1', 0, 'hot'), {}, at)))).toBe(false);
	});

	it('LWW fields: the same value is a restatement, a different one is not', () => {
		const s = fresh([op('library_track', 'set-rating', 'r1', { rating: 3 }, at), op('tag', 'create', 't1', { name: 'Vocal', kind: 'user', color: null }, at)]);
		expect(isRestatement(s, strip(op('library_track', 'set-rating', 'r1', { rating: 3 }, later)))).toBe(true);
		expect(isRestatement(s, strip(op('library_track', 'set-rating', 'r1', { rating: 4 }, later)))).toBe(false);
		expect(isRestatement(s, strip(op('tag', 'create', 't1', { name: 'Vocal', kind: 'user', color: null }, later)))).toBe(true);
		expect(isRestatement(s, strip(op('tag', 'rename', 't1', { name: 'Vocals' }, later)))).toBe(false);
	});

	it('set membership follows add-wins: re-adding a removed row is a change', () => {
		const k = trackTagEntityId('r1', 't1');
		const added = fresh([op('track_tag', 'add', k, {}, at)]);
		expect(isRestatement(added, strip(op('track_tag', 'add', k, {}, later)))).toBe(true);
		expect(isRestatement(added, strip(op('track_tag', 'remove', k, {}, later)))).toBe(false);
		const removed = fresh([op('track_tag', 'add', k, {}, at), op('track_tag', 'remove', k, {}, later)]);
		expect(isRestatement(removed, strip(op('track_tag', 'add', k, {}, { ts: T(10, 0) })))).toBe(false);
		expect(isRestatement(removed, strip(op('track_tag', 'remove', k, {}, { ts: T(10, 0) })))).toBe(true);
	});

	it('playlist rows: same binding and key is a restatement, a move is not', () => {
		const s = fresh([op('playlist_track', 'add', 'row1', { playlist_id: 'p1', recording_id: 'r1', order_key: 'a0' }, at)]);
		expect(isRestatement(s, strip(op('playlist_track', 'add', 'row1', { playlist_id: 'p1', recording_id: 'r1', order_key: 'a0' }, later)))).toBe(true);
		expect(isRestatement(s, strip(op('playlist_track', 'move', 'row1', { order_key: 'a0' }, later)))).toBe(true);
		expect(isRestatement(s, strip(op('playlist_track', 'move', 'row1', { order_key: 'a1' }, later)))).toBe(false);
		expect(isRestatement(s, strip(op('playlist_track', 'add', 'row1', { playlist_id: 'p2', recording_id: 'r1', order_key: 'a0' }, later)))).toBe(false);
	});

	it('cues compare the whole body; a deleted slot re-upserted is a change', () => {
		const id = cueEntityId('r1', 0, 'hot');
		const body = { slot: 0, kind: 'hot' as const, position_sec: 12.5, length_sec: null, color: null, name: null };
		const s = fresh([op('cue', 'upsert', id, body, at)]);
		expect(isRestatement(s, strip(op('cue', 'upsert', id, body, later)))).toBe(true);
		expect(isRestatement(s, strip(op('cue', 'upsert', id, { ...body, position_sec: 13 }, later)))).toBe(false);
		const gone = fresh([op('cue', 'upsert', id, body, at), op('cue', 'delete', id, {}, later)]);
		expect(isRestatement(gone, strip(op('cue', 'upsert', id, body, { ts: T(10, 0) })))).toBe(false);
		expect(isRestatement(gone, strip(op('cue', 'delete', id, {}, { ts: T(10, 0) })))).toBe(true);
	});

	it('plays and sessions restate by value (the rekordbox history re-import)', () => {
		const ev = { session_id: 's1', recording_id: 'r1', source: 'rekordbox' as const, played_at: null, played_ms: null, duration_ms: null, max_position_ms: null, played75: null, ended_reason: null, context_type: null, context_id: null, track_no: 1, rb_song_history_id: 'h1' };
		const sess = { origin: 'rekordbox' as const, kind: 'set' as const, kind_source: 'auto' as const, name: 'HISTORY', started_at: T(8, 0), ended_at: null, rb_history_id: 'H' };
		const s = fresh([op('play_event', 'append', 'e1', ev, at), op('play_session', 'append', 's1', sess, at)]);
		expect(isRestatement(s, strip(op('play_event', 'append', 'e1', ev, later)))).toBe(true);
		expect(isRestatement(s, strip(op('play_event', 'append', 'e1', { ...ev, track_no: 2 }, later)))).toBe(false);
		expect(isRestatement(s, strip(op('play_session', 'append', 's1', sess, later)))).toBe(true);
		expect(isRestatement(s, strip(op('play_session', 'set-kind', 's1', { kind: 'set' }, later)))).toBe(false); // kind_source flips to user
	});

	it('merges and alias rules are never restatements: their clock order is the outcome', () => {
		const s = fresh([op('recording', 'merge', 'r2', { winner: 'r1' }, at), op('artist_alias', 'set', 'a', { from: 'A', to: 'B', to_key: 'b' }, at)]);
		expect(isRestatement(s, strip(op('recording', 'merge', 'r2', { winner: 'r1' }, later)))).toBe(false);
		expect(isRestatement(s, strip(op('artist_alias', 'set', 'a', { from: 'A', to: 'B', to_key: 'b' }, later)))).toBe(false);
	});
});

// set-rb-analysis (first emitted 2026-10-20): each unit its own LWW field, in
// every order, folded by clock through a recording merge like any field.
describe('rekordbox analysis units', () => {
	const g1 = [1, 3, 1, 1000, 469, 0, 0];
	const g2 = [1, 4, 1, 1010, 468, 1, 0, 1];
	const segs = [{ startSec: 0, endSec: 32.1, label: 'Intro 1', source: 'rekordbox', rbKind: 1 }];

	it('two devices import different grids, keys and phrases: the later write per unit wins in every order', () => {
		const { view } = converge([
			op('library_track', 'set-rb-analysis', A, { unit: 'grid', value: g1 }, { ts: T(10, 0), device: 'desktop' }),
			op('library_track', 'set-rb-analysis', A, { unit: 'grid', value: g2 }, { ts: T(10, 5), device: 'laptop' }),
			op('library_track', 'set-rb-analysis', A, { unit: 'key', value: '8A' }, { ts: T(10, 6), device: 'desktop' }),
			op('library_track', 'set-rb-analysis', A, { unit: 'key', value: '9A' }, { ts: T(10, 1), device: 'laptop' }),
			op('library_track', 'set-rb-analysis', A, { unit: 'segments', value: segs }, { ts: T(10, 2), device: 'laptop' }),
			op('library_track', 'set-rb-analysis', A, { unit: 'segments', value: null }, { ts: T(10, 1), device: 'desktop' }),
		]);
		expect(view.libraryTracks[0]!.rb).toEqual({ grid: g2, key: '8A', segments: segs });
	});

	it('a null clears a unit; re-applying any op changes nothing', () => {
		const set = op('library_track', 'set-rb-analysis', A, { unit: 'grid', value: g1 }, { ts: T(10, 0) });
		const clear = op('library_track', 'set-rb-analysis', A, { unit: 'grid', value: null }, { ts: T(10, 5) });
		const { state, view } = converge([set, clear]);
		expect(view.libraryTracks[0]!.rb).toEqual({});
		const before = canonical(state);
		expect(applyOp(state, set).changed).toEqual([]);
		expect(applyOp(state, clear).changed).toEqual([]);
		expect(canonical(state)).toEqual(before);
	});

	it('a merge folds each unit by clock, whether the loser\'s units arrive before or after it', () => {
		const { view } = converge([
			op('library_track', 'set-rb-analysis', A, { unit: 'grid', value: g1 }, { ts: T(10, 5) }),
			op('library_track', 'set-rb-analysis', B, { unit: 'grid', value: g2 }, { ts: T(10, 0) }),
			op('library_track', 'set-rb-analysis', B, { unit: 'key', value: '3B' }, { ts: T(10, 0) }),
			op('recording', 'merge', A, { winner: B }, { ts: T(11, 0) }),
		]);
		expect(view.libraryTracks.find((t) => t.recordingId === B)!.rb).toEqual({ grid: g1, key: '3B' });
	});

	it('restating the same grid is a restatement; a changed one is not', () => {
		const s = reduceAll([op('library_track', 'set-rb-analysis', 'r1', { unit: 'grid', value: g1 }, { ts: T(9, 0) })]);
		const again = (payload: PayloadOf<'library_track', 'set-rb-analysis'>) => ({ entity: 'library_track' as const, entity_id: 'r1', kind: 'set-rb-analysis' as const, payload });
		expect(isRestatement(s, again({ unit: 'grid', value: [...g1] }))).toBe(true);
		expect(isRestatement(s, again({ unit: 'grid', value: g2 }))).toBe(false);
		expect(isRestatement(s, again({ unit: 'key', value: '8A' }))).toBe(false);
	});
});

// Unfinalised plays (2026-10-20): a curator play the tracker never finalised
// (quit, crash, reload) is finalised on this device as 'interrupted' and
// appended then; if the play turns out to be alive after all, its real
// finalise is a later append of the same row. Append is LWW on the clock, so
// every order lands on the latest.
describe('unfinalised plays', () => {
	const session = uuid();
	const event = uuid();
	const base = {
		session_id: session, recording_id: A, source: 'local' as const, played_at: T(9, 0), played_ms: 42_000, duration_ms: 240_000,
		max_position_ms: 42_000, played75: false, ended_reason: 'interrupted' as const, context_type: null, context_id: null, track_no: null, rb_song_history_id: null,
	};
	const sess = (ended: number) => op('play_session', 'append', session, { origin: 'curator', kind: 'prep', kind_source: 'auto', name: null, started_at: T(9, 0), ended_at: ended, rb_history_id: null }, { ts: T(12, 0) });

	it('the interrupted append and a later real finalise converge on the finalise in every order', () => {
		const interrupted = op('play_event', 'append', event, base, { ts: T(12, 0) });
		const finalised = op('play_event', 'append', event, { ...base, played_ms: 200_000, max_position_ms: 230_000, played75: true, ended_reason: 'ended' }, { ts: T(12, 30) });
		const { view } = converge([sess(T(9, 1)), interrupted, finalised]);
		expect(view.playEvents).toEqual([expect.objectContaining({ id: event, ended_reason: 'ended', played_ms: 200_000 })]);
		expect(view.playSessions).toHaveLength(1);
	});

	it('the same interrupted append twice (a second sweep, a retried push) is one row', () => {
		const a = op('play_event', 'append', event, base, { ts: T(12, 0) });
		const state = reduceAll([sess(T(9, 1)), a]);
		const before = canonical(state);
		expect(applyOp(state, a).changed).toEqual([]);
		expect(canonical(state)).toEqual(before);
		const { op_id: _a, device_id: _b, client_ts: _c, schema_version: _d, ...body } = a;
		expect(isRestatement(state, body as Parameters<typeof isRestatement>[1])).toBe(true);
	});
});

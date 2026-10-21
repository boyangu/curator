import { randomUUID } from 'node:crypto';
import { MAX_PUSH_OPS, MAX_PULL_OPS, SCHEMA_VERSION, SYNC_FEATURES, trackTagEntityId } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorReason, opsFor, sampleLibrary, wakeups, type TestApp } from '../test/harness.js';
import { buildSnapshot } from '../snapshot/job.js';
import { decodeSnapshotBase64 } from '../snapshot/codec.js';
import { hasUnstorableText } from './push.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

const rowCount = async (userId: string) =>
	(await app.pg.query<{ n: number }>('select count(*)::int as n from curator.library_op where user_id = $1', [userId])).rows[0]!.n;

describe('sync.push / sync.pull', () => {
	it('round-trips ops in seq order with the server fields filled in', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const ops = sampleLibrary(deviceId);
		const res = await api.sync.push.mutate({ deviceId, ops });
		expect(res.rejected).toEqual([]);
		expect(res.accepted).toBe(ops.length);

		const pulled = await api.sync.pull.query({ afterSeq: 0 });
		expect(pulled.ops.map((o) => o.op_id)).toEqual(ops.map((o) => o.op_id));
		const seqs = pulled.ops.map((o) => o.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(pulled.nextSeq).toBe(seqs[seqs.length - 1]);
		expect(res.maxSeq).toBe(pulled.nextSeq);
		for (const [i, o] of pulled.ops.entries()) {
			expect(o.user_id).toBe(userId);
			expect(o.received_at).toBeGreaterThan(Date.now() - 60_000);
			// Everything the device sent comes back as sent.
			expect({ ...o, seq: undefined, user_id: undefined, received_at: undefined }).toEqual({ ...ops[i], seq: undefined, user_id: undefined, received_at: undefined });
		}
	});

	it('pages with nextSeq, caps the limit, and returns nothing past the head', async () => {
		const { deviceId, api } = await app.signIn();
		const ops = sampleLibrary(deviceId, 2);
		await api.sync.push.mutate({ deviceId, ops });
		const first = await api.sync.pull.query({ afterSeq: 0, limit: 10 });
		expect(first.ops).toHaveLength(10);
		const rest = await api.sync.pull.query({ afterSeq: first.nextSeq, limit: 1_000_000 });
		expect([...first.ops, ...rest.ops].map((o) => o.op_id)).toEqual(ops.map((o) => o.op_id));
		const empty = await api.sync.pull.query({ afterSeq: rest.nextSeq });
		expect(empty).toEqual({ ops: [], nextSeq: rest.nextSeq, features: [...SYNC_FEATURES] });
		expect(MAX_PULL_OPS).toBe(1000);
	});

	it('treats a re-push as accepted with no new rows and no new wake-up', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const ops = sampleLibrary(deviceId);
		const first = await api.sync.push.mutate({ deviceId, ops });
		const rows = await rowCount(userId);
		const wakes = (await wakeups(app.pg, userId)).length;

		const again = await api.sync.push.mutate({ deviceId, ops });
		// Nothing outside the batch is this device's: priorOwnMaxSeq 0.
		expect(again).toEqual({ accepted: ops.length, maxSeq: first.maxSeq, rejected: [], clamped: [], batchMaxSeq: first.batchMaxSeq, priorOwnMaxSeq: 0, features: [...SYNC_FEATURES] });
		expect(first.batchMaxSeq).toBe(first.maxSeq);
		expect(await rowCount(userId)).toBe(rows);
		expect((await wakeups(app.pg, userId)).length).toBe(wakes);

		// A partial overlap lands only the new ops, in one more wake-up.
		const more = opsFor(deviceId)('tag', 'create', randomUUID(), { name: 'late', kind: 'user' });
		const mixed = await api.sync.push.mutate({ deviceId, ops: [...ops.slice(0, 3), more] });
		expect(mixed.accepted).toBe(4);
		expect(await rowCount(userId)).toBe(rows + 1);
		expect((await wakeups(app.pg, userId)).length).toBe(wakes + 1);
	});

	it('also dedupes an op id repeated inside one batch', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const [a] = sampleLibrary(deviceId);
		const res = await api.sync.push.mutate({ deviceId, ops: [a, a] });
		expect(res).toMatchObject({ accepted: 2, rejected: [] });
		expect(await rowCount(userId)).toBe(1);
	});

	it('sends one wake-up per push statement, carrying the batch head seq, on the owner topic', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const ops = sampleLibrary(deviceId, 3);
		const before = await wakeups(app.pg, userId);
		expect(before).toEqual([]);
		const a = await api.sync.push.mutate({ deviceId, ops: ops.slice(0, 40) });
		const b = await api.sync.push.mutate({ deviceId, ops: ops.slice(40) });
		const after = await wakeups(app.pg, userId);
		expect(after).toEqual([
			{ topic: `user:${userId}`, event: 'wake', payload: { seq: a.maxSeq } },
			{ topic: `user:${userId}`, event: 'wake', payload: { seq: b.maxSeq } },
		]);
	});

	it('does not write or wake for an empty or all-rejected push', async () => {
		const { userId, deviceId, api } = await app.signIn();
		expect(await api.sync.push.mutate({ deviceId, ops: [] })).toEqual({ accepted: 0, maxSeq: 0, rejected: [], clamped: [], batchMaxSeq: 0, features: [...SYNC_FEATURES] });
		const bad = await api.sync.push.mutate({ deviceId, ops: [{ nope: true }] });
		expect(bad.rejected).toEqual([{ opId: '', reason: 'malformed' }]);
		expect(await rowCount(userId)).toBe(0);
		expect(await wakeups(app.pg, userId)).toEqual([]);
	});
});

describe('per-op rejections', () => {
	it('rejects malformed ops one by one and accepts the rest', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const good1 = op('tag', 'create', randomUUID(), { name: 'ok', kind: 'user' });
		const good2 = op('library_track', 'set-rating', randomUUID(), { rating: 3 });
		const unknownEntity = { ...good1, op_id: randomUUID(), entity: 'galaxy' };
		const unknownKind = { ...good1, op_id: randomUUID(), kind: 'explode' };
		const badPayload = { ...good2, op_id: randomUUID(), payload: { rating: 11 } };
		const extraField = { ...good1, op_id: randomUUID(), payload: { name: 'x', kind: 'user', evil: 1 } };
		const badCompositeId = op('track_tag', 'add', trackTagEntityId(randomUUID(), 't'), {});
		const brokenId = { ...badCompositeId, op_id: randomUUID(), entity_id: 'no-colon' };
		const tooBig = { ...good1, op_id: randomUUID(), payload: { name: 'x'.repeat(17 * 1024), kind: 'user' } };
		const notAnObject = 42;

		const res = await api.sync.push.mutate({
			deviceId,
			ops: [good1, unknownEntity, unknownKind, badPayload, extraField, brokenId, tooBig, notAnObject, good2],
		});
		expect(res.accepted).toBe(2);
		expect(res.rejected).toEqual([
			{ opId: unknownEntity.op_id, reason: 'unknown_entity' },
			{ opId: unknownKind.op_id, reason: 'unknown_kind' },
			{ opId: badPayload.op_id, reason: 'invalid_payload' },
			{ opId: extraField.op_id, reason: 'invalid_payload' },
			{ opId: brokenId.op_id, reason: 'invalid_payload' },
			{ opId: tooBig.op_id, reason: 'payload_too_large' },
			{ opId: '', reason: 'malformed' },
		]);
		const pulled = await api.sync.pull.query({ afterSeq: 0 });
		expect(pulled.ops.map((o) => o.op_id)).toEqual([good1.op_id, good2.op_id]);
		expect(await rowCount(userId)).toBe(2);
	});

	it('rejects text Postgres cannot store per op instead of failing the batch', async () => {
		expect(hasUnstorableText({ a: ['ok', 'nul\u0000'] })).toBe(true);
		expect(hasUnstorableText({ ['k\ud800']: 1 })).toBe(true);
		expect(hasUnstorableText('lone \udc00 low')).toBe(true);
		expect(hasUnstorableText('pair 🎵 ok')).toBe(false);

		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const good = op('tag', 'create', randomUUID(), { name: 'emoji 🎵', kind: 'user' });
		const nul = op('tag', 'create', randomUUID(), { name: 'a\u0000b', kind: 'user' });
		const surrogate = op('tag', 'rename', randomUUID(), { name: 'half \ud800' });
		const res = await api.sync.push.mutate({ deviceId, ops: [nul, good, surrogate] });
		expect(res.accepted).toBe(1);
		expect(res.rejected).toEqual([
			{ opId: nul.op_id, reason: 'invalid_payload' },
			{ opId: surrogate.op_id, reason: 'invalid_payload' },
		]);
		const [stored] = (await api.sync.pull.query({ afterSeq: 0 })).ops;
		expect(stored!.payload).toEqual({ name: 'emoji 🎵', kind: 'user' });
	});

	it('rejects an op stamped with another device id', async () => {
		const { deviceId, api } = await app.signIn();
		const foreign = opsFor('some-other-device')('tag', 'create', randomUUID(), { name: 'x', kind: 'user' });
		const res = await api.sync.push.mutate({ deviceId, ops: [foreign] });
		expect(res).toMatchObject({ accepted: 0, rejected: [{ opId: foreign.op_id, reason: 'not_owner' }] });
	});
});

describe('schema version gate', () => {
	it('answers update_required below the minimum, even for a payload today’s schema would reject', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const current = op('tag', 'create', randomUUID(), { name: 'now', kind: 'user' });
		const old = { ...op('tag', 'create', randomUUID(), { name: 'then', kind: 'user' }), schema_version: 0 };
		const oldShape = { ...old, op_id: randomUUID(), payload: { label: 'obsolete field name' } };
		const res = await api.sync.push.mutate({ deviceId, ops: [old, current, oldShape] });
		expect(res.accepted).toBe(1);
		expect(res.rejected).toEqual([
			{ opId: old.op_id, reason: 'update_required' },
			{ opId: oldShape.op_id, reason: 'update_required' },
		]);
	});

	it('refuses the whole call when an op is newer than the server, so the device retries instead of dropping it', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const ok = op('tag', 'create', randomUUID(), { name: 'fine', kind: 'user' });
		const future = { ...op('tag', 'create', randomUUID(), { name: 'from v+1', kind: 'user' }), schema_version: SCHEMA_VERSION + 1 };
		expect(await errorReason(api.sync.push.mutate({ deviceId, ops: [ok, future] }))).toMatchObject({
			code: 'PRECONDITION_FAILED',
			reason: 'server_outdated',
		});
		expect(await rowCount(userId)).toBe(0);
	});
});

describe('protocol v2 kinds', () => {
	it('accepts library_track.set-state and artist_alias set/remove, and pulls them back as sent', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const rec = randomUUID();
		const ops = [
			op('library_track', 'set-state', rec, { state: 'backlog' }),
			op('artist_alias', 'set', 'oldname', { from: 'Old Name', to: 'New Name', to_key: 'newname' }),
			op('artist_alias', 'set', 'newname', { from: 'New Name', to: 'New Name', to_key: 'newname' }),
			op('artist_alias', 'remove', 'gone', {}),
		];
		const res = await api.sync.push.mutate({ deviceId, ops });
		expect(res).toMatchObject({ accepted: ops.length, rejected: [] });
		const pulled = await api.sync.pull.query({ afterSeq: 0 });
		expect(pulled.ops.map((o) => [o.entity, o.kind, o.entity_id, o.payload, o.schema_version])).toEqual(ops.map((o) => [o.entity, o.kind, o.entity_id, o.payload, SCHEMA_VERSION]));
	});

	it('still accepts a v1-stamped v1 kind, and rejects a v2 kind stamped v1 or an unknown state', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const rec = randomUUID();
		const v1Rating = { ...op('library_track', 'set-rating', rec, { rating: 3 }), schema_version: 1 };
		const v1State = { ...op('library_track', 'set-state', rec, { state: 'backlog' }), schema_version: 1 };
		const badState = { ...op('library_track', 'set-state', rec, { state: 'backlog' }), payload: { state: 'archived' } };
		const res = await api.sync.push.mutate({ deviceId, ops: [v1Rating, v1State, badState] });
		expect(res.accepted).toBe(1);
		expect(res.rejected).toEqual([
			{ opId: v1State.op_id, reason: 'invalid_payload' },
			{ opId: badState.op_id, reason: 'invalid_payload' },
		]);
	});
});

describe('protocol v4 kinds (the zero-loss release)', () => {
	const attrs = {
		source: 'local' as const, bpm: 122.5, key_camelot: '8A', key_source: 'rekordbox' as const, explicit: false,
		mbid: null, copyright: null, play_count: 79, provider_refs: [], artist_names: ['Bonobo'],
	};
	const cueBody = { slot: 1, kind: 'hot' as const, position_sec: 10, length_sec: null, color: null, name: null };
	const event = {
		session_id: randomUUID(), recording_id: randomUUID(), source: 'rekordbox' as const, played_at: 1_700_000_000_000, played_ms: null, duration_ms: null, max_position_ms: null,
		played75: null, ended_reason: null, context_type: null, context_id: null, track_no: 1, rb_song_history_id: '9',
	};
	const v4Ops = (deviceId: string) => {
		const op = opsFor(deviceId);
		const rec = randomUUID();
		return [
			op('library_track', 'set-attrs', rec, attrs),
			op('library_track', 'set-cues-edited', rec, { at: 1_700_000_000_000 }),
			op('library_track', 'set-curation', rec, { field: 'comment', value: 'ethnic, up' }),
			op('library_track', 'set-rb-analysis', rec, { unit: 'bpm', value: 120.0006 }),
			op('library_track', 'set-rb-analysis', rec, { unit: 'key_strength', value: 0.61 }),
			op('recording_claim', 'add', rec, { kind: 'traxsource', value: '7574432', confidence: 0.7 }),
			op('cue', 'upsert2', `${rec}:1:hot`, { ...cueBody, origin: 'rekordbox' }),
			op('play_event', 'append2', randomUUID(), { ...event, rb_content_id: '98765', source_track_id: null }),
			op('playlist', 'set-attrs', randomUUID(), { hybrid_tidal: true, position: 5, mark: 'R' }),
			op('playlist_folder', 'set-attrs', randomUUID(), { position: 2 }),
			op('feed_item', 'set-state', 'isrc:GB0000000001', { state: 'archived' }),
			op('feed_item', 'mark-played', 'spotify:track:abc', { at: 1_700_000_000_000 }),
			op('feed_item', 'mark-listened', 'spotify:album:xyz', { source_track_id: 'abc' }),
			op('feed_suppression', 'set', 'artist:ar1', { scope: 'artist', active: true }),
			op('album', 'set-meta', 'spotify:al1', { album_type: 'album', total_tracks: 12, release_date: '2022', label: 'Ninja Tune', upc: '1', cover_url: null, artists: ['Bonobo'], various: false }),
		];
	};

	it('advertises zero_loss_v4, accepts every v4 kind, claim kind and unit, and pulls them back as sent (no migration: ops are jsonb)', async () => {
		const { deviceId, api } = await app.signIn();
		const ops = v4Ops(deviceId);
		expect(ops.every((o) => o.schema_version === 4)).toBe(true);
		const res = await api.sync.push.mutate({ deviceId, ops });
		expect(res).toMatchObject({ accepted: ops.length, rejected: [] });
		expect(res.features).toContain('zero_loss_v4');
		const pulled = await api.sync.pull.query({ afterSeq: 0 });
		expect(pulled.features).toContain('zero_loss_v4');
		expect(pulled.ops.map((o) => [o.entity, o.kind, o.entity_id, o.payload, o.schema_version])).toEqual(ops.map((o) => [o.entity, o.kind, o.entity_id, o.payload, 4]));
	});

	it('rejects every one of them stamped v3: a v3 client must hold them aside, not stop', async () => {
		const { deviceId, api } = await app.signIn();
		const ops = v4Ops(deviceId).map((o) => ({ ...o, schema_version: 3 }));
		const res = await api.sync.push.mutate({ deviceId, ops });
		expect(res.accepted).toBe(0);
		expect(res.rejected.map((r) => r.reason)).toEqual(ops.map(() => 'invalid_payload'));
	});

	it('folds them into the snapshot: a bootstrap carries the feed decisions and releases (new maps) and the attribute cells', async () => {
		const { deviceId, api, userId } = await app.signIn();
		const ops = v4Ops(deviceId);
		await api.sync.push.mutate({ deviceId, ops });
		const built = await buildSnapshot(app.db, userId);
		expect(built.status).toBe('built');
		const state = await decodeSnapshotBase64((await api.sync.bootstrap.query()).snapshot);
		expect(state.feedItems.get('isrc:GB0000000001')?.fields['state']?.value).toBe('archived');
		expect(state.feedSuppressions.get('artist:ar1')?.fields['active']?.value).toBe(true);
		expect(state.albums.get('spotify:al1')?.fields['label']?.value).toBe('Ninja Tune');
		const rec = ops[0]!.entity_id;
		expect(Object.keys(state.libraryTracks.get(rec)!.fields).sort()).toEqual([`attrs.${deviceId}`, 'cues_edited_at', 'curation.comment', 'rb.bpm', 'rb.key_strength']);
	});
});

describe('protocol v3 kinds', () => {
	const meta = { source: 'local' as const, title: 'Lilac', artists: [{ name: 'Bonobo' }], album_title: null, duration_sec: 312, isrc: null, release_date: null, label: null, genre: null, cover_url: 'https://i.scdn.co/image/x' };

	it('advertises track_meta, accepts set-meta and the master device setting, and pulls them back as sent', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const rec = randomUUID();
		const ops = [
			op('library_track', 'set-meta', rec, meta),
			op('setting', 'set', 'library.master_device', { value: deviceId }),
		];
		const res = await api.sync.push.mutate({ deviceId, ops });
		expect(res).toMatchObject({ accepted: 2, rejected: [] });
		expect(res.features).toContain('track_meta');
		const pulled = await api.sync.pull.query({ afterSeq: 0 });
		expect(pulled.features).toContain('track_meta');
		expect(pulled.ops.map((o) => [o.entity, o.kind, o.entity_id, o.payload, o.schema_version])).toEqual(ops.map((o) => [o.entity, o.kind, o.entity_id, o.payload, SCHEMA_VERSION]));
	});

	it('rejects either stamped v2 (a v2 client must hold them aside, not stop) and a non-http cover', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const rec = randomUUID();
		const v2Meta = { ...op('library_track', 'set-meta', rec, meta), schema_version: 2 };
		const v2Master = { ...op('setting', 'set', 'library.master_device', { value: deviceId }), schema_version: 2 };
		const fileCover = { ...op('library_track', 'set-meta', rec, meta), payload: { ...meta, cover_url: 'file:///C:/a.jpg' } };
		const res = await api.sync.push.mutate({ deviceId, ops: [v2Meta, v2Master, fileCover] });
		expect(res.accepted).toBe(0);
		expect(res.rejected).toEqual([
			{ opId: v2Meta.op_id, reason: 'invalid_payload' },
			{ opId: v2Master.op_id, reason: 'invalid_payload' },
			{ opId: fileCover.op_id, reason: 'invalid_payload' },
		]);
	});
});

describe('devices and pushes', () => {
	it('refuses a push from an unregistered device as a whole-call error', async () => {
		const { userId, api } = await app.signIn();
		const ghost = 'never-registered';
		const op = opsFor(ghost)('tag', 'create', randomUUID(), { name: 'x', kind: 'user' });
		expect(await errorReason(api.sync.push.mutate({ deviceId: ghost, ops: [op] }))).toMatchObject({
			code: 'PRECONDITION_FAILED',
			reason: 'device_not_registered',
		});
		expect(await rowCount(userId)).toBe(0);
	});

	it('rejects every op from a revoked device and stores nothing', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const ops = sampleLibrary(deviceId).slice(0, 5);
		await api.account.revokeDevice.mutate({ deviceId });
		const res = await api.sync.push.mutate({ deviceId, ops });
		expect(res.accepted).toBe(0);
		expect(res.rejected).toEqual(ops.map((o) => ({ opId: o.op_id, reason: 'device_revoked' })));
		expect(await rowCount(userId)).toBe(0);
		expect(await wakeups(app.pg, userId)).toEqual([]);
	});

	it('moves last_seen_at on push', async () => {
		const { deviceId, api } = await app.signIn();
		await app.pg.query(`update curator.device set last_seen_at = now() - interval '1 day' where device_id = $1`, [deviceId]);
		const stale = (await api.account.devices.query())[0]!.lastSeenAt!;
		await api.sync.push.mutate({ deviceId, ops: [] });
		const fresh = (await api.account.devices.query())[0]!.lastSeenAt!;
		expect(fresh - stale).toBeGreaterThan(23 * 3600_000);
	});
});

describe('limits and clocks', () => {
	it('refuses a batch over 500 ops or 1 MB as batch_too_large', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const many = Array.from({ length: MAX_PUSH_OPS + 1 }, () => op('library_track', 'set-rating', randomUUID(), { rating: 1 }));
		expect(await errorReason(api.sync.push.mutate({ deviceId, ops: many }))).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', reason: 'batch_too_large' });
		const fat = Array.from({ length: 80 }, () => op('tag', 'create', randomUUID(), { name: 'x'.repeat(15 * 1024), kind: 'user' }));
		expect(await errorReason(api.sync.push.mutate({ deviceId, ops: fat }))).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', reason: 'batch_too_large' });
	});

	it('clamps a client_ts far in the future to the server clock and logs it', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const fast = op('library_track', 'set-rating', randomUUID(), { rating: 2 }, Date.now() + 3600_000);
		const skewed = op('library_track', 'set-rating', randomUUID(), { rating: 2 }, Date.now() + 60_000);
		await api.sync.push.mutate({ deviceId, ops: [fast, skewed] });
		const [a, b] = (await api.sync.pull.query({ afterSeq: 0 })).ops;
		expect(a!.client_ts).toBe(a!.received_at);
		// Ordinary skew within MAX_CLOCK_SKEW_MS keeps the device's own stamp.
		expect(b!.client_ts).toBe(skewed.client_ts);
		expect(app.logs.some((l) => l.msg === 'client_ts_clamped' && l.deviceId === deviceId && l.count === 1)).toBe(true);
	});
});

describe('far-behind hint', () => {
	it('names the snapshot when the cursor is more than farBehindOps behind it, or older than farBehindMs', async () => {
		const small = await createTestApp({ pull: { farBehindOps: 10, farBehindMs: 30 * 24 * 3600_000 } });
		try {
			const { userId, deviceId, api } = await small.signIn();
			const ops = sampleLibrary(deviceId, 2);
			await api.sync.push.mutate({ deviceId, ops });
			// No snapshot yet: nothing better to offer than replay.
			expect((await api.sync.pull.query({ afterSeq: 0 })).snapshotSeq).toBeUndefined();

			const { buildSnapshot } = await import('../snapshot/job.js');
			const snap = await buildSnapshot(small.db, userId);
			expect(snap.status).toBe('built');
			const snapshotSeq = snap.status === 'built' ? snap.snapshotSeq : -1;
			const all = (await api.sync.pull.query({ afterSeq: 0 })).ops;

			expect((await api.sync.pull.query({ afterSeq: 0 })).snapshotSeq).toBe(snapshotSeq);
			// 10 ops behind the snapshot is not "more than 10".
			const tenBehind = all[all.length - 11]!.seq;
			expect((await api.sync.pull.query({ afterSeq: tenBehind })).snapshotSeq).toBeUndefined();
			expect((await api.sync.pull.query({ afterSeq: all[all.length - 12]!.seq })).snapshotSeq).toBe(snapshotSeq);
			// At or past the snapshot there is never a hint.
			expect((await api.sync.pull.query({ afterSeq: snapshotSeq })).snapshotSeq).toBeUndefined();

			// A cursor whose op is older than the window gets the hint too.
			await small.pg.query(`update curator.library_op set received_at = now() - interval '31 days' where seq <= $1`, [tenBehind]);
			expect((await api.sync.pull.query({ afterSeq: tenBehind })).snapshotSeq).toBe(snapshotSeq);
			// The hint rides along with the page; the ops still come.
			expect((await api.sync.pull.query({ afterSeq: tenBehind })).ops).toHaveLength(10);
		} finally {
			await small.db.close();
		}
	});
});

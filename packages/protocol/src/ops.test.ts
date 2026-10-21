import { describe, it, expect } from 'vitest';
import {
	cueEntityId,
	ENTITIES,
	isAccountSettingKey,
	kindsOf,
	MASTER_DEVICE_SETTING,
	MAX_OP_PAYLOAD_BYTES,
	MIN_SUPPORTED_SCHEMA_VERSION,
	OP_SCHEMAS,
	opPayloadBytes,
	OpValidationError,
	opSchemaVersion,
	parseCueEntityId,
	parseOp,
	parseTrackTagEntityId,
	safeParseOp,
	SCHEMA_VERSION,
	schemaVersionStatus,
	trackTagEntityId,
	utf8ByteLength,
	ZOp,
	type Entity,
} from './ops.js';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REC_A = U(1);
const REC_B = U(2);
const TAG = U(10);
const PL = U(20);
const ROW = U(30);
const SESSION = U(40);

function envelope(entity: Entity, kind: string, entity_id: string, payload: unknown) {
	return { op_id: U(999), device_id: 'desktop', client_ts: 1_700_000_000_000, schema_version: SCHEMA_VERSION, entity, entity_id, kind, payload };
}

// One valid sample per (entity, kind); the test below asserts this table
// covers every schema in OP_SCHEMAS so a new kind cannot ship without one.
const SAMPLES: [Entity, string, string, unknown][] = [
	['tag', 'create', TAG, { name: 'Peak', kind: 'user', color: '#f00' }],
	['tag', 'rename', TAG, { name: 'Peak time' }],
	['tag', 'set-colour', TAG, { color: null }],
	['tag', 'delete', TAG, {}],
	['track_tag', 'add', trackTagEntityId(REC_A, TAG), {}],
	['track_tag', 'remove', trackTagEntityId(REC_A, 'interested'), {}],
	['playlist', 'create', PL, { name: 'Warm up', folder_id: null, source_link: { source: 'spotify', source_id: '37i9dQ', url: null } }],
	['playlist', 'rename', PL, { name: 'Warm-up' }],
	['playlist', 'move-to-folder', PL, { folder_id: U(21) }],
	['playlist', 'set-source-link', PL, { source_link: null }],
	['playlist', 'set-favourite', PL, { favourite: true }],
	['playlist', 'delete', PL, {}],
	['playlist_folder', 'create', U(21), { name: 'Gigs' }],
	['playlist_folder', 'rename', U(21), { name: 'Gigs 2026' }],
	['playlist_folder', 'move-to-folder', U(21), { parent_folder_id: null }],
	['playlist_folder', 'set-source-link', U(21), { source_link: { source: 'rekordbox', source_id: '42' } }],
	['playlist_folder', 'delete', U(21), {}],
	['playlist_track', 'add', ROW, { playlist_id: PL, recording_id: REC_A, order_key: 'a0' }],
	['playlist_track', 'move', ROW, { order_key: 'a0V' }],
	['playlist_track', 'remove', ROW, {}],
	['playlist_track', 'rekey', PL, { keys: { [ROW]: 'a0', [U(31)]: 'a1' } }],
	['library_track', 'create', REC_A, { added_at: 1_600_000_000_000 }],
	['library_track', 'set-rating', REC_A, { rating: 4 }],
	['library_track', 'set-favourite', REC_A, { favourite: false }],
	['library_track', 'set-state', REC_A, { state: 'backlog' }],
	[
		'library_track',
		'set-meta',
		REC_A,
		{
			source: 'spotify', title: 'Lilac', artists: [{ name: 'Bonobo' }], album_title: 'Fragments', duration_sec: 312, isrc: 'GBCFB2100001',
			release_date: '2022-01-14', label: 'Ninja Tune', genre: null, cover_url: 'https://i.scdn.co/image/ab67', track_number: 3, disc_number: 1,
		},
	],
	['library_track', 'set-override', REC_A, { field: 'artists', value: [{ name: 'Ben Böhmer' }, { name: 'Nils Hoffmann', role: 'remixer' }] }],
	['library_track', 'set-rb-analysis', REC_A, { unit: 'grid', value: [1, 3, 1, 123, 468, 1, 0] }],
	['library_track', 'delete', REC_A, {}],
	['library_track', 'undelete', REC_A, {}],
	['cue', 'upsert', cueEntityId(REC_A, 3, 'hot'), { slot: 3, kind: 'hot', position_sec: 61.5, length_sec: null, color: '#28e214', name: 'Drop' }],
	['cue', 'delete', cueEntityId(REC_A, 0, 'memory'), {}],
	[
		'play_session',
		'append',
		SESSION,
		{ origin: 'curator', kind: 'prep', kind_source: 'auto', name: null, started_at: 1_700_000_000_000, ended_at: null, rb_history_id: null },
	],
	['play_session', 'set-kind', SESSION, { kind: 'set' }],
	[
		'play_event',
		'append',
		U(41),
		{
			session_id: SESSION,
			recording_id: REC_A,
			source: 'local',
			played_at: 1_700_000_000_000,
			played_ms: 180_000,
			duration_ms: 240_000,
			max_position_ms: 200_000,
			played75: true,
			ended_reason: 'ended',
			context_type: 'playlist',
			context_id: PL,
			track_no: null,
			rb_song_history_id: null,
		},
	],
	['pinned_search', 'create', U(50), { name: 'Bright Em', query: 'key:Em bright:>0.7', sort_column: 'bpm', sort_dir: 'asc' }],
	['pinned_search', 'rename', U(50), { name: 'Bright E minor' }],
	['pinned_search', 'set-query', U(50), { query: 'key:Em' }],
	['pinned_search', 'delete', U(50), {}],
	['setting', 'set', 'credit_format', { value: { style: 'artist-title' } }],
	['recording_claim', 'add', REC_A, { kind: 'fingerprint', value: 'AQADtEmi...', confidence: 0.9, duration_sec: 120 }],
	['recording', 'merge', REC_A, { winner: REC_B }],
	['recording', 'split', REC_A, { winner: REC_B }],
	['upstream', 'ack', U(60), { provider: 'spotify', status: 'pushed' }],
	['artist_alias', 'set', 'benbohmer', { from: 'Ben Bohmer', to: 'Ben Böhmer', to_key: 'benbohmer' }],
	['artist_alias', 'remove', 'bohmer', {}],
	// v4
	['playlist', 'set-attrs', PL, { hybrid_tidal: true, position: 14, mark: 'R', description: null, cover_url: 'https://i.scdn.co/image/x', is_public: false }],
	['playlist_folder', 'set-attrs', U(21), { position: 3 }],
	[
		'library_track',
		'set-attrs',
		REC_A,
		{
			source: 'local', bpm: 122.5, key_camelot: '8A', key_source: 'rekordbox', explicit: false,
			mbid: null, copyright: null, play_count: 79,
			provider_refs: [{
				source: 'spotify', album: { id: '4aawyAB9vmqN3uQ7FjRGTy', name: 'Fragments', artists: ['Bonobo'], release_date: '2022-01-14', cover_url: 'https://i.scdn.co/image/ab67', album_type: 'album', total_tracks: 12 },
				artists: [{ name: 'Bonobo', id: '0cmWgDlu9CwTgxPhf403hb' }], track_number: 3, disc_number: 1,
			}],
			artist_names: ['Bonobo'],
		},
	],
	['library_track', 'set-cues-edited', REC_A, { at: 1_700_000_000_000 }],
	['library_track', 'set-curation', REC_A, { field: 'comment', value: 'ethnic, up' }],
	['cue', 'upsert2', cueEntityId(REC_A, 3, 'hot'), { slot: 3, kind: 'hot', position_sec: 61.5, length_sec: null, color: '#28e214', name: 'Drop', origin: 'rekordbox' }],
	[
		'play_event',
		'append2',
		U(42),
		{
			session_id: SESSION, recording_id: REC_A, source: 'rekordbox', played_at: 1_700_000_000_000, played_ms: null, duration_ms: null, max_position_ms: null,
			played75: null, ended_reason: null, context_type: null, context_id: null, track_no: 4, rb_song_history_id: '123', rb_content_id: '98765', source_track_id: null,
		},
	],
	['feed_item', 'set-state', 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy', { state: 'archived' }],
	['feed_item', 'mark-played', 'isrc:GBCFB2100001', { at: 1_700_000_000_000 }],
	['feed_item', 'mark-listened', 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy', { source_track_id: '7mCHjSQsqvTMfRotUfNob5' }],
	['feed_suppression', 'set', 'artist:0cmWgDlu9CwTgxPhf403hb', { scope: 'artist', active: true }],
	['album', 'set-meta', 'spotify:4aawyAB9vmqN3uQ7FjRGTy', { album_type: 'album', total_tracks: 12, release_date: '2022-01-14', label: 'Ninja Tune', upc: '5054429150000', cover_url: null, artists: ['Bonobo'], various: false }],
];

describe('every (entity, kind) parses', () => {
	it.each(SAMPLES.map(([e, k, id, p]) => [`${e}.${k}`, e, k, id, p] as const))('%s', (_label, entity, kind, id, payload) => {
		const raw = envelope(entity, kind, id, payload);
		const op = parseOp(raw);
		expect(op.entity).toBe(entity);
		expect(op.kind).toBe(kind);
		expect(op.entity_id).toBe(id);
		expect(op.payload).toEqual(payload);
		expect(ZOp.safeParse(raw).success).toBe(true);
		expect(safeParseOp(raw)).toEqual({ ok: true, op });
	});

	it('the sample table covers every schema and every entity', () => {
		const sampled = new Set(SAMPLES.map(([e, k]) => `${e}/${k}`));
		expect(sampled.size).toBe(OP_SCHEMAS.length);
		for (const entity of ENTITIES) {
			expect(kindsOf(entity).length, entity).toBeGreaterThan(0);
			for (const kind of kindsOf(entity)) expect(sampled.has(`${entity}/${kind}`), `${entity}.${kind} has a sample`).toBe(true);
		}
	});
});

describe('rejections name the entity and kind', () => {
	const fail = (raw: unknown) => {
		try {
			parseOp(raw);
		} catch (e) {
			expect(e).toBeInstanceOf(OpValidationError);
			return e as OpValidationError;
		}
		throw new Error('expected parseOp to throw');
	};

	it('wrong payload shape', () => {
		const e = fail(envelope('library_track', 'set-rating', REC_A, { rating: 7 }));
		expect(e.reason).toBe('invalid_payload');
		expect(e.entity).toBe('library_track');
		expect(e.kind).toBe('set-rating');
		expect(e.opId).toBe(U(999));
		expect(e.message).toContain('library_track.set-rating');
		expect(e.message).toContain('payload.rating');
	});

	it('unknown field on a strict payload', () => {
		const e = fail(envelope('tag', 'rename', TAG, { name: 'x', colour: 'red' }));
		expect(e.reason).toBe('invalid_payload');
		expect(e.message).toContain('tag.rename');
	});

	it('unknown entity and unknown kind', () => {
		expect(fail(envelope('artist' as Entity, 'rename', 'x', {})).reason).toBe('unknown_entity');
		const e = fail(envelope('tag', 'set-icon', TAG, {}));
		expect(e.reason).toBe('unknown_kind');
		expect(e.entity).toBe('tag');
		expect(e.kind).toBe('set-icon');
	});

	it('malformed envelope', () => {
		expect(fail(null).reason).toBe('malformed');
		expect(fail({ entity: 'tag' }).reason).toBe('malformed');
		expect(fail({ ...envelope('tag', 'delete', TAG, {}), op_id: 'not-a-uuid' }).reason).toBe('invalid_payload');
		expect(fail({ ...envelope('tag', 'delete', TAG, {}), client_ts: -5 }).reason).toBe('invalid_payload');
		expect(fail({ ...envelope('tag', 'delete', TAG, {}), extra: 1 }).reason).toBe('invalid_payload');
	});

	it('composite ids must have the right shape and agree with the payload', () => {
		expect(fail(envelope('track_tag', 'add', REC_A, {})).reason).toBe('invalid_payload');
		expect(fail(envelope('cue', 'upsert', `${REC_A}:3:hot`, { slot: 4, kind: 'hot', position_sec: 1, length_sec: null, color: null, name: null })).reason).toBe(
			'invalid_payload',
		);
		expect(fail(envelope('cue', 'upsert', `${REC_A}:3:loop`, { slot: 3, kind: 'hot', position_sec: 1, length_sec: null, color: null, name: null })).reason).toBe(
			'invalid_payload',
		);
		expect(fail(envelope('cue', 'delete', `${REC_A}:x:hot`, {})).reason).toBe('invalid_payload');
	});

	it('a merge onto itself and a device-level setting key', () => {
		expect(fail(envelope('recording', 'merge', REC_A, { winner: REC_A })).reason).toBe('invalid_payload');
		const e = fail(envelope('setting', 'set', 'sourceSync.spotify', { value: { writeSync: true } }));
		expect(e.reason).toBe('invalid_payload');
		expect(e.message).toContain('account-level');
		expect(isAccountSettingKey('wav.output_dir')).toBe(false);
		expect(isAccountSettingKey('device.id')).toBe(false);
		expect(isAccountSettingKey('credit_format')).toBe(true);
	});

	it('an oversize payload is rejected after schema validation', () => {
		const big = envelope('setting', 'set', 'mir.settings', { value: 'x'.repeat(MAX_OP_PAYLOAD_BYTES + 1) });
		const e = fail(big);
		expect(e.reason).toBe('payload_too_large');
		expect(e.entity).toBe('setting');
		expect(e.kind).toBe('set');
		// Just under the cap passes.
		const ok = envelope('setting', 'set', 'mir.settings', { value: 'x'.repeat(MAX_OP_PAYLOAD_BYTES - 20) });
		expect(opPayloadBytes(parseOp(ok))).toBeLessThanOrEqual(MAX_OP_PAYLOAD_BYTES);
	});

	it('safeParseOp reports instead of throwing', () => {
		const r = safeParseOp(envelope('tag', 'rename', TAG, {}));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.kind).toBe('rename');
	});
});

describe('helpers', () => {
	it('composite id round-trips', () => {
		expect(parseTrackTagEntityId(trackTagEntityId(REC_A, 'interested'))).toEqual({ recordingId: REC_A, tagId: 'interested' });
		expect(parseTrackTagEntityId('nocolon')).toBeNull();
		expect(parseTrackTagEntityId(':x')).toBeNull();
		expect(parseCueEntityId(cueEntityId(REC_A, 7, 'memory'))).toEqual({ recordingId: REC_A, slot: 7, kind: 'memory' });
		expect(parseCueEntityId(`${REC_A}:7`)).toBeNull();
	});

	it('utf8ByteLength counts multi-byte and surrogate pairs', () => {
		expect(utf8ByteLength('abc')).toBe(3);
		expect(utf8ByteLength('é')).toBe(2);
		expect(utf8ByteLength('€')).toBe(3);
		expect(utf8ByteLength('𝄞')).toBe(4);
		expect(utf8ByteLength('Böhmer 🎧')).toBe(12);
	});

	it('schemaVersionStatus', () => {
		expect(schemaVersionStatus(SCHEMA_VERSION)).toBe('ok');
		expect(schemaVersionStatus(MIN_SUPPORTED_SCHEMA_VERSION - 1)).toBe('update_required');
		expect(schemaVersionStatus(SCHEMA_VERSION + 1)).toBe('ahead');
		expect(schemaVersionStatus(3, 5, 2)).toBe('ok');
	});
});

describe('protocol v3: set-meta and the master device setting', () => {
	const meta = { source: 'local', title: 'T', artists: [{ name: 'A' }], album_title: null, duration_sec: 300, isrc: null, release_date: null, label: null, genre: null, cover_url: null };

	it('stamps set-meta and the master setting v3, every older kind and key as before', () => {
		expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(1);
		expect(opSchemaVersion({ entity: 'library_track', kind: 'set-meta' })).toBe(3);
		expect(opSchemaVersion({ entity: 'library_track', kind: 'set-state' })).toBe(2);
		expect(opSchemaVersion({ entity: 'setting', kind: 'set', entity_id: MASTER_DEVICE_SETTING })).toBe(3);
		expect(opSchemaVersion({ entity: 'setting', kind: 'set', entity_id: 'credit_format' })).toBe(1);
		expect(isAccountSettingKey(MASTER_DEVICE_SETTING)).toBe(true);
	});

	it('refuses either stamped below v3: a v2 client would stop at it instead of holding it aside', () => {
		const m = { ...envelope('library_track', 'set-meta', REC_A, meta), schema_version: 2 };
		expect(safeParseOp(m)).toMatchObject({ ok: false, error: { reason: 'invalid_payload' } });
		const s = { ...envelope('setting', 'set', MASTER_DEVICE_SETTING, { value: 'dev-1' }), schema_version: 2 };
		expect(safeParseOp(s)).toMatchObject({ ok: false, error: { reason: 'invalid_payload' } });
		expect(safeParseOp({ ...s, schema_version: 3 }).ok).toBe(true);
	});

	it('takes only http(s) cover urls and whole-number counts', () => {
		const bad = (p: Record<string, unknown>) => safeParseOp(envelope('library_track', 'set-meta', REC_A, { ...meta, ...p })).ok;
		expect(bad({ cover_url: 'file:///C:/covers/a.jpg' })).toBe(false);
		expect(bad({ cover_url: 'data:image/png;base64,AAAA' })).toBe(false);
		expect(bad({ cover_url: 'HTTPS://i.scdn.co/x' })).toBe(true);
		expect(bad({ duration_sec: 1.5 })).toBe(false);
		expect(bad({ source: 'rekordbox' })).toBe(false);
		expect(bad({ extra: 1 })).toBe(false);
		expect(bad({ track_number: null, disc_number: 2 })).toBe(true);
	});
});

describe('protocol v4: the zero-loss additions', () => {
	const sample = (e: string, k: string) => SAMPLES.find(([se, sk]) => se === e && sk === k)!;
	const V4_KINDS = [
		['library_track', 'set-attrs'], ['library_track', 'set-cues-edited'], ['library_track', 'set-curation'], ['cue', 'upsert2'], ['play_event', 'append2'],
		['playlist', 'set-attrs'], ['playlist_folder', 'set-attrs'], ['feed_item', 'set-state'], ['feed_item', 'mark-played'],
		['feed_item', 'mark-listened'], ['feed_suppression', 'set'], ['album', 'set-meta'],
	] as const;

	it('is v4 with the minimum unchanged; every v4 kind is stamped 4 and every older kind keeps its version', () => {
		expect(SCHEMA_VERSION).toBe(4);
		expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(1);
		for (const [e, k] of V4_KINDS) expect(opSchemaVersion({ entity: e, kind: k }), `${e}.${k}`).toBe(4);
		expect(opSchemaVersion({ entity: 'cue', kind: 'upsert' })).toBe(1);
		expect(opSchemaVersion({ entity: 'play_event', kind: 'append' })).toBe(1);
		expect(opSchemaVersion({ entity: 'library_track', kind: 'set-meta' })).toBe(3);
	});

	it('stamps the new claim kinds and rekordbox units 4, the old ones as before', () => {
		const claim = (kind: string) => opSchemaVersion({ entity: 'recording_claim', kind: 'add', payload: { kind, value: 'x', confidence: 1 } });
		for (const k of ['traxsource', 'musicbrainz', 'discogs']) expect(claim(k), k).toBe(4);
		for (const k of ['isrc', 'audio_hash', 'fingerprint', 'spotify', 'tidal', 'beatport']) expect(claim(k), k).toBe(1);
		const unit = (u: string) => opSchemaVersion({ entity: 'library_track', kind: 'set-rb-analysis', payload: { unit: u, value: null } });
		for (const u of ['bpm', 'key_strength']) expect(unit(u), u).toBe(4);
		for (const u of ['grid', 'key', 'segments']) expect(unit(u), u).toBe(1);
	});

	it('refuses any of them stamped below v4: a v3 client must hold them, not reject them', () => {
		for (const [e, k] of V4_KINDS) {
			const [, , id, p] = sample(e, k);
			const raw = { ...envelope(e, k, id, p), schema_version: 3 };
			expect(safeParseOp(raw), `${e}.${k}`).toMatchObject({ ok: false, error: { reason: 'invalid_payload' } });
			expect(safeParseOp({ ...raw, schema_version: 4 }).ok, `${e}.${k}`).toBe(true);
		}
		const tx = { ...envelope('recording_claim', 'add', REC_A, { kind: 'traxsource', value: '7574432', confidence: 1 }), schema_version: 3 };
		expect(safeParseOp(tx).ok).toBe(false);
		expect(safeParseOp({ ...tx, schema_version: 4 }).ok).toBe(true);
		const bpm = { ...envelope('library_track', 'set-rb-analysis', REC_A, { unit: 'bpm', value: 120.0006 }), schema_version: 1 };
		expect(safeParseOp(bpm).ok).toBe(false);
		expect(safeParseOp({ ...bpm, schema_version: 4 }).ok).toBe(true);
	});

	it('keeps the old payloads strict: a v3 cue upsert with an origin, or a v1 append with references, is refused', () => {
		const [, , cid, cp] = sample('cue', 'upsert');
		expect(safeParseOp(envelope('cue', 'upsert', cid, { ...(cp as object), origin: 'rekordbox' })).ok).toBe(false);
		const [, , eid, ep] = sample('play_event', 'append');
		expect(safeParseOp(envelope('play_event', 'append', eid, { ...(ep as object), rb_content_id: '1' })).ok).toBe(false);
		const [, , mid, mp] = sample('library_track', 'set-meta');
		expect(safeParseOp(envelope('library_track', 'set-meta', mid, { ...(mp as object), bpm: 120 })).ok).toBe(false);
	});

	it('validates the v4 shapes', () => {
		const ok = (e: Entity, k: string, id: string, p: unknown) => safeParseOp(envelope(e, k, id, p)).ok;
		expect(ok('playlist', 'set-attrs', PL, {})).toBe(false);
		expect(ok('playlist', 'set-attrs', PL, { cover_url: 'file:///x.jpg' })).toBe(false);
		expect(ok('playlist', 'set-attrs', PL, { position: 1.5 })).toBe(false);
		expect(ok('album', 'set-meta', 'deezer:1', { album_type: null, total_tracks: null, release_date: null, label: null, upc: null, cover_url: null, artists: [], various: false })).toBe(false);
		expect(ok('feed_item', 'set-state', 'x'.repeat(257), { state: 'archived' })).toBe(false);
		expect(ok('feed_suppression', 'set', 'artist:1', { scope: 'genre', active: true })).toBe(false);
		const [, , aid, ap] = sample('library_track', 'set-attrs');
		expect(ok('library_track', 'set-attrs', aid, { ...(ap as object), bpm: 0 })).toBe(false);
		expect(ok('library_track', 'set-attrs', aid, { ...(ap as object), play_count: -1 })).toBe(false);
		// Curation is not an attribute: set-attrs refuses it.
		expect(ok('library_track', 'set-attrs', aid, { ...(ap as object), comment: 'x' })).toBe(false);
		expect(ok('library_track', 'set-curation', aid, { field: 'color_label', value: null })).toBe(true);
		expect(ok('library_track', 'set-curation', aid, { field: 'comment', value: '' })).toBe(false);
		expect(ok('library_track', 'set-curation', aid, { field: 'rating', value: 3 })).toBe(false);
	});
});

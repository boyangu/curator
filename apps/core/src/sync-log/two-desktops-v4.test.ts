// Protocol v4, the zero-data-loss release (2026-10-21 audit items 2, 4, 6c,
// 9-16), across two or three desktops on one account. Same rig and rails as
// the other two-desktop suites: generated databases only, no
// remoteWritePolicy, streaming adapters that record and throw, no network.
//
//   - a v3 server: nothing v4 is emitted or pushed, sync carries on; once the
//     server reads v4 the backfills state everything the master holds;
//   - track attributes: master wins per field, adoption onto empty own
//     fields, follow / clear, a local value taking a field back, a master
//     switch, play counts of a rekordbox-linked row kept;
//   - cue origins, play references, rekordbox tempo / key strength, playlist
//     details (with the baseline guarding an unstated local change),
//     Traxsource claims, provider album metadata, artist spellings;
//   - the Discover feed: decisions by stable key both ways, a follower runs
//     no producer;
//   - a v3 client holds v4 ops aside and applies them once it reads them;
//   - the remixer role merge: the replay divergence of a real-library recording.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, schemaVersionStatus, type StoredOp } from '@curator/protocol';
import { SqliteFeedStore } from '../feed/store.js';
import { syncedItemsFor } from '../feed/sync.js';
import type { FeedItemDraft } from '../feed/types.js';
import { syncTrackAlbumsRaw } from '../library/albums.js';
import { heldCount, holdOps, replayHeldOps } from './held.js';
import { recordingIdForTrack } from './recording-id.js';
import { remoteTrackId } from './stable-ids.js';
import { markPreOpLog, TwoDesktopRig, tick, type Desktop } from '../test-support/two-desktops.js';
import { RekordboxExporter } from '../rekordbox/exporter.js';
import type { WriteOp } from '../rekordbox/sidecar.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-v4-'); });
afterEach(() => {
	const upstream = rig.upstreamCalls();
	rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
const v3Server = (): void => { rig.cloud.features = rig.cloud.features.filter((f) => f !== 'zero_loss_v4'); };
const v4Server = (): void => { if (!rig.cloud.features.includes('zero_loss_v4')) rig.cloud.features = [...rig.cloud.features, 'zero_loss_v4']; };
const v4Ops = (): StoredOp[] => rig.cloud.log.filter((o) => o.schema_version >= 4);
const row = (d: Desktop, t: string): Record<string, unknown> =>
	d.raw.prepare(`SELECT * FROM track WHERE recording_id = ? ORDER BY remote_only, created_at LIMIT 1`).get(R(t)) as Record<string, unknown>;
const attrsOf = async (d: Desktop, t: string): Promise<Record<string, unknown> | undefined> => {
	const id = await d.deviceId();
	const ops = rig.cloud.log.filter((o) => o.device_id === id && o.kind === 'set-attrs' && o.entity_id === R(t));
	return ops[ops.length - 1]?.payload as Record<string, unknown> | undefined;
};

// ── the v3 server, then the upgrade ─────────────────────────────────────────

describe('v4 against a v3 server, then after the server upgrade', () => {
	it('emits nothing v4 to a v3 server and keeps syncing; the upgrade states the master\'s whole library once', async () => {
		v3Server();
		const a = await rig.desktop('a', {
			catalogue: ['trk-0', 'trk-1', 'trk-2', 'trk-3', 'trk-4'],
			seed: (raw) => {
				raw.prepare(`UPDATE track SET bpm = 122.5, key_camelot = '8A', comment = 'note', color_label = 'red', explicit = 0, play_count = 79 WHERE id = 'trk-0'`).run();
				// A rekordbox-origin cue (the importer's), a rekordbox play with its
				// content id, the rb slot's tempo and key strength.
				raw.prepare(`INSERT INTO cue (id, track_id, slot, kind, position_sec, origin) VALUES ('c1', 'trk-1', 0, 'hot', 12.5, 'rekordbox')`).run();
				raw.prepare(`INSERT INTO play_session (id, origin, kind, kind_source, started_at, rb_history_id) VALUES ('s1', 'rekordbox', 'set', 'auto', 1700000000000, '77')`).run();
				raw.prepare(`INSERT INTO play_event (id, session_id, track_id, source, played_at, rb_song_history_id, rb_content_id) VALUES ('e1', 's1', 'trk-1', 'rekordbox', 1700000000000, '9', '98765')`).run();
				raw.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at, rb_bpm, rb_key_strength) VALUES ('trk-2', 'rekordbox', 1700000000000, 120.0006, 0.61)`).run();
				raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES ('tx', 'trk-3', 'traxsource', '7574432', 1700000000000)`).run();
				raw.prepare(`INSERT INTO playlist (id, source, source_id, name, mark, hybrid_tidal, position, description, sync_status) VALUES ('pl1', 'local', 'pl1', 'Deep', 'P', 1, 5, 'warm-up tracks', 'synced')`).run();
				// A Spotify listing names trk-4's release; the album fill already ran.
				raw.prepare(`UPDATE track SET album_title = 'Fragments' WHERE id = 'trk-4'`).run();
				raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload, fetched_at) VALUES ('sp4', 'trk-4', 'spotify', 'sp4', ?, 1700000000000)`)
					.run(JSON.stringify({ id: 'sp4', album: { id: 'al1', name: 'Fragments', release_date: '2022-01-14', images: [] }, artists: [{ id: 'ar1', name: 'Artist' }], track_number: 3, disc_number: 1 }));
				syncTrackAlbumsRaw(raw, ['trk-4']);
				raw.prepare(`UPDATE album SET label = 'Ninja Tune', upc = '5054429150000', album_type = 'album', total_tracks = 12, enriched_at = 1700000000000`).run();
				// A library from before the op log: the initial push records it.
				markPreOpLog(raw);
			},
		});
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		// Nothing v4 reached the v3 server, and no push failed.
		expect(v4Ops()).toEqual([]);
		expect((await a.svc.getCloudSyncStatus()).lastError).toBeNull();
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE schema_version >= 4`)).toBe(0);
		expect(row(b, 'trk-0')['bpm']).toBeNull();

		v4Server();
		await rig.settle();
		const kinds = [...new Set(v4Ops().map((o) => `${o.entity}.${o.kind}`))].sort();
		expect(kinds).toEqual([
			'album.set-meta', 'cue.upsert2', 'library_track.set-attrs', 'library_track.set-curation', 'library_track.set-rb-analysis', 'play_event.append2', 'playlist.set-attrs', 'recording_claim.add',
		]);
		// Every v4 op is stamped 4: a v3 client holds it.
		expect(v4Ops().every((o) => o.schema_version === 4 && schemaVersionStatus(o.schema_version, 3) === 'ahead')).toBe(true);

		const r0 = row(b, 'trk-0');
		expect([r0['remote_only'], r0['bpm'], r0['key_camelot'], r0['comment'], r0['color_label'], r0['explicit'], r0['play_count']]).toEqual([1, 122.5, '8A', 'note', 'red', 0, 79]);
		expect(b.one(`SELECT origin FROM cue WHERE track_id = ?`, remoteTrackId(R('trk-1')))).toBe('rekordbox');
		expect(b.one(`SELECT rb_content_id FROM play_event WHERE id = 'e1'`)).toBe('98765');
		expect(b.raw.prepare(`SELECT rb_bpm, rb_key_strength FROM track_analysis WHERE track_id = ?`).get(remoteTrackId(R('trk-2')))).toEqual({ rb_bpm: 120.0006, rb_key_strength: 0.61 });
		expect(b.one(`SELECT source_track_id FROM claim_link WHERE track_id = ? AND source = 'traxsource'`, remoteTrackId(R('trk-3')))).toBe('7574432');
		expect(b.raw.prepare(`SELECT mark, hybrid_tidal, position, description FROM playlist WHERE id = 'pl1'`).get()).toEqual({ mark: 'P', hybrid_tidal: 1, position: 5, description: 'warm-up tracks' });
		// The remote row of trk-4 files under the master's release, with what
		// the provider said about it.
		const album = b.raw.prepare(`SELECT a.title, a.label, a.upc, a.album_type, a.total_tracks FROM track t JOIN album a ON a.id = t.album_id WHERE t.id = ?`).get(remoteTrackId(R('trk-4')));
		expect(album).toEqual({ title: 'Fragments', label: 'Ninja Tune', upc: '5054429150000', album_type: 'album', total_tracks: 12 });
		expect(b.one(`SELECT source_id FROM album_link al JOIN track t ON t.album_id = al.album_id WHERE t.id = ?`, remoteTrackId(R('trk-4')))).toBe('al1');
		expect(b.one(`SELECT al.source_id FROM artist_link al JOIN artist ar ON ar.id = al.artist_id WHERE ar.name = 'Artist'`)).toBe('ar1');

		// Once: a second settle (and a restart) states nothing more.
		const n = v4Ops().length;
		await a.restart();
		await rig.settle();
		expect(v4Ops().length).toBe(n);
		// The remote rows never state anything of their own.
		const bId = await b.deviceId();
		expect(rig.cloud.log.filter((o) => o.device_id === bId && o.schema_version >= 4)).toEqual([]);
	});
});

describe('a server rolled back to v3', () => {
	it('v4 ops already in the outbox wait; everything else keeps flowing; they go once the server reads v4 again', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		v3Server();
		// A still believes v4: its next writes are v4-shaped.
		a.raw.prepare(`UPDATE track SET bpm = 128 WHERE id = 'trk-0'`).run();
		await a.svc.upsertCue({ trackId: 'trk-1', slot: 2, kind: 'hot', positionSec: 30, lengthSec: null, color: null, name: null });
		// A v3 write meanwhile.
		await a.svc.setRating(['trk-1'], 4);
		// The first push after the rollback is refused whole (server_outdated);
		// the client stops sending v4 and the next cycle carries the rest.
		await a.sync();
		await a.sync();
		await b.sync();
		expect((await a.svc.getCloudSyncStatus()).lastError).toBeNull();
		expect(row(b, 'trk-1')['rating']).toBe(4);
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE state = 'pending' AND schema_version >= 4`)).toBeGreaterThan(0);
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE state = 'pending' AND schema_version < 4`)).toBe(0);
		v4Server();
		await rig.settle();
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE state = 'pending'`)).toBe(0);
		expect(row(b, 'trk-0')['bpm']).toBe(128);
		expect(b.one(`SELECT position_sec FROM cue WHERE track_id = ?`, remoteTrackId(R('trk-1')))).toBe(30);
	});
});

// ── track attributes ────────────────────────────────────────────────────────

describe('track attributes: master wins per field, adopted into empty fields', () => {
	it('fills remote and empty own fields, keeps own values, follows and clears, and a local value takes a field back', async () => {
		const a = await rig.desktop('a', {
			catalogue: ['trk-0'],
			seed: (raw) => { raw.prepare(`UPDATE track SET bpm = 122, key_camelot = '8A', mbid = 'mb-main', copyright = '(C) Main', play_count = 79 WHERE id = 'trk-0'`).run(); },
		});
		const b = await rig.desktop('b', { catalogue: [] });
		// C holds trk-0 itself, with its own tempo and a rekordbox link (its own
		// rekordbox's counter: 3 plays).
		const c = await rig.desktop('c', {
			catalogue: ['trk-0'],
			seed: (raw) => {
				raw.prepare(`UPDATE track SET bpm = 120, play_count = 3 WHERE id = 'trk-0'`).run();
				raw.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at) VALUES ('trk-0', '555', 1, 1700000000000)`).run();
			},
		});
		await rig.settle();
		expect([row(b, 'trk-0')['bpm'], row(b, 'trk-0')['mbid'], row(b, 'trk-0')['play_count']]).toEqual([122, 'mb-main', 79]);
		const rc = row(c, 'trk-0');
		expect([rc['bpm'], rc['mbid'], rc['copyright'], rc['key_camelot'], rc['play_count']]).toEqual([120, 'mb-main', '(C) Main', '8A', 3]);
		// C states only its own: bpm and its counter, nothing it adopted.
		expect(await attrsOf(c, 'trk-0')).toMatchObject({ bpm: 120, mbid: null, copyright: null, key_camelot: null, play_count: 3 });

		// The master edits and clears: both follow.
		a.raw.prepare(`UPDATE track SET mbid = 'mb-edited', copyright = NULL WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect([row(b, 'trk-0')['mbid'], row(b, 'trk-0')['copyright']]).toEqual(['mb-edited', null]);
		expect([row(c, 'trk-0')['mbid'], row(c, 'trk-0')['copyright']]).toEqual(['mb-edited', null]);

		// C's own writer puts its own value: the field is C's again, and C
		// states it; the master's still wins on B (source data: master wins).
		c.raw.prepare(`UPDATE track SET mbid = 'mb-C' WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect(row(c, 'trk-0')['mbid']).toBe('mb-C');
		expect(await attrsOf(c, 'trk-0')).toMatchObject({ mbid: 'mb-C' });
		expect(row(b, 'trk-0')['mbid']).toBe('mb-edited');

		// An override still wins on read over the account's tempo, everywhere.
		await a.svc.setTrackOverrides('trk-0', { bpm: 125 });
		await rig.settle();
		const [tb] = await b.svc.getTracks({ ids: [remoteTrackId(R('trk-0'))] });
		expect([tb!.bpm, row(b, 'trk-0')['bpm']]).toEqual([125, 122]);
		const [tc] = await c.svc.getTracks({ ids: ['trk-0'] });
		expect(tc!.bpm).toBe(125);
		await a.svc.setTrackOverrides('trk-0', { bpm: null });
		await rig.settle();

		// Master switch to C: B's remote row re-picks per field — C's own tempo
		// and mbid, the old master's key where C states none.
		await c.svc.setMasterDevice(await c.deviceId());
		await rig.settle();
		await rig.settle();
		const rb = row(b, 'trk-0');
		expect([rb['bpm'], rb['mbid'], rb['key_camelot']]).toEqual([120, 'mb-C', '8A']);
	});

	it('the cue-edit stamp is account-wide: the latest anywhere reaches every row', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'] });
		const c = await rig.desktop('c', { catalogue: ['trk-0'] });
		await rig.settle();
		const at = 1_760_000_000_000;
		c.raw.prepare(`UPDATE track SET cues_edited_at = ? WHERE id = 'trk-0'`).run(at);
		await rig.settle();
		expect(a.one(`SELECT cues_edited_at FROM track WHERE id = 'trk-0'`)).toBe(at);
		// An older stamp elsewhere never lowers it.
		a.raw.prepare(`UPDATE track SET cues_edited_at = ? WHERE id = 'trk-0'`).run(at - 1000);
		await rig.settle();
		expect(c.one(`SELECT cues_edited_at FROM track WHERE id = 'trk-0'`)).toBe(at);
	});

	it('the analyzer fill of a remote row gives way to the account\'s tempo, and stays where the account has none', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'], seed: (raw) => { raw.prepare(`UPDATE track SET bpm = 122 WHERE id = 'trk-0'`).run(); } });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		void a;
		// What catalogue/layer.ts fillTrackMirrors leaves (a fill, marked).
		for (const t of ['trk-0', 'trk-1']) {
			const id = remoteTrackId(R(t));
			b.raw.prepare(`UPDATE track SET bpm = 119.9, attrs_adopted = ? WHERE id = ?`).run(JSON.stringify({ bpm: { v: 119.9, from: 'catalogue' } }), id);
		}
		// Re-projection (a later attrs op, here a restatement through the sweep).
		b.raw.prepare(`DELETE FROM app_setting WHERE key = 'sync.materialize_remote_at'`).run();
		await rig.settle();
		expect(row(b, 'trk-0')['bpm']).toBe(122);
		expect(row(b, 'trk-1')['bpm']).toBe(119.9);
	});
});

// ── curation: comment and colour, last write wins everywhere ───────────────

// What A's "Sync updates" to rekordbox would push for one linked track: the
// real exporter's target resolution and op build, never run against a
// rekordbox (no sidecar; resolveTargets / buildWriteOps only read curator.db).
function rbTrackOp(d: Desktop, trackId: string): Extract<WriteOp, { kind: 'track' }> | undefined {
	const exporter = new RekordboxExporter(d.db, {} as never);
	const opts = { targetKind: 'updates' as const, targetIds: [], dbPath: d.path, flags: { syncMetadata: true, syncCues: false, syncTags: true, syncPlaylist: false } };
	const t = (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: Array<{ curatorTrackId: string }>; playlistOrders?: unknown[] } }).resolveTargets(opts);
	if (!t.linked.some((p) => p.curatorTrackId === trackId)) return undefined;
	const ops = (exporter as unknown as { buildWriteOps: (o: typeof opts, l: unknown, p: unknown) => { ops: WriteOp[] } }).buildWriteOps(opts, t.linked, t.playlistOrders ?? []).ops;
	return ops.find((o): o is Extract<WriteOp, { kind: 'track' }> => o.kind === 'track' && o.rb_content_id === d.one<string>(`SELECT rb_content_id FROM rekordbox_link WHERE track_id = ?`, trackId));
}

// A rekordbox-linked row with its MyTag block and the rb tags behind it,
// pushed before (pushed_at), as the master's library has them.
const rbLinked = (comment: string, tagOrder: string[]) => (raw: import('better-sqlite3').Database): void => {
	raw.prepare(`UPDATE track SET comment = ?, color_label = 'red', play_count = 41 WHERE id = 'trk-0'`).run(comment);
	raw.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, pushed_at) VALUES ('trk-0', 'C0', 1, 1000, 1000, 1000)`).run();
	for (const [i, name] of tagOrder.entries()) {
		raw.prepare(`INSERT OR IGNORE INTO tag (id, name, kind) VALUES (?, ?, 'user')`).run(`rb_${name}`, name);
		raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES ('trk-0', ?, ?)`).run(`rb_${name}`, 1_700_000_000_000 + i);
	}
};
const curationOps = async (d: Desktop): Promise<StoredOp[]> => { const id = await d.deviceId(); return rig.cloud.log.filter((o) => o.device_id === id && o.kind === 'set-curation'); };

describe('curation: comment and colour are last-write-wins on every device', () => {
	it('a comment / colour edited on B reaches A\'s row (behind A\'s own MyTag block) and A\'s rekordbox push; the later edit wins whichever device makes it', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: rbLinked('old note /* deep / dub */', ['deep', 'dub']) });
		const b = await rig.desktop('b', { catalogue: ['trk-0'] });
		await rig.settle();
		// B had nothing of its own: it took A's text and colour (no block — B
		// has no rekordbox).
		expect([row(b, 'trk-0')['comment'], row(b, 'trk-0')['color_label']]).toEqual(['old note', 'red']);

		// B edits (Curator, rekordbox, the future phone — any local writer).
		await tick();
		b.raw.prepare(`UPDATE track SET comment = 'new from B', color_label = 'blue' WHERE id = 'trk-0'`).run();
		await rig.settle();
		// A's OWN row takes it — not only an empty field — behind its block.
		expect([row(a, 'trk-0')['comment'], row(a, 'trk-0')['color_label']]).toEqual(['new from B /* deep / dub */', 'blue']);
		// …and A's next "Sync updates" carries it into A's rekordbox, the block
		// rebuilt from A's rb tags; the play counter is never pushed.
		const op = rbTrackOp(a, 'trk-0')!;
		expect(op).toBeDefined();
		expect([op.fields.Comment, op.fields.Color]).toEqual(['new from B /* deep / dub */', 'blue']);
		expect(Object.keys(op.fields).filter((k) => /play/i.test(k))).toEqual([]);

		// Then A edits later: A's wins on B.
		await tick();
		a.raw.prepare(`UPDATE track SET comment = 'A again /* deep / dub */' WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect(row(b, 'trk-0')['comment']).toBe('A again');

		// Both edit offline, B later; synced in either order the later wins.
		await tick();
		a.raw.prepare(`UPDATE track SET comment = 'A offline /* deep / dub */' WHERE id = 'trk-0'`).run();
		await tick();
		b.raw.prepare(`UPDATE track SET comment = 'B offline later' WHERE id = 'trk-0'`).run();
		await b.sync();
		await a.sync();
		await rig.settle();
		expect([row(a, 'trk-0')['comment'], row(b, 'trk-0')['comment']]).toEqual(['B offline later /* deep / dub */', 'B offline later']);
		await tick();
		b.raw.prepare(`UPDATE track SET comment = 'B first' WHERE id = 'trk-0'`).run();
		await tick();
		a.raw.prepare(`UPDATE track SET comment = 'A later /* deep / dub */' WHERE id = 'trk-0'`).run();
		await a.sync();
		await b.sync();
		await rig.settle();
		expect([row(a, 'trk-0')['comment'], row(b, 'trk-0')['comment']]).toEqual(['A later /* deep / dub */', 'A later']);
		// The master's rekordbox counter stays on the master: B shows it (no
		// rekordbox of its own), A's push never carries a count.
		expect(row(b, 'trk-0')['play_count']).toBe(41);
	});

	it('a rekordbox import that restates the comment, or rewrites only its block, states nothing', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: rbLinked('keep /* deep / dub */', ['deep', 'dub']) });
		await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		const n = (await curationOps(a)).length;
		expect(n).toBe(2); // the comment's text and the colour, once
		a.raw.prepare(`UPDATE track SET comment = 'keep /* deep / dub */', color_label = 'red' WHERE id = 'trk-0'`).run();
		await rig.settle();
		a.raw.prepare(`UPDATE track SET comment = 'keep /* dub / deep / new */' WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect((await curationOps(a)).length).toBe(n);
		// A changed text is a new write.
		a.raw.prepare(`UPDATE track SET comment = 'changed /* dub / deep / new */' WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect((await curationOps(a)).length).toBe(n + 1);
	});

	it('two machines whose rekordbox lists the same tags in different orders never rewrite each other\'s comment', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: rbLinked('same /* deep / dub */', ['deep', 'dub']) });
		const c = await rig.desktop('c', { catalogue: ['trk-0'], seed: rbLinked('same /* dub / deep */', ['dub', 'deep']) });
		await rig.settle();
		const before = rig.cloud.log.filter((o) => o.kind === 'set-curation').length;
		for (let i = 0; i < 3; i++) {
			// Each exporter writes its rebuilt comment back; each import reads
			// its own rekordbox's order again.
			a.raw.prepare(`UPDATE track SET comment = 'same /* deep / dub */' WHERE id = 'trk-0'`).run();
			c.raw.prepare(`UPDATE track SET comment = 'same /* dub / deep */' WHERE id = 'trk-0'`).run();
			await rig.settle();
		}
		expect(rig.cloud.log.filter((o) => o.kind === 'set-curation').length).toBe(before);
		expect([row(a, 'trk-0')['comment'], row(c, 'trk-0')['comment']]).toEqual(['same /* deep / dub */', 'same /* dub / deep */']);
		// Each machine's push keeps its own rekordbox's order.
		expect(rbTrackOp(c, 'trk-0')?.fields.Comment ?? 'same /* dub / deep */').toBe('same /* dub / deep */');
	});
});

// ── playlists: the baseline keeps an unstated local change ──────────────────

describe('playlist details', () => {
	it('a toggle made on either device reaches the other; a pulled value never overwrites a local change the drain has not stated', async () => {
		const a = await rig.desktop('a', {
			catalogue: ['trk-0'],
			seed: (raw) => { raw.prepare(`INSERT INTO playlist (id, source, source_id, name, hybrid_tidal, position, sync_status) VALUES ('pl1', 'local', 'pl1', 'Deep', 1, 2, 'synced')`).run(); },
		});
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		expect(b.one(`SELECT hybrid_tidal FROM playlist WHERE id = 'pl1'`)).toBe(1);
		b.raw.prepare(`UPDATE playlist SET hybrid_tidal = 0 WHERE id = 'pl1'`).run();
		await rig.settle();
		expect(a.one(`SELECT hybrid_tidal FROM playlist WHERE id = 'pl1'`)).toBe(0);

		// A moves it; B moves it locally before its drain runs. B's pull of A's
		// older move must leave B's own value, which B then states (later).
		a.raw.prepare(`UPDATE playlist SET position = 7 WHERE id = 'pl1'`).run();
		await a.sync();
		await tick();
		b.raw.prepare(`UPDATE playlist SET position = 9 WHERE id = 'pl1'`).run();
		// Pull first, as a write landing between B's drain and its pull would.
		b.raw.prepare(`DELETE FROM playlist_attrs_dirty`).run();
		const { applyOps } = await import('./apply.js');
		const pending = rig.cloud.log.filter((o) => o.entity === 'playlist' && o.kind === 'set-attrs');
		applyOps(b.raw, pending.map(({ seq: _s, user_id: _u, received_at: _r, ...op }) => op));
		expect(b.one(`SELECT position FROM playlist WHERE id = 'pl1'`)).toBe(9);
		b.raw.prepare(`INSERT INTO playlist_attrs_dirty (entity, id) VALUES ('playlist', 'pl1')`).run();
		await rig.settle();
		expect(a.one(`SELECT position FROM playlist WHERE id = 'pl1'`)).toBe(9);
		expect(b.one(`SELECT position FROM playlist WHERE id = 'pl1'`)).toBe(9);
	});
});

// ── artist spelling ─────────────────────────────────────────────────────────

describe('artist spelling: the master\'s wins for an artist nobody renamed', () => {
	it('a device that met another spelling first shows the master\'s', async () => {
		// The master's artist row was first seen as "Ayşe Çelikoğlu"; one of its
		// listings spells it without the diacritic.
		await rig.desktop('a', {
			catalogue: ['trk-0', 'trk-1'],
			artists: (id) => [{ name: id === 'trk-0' ? 'Ayşe Çelikoğlu' : 'Ayse Celikoglu' }],
		});
		// B meets the plain spelling first: its own file credits it so.
		const b = await rig.desktop('b', { catalogue: ['trk-1'], artists: () => [{ name: 'Ayse Celikoglu' }] });
		expect(b.one(`SELECT name FROM artist WHERE name_ascii = 'aysecelikoglu'`)).toBe('Ayse Celikoglu');
		await rig.settle();
		expect(b.one(`SELECT name FROM artist WHERE name_ascii = 'aysecelikoglu'`)).toBe('Ayşe Çelikoğlu');
		// A fresh device mints it with the master's spelling, whichever row it
		// derives first.
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expect(c.one(`SELECT name FROM artist WHERE name_ascii = 'aysecelikoglu'`)).toBe('Ayşe Çelikoğlu');
	});
});

// ── the remixer role merge ──────────────────────────────────────────────────

describe('remixer role merge (a real-library case, "Night Tide")', () => {
	it('the master re-derives under the role-merging rules once and a fresh device derives the same credits', async () => {
		const credits = [
			{ name: 'Ada' }, { name: 'Bram' }, { name: 'Rho (NL)' }, { name: 'Vela', role: 'remixer' },
			{ name: 'Orin (DE)' }, { name: 'Rho', role: 'remixer' }, { name: 'Orin', role: 'remixer' },
		];
		const a = await rig.desktop('a', { catalogue: ['trk-0'], artists: () => credits as never });
		await rig.settle();
		// The rename that made the alias (as the main library has: Rho → Rho (NL)).
		await a.svc.mergeArtists(a.one<string>(`SELECT id FROM artist WHERE name = 'Rho (NL)'`), a.one<string>(`SELECT id FROM artist WHERE name = 'Rho'`));
		await rig.settle();
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		const want = JSON.parse(a.one<string>(`SELECT artists FROM track WHERE id = 'trk-0'`));
		expect(want).toContainEqual({ name: 'Rho (NL)', role: 'remixer' });
		expect(want).toContainEqual({ name: 'Rho (NL)' });
		expect(JSON.parse(c.one<string>(`SELECT artists FROM track WHERE id = ?`, remoteTrackId(R('trk-0'))))).toEqual(want);
	});

	it('a row ingested while the rule stood (the live case) converges once the upgrade re-derives it', async () => {
		const credits = [{ name: 'Rho (NL)' }, { name: 'Rho', role: 'remixer' }];
		const a = await rig.desktop('a', { catalogue: ['trk-0'], artists: () => [{ name: 'Rho (NL)' }, { name: 'Rho' }] });
		await rig.settle();
		await a.svc.mergeArtists(a.one<string>(`SELECT id FROM artist WHERE name = 'Rho (NL)'`), a.one<string>(`SELECT id FROM artist WHERE name = 'Rho'`));
		await rig.settle();
		// What an ingest after the rule wrote on the main library: the
		// substituted main credit plus the remixer read off the title, raw.
		a.raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES ('trk-k', ?, 'Night Tide - Rho Remix', ?, 'unsorted', 300)`).run(R('trk-k'), JSON.stringify(credits));
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		const remote = (): unknown => JSON.parse(c.one<string>(`SELECT artists FROM track WHERE id = ?`, remoteTrackId(R('trk-k'))));
		// Both roles kept through the rule on the deriving device…
		expect(remote()).toEqual([{ name: 'Rho (NL)' }, { name: 'Rho (NL)', role: 'remixer' }]);
		// …while the master still shows what it ingested.
		expect(JSON.parse(a.one<string>(`SELECT artists FROM track WHERE id = 'trk-k'`))).toEqual(credits);
		// The upgrade's one-time re-derive (migrate.ts → queueRoleMergeRederive).
		const { queueRoleMergeRederive, ROLE_MERGE_REDERIVE_KEY } = await import('../library/artist-alias.js');
		a.raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(ROLE_MERGE_REDERIVE_KEY);
		expect(queueRoleMergeRederive(a.raw)).toBeGreaterThan(0);
		await rig.settle();
		expect(JSON.parse(a.one<string>(`SELECT artists FROM track WHERE id = 'trk-k'`))).toEqual(remote());
	});
});

// ── the Discover feed ───────────────────────────────────────────────────────

const draft = (key: string, sourceId: string, title: string): FeedItemDraft => ({
	type: 'track', source: 'spotify', sourceId, dedupeKey: key, payload: { title, artists: ['A'], artistIds: ['ar1'] }, origin: null, publishedAt: 1_700_000_000_000, suppressKeys: ['source:spotify', 'artist:ar1'],
} as FeedItemDraft);

// A read of a device's feed.db on a connection of its own.
function feedState(d: Desktop, key: string): string | undefined {
	const db = new Database(join(d.dir, 'feed.db'), { readonly: true });
	try { return db.prepare(`SELECT state FROM feed_item WHERE dedupe_key = ?`).pluck().get(key) as string | undefined; } finally { db.close(); }
}

describe('Discover feed decisions', () => {
	it('decisions travel both ways by stable key; a follower runs no producer and an item it collects later lands decided', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'] });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		expect((await a.svc.getFeedRole()).role).toBe('collector');
		expect((await b.svc.getFeedRole()).role).toBe('follower');
		expect(await b.svc.runFeedRefresh()).toEqual({ producers: [], skipped: 'follower' });

		// Both hold the same items (their own feed.db rows, own ids).
		const stores = [a, b].map((d) => new SqliteFeedStore(join(d.dir, 'feed.db')));
		try {
			for (const s of stores) await s.upsertItems([draft('isrc:GB0000000001', 'sp1', 'One'), draft('spotify:track:sp2', 'sp2', 'Two')]);
			const idOf = async (s: SqliteFeedStore, key: string): Promise<string> => (await s.getPage({ limit: 50 })).items.find((i) => i.dedupeKey === key)?.id
				?? (await s.getArchivedPage({ limit: 50 })).items.find((i) => i.dedupeKey === key)!.id;
			await a.svc.feedAction({ kind: 'archive', itemId: await idOf(stores[0]!, 'isrc:GB0000000001') });
			await a.svc.feedAction({ kind: 'mute', scopes: [{ scope: 'artist', key: 'artist:ar9' }] });
			await rig.settle();
			expect(feedState(b, 'isrc:GB0000000001')).toBe('archived');
			expect([...(await stores[1]!.suppressedKeys('artist'))]).toEqual(['artist:ar9']);
			// The follower's own decision syncs back.
			await b.svc.feedAction({ kind: 'dismiss', itemId: await idOf(stores[1]!, 'spotify:track:sp2') });
			await rig.settle();
			expect(feedState(a, 'spotify:track:sp2')).toBe('dismissed');
			// An item the account already decided about lands decided when a
			// device collects it later.
			const c = await rig.desktop('c', { catalogue: [] });
			await rig.settle();
			// The service wires its own store this way (service.ts); this test
			// opens feed.db on a store of its own, so it wires it the same.
			const cs = new SqliteFeedStore(join(c.dir, 'feed.db'));
			cs.setDecisionSource((keys) => syncedItemsFor(c.raw, keys));
			try {
				await cs.upsertItems([draft('isrc:GB0000000001', 'sp1', 'One')]);
				expect((await cs.getArchivedPage({ limit: 10 })).items.map((i) => i.dedupeKey)).toEqual(['isrc:GB0000000001']);
			} finally { cs.close(); }
			// A device that already holds the items, undecided, when it first
			// syncs: the decisions land, and its one-time feed backfill states
			// none of them back (no echo).
			const d = await rig.desktop('d', { catalogue: [] });
			const ds = new SqliteFeedStore(join(d.dir, 'feed.db'));
			try { await ds.upsertItems([draft('isrc:GB0000000001', 'sp1', 'One'), draft('spotify:track:sp2', 'sp2', 'Two')]); } finally { ds.close(); }
			await rig.settle();
			expect([feedState(d, 'isrc:GB0000000001'), feedState(d, 'spotify:track:sp2')]).toEqual(['archived', 'dismissed']);
			const dId = await d.deviceId();
			expect(rig.cloud.log.filter((o) => o.device_id === dId && (o.entity === 'feed_item' || o.entity === 'feed_suppression'))).toEqual([]);
		} finally {
			for (const s of stores) s.close();
		}
	});
});

// ── the snapshot in pieces ──────────────────────────────────────────────────

describe('bootstrap with snapshot_chunks', () => {
	it('asks for the snapshot in pieces only from a server that offers them', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: (raw) => { raw.prepare(`UPDATE track SET bpm = 124 WHERE id = 'trk-0'`).run(); } });
		await rig.settle();
		rig.cloud.hintBelow = rig.cloud.takeSnapshot();
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		expect([rig.cloud.calls.bootstrap, rig.cloud.calls.chunkedBootstraps]).toEqual([1, 1]);
		expect(row(b, 'trk-0')['bpm']).toBe(124);
		// A server without the feature gets the old inline request.
		rig.cloud.features = rig.cloud.features.filter((f) => f !== 'snapshot_chunks');
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expect([rig.cloud.calls.bootstrap, rig.cloud.calls.chunkedBootstraps]).toEqual([2, 1]);
		expect(row(c, 'trk-0')['bpm']).toBe(124);
		void a;
	});
});

// ── a v3 client ─────────────────────────────────────────────────────────────

describe('a v3 client holds v4 ops aside', () => {
	it('every v4 op is "ahead" for a v3 reader; held, it replays once the build reads v4', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: (raw) => { raw.prepare(`UPDATE track SET bpm = 124 WHERE id = 'trk-0'`).run(); } });
		const b = await rig.desktop('b', { catalogue: ['trk-0'] });
		await rig.settle();
		void a;
		const v4 = v4Ops();
		expect(v4.length).toBeGreaterThan(0);
		expect(SCHEMA_VERSION).toBe(4);
		expect(v4.every((o) => schemaVersionStatus(o.schema_version, 3) === 'ahead')).toBe(true);
		// What a v3 build's pull does with them (client.ts: held by version
		// before any parse), then the same database under this build.
		b.raw.prepare(`UPDATE track SET bpm = NULL, attrs_adopted = NULL WHERE id = 'trk-0'`).run();
		b.raw.prepare(`DELETE FROM sync_state WHERE map = 'libraryTracks' AND key = ?`).run(R('trk-0'));
		b.raw.transaction(() => { holdOps(b.raw, v4); })();
		expect(replayHeldOps(b.raw, 3).applied).toBe(0);
		expect(heldCount(b.raw)).toBe(v4.length);
		const r = replayHeldOps(b.raw, 4);
		expect(r.applied).toBe(v4.length);
		expect(heldCount(b.raw)).toBe(0);
		expect(b.one(`SELECT bpm FROM track WHERE id = 'trk-0'`)).toBe(124);
	});
});

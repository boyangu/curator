// Streaming identity across desktops (cloud plan: streaming identity, stage
// 1; the 2026-10-20 second-desktop incident). One Spotify playlist imported
// on two desktops must end as one set of recordings and one set of rows:
// a desktop that already holds the account's claims binds to them
// (claim-bind.ts) instead of minting, imports made concurrently converge on
// the same row ids (stable-ids.ts) and merge through the streaming tier
// (identity.ts), and the duplicates a pre-fix import left heal from the
// original desktop alone, doubled rows included (playlist-dedupe.ts).
// Scenario 21: an op from a newer protocol is held aside, not a stop.
//
// Same rig and rails as the other two-desktop suites: generated DBs and
// files only, no remoteWritePolicy, streaming adapters that record and
// throw (`upstreamCalls()` stays empty), no rekordbox sidecar. The Spotify
// read-sync is driven through SpotifySync's own write path with synthetic
// payloads (as reimport-no-ops.test.ts does): no network, no account.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { keysBetween, SCHEMA_VERSION, type StoredOp } from '@curator/protocol';
import type { SpotifyPlaylist, SpotifyPlaylistTrack } from '@curator/spotify';
import * as mut from '../library/mutators.js';
import { normalizePath } from '../local/scanner.js';
import { SpotifySync } from '../sync/spotify.js';
import { writeFlac } from '../test-support/catalogue-fakes.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { CloudTransportError, readCursor } from './client.js';
import { heldCount, replayHeldOps } from './held.js';
import { planIdentityMerges } from './identity.js';
import { planStreamingDedupe } from './playlist-dedupe.js';
import { recordingIdForTrack } from './recording-id.js';
import { FIRST_PULL_KEY } from './role.js';
import { remoteTrackId, streamingPlaylistId } from './stable-ids.js';
import { syncTrackArtistsByIdRaw } from '../library/artists.js';
import {
	flacParse,
	markPreOpLog,
	playlistOrder,
	positionsContiguous,
	replicaDiff,
	scanWaiter,
	tick,
	TRACKS,
	TwoDesktopRig,
	type Desktop,
} from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-catalogue-'); });
afterEach(() => {
	const upstream = rig.upstreamCalls();
	rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
// The real profile ran a build from before role.ts, which stated its base
// metadata before its first pull. Its first-pull key set, a device that
// names no master yet does the same (role.ts sourceRole: 'all').
const asPreRoleBuild = (raw: Database.Database): void => {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1)`).run(FIRST_PULL_KEY);
};
const ORDERS = [['A syncs first', 'ab'], ['B syncs first', 'ba']] as const;

// ── the Spotify read-sync, offline ─────────────────────────────────────────

type Writer = {
	upsertPlaylistMeta(pl: SpotifyPlaylist): string;
	replacePlaylistTracks(id: string, items: SpotifyPlaylistTrack[]): number;
};

function spotifyPlaylist(id: string, name = 'Shared Mix'): SpotifyPlaylist {
	return {
		id, name, description: null, owner: { id: 'me', display_name: 'Me' }, images: [],
		tracks: { total: 0 }, collaborative: false, public: false, snapshot_id: 's1', external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
	};
}

function spotifyItems(ns: readonly number[]): SpotifyPlaylistTrack[] {
	return ns.map((n) => ({
		added_at: '2026-08-01T10:00:00Z',
		added_by: { id: 'me' },
		is_local: false,
		track: {
			id: `sp${n}`, name: `Song ${n}`, duration_ms: 200_000 + n * 1_000, explicit: false,
			external_ids: { isrc: `GBAAA26${String(n).padStart(5, '0')}` },
			artists: [{ id: `ar${n}`, name: `Artist ${n}` }],
			album: { id: `al${n}`, name: `Album ${n}`, release_date: '2026-01-01', images: [] },
		},
	}) as SpotifyPlaylistTrack);
}

// What SpotifySync.syncPlaylist does after its fetch: meta, then the rows.
function importPlaylist(d: Desktop, spId: string, ns: readonly number[]): string {
	const w = new SpotifySync(d.db, {} as never) as unknown as Writer;
	const id = w.upsertPlaylistMeta(spotifyPlaylist(spId));
	w.replacePlaylistTracks(id, spotifyItems(ns));
	return id;
}

const trackOfSp = (d: Desktop, n: number): string => d.one(`SELECT track_id FROM source_link WHERE source = 'spotify' AND source_track_id = ?`, `sp${n}`);
const recOfSp = (d: Desktop, n: number): string => d.one(`SELECT recording_id FROM track WHERE id = ?`, trackOfSp(d, n));
const outboxLen = (d: Desktop): number => d.one(`SELECT count(*) FROM sync_outbox`);
const outboxSince = (d: Desktop, n: number): string[] =>
	(d.all<{ entity: string; kind: string }>(`SELECT entity, kind FROM sync_outbox ORDER BY seq_local`)).slice(n).map((o) => `${o.entity}.${o.kind}`);
const opsBy = async (d: Desktop, entity: string, kind: string): Promise<StoredOp[]> => {
	const id = await d.deviceId();
	return rig.cloud.log.filter((o) => o.device_id === id && o.entity === entity && o.kind === kind);
};
const mergeOps = (): Array<{ loser: string; winner: string; device: string }> =>
	rig.cloud.log.filter((o) => o.entity === 'recording' && o.kind === 'merge').map((o) => ({ loser: o.entity_id, winner: (o.payload as { winner: string }).winner, device: o.device_id }));
const liveTracks = (d: Desktop): number => d.one(`SELECT count(*) FROM track WHERE deleted_at IS NULL`);

// ── 19 — the same Spotify playlist on both desktops ────────────────────────

describe('scenario 19 — the same Spotify playlist imported on both desktops', () => {
	it('a: sequential — B binds every track to A\'s recordings and adds nothing', async () => {
		const a = await rig.desktop('a');
		const b = await rig.desktop('b');
		const pl = importPlaylist(a, 'spP', [1, 2, 3]);
		expect(pl).toBe(streamingPlaylistId('spotify', 'spP'));
		await rig.settle();
		// B holds the playlist (pulled) and A's rows, on remote rows made from
		// A's base metadata: the tracks show, marked not on this device.
		expect(b.one(`SELECT count(*) FROM playlist_track pt JOIN track t ON t.id = pt.track_id WHERE pt.playlist_id = ? AND t.remote_only = 1`, pl)).toBe(3);
		const remoteIds = b.all<{ id: string }>(`SELECT t.id FROM playlist_track pt JOIN track t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`, pl).map((r) => r.id);

		const before = outboxLen(b);
		expect(importPlaylist(b, 'spP', [1, 2, 3])).toBe(pl);
		// No create, no claim, no membership op: it is all A's already.
		expect(outboxSince(b, before)).toEqual([]);
		// The links landed on the rows B already showed, which are now its own.
		expect([1, 2, 3].map((n) => trackOfSp(b, n))).toEqual(remoteIds);
		expect(b.one(`SELECT count(*) FROM track WHERE remote_only = 1`)).toBe(0);
		for (const n of [1, 2, 3]) expect(recOfSp(b, n), `sp${n}`).toBe(recOfSp(a, n));
		expect(playlistOrder(b, pl)).toEqual(playlistOrder(a, pl));
		expect(positionsContiguous(b, pl)).toBe(true);
		// Projected onto the new rows, with their provider ids.
		expect(b.all(`SELECT source_track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`, pl).map((r) => (r as { source_track_id: string }).source_track_id)).toEqual(['sp1', 'sp2', 'sp3']);

		await rig.settle();
		expect(mergeOps()).toEqual([]);
		expect(replicaDiff(a, b)).toEqual([]);
		// A re-sync with the same list stays silent.
		const again = outboxLen(b);
		importPlaylist(b, 'spP', [1, 2, 3]);
		expect(outboxSince(b, again)).toEqual([]);
	});

	it.each(ORDERS)('b: concurrent, both offline — one playlist, one row per item, one recording per track (%s)', async (_label, order) => {
		const a = await rig.desktop('a');
		const b = await rig.desktop('b');
		const pa = importPlaylist(a, 'spP', [1, 2, 3, 2]);
		const pb = importPlaylist(b, 'spP', [1, 2, 3, 2]);
		expect(pa).toBe(pb);
		// The same row ids on both, before either has seen the other.
		expect(b.all(`SELECT id FROM playlist_track WHERE playlist_id = ? ORDER BY id`, pb)).toEqual(a.all(`SELECT id FROM playlist_track WHERE playlist_id = ? ORDER BY id`, pa));
		const minted = [1, 2, 3].map((n) => [recOfSp(a, n), recOfSp(b, n)].sort());

		await rig.settle(order === 'ab' ? [a, b] : [b, a]);

		// Each pair merged into its smaller id (possibly by both: idempotent).
		const merged = new Map(mergeOps().map((m) => [m.loser, m.winner]));
		for (const [lo, hi] of minted) expect(merged.get(hi!)).toBe(lo);
		for (const d of [a, b]) {
			for (const [i, n] of [1, 2, 3].entries()) expect(recOfSp(d, n), `${d.name} sp${n}`).toBe(minted[i]![0]);
			expect(d.one(`SELECT count(*) FROM playlist_track WHERE playlist_id = ?`, pa), d.name).toBe(4);
			expect(playlistOrder(d, pa), d.name).toEqual([1, 2, 3, 2].map((n) => minted[n - 1]![0]));
			expect(d.one(`SELECT count(*) FROM playlist WHERE source = 'spotify' AND source_id = 'spP'`), d.name).toBe(1);
			expect(liveTracks(d), d.name).toBe(TRACKS.length + 3);
		}
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) expect(planIdentityMerges(d.raw), d.name).toMatchObject({ groups: 0, merges: [] });
	});

	it('c: an upstream duplicate and a reorder between the two imports', async () => {
		const a = await rig.desktop('a');
		const b = await rig.desktop('b');
		const pl = importPlaylist(a, 'spP', [1, 2, 1, 3]);
		await rig.settle();
		// Upstream moved: reordered, and a new track at the end.
		const before = outboxLen(b);
		importPlaylist(b, 'spP', [3, 1, 2, 1, 4]);
		// Only what changed upstream: moves and the new track.
		const ops = outboxSince(b, before);
		expect(ops.filter((o) => o === 'playlist_track.add')).toEqual(['playlist_track.add']);
		expect(ops.filter((o) => o === 'library_track.create')).toEqual(['library_track.create']);
		expect(ops.filter((o) => o === 'playlist_track.remove')).toEqual([]);
		await rig.settle();
		// A shows the new track once it binds it in its own next import.
		const again = outboxLen(a);
		importPlaylist(a, 'spP', [3, 1, 2, 1, 4]);
		expect(outboxSince(a, again)).toEqual([]);
		await rig.settle();
		const want = [3, 1, 2, 1, 4].map((n) => recOfSp(a, n));
		for (const d of [a, b]) {
			expect(playlistOrder(d, pl), d.name).toEqual(want);
			expect(positionsContiguous(d, pl), d.name).toBe(true);
		}
		expect(mergeOps()).toEqual([]);
		expect(replicaDiff(a, b)).toEqual([]);
	});

	it('d: a track A deleted stays deleted when B imports it', async () => {
		const a = await rig.desktop('a');
		const b = await rig.desktop('b');
		const pl = importPlaylist(a, 'spP', [1, 2]);
		mut.softDeleteTracks(a.db, [trackOfSp(a, 2)]);
		await rig.settle();
		const before = outboxLen(b);
		importPlaylist(b, 'spP', [1, 2]);
		expect(outboxSince(b, before)).toEqual([]);
		expect(recOfSp(b, 2)).toBe(recOfSp(a, 2));
		expect(b.one(`SELECT deleted_at FROM track WHERE id = ?`, trackOfSp(b, 2))).not.toBeNull();
		expect(b.one(`SELECT deleted_at FROM track WHERE id = ?`, trackOfSp(b, 1))).toBeNull();
		await rig.settle();
		expect(mergeOps()).toEqual([]);
		expect(playlistOrder(b, pl)).toEqual(playlistOrder(a, pl));
		expect(replicaDiff(a, b)).toEqual([]);
	});

	it('e: two claimants already on record — B binds to the one the resolver keeps', async () => {
		const a = await rig.desktop('a');
		const c = await rig.desktop('c');
		importPlaylist(a, 'spP', [1]);
		importPlaylist(c, 'spP', [1]);
		await a.sync();
		// C pushes but cannot pull (so it cannot resolve the pair yet).
		rig.cloud.fail.pull.push(new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'));
		await c.sync();
		c.transport.online = false;
		const b = await rig.desktop('b');
		await b.sync();
		const claimants = [recOfSp(a, 1), recOfSp(c, 1)].sort();
		expect(claimants[0]).not.toBe(claimants[1]);
		const before = outboxLen(b);
		const pl = importPlaylist(b, 'spP', [1]);
		expect(recOfSp(b, 1)).toBe(claimants[0]);
		expect(outboxSince(b, before).filter((o) => o === 'library_track.create')).toEqual([]);

		c.transport.online = true;
		await rig.settle([a, b, c]);
		expect(new Set(mergeOps().map((m) => `${m.loser}>${m.winner}`))).toEqual(new Set([`${claimants[1]}>${claimants[0]}`]));
		for (const d of [a, b, c]) {
			expect(recOfSp(d, 1), d.name).toBe(claimants[0]);
			expect(d.one(`SELECT count(*) FROM playlist_track WHERE playlist_id = ?`, pl), d.name).toBe(1);
		}
		expect(replicaDiff(a, b)).toEqual([]);
		expect(replicaDiff(a, c)).toEqual([]);
	});
});

// ── 20 — the incident, replayed ────────────────────────────────────────────

describe('scenario 20 — a second desktop that minted its own recordings for A\'s Spotify playlist', () => {
	// Upstream: s1 twice, and s0 a second time because the user added it in
	// Curator on A and the push landed (acked). B imported later, so it also
	// holds s4, which A has not seen yet.
	const A_LIST = [0, 1, 2, 1, 3];
	const B_LIST = [0, 1, 2, 1, 3, 0, 4];
	const PL = 'pl-shared';
	// A second shared playlist B fills only after A healed (offline, from a
	// pre-fix import still in its outbox).
	const PL2 = 'pl-two';

	// Track ids whose recordings sort A-before-B (or B-before-A) per item.
	function pairIds(aSmaller: boolean): { a: string[]; b: string[] } {
		const a: string[] = [];
		const b: string[] = [];
		for (let n = 0; n < 5; n++) {
			for (let i = 0; ; i++) {
				const ida = `a-s${n}-${i}`;
				const idb = `b-s${n}-${i}`;
				if ((R(ida) < R(idb)) === aSmaller) { a.push(ida); b.push(idb); break; }
			}
		}
		return { a, b };
	}

	function seedSpotify(raw: Database.Database, ids: readonly string[], items: readonly number[], addedBase: number, lastKey?: string): void {
		const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, isrc, added_at, created_at) VALUES (?, ?, ?, ?, 'unsorted', ?, ?, ?, ?)`);
		const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, ?)`);
		ids.forEach((id, n) => {
			ins.run(id, R(id), `Song ${n}`, JSON.stringify([{ name: `Artist ${n}` }]), 200 + n, `GBAAA26${String(n).padStart(5, '0')}`, addedBase, addedBase);
			link.run(`sl-${id}`, id, `sp${n}`, addedBase);
		});
		// The artist junction an import derives (a remote row of these on the
		// other desktop derives it too).
		syncTrackArtistsByIdRaw(raw, [...ids]);
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name, created_at) VALUES (?, 'spotify', 'spP', 'Shared Mix', ?)`).run(PL, addedBase);
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name, created_at) VALUES (?, 'spotify', 'spQ', 'Second Mix', ?)`).run(PL2, addedBase);
		const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		items.forEach((n, pos) => {
			const [id, key] = memberOrder(pos);
			// The new item goes after everything A's rows will hold.
			row.run(id, PL, ids[n], n === 4 && lastKey ? keysBetween(lastKey, null, 1)[0] : key, pos, addedBase + pos, `sp${n}`);
		});
	}

	it.each([['A holds the smaller ids (survivors stay on A)', true], ['B holds the smaller ids (A\'s rows re-point)', false]] as const)('%s: A alone heals, then B converges', async (_label, aSmaller) => {
		const ids = pairIds(aSmaller);
		const a = await rig.desktop('a', {
			seed: (raw) => {
				// A never saw s4.
				seedSpotify(raw, ids.a.slice(0, 4), A_LIST, 1_700_000_000_000);
				const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, 1700000000000, ?)`);
				[0, 2].forEach((n, pos) => { const [id, key] = memberOrder(pos); row.run(id, PL2, ids.a[n], key, pos, `sp${n}`); });
				markPreOpLog(raw);
			},
		});
		await a.sync();
		// The user's own second copy of s0, pushed to Spotify.
		const { opIds } = mut.withUpstreamPending(a.db, 'spotify', () => mut.addMembers(a.db, PL, [{ playlistId: PL, trackId: ids.a[0]!, addedAt: new Date(), addedBy: null, sourceTrackId: 'sp0' }]));
		mut.ackUpstream(a.db, opIds, 'spotify', 'pushed');
		await a.sync();
		const aRowsBefore = a.all<{ id: string; track_id: string }>(`SELECT id, track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`, PL);
		const aTracksBefore = liveTracks(a);
		const lastKey = a.one<string>(`SELECT max(order_key) FROM playlist_track WHERE playlist_id = ?`, PL);

		// B: the profile. Its own recording ids for the same Spotify tracks and
		// random-id rows in A's playlist, from before the fix; its initial push
		// states all of it. It pushes and goes away before pulling (so it
		// cannot heal anything itself).
		const b = await rig.desktop('b', {
			seed: (raw) => {
				seedSpotify(raw, ids.b, B_LIST, 1_750_000_000_000, lastKey);
				markPreOpLog(raw);
				asPreRoleBuild(raw);
			},
		});
		rig.cloud.fail.pull.push(new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'));
		await b.sync();
		b.transport.online = false;
		const bRows = b.all<{ id: string; track_id: string }>(`SELECT id, track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`, PL);
		expect(bRows).toHaveLength(B_LIST.length);
		expect(mergeOps()).toEqual([]);

		// A alone.
		await rig.settle([a]);
		const survivor = (n: number): string => (aSmaller ? R(ids.a[n]!) : R(ids.b[n]!));
		const loser = (n: number): string => (aSmaller ? R(ids.b[n]!) : R(ids.a[n]!));
		const aId = await a.deviceId();
		// One merge per shared track, all from A, into the smaller id.
		expect(mergeOps().map((m) => [m.loser, m.winner, m.device]).sort()).toEqual([0, 1, 2, 3].map((n) => [loser(n), survivor(n), aId]).sort());
		// One remove per B row of a shared track; s4's row stays B's.
		const removes = (await opsBy(a, 'playlist_track', 'remove')).map((o) => o.entity_id).sort();
		const bShared = bRows.filter((_, pos) => B_LIST[pos] !== 4).map((r) => r.id).sort();
		expect(removes).toEqual(bShared);
		expect(removes).toHaveLength(6);
		// A's library is the one it had — same rows, same playlist rows,
		// upstream order, the duplicate and the user's add both still there,
		// no doubles — plus the one track only B holds (s4), as a remote row
		// made from B's base metadata, with B's row of it.
		const s4 = R(ids.b[4]!);
		expect(liveTracks(a)).toBe(aTracksBefore + 1);
		expect(a.all(`SELECT recording_id FROM track WHERE remote_only = 1`)).toEqual([{ recording_id: s4 }]);
		expect(a.one(`SELECT title FROM track WHERE remote_only = 1`)).toBe('Song 4');
		expect(a.all(`SELECT id, track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`, PL).slice(0, aRowsBefore.length)).toEqual(aRowsBefore);
		expect(playlistOrder(a, PL)).toEqual([...[0, 1, 2, 1, 3, 0].map(survivor), s4]);
		expect(positionsContiguous(a, PL)).toBe(true);
		for (const n of [0, 1, 2, 3]) expect(a.one(`SELECT recording_id FROM track WHERE id = ?`, ids.a[n]), `s${n}`).toBe(survivor(n));
		// Nothing left to heal on A.
		expect(planIdentityMerges(a.raw)).toMatchObject({ groups: 0, merges: [] });
		expect(planStreamingDedupe(a.raw).removes).toEqual([]);
		// The survivor keeps the earliest add to the library (A's import).
		for (const n of [0, 1, 2, 3]) {
			const rec = JSON.parse(a.one<string>(`SELECT value FROM sync_state WHERE map = 'libraryTracks' AND key = ?`, survivor(n))) as { fields: { added_at?: { value: number } } };
			expect(rec.fields.added_at?.value, `s${n}`).toBe(1_700_000_000_000);
		}

		// B, still unaware of the merges, adds its own rows to the second
		// playlist (an old import's adds) and pushes them without pulling. A
		// shows no double even for one commit: its pull folds them.
		const pl2Before = playlistOrder(a, PL2);
		expect(pl2Before).toEqual([0, 2].map(survivor));
		const late = mut.addMembers(b.db, PL2, [0, 2].map((n) => ({ playlistId: PL2, trackId: ids.b[n]!, addedAt: new Date(), addedBy: null, sourceTrackId: `sp${n}` })));
		b.transport.online = true;
		rig.cloud.fail.pull.push(new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'));
		await b.sync();
		b.transport.online = false;
		await a.sync();
		expect(playlistOrder(a, PL2)).toEqual(pl2Before);
		// The removes wait in A's outbox for its next push.
		expect(a.all<{ entity_id: string }>(`SELECT entity_id FROM sync_outbox WHERE entity = 'playlist_track' AND kind = 'remove' AND state = 'pending'`).map((o) => o.entity_id).sort()).toEqual(late.map((r) => r.id).sort());

		// B comes back and converges, emitting no merge of its own.
		b.transport.online = true;
		await rig.settle([b, a]);
		const bId = await b.deviceId();
		expect(mergeOps().filter((m) => m.device === bId)).toEqual([]);
		for (const n of [0, 1, 2, 3]) expect(b.one(`SELECT recording_id FROM track WHERE id = ?`, ids.b[n]), `s${n}`).toBe(survivor(n));
		expect(playlistOrder(b, PL)).toEqual([...[0, 1, 2, 1, 3, 0].map(survivor), R(ids.b[4]!)]);
		expect(playlistOrder(b, PL2)).toEqual(pl2Before);
		expect(positionsContiguous(b, PL)).toBe(true);
		expect(replicaDiff(a, b)).toEqual([]);
		// B's next read-sync of the same list changes nothing.
		const before = outboxLen(b);
		importPlaylist(b, 'spP', [0, 1, 2, 1, 3, 0, 4]);
		expect(outboxSince(b, before)).toEqual([]);
	});
});

// ── the scanner binds a file to the recording another desktop claims ──────

describe('the scanner on a desktop that already holds another desktop\'s audio claim', () => {
	it('binds the file to that recording: the remote row it showed becomes its own, no new recording, no merge', async () => {
		const PCM = 'c0ffee11'.repeat(4);
		const a = await rig.desktop('a', { parseAudio: flacParse });
		const b = await rig.desktop('b', { parseAudio: flacParse });
		writeFlac(join(a.musicDir, 'Artist - Bound.flac'), PCM, 'TITLE=Bound\nARTIST=Artist\n');
		const wa = scanWaiter(a, normalizePath(a.musicDir));
		await a.svc.addLibraryFolder(a.musicDir);
		await wa.done(1);
		const ta = a.one<string>(`SELECT track_id FROM source_link WHERE source = 'local'`);
		await a.svc.addTrackTag(ta, 'interested');
		await a.svc.setRating([ta], 4);
		await rig.settle();
		// B already shows A's track, as a remote row (no file here).
		const rec = a.one<string>(`SELECT recording_id FROM track WHERE id = ?`, ta);
		expect(b.all(`SELECT id, remote_only FROM track WHERE recording_id = ?`, rec)).toEqual([{ id: remoteTrackId(rec), remote_only: 1 }]);

		writeFlac(join(b.musicDir, 'Artist - Bound.flac'), PCM, 'TITLE=Bound\nARTIST=Artist\n');
		const before = outboxLen(b);
		const wb = scanWaiter(b, normalizePath(b.musicDir));
		await b.svc.addLibraryFolder(b.musicDir);
		expect((await wb.done(1)).created).toBe(0);
		// The file attached to that row, which is now B's own.
		const tb = b.one<string>(`SELECT track_id FROM source_link WHERE source = 'local'`);
		expect(tb).toBe(remoteTrackId(rec));
		expect(b.one(`SELECT remote_only FROM track WHERE id = ?`, tb)).toBe(0);
		expect(b.one(`SELECT count(*) FROM track WHERE recording_id = ?`, rec)).toBe(1);
		expect(b.one(`SELECT recording_id FROM track WHERE id = ?`, tb)).toBe(a.one(`SELECT recording_id FROM track WHERE id = ?`, ta));
		expect(outboxSince(b, before).filter((o) => o === 'library_track.create')).toEqual([]);
		expect(b.one(`SELECT rating FROM track WHERE id = ?`, tb)).toBe(4);
		expect(b.one(`SELECT count(*) FROM track_tag WHERE track_id = ? AND tag_id = 'interested'`, tb)).toBe(1);
		await rig.settle();
		expect(mergeOps()).toEqual([]);
		expect(replicaDiff(a, b)).toEqual([]);
	});
});

// ── the read-sync waits for the first pull ─────────────────────────────────

describe('a signed-in desktop\'s streaming read-sync waits for its first pull', () => {
	it('refuses before the first pull, runs after it', async () => {
		const a = await rig.desktop('a');
		await expect(a.svc.runSpotifySync()).rejects.toThrow(/still loading your library/);
		await expect(a.svc.runTidalSync()).rejects.toThrow(/still loading your library/);
		await a.sync();
		// Past the gate: now it is only the (absent) Spotify connection.
		await expect(a.svc.runSpotifySync()).rejects.toThrow(/Spotify not connected/);
	});
});

// ── 17 — a fresh device with no sources shows the whole library ───────────

// Protocol v3 (cloud plan: streaming identity §3): every device states its
// rows' base metadata, and a device with no row of a recording shows it as a
// remote row (remote-rows.ts) — "not on this device" — with its curation.
describe('scenario 17 — a fresh device with no sources shows the account\'s whole library', () => {
	const remoteRows = (d: Desktop): Array<{ recording_id: string; title: string; deleted: number }> =>
		d.all(`SELECT recording_id, title, deleted_at IS NOT NULL AS deleted FROM track WHERE remote_only = 1 ORDER BY recording_id`);
	const titleOn = (d: Desktop, id: string): string | null => d.one(`SELECT coalesce(json_extract(overrides, '$.title'), title) FROM track WHERE recording_id = ?`, R(id)) ?? null;

	// A's library: tags, a rating, a playlist, an override, a delete.
	async function curate(a: Desktop): Promise<void> {
		await a.svc.addTrackTag('trk-1', 'interested');
		await a.svc.setRating(['trk-2'], 5);
		await a.svc.createLocalPlaylistFromTracks('Warmup', ['trk-3', 'trk-4']);
		await a.svc.setTrackOverrides('trk-5', { title: 'Edited Title' });
		mut.softDeleteTracks(a.db, ['trk-6']);
	}

	function expectWholeLibrary(a: Desktop, c: Desktop): void {
		// Every live track of A's, on C, marked: no row of C's own exists.
		expect(c.one(`SELECT count(*) FROM track WHERE remote_only = 0`)).toBe(0);
		expect(remoteRows(c).filter((r) => !r.deleted).map((r) => r.recording_id).sort()).toEqual(TRACKS.filter((t) => t !== 'trk-6').map(R).sort());
		// The deleted track's row is there, deleted (as A's own is).
		expect(remoteRows(c).filter((r) => r.recording_id === R('trk-6')).map((r) => r.deleted)).toEqual([1]);
		expect(titleOn(c, 'trk-0')).toBe('Title trk-0');
		expect(titleOn(c, 'trk-5')).toBe('Edited Title');
		expect(c.one(`SELECT rating FROM track WHERE recording_id = ?`, R('trk-2'))).toBe(5);
		expect(c.one(`SELECT count(*) FROM track_tag tt JOIN track t ON t.id = tt.track_id WHERE t.recording_id = ? AND tt.tag_id = 'interested'`, R('trk-1'))).toBe(1);
		const pl = a.one<string>(`SELECT id FROM playlist WHERE name = 'Warmup'`);
		expect(playlistOrder(c, pl)).toEqual([R('trk-3'), R('trk-4')]);
		// The credits and their artist entities, as on A.
		expect(c.one(`SELECT count(*) FROM track_artist ta JOIN track t ON t.id = ta.track_id WHERE t.remote_only = 1`)).toBe(TRACKS.length);
		expect(replicaDiff(a, c, { sharedOnly: true })).toEqual([]);
	}

	it('via ops: the rows appear, then follow a rename (alias re-derivation), a delete and an undelete', async () => {
		const a = await rig.desktop('a');
		await curate(a);
		await rig.settle();
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expectWholeLibrary(a, c);
		expect(await c.svc.getAccountLibraryInfo()).toMatchObject({ masterDeviceId: await a.deviceId(), remoteOnlyCount: TRACKS.length - 1, metaSyncAvailable: true });

		// A renames the artist: C's credits re-derive from the source credits
		// its remote rows keep.
		const artistId = a.one<string>(`SELECT id FROM artist WHERE name = 'Artist'`);
		await a.svc.renameArtist(artistId, 'The Artist');
		mut.softDeleteTracks(a.db, ['trk-7']);
		mut.undeleteTracks(a.db, ['trk-6']);
		await rig.settle();
		expect(c.one(`SELECT artists FROM track WHERE recording_id = ?`, R('trk-0'))).toBe(JSON.stringify([{ name: 'The Artist' }]));
		expect(c.one(`SELECT deleted_at IS NOT NULL FROM track WHERE recording_id = ?`, R('trk-7'))).toBe(1);
		expect(c.one(`SELECT deleted_at FROM track WHERE recording_id = ?`, R('trk-6'))).toBeNull();
		expect(replicaDiff(a, c)).toEqual([]);
		// Nothing of C's own went out: no create, no claim, no meta.
		const cId = await c.deviceId();
		expect(rig.cloud.log.filter((o) => o.device_id === cId && (o.entity === 'recording_claim' || o.kind === 'create' || o.kind === 'set-meta'))).toEqual([]);
	});

	it('via the snapshot: a device that bootstraps gets every remote row from the records it loads', async () => {
		const a = await rig.desktop('a');
		await curate(a);
		await rig.settle();
		const snapSeq = rig.cloud.takeSnapshot();
		rig.cloud.hintBelow = snapSeq;
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expect(rig.cloud.calls.bootstrap).toBe(1);
		expectWholeLibrary(a, c);
	});

	it('the v2-snapshot upgrade: records loaded before any device stated meta show nothing, then everything once the server reads v3', async () => {
		const v2 = rig.cloud.features;
		rig.cloud.features = v2.filter((f) => f !== 'track_meta' && f !== 'zero_loss_v4');
		const a = await rig.desktop('a');
		await curate(a);
		await rig.settle();
		const snapSeq = rig.cloud.takeSnapshot();
		rig.cloud.hintBelow = snapSeq;
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expect(rig.cloud.calls.bootstrap).toBe(1);
		// The 2026-10-20 incident's second desktop: the records, no rows.
		expect(c.one(`SELECT count(*) FROM sync_state WHERE map = 'libraryTracks'`)).toBeGreaterThan(0);
		expect(c.one(`SELECT count(*) FROM track`)).toBe(0);
		expect(rig.cloud.log.some((o) => o.kind === 'set-meta')).toBe(false);
		// The server is upgraded: A states its rows' meta once (the
		// backfill), C materialises them.
		rig.cloud.features = v2;
		await rig.settle();
		expectWholeLibrary(a, c);
		expect(rig.cloud.log.filter((o) => o.kind === 'set-meta')).toHaveLength(TRACKS.length);
	});
});

// ── 18 — the master device's metadata wins ─────────────────────────────────

describe('scenario 18 — master device wins', () => {
	it('the master\'s spelling shows on a third device; a track only another device holds shows its own; a master change re-picks', async () => {
		// A links the library first: the default master.
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		await rig.settle();
		const b = await rig.desktop('b', {
			catalogue: ['trk-0', 'trk-1', 'b-only'],
			seed: (raw) => { raw.prepare(`UPDATE track SET title = 'B spelling of ' || id`).run(); },
		});
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		const [aId, bId] = [await a.deviceId(), await b.deviceId()];
		expect(rig.cloud.log.filter((o) => o.entity === 'setting' && o.entity_id === 'library.master_device').map((o) => [o.device_id, o.payload])).toEqual([[aId, { value: aId }]]);
		const title = (d: Desktop, id: string): string => d.one(`SELECT title FROM track WHERE recording_id = ?`, R(id));
		// Both A and B stated meta for trk-0; A is the master.
		expect(title(c, 'trk-0')).toBe('Title trk-0');
		expect(title(c, 'trk-1')).toBe('Title trk-1');
		// Only B holds b-only: its meta shows.
		expect(title(c, 'b-only')).toBe('B spelling of b-only');
		expect(title(a, 'b-only')).toBe('B spelling of b-only');
		expect(a.one(`SELECT remote_only FROM track WHERE recording_id = ?`, R('b-only'))).toBe(1);
		// Own rows keep their own spelling on every device.
		expect(title(b, 'trk-0')).toBe('B spelling of trk-0');
		expect(title(a, 'trk-0')).toBe('Title trk-0');

		// The user makes B the master (Settings → Account).
		expect(await b.svc.setMasterDevice(bId)).toMatchObject({ masterDeviceId: bId });
		await rig.settle();
		expect(title(c, 'trk-0')).toBe('B spelling of trk-0');
		expect(title(a, 'trk-0')).toBe('Title trk-0');
		for (const d of [a, b, c]) expect((await d.svc.getAccountLibraryInfo()).masterDeviceId, d.name).toBe(bId);
		expect(replicaDiff(a, c, { sharedOnly: true }).map((r) => r.table)).not.toContain('tracks');
	});
});

// ── the "Astral Traveling" edge (dry run, 2026-10-20) ──────────────────────

describe('a streaming playlist holding two releases of one song that another device folded into one recording', () => {
	// Upstream: "Back Stabbers" twice — two releases, two Spotify ids, one
	// ISRC. A (main) holds a recording per release; B (the profile, pre-fix)
	// bound the second release to the first by ISRC (stated at 1.0 back then),
	// so one recording of B's claims both ids and B's import holds it twice.
	const PL = 'pl-astral';
	const ISRC = 'USSM17200040';

	function seed(raw: Database.Database, rows: Array<[string, string[]]>, members: string[], addedBase: number): void {
		const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, isrc, added_at, created_at) VALUES (?, ?, 'Back Stabbers', '[{"name":"The O''Jays"}]', 'unsorted', 230, ?, ?, ?)`);
		const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, ?)`);
		for (const [id, sps] of rows) {
			ins.run(id, R(id), ISRC, addedBase, addedBase);
			for (const sp of sps) link.run(`sl-${id}-${sp}`, id, sp, addedBase);
		}
		syncTrackArtistsByIdRaw(raw, rows.map(([id]) => id));
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name, created_at) VALUES (?, 'spotify', 'spAstral', 'Astral Traveling', ?)`).run(PL, addedBase);
		const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		members.forEach((t, pos) => { const [id, key] = memberOrder(pos); row.run(`${t}-row-${pos}`, PL, t, key, pos, addedBase + pos, 'sp'); });
		markPreOpLog(raw);
	}

	it('A keeps one row per upstream item, whichever recordings the rows are under', async () => {
		const a = await rig.desktop('a', { catalogue: [], seed: (raw) => seed(raw, [['a-sa', ['spA']], ['a-sb', ['spB']]], ['a-sa', 'a-sb'], 1_700_000_000_000) });
		await a.sync();
		// B pushes and goes away before pulling.
		const b = await rig.desktop('b', { catalogue: [], seed: (raw) => { seed(raw, [['b-p', ['spA', 'spB']]], ['b-p', 'b-p'], 1_750_000_000_000); asPreRoleBuild(raw); } });
		rig.cloud.fail.pull.push(new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'));
		await b.sync();
		b.transport.online = false;
		await rig.settle([a]);

		// B's one recording bridges A's two: the resolver holds it (A minted
		// two of the group), so nothing merges.
		expect(mergeOps()).toEqual([]);
		// A's playlist: its own two rows, B's two removed (one per upstream
		// item stays, not one per recording).
		expect(playlistOrder(a, PL)).toEqual([R('a-sa'), R('a-sb')]);
		expect(planStreamingDedupe(a.raw).removes).toEqual([]);
		expect((await opsBy(a, 'playlist_track', 'remove')).map((o) => o.entity_id).sort()).toEqual(['b-p-row-0', 'b-p-row-1']);
		// B's recording is in A's library (a remote row), not in the playlist.
		expect(a.one(`SELECT remote_only FROM track WHERE recording_id = ?`, R('b-p'))).toBe(1);

		b.transport.online = true;
		await rig.settle([b, a]);
		for (const d of [a, b]) expect(playlistOrder(d, PL), d.name).toEqual([R('a-sa'), R('a-sb')]);
		expect(positionsContiguous(b, PL)).toBe(true);
	});

	it('the dry run\'s order: the first release merged, then the second release\'s claim and row arrive', async () => {
		const a = await rig.desktop('a', { catalogue: [], seed: (raw) => seed(raw, [['a-sa', ['spA']], ['a-sb', ['spB']]], ['a-sa', 'a-sb'], 1_700_000_000_000) });
		await a.sync();
		// B first holds only the first release, once.
		const b = await rig.desktop('b', { catalogue: [], seed: (raw) => seed(raw, [['b-p', ['spA']]], ['b-p'], 1_750_000_000_000) });
		rig.cloud.fail.pull.push(new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'));
		await b.sync();
		b.transport.online = false;
		await rig.settle([a]);
		expect(mergeOps()).toHaveLength(1);
		expect(playlistOrder(a, PL).length).toBe(2);
		// Still offline and pre-fix, B binds the second release to its
		// recording by ISRC and adds it: the claim and the row reach A later.
		b.raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES ('sl-b-p-spB', 'b-p', 'spotify', 'spB', 1)`).run();
		mut.addClaims(b.db, 'b-p', [{ kind: 'spotify', value: 'spB', confidence: 1 }]);
		mut.addMembers(b.db, PL, [{ playlistId: PL, trackId: 'b-p', addedAt: new Date(), addedBy: null, sourceTrackId: 'spB' }]);
		b.transport.online = true;
		rig.cloud.fail.pull.push(new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'));
		await b.sync();
		b.transport.online = false;
		await rig.settle([a]);
		// Two items, two rows — not the three a per-recording fold left.
		expect(playlistOrder(a, PL)).toHaveLength(2);
		expect(planStreamingDedupe(a.raw).removes).toEqual([]);
		b.transport.online = true;
		await rig.settle([b, a]);
		for (const d of [a, b]) expect(playlistOrder(d, PL), d.name).toHaveLength(2);
	});
});

// ── 21 — a newer protocol version on the log ───────────────────────────────

describe('scenario 21 — an op from a newer protocol version', () => {
	it('is held aside on the older desktop; everything else applies; it replays after an update', async () => {
		const a = await rig.desktop('a');
		const b = await rig.desktop('b');
		await rig.settle();
		await a.svc.setRating(['trk-1'], 2);
		await a.sync();
		// A newer desktop's op, of a kind this build knows but stamped with a
		// version it does not read, then more ordinary ops after it.
		const head = rig.cloud.maxSeq;
		rig.cloud.appendRaw({
			op_id: '5f0c3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f', device_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', client_ts: Date.now() + 1_000,
			schema_version: SCHEMA_VERSION + 1, entity: 'library_track', entity_id: R('trk-2'), kind: 'set-rating', payload: { rating: 5 },
			seq: head + 1, user_id: 'user-e2e', received_at: Date.now(),
		} as StoredOp);
		await tick();
		await a.svc.setRating(['trk-3'], 3);
		await a.svc.addTrackTag('trk-4', 'interested');
		await a.sync();
		await b.sync();

		expect(readCursor(b.raw).lastSeq).toBe(rig.cloud.maxSeq);
		expect(heldCount(b.raw)).toBe(1);
		expect((await b.svc.getCloudSyncStatus()).needsUpdate).toBe(true);
		expect(b.one(`SELECT rating FROM track WHERE id = 'trk-1'`)).toBe(2);
		expect(b.one(`SELECT rating FROM track WHERE id = 'trk-3'`)).toBe(3);
		expect(b.one(`SELECT count(*) FROM track_tag WHERE track_id = 'trk-4'`)).toBe(1);
		expect(b.one(`SELECT rating FROM track WHERE id = 'trk-2'`)).toBeNull();
		// Another pull neither re-holds nor stops.
		await b.sync();
		expect(heldCount(b.raw)).toBe(1);

		// The update: a build that reads the version replays it.
		expect(replayHeldOps(b.raw, SCHEMA_VERSION + 1)).toMatchObject({ applied: 1, remaining: 0, error: null });
		expect(b.one(`SELECT rating FROM track WHERE id = 'trk-2'`)).toBe(5);
		expect((await b.svc.getCloudSyncStatus()).needsUpdate).toBe(false);
	});
});

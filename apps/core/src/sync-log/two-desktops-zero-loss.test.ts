// The desktop-only fixes of the 2026-10-21 zero-data-loss audit, across two
// (or three) desktops on one account:
//   1  play history: a device that bootstraps, or adopts a recording later,
//      links every play to its track; the one-time heal re-links what the
//      old projection left detached and leaves a device's own plays alone;
//   5  covers: a row whose cover only showed through the Spotify payload
//      states it, so remote rows show it too (and the v2 backfill key
//      re-states exactly the rows whose meta changed);
//   6a every provider id of a recording reaches the other device (a merged
//      track's two Spotify ids), primary first, an own link winning per id;
//   6b the launch-time claims reconcile states a link no claim carried, once.
// Same rig and rails as the other two-desktop suites: generated DBs only, no
// remoteWritePolicy, streaming adapters that record and throw, no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PlayRecordUpsert } from '@curator/shared/schema';
import { projectAdoptedRecordings } from './claim-bind.js';
import { PLAY_HEAL_KEY } from './play-heal.js';
import { recordingIdForTrack } from './recording-id.js';
import { remoteTrackId } from './stable-ids.js';
import { TRACK_META_BACKFILL_KEY } from './track-meta.js';
import { historyDump, TwoDesktopRig, type Desktop } from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-zl-'); });
afterEach(async () => {
	const upstream = rig.upstreamCalls();
	await rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `trk-${i}`);

const play = (id: string, trackId: string, at: number): PlayRecordUpsert => ({
	id, trackId, startedAt: at, playedMs: 200_000, final: true, sourceTrackId: null, source: 'local', durationMs: 300_000, maxPositionMs: 200_000,
	endedReason: 'ended', contextType: null, contextId: null,
});
async function playAll(d: Desktop, tracks: readonly string[], t0 = Date.now() - 86_400_000): Promise<void> {
	for (const [i, t] of tracks.entries()) await d.svc.recordPlay(play(`p-${t}`, t, t0 + i * 400_000));
}
// event id → the recording its row shows it under (null: detached).
const playLinks = (d: Desktop): Record<string, string | null> =>
	Object.fromEntries(d.all<{ id: string; rec: string | null }>(`SELECT e.id, t.recording_id AS rec FROM play_event e LEFT JOIN track t ON t.id = e.track_id ORDER BY e.id`).map((r) => [r.id, r.rec]));

// ── 1 — play history ────────────────────────────────────────────────────────

describe('audit 1 — plays stay linked to their tracks on another device', () => {
	it('bootstrap: a fresh device links every play, including those of the rows it makes after the snapshot (more than the inline budget)', async () => {
		// 40 tracks: past remote-rows.ts INLINE_CREATE_ROWS (25), so most rows
		// are made by the drain after the snapshot's events were projected.
		const tracks = ids(40);
		const a = await rig.desktop('a', { catalogue: tracks });
		await playAll(a, tracks);
		await rig.settle();
		rig.cloud.hintBelow = rig.cloud.takeSnapshot();
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		expect(rig.cloud.calls.storageBootstraps).toBe(1);
		const links = playLinks(c);
		expect(Object.keys(links)).toHaveLength(40);
		expect(links).toEqual(Object.fromEntries(tracks.map((t) => [`p-${t}`, R(t)])));
		expect(historyDump(c)).toEqual(historyDump(a));
	});

	it('adopt: a recording whose row arrives after its plays (a bound import) shows them', async () => {
		// A v2 server: records, no meta, so no remote rows — the plays are
		// projected with no track to land on. Without v3 no device can be the
		// master, so no base either: the library goes up as ops.
		rig.cloud.features = rig.cloud.features.filter((f) => f !== 'track_meta' && f !== 'zero_loss_v4' && f !== 'snapshot_storage');
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		await playAll(a, ['trk-0', 'trk-1']);
		await rig.settle();
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		expect(b.one(`SELECT count(*) FROM track`)).toBe(0);
		expect(playLinks(b)).toEqual({ 'p-trk-0': null, 'p-trk-1': null });
		// A streaming import binds trk-0's recording (claim-bind.ts): a row
		// with its recording id, then the recording's records projected.
		b.raw.transaction(() => {
			b.raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES ('bound', ?, 'Bound', '[]', 'unsorted', 300)`).run(R('trk-0'));
			projectAdoptedRecordings(b.raw, [R('trk-0')]);
		})();
		expect(playLinks(b)).toEqual({ 'p-trk-0': R('trk-0'), 'p-trk-1': null });
		expect(b.one(`SELECT track_id FROM play_event WHERE id = 'p-trk-0'`)).toBe('bound');
	});

	it('the one-time heal re-links detached plays and re-creates a missing session; a device\'s own plays are left exactly as they were', async () => {
		const tracks = ids(6);
		const a = await rig.desktop('a', { catalogue: tracks });
		// Two sessions, a day apart.
		await playAll(a, tracks.slice(0, 3), Date.now() - 2 * 86_400_000);
		await playAll(a, tracks.slice(3), Date.now() - 86_400_000);
		await rig.settle();
		expect(a.one(`SELECT count(DISTINCT session_id) FROM play_event`)).toBe(2);
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		const want = playLinks(a);
		expect(playLinks(b)).toEqual(want);
		// What the old projection left on the real second profile: every play
		// detached, and (worse case) a session row missing with its events.
		const session = b.one<string>(`SELECT session_id FROM play_event WHERE id = 'p-trk-5'`);
		b.raw.prepare(`UPDATE play_event SET track_id = NULL`).run();
		b.raw.prepare(`DELETE FROM play_event WHERE session_id = ?`).run(session);
		b.raw.prepare(`DELETE FROM play_session WHERE id = ?`).run(session);
		b.raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(PLAY_HEAL_KEY);
		// A has the heal pending too: it must change nothing there.
		a.raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(PLAY_HEAL_KEY);
		const aBefore = a.all(`SELECT * FROM play_event ORDER BY id`);
		const aSessions = a.all(`SELECT * FROM play_session ORDER BY id`);
		await rig.settle();
		expect(playLinks(b)).toEqual(want);
		expect(b.one(`SELECT count(*) FROM play_session WHERE id = ?`, session)).toBe(1);
		expect(historyDump(b)).toEqual(historyDump(a));
		expect(a.all(`SELECT * FROM play_event ORDER BY id`)).toEqual(aBefore);
		expect(a.all(`SELECT * FROM play_session ORDER BY id`)).toEqual(aSessions);
		// Gated: it ran once on each.
		expect(b.one(`SELECT count(*) FROM app_setting WHERE key = ?`, PLAY_HEAL_KEY)).toBe(1);
		expect(a.one(`SELECT count(*) FROM app_setting WHERE key = ?`, PLAY_HEAL_KEY)).toBe(1);
	});
});

// ── 5 — covers ──────────────────────────────────────────────────────────────

const ART = 'https://i.scdn.co/image/ab67616d0000b273aaaaaaaaaaaaaaaaaaaaaaaa';
const payload = (url: string | null): string => JSON.stringify({ id: 'sp0', name: 'Song', album: { id: 'al0', name: 'Album', images: url ? [{ height: 640, width: 640, url }, { height: 64, width: 64, url: `${url}-small` }] : [] } });

describe('audit 5 — covers that only showed through the Spotify payload reach remote rows', () => {
	it('a row with no cover_url states its payload art; the v2 backfill re-states only the rows whose meta changed', async () => {
		const a = await rig.desktop('a', {
			catalogue: ['trk-0', 'trk-1', 'trk-2'],
			seed: (raw) => {
				const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload, fetched_at) VALUES (?, ?, 'spotify', ?, ?, 1700000000000)`);
				link.run('sl-0', 'trk-0', 'sp0', payload(ART));
				// trk-1's art arrives later (a re-fetch writes the payload only).
				link.run('sl-1', 'trk-1', 'sp1', payload(null));
				raw.prepare(`UPDATE track SET cover_url = 'https://example.test/own.jpg' WHERE id = 'trk-2'`).run();
			},
		});
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		const cover = (d: Desktop, t: string): string | null => d.one(`SELECT cover_url FROM track WHERE recording_id = ?`, R(t));
		expect(cover(c, 'trk-0')).toBe(ART);
		expect(cover(c, 'trk-1')).toBeNull();
		expect(cover(c, 'trk-2')).toBe('https://example.test/own.jpg');
		expect(await c.svc.getTrackCoverUrl(remoteTrackId(R('trk-0')))).toBe(ART);

		// The payload changes without a dirty mark (no meta column moved);
		// the upgrade to a build with a new backfill key re-queues every row,
		// and the digest keeps the emission to the one that changed.
		a.raw.prepare(`UPDATE source_link SET payload = ? WHERE id = 'sl-1'`).run(payload(`${ART}-1`));
		a.raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(TRACK_META_BACKFILL_KEY);
		const aId = await a.deviceId();
		const metaOps = (): number => rig.cloud.log.filter((o) => o.device_id === aId && o.kind === 'set-meta').length;
		const before = metaOps();
		await rig.settle();
		expect(metaOps() - before).toBe(1);
		expect(cover(c, 'trk-1')).toBe(`${ART}-1`);
	});
});

// ── 6a — every provider id ──────────────────────────────────────────────────

describe('audit 6a — every provider id of a recording reaches the other device', () => {
	it('a merged track\'s two Spotify ids: both listed, the primary first; an own link wins for its id only', async () => {
		const a = await rig.desktop('a', {
			catalogue: ['trk-0', 'trk-1', 'trk-2'],
			seed: (raw) => {
				const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, ?, ?, ?)`);
				link.run('sl-0', 'trk-0', 'spotify', 'sp0', 1_700_000_000_000);
				link.run('sl-1', 'trk-1', 'spotify', 'sp1', 1_700_000_000_001);
				link.run('sl-1t', 'trk-1', 'tidal', 'td1', 1_700_000_000_002);
			},
		});
		// B holds trk-0 itself, with its own link of one of the ids.
		const b = await rig.desktop('b', {
			catalogue: ['trk-0'],
			seed: (raw) => { raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES ('b-sl-0', 'trk-0', 'spotify', 'sp0', 1700000000000)`).run(); },
		});
		const c = await rig.desktop('c', { catalogue: [] });
		await rig.settle();
		await a.svc.mergeTracks('trk-0', 'trk-1');
		await rig.settle();
		// A's merge keeps one own link per provider (merge-tracks.ts drops the
		// loser's duplicate); the recording's claims keep both ids, so even A
		// lists the dropped one, from the account.
		expect(a.all<{ s: string }>(`SELECT source_track_id AS s FROM source_link WHERE track_id = 'trk-0' AND source = 'spotify'`).map((r) => r.s)).toEqual(['sp0']);
		expect((await a.svc.getTrackSourceLinks('trk-0')).map((l) => [l.source, l.sourceTrackId, l.derived ?? false])).toEqual([['spotify', 'sp0', false], ['tidal', 'td1', false], ['spotify', 'sp1', true]]);

		// C (no row of its own): the remote row lists every id, ranked.
		const rc = remoteTrackId(R('trk-0'));
		expect(c.all<{ s: string; v: string; rank: number }>(`SELECT source AS s, source_track_id AS v, rank FROM claim_link WHERE track_id = ? ORDER BY source, rank`, rc))
			.toEqual([{ s: 'spotify', v: 'sp1', rank: 0 }, { s: 'spotify', v: 'sp0', rank: 1 }, { s: 'tidal', v: 'td1', rank: 0 }]);
		const links = await c.svc.getTrackSourceLinks(rc);
		expect(links.map((l) => [l.source, l.sourceTrackId, l.derived ?? false])).toEqual([['spotify', 'sp1', true], ['spotify', 'sp0', true], ['tidal', 'td1', true]]);
		const [tc] = await c.svc.getTracks({ ids: [rc] });
		expect([...tc!.claimSources!].sort()).toEqual(['spotify', 'tidal']);

		// B: its own sp0 wins for that id; sp1 and td1 are listed from the
		// account; the pips name only the providers B holds no link of.
		const bl = await b.svc.getTrackSourceLinks('trk-0');
		expect(bl.map((l) => [l.source, l.sourceTrackId, l.derived ?? false])).toEqual([['spotify', 'sp0', false], ['spotify', 'sp1', true], ['tidal', 'td1', true]]);
		const [tb] = await b.svc.getTracks({ ids: ['trk-0'] });
		expect(tb!.sources).toEqual(['spotify']);
		expect(tb!.claimSources).toEqual(['tidal']);
		// Derived ids are display only: neither states one as a claim. (B may
		// state its own link, sp0 — a device vouching for what it ingested.)
		for (const d of [b, c]) {
			const id = await d.deviceId();
			const values = rig.cloud.log.filter((o) => o.device_id === id && o.entity === 'recording_claim').map((o) => (o.payload as { value: string }).value);
			expect(values.filter((v) => v !== 'sp0' || d !== b)).toEqual([]);
		}
	});
});

// ── 6b — the claims reconcile ───────────────────────────────────────────────

describe('audit 6b — a link no claim carried is stated at the next launch, once', () => {
	it('a Tidal link written after the claims backfill reaches the other device; a second launch states nothing', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		// The 2026-10-20 case: a writer that did not claim yet, after the
		// one-time backfill had run.
		a.raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES ('late', 'trk-1', 'tidal', '564917096', 1760900000000)`).run();
		await rig.settle();
		const aId = await a.deviceId();
		const claims = (): Array<{ entity_id: string; payload: unknown; client_ts: number }> =>
			rig.cloud.log.filter((o) => o.device_id === aId && o.entity === 'recording_claim' && (o.payload as { value: string }).value === '564917096') as never;
		// This session already reconciled (its first cycle, before the write).
		expect(claims()).toEqual([]);
		await a.restart();
		await rig.settle();
		expect(claims()).toHaveLength(1);
		expect(claims()[0]).toMatchObject({ entity_id: R('trk-1'), payload: { kind: 'tidal', value: '564917096', confidence: 1 }, client_ts: 1_760_900_000_000 });
		expect(b.one(`SELECT source_track_id FROM claim_link WHERE track_id = ? AND source = 'tidal'`, remoteTrackId(R('trk-1')))).toBe('564917096');
		await a.restart();
		await rig.settle();
		expect(claims()).toHaveLength(1);
	});
});

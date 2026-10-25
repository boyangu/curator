// Provider links on a second desktop (the 2026-10-21 gap: source_link is
// device-local, so the second desktop showed none of the Tidal links the
// main desktop's hybrid matcher had made, and no link at all on its remote
// rows). A holds Spotify, Tidal and Beatport links — imported ones, a hybrid
// match made after its initial push, an enrichment link — and owns a Spotify
// playlist; B is fresh but for two rows of its own. B shows A's ids on every
// row as claim-derived links (claim-links.ts), and they stay display data:
// B's deletes push nothing anywhere, B's own Tidal import replaces only the
// links it really ingests, and A's later link change and merge reach B.
//
// Same rig and rails as the other two-desktop suites: generated DBs only, no
// remoteWritePolicy, streaming adapters that record and throw
// (`upstreamCalls()` stays empty), no rekordbox sidecar, no network (the
// Tidal matcher gets a stub client, the Tidal import synthetic payloads).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TidalApiClient, TidalPlaylist, TidalPlaylistItem, TidalTrackV2 } from '@curator/tidal';
import { TidalHybrid } from '../sync/tidal-hybrid.js';
import { TidalSync } from '../sync/tidal.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { markPreOpLog, TwoDesktopRig, type Desktop } from '../test-support/two-desktops.js';
import { recordingIdForTrack } from './recording-id.js';
import { remoteTrackId } from './stable-ids.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-links-'); });
afterEach(async () => {
	const upstream = rig.upstreamCalls();
	await rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;

// A's links, as its imports, matchers and enrichment left them.
const A_LINKS: Record<string, Array<[string, string]>> = {
	'trk-0': [['spotify', 'sp0'], ['tidal', 'td0'], ['beatport', '100']],
	'trk-1': [['spotify', 'sp1'], ['tidal', 'td1'], ['beatport', '101']],
	'trk-2': [['spotify', 'sp2'], ['tidal', 'td2']],
	'trk-3': [['spotify', 'sp3'], ['tidal', 'td3']],
	'trk-4': [['spotify', 'sp4']],
	'trk-5': [['beatport', '105']],
	'trk-6': [['spotify', 'sp6']],
	'trk-7': [['tidal', 'td7']],
};
const PL = 'pl-owned';

async function mainDesktop(): Promise<Desktop> {
	return rig.desktop('a', {
		seed: (raw) => {
			const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, ?, ?, ?)`);
			let at = 1_700_000_000_000;
			for (const [trackId, links] of Object.entries(A_LINKS)) for (const [source, value] of links) link.run(`sl-${trackId}-${source}`, trackId, source, value, at++);
			raw.prepare(`UPDATE track SET isrc = 'GBAAA2600006' WHERE id = 'trk-6'`).run();
			// A playlist A owns on Spotify, holding two of the tracks.
			raw.prepare(`INSERT INTO playlist (id, source, source_id, name, owner_id, created_at) VALUES (?, 'spotify', 'spOwned', 'Mine', 'me', 1700000000000)`).run(PL);
			const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, 1700000000000, ?)`);
			['trk-2', 'trk-3'].forEach((t, pos) => { const [id, key] = memberOrder(pos); row.run(id, PL, t, key, pos, `sp${pos + 2}`); });
			// A library from before the op log: the initial push states its
			// recordings and claims (the claims backfill path).
			markPreOpLog(raw);
		},
	});
}

// What A holds per recording / what B shows as derived, as one comparable map.
const ownLinks = (d: Desktop): Record<string, Record<string, string>> => group(d.all<{ rec: string; source: string; value: string }>(
	`SELECT t.recording_id AS rec, l.source, l.source_track_id AS value FROM source_link l JOIN track t ON t.id = l.track_id
	WHERE l.source IN ('spotify', 'tidal', 'beatport') AND t.deleted_at IS NULL`));
const derivedLinks = (d: Desktop): Record<string, Record<string, string>> => group(d.all<{ rec: string; source: string; value: string }>(
	`SELECT t.recording_id AS rec, c.source, c.source_track_id AS value FROM claim_link c JOIN track t ON t.id = c.track_id WHERE t.deleted_at IS NULL AND c.rank = 0`));
function group(rows: Array<{ rec: string; source: string; value: string }>): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	for (const r of rows) (out[r.rec] ??= {})[r.source] = r.value;
	return out;
}
// The primary per provider (rank 0), and every id per provider in rank order.
const derivedOf = (d: Desktop, trackId: string): Record<string, string> =>
	Object.fromEntries(d.all<{ source: string; v: string }>(`SELECT source, source_track_id AS v FROM claim_link WHERE track_id = ? AND rank = 0`, trackId).map((r) => [r.source, r.v]));
const allDerivedOf = (d: Desktop, trackId: string): Record<string, string[]> => {
	const out: Record<string, string[]> = {};
	for (const r of d.all<{ source: string; v: string }>(`SELECT source, source_track_id AS v FROM claim_link WHERE track_id = ? ORDER BY source, rank`, trackId)) (out[r.source] ??= []).push(r.v);
	return out;
};
const rowOf = (d: Desktop, t: string): string => d.trackId(R(t))!;
const opsOf = async (d: Desktop, filter: (o: { entity: string; kind: string }) => boolean): Promise<unknown[]> => {
	const id = await d.deviceId();
	return rig.cloud.log.filter((o) => o.device_id === id && filter(o));
};

// Tidal's answer to the hybrid matcher's ISRC query for trk-6.
const hybridClient = (): TidalApiClient => {
	const hit: TidalTrackV2 = { id: 'td6', title: 'Title trk-6', version: null, duration: 300, isrc: 'GBAAA2600006', bpm: null, key: null, keyScale: null, explicit: false, artists: [], album: null, url: 'https://tidal.com/browse/track/td6' };
	return { getTracksByIsrc: async () => [hit], searchTracks: async () => [] } as unknown as TidalApiClient;
};

describe('provider links reach a second desktop as claim-derived links', () => {
	it('B shows A\'s ids on its own and remote rows, as display data only, and they follow A', async () => {
		const a = await mainDesktop();
		const b = await rig.desktop('b', { catalogue: ['trk-0', 'trk-1'] });
		await rig.settle();
		// A's hybrid matcher links trk-6 on Tidal after the initial push: the
		// match is stated as a claim like the imports' were.
		expect(await new TidalHybrid(a.db, {} as never).matchOne('trk-6', hybridClient())).toEqual({ tidalId: 'td6' });
		await rig.settle();

		// ── every row of B carries exactly A's ids ──────────────────────────
		expect(Object.keys(ownLinks(b))).toEqual([]);
		expect(derivedLinks(b)).toEqual(ownLinks(a));
		expect(derivedOf(b, rowOf(b, 'trk-6'))).toEqual({ spotify: 'sp6', tidal: 'td6' });
		// B's own rows took them as well as its remote rows.
		expect(rowOf(b, 'trk-0')).toBe('trk-0');
		expect(derivedOf(b, 'trk-0')).toEqual({ spotify: 'sp0', tidal: 'td0', beatport: '100' });
		expect(rowOf(b, 'trk-2')).toBe(remoteTrackId(R('trk-2')));

		// The Edit screen's read and the list's decoration.
		const links = await b.svc.getTrackSourceLinks(rowOf(b, 'trk-2'));
		expect(links).toEqual([
			{ source: 'spotify', sourceTrackId: 'sp2', url: 'https://open.spotify.com/track/sp2', derived: true },
			{ source: 'tidal', sourceTrackId: 'td2', url: 'https://tidal.com/browse/track/td2', derived: true },
		]);
		const [t0] = await b.svc.getTracks({ ids: ['trk-0'] });
		expect(t0!.sources).toEqual([]);
		expect([...t0!.claimSources!].sort()).toEqual(['beatport', 'spotify', 'tidal']);

		// Display only: remote rows stay remote, B stated nothing, and in A's
		// playlist B's rows carry no provider id to push.
		expect(b.one(`SELECT count(*) FROM track WHERE remote_only = 1`)).toBe(8);
		expect(await opsOf(b, (o) => o.entity === 'recording_claim' || o.entity === 'upstream')).toEqual([]);
		expect(b.all<{ s: string; t: string }>(`SELECT source_track_id AS s, track_id AS t FROM playlist_track WHERE playlist_id = ? ORDER BY position`, PL).map((r) => r.s === r.t)).toEqual([true, true]);
		// The bulk matchers find nothing left to crawl.
		const auth = { getTidalAccessToken: async () => { throw new Error('no Tidal call expected'); }, getTidalCountryCode: () => 'US' };
		expect(await new TidalHybrid(b.db, auth as never).setPlaylistHybrid(PL, true)).toEqual({ matched: 0, scanned: 0, enabled: true });

		// ── A changes a link and merges two tracks ─────────────────────────
		const res = await a.svc.setTrackSourceLinks('trk-3', { tidal: 'https://tidal.com/browse/track/3003' });
		expect(res.updated).toEqual(['tidal']);
		await a.svc.mergeTracks('trk-4', 'trk-5');
		await rig.settle();
		expect(derivedOf(b, rowOf(b, 'trk-3')).tidal).toBe('3003');
		// The replaced id stays listed below it: claims are append-only, and a
		// removal reaching other devices waits for a claim-remove op (v4).
		expect(allDerivedOf(b, rowOf(b, 'trk-3')).tidal).toEqual(['3003', 'td3']);
		// The loser's remote row is gone with its links; the survivor took them.
		expect(b.one(`SELECT count(*) FROM track WHERE recording_id = ?`, R('trk-5'))).toBe(0);
		expect(b.one(`SELECT count(*) FROM claim_link WHERE recording_id = ?`, R('trk-5'))).toBe(0);
		expect(derivedOf(b, rowOf(b, 'trk-4'))).toEqual({ spotify: 'sp4', beatport: '105' });

		// ── B's own Tidal import: what it ingests replaces the derived link ─
		const sync = new TidalSync(b.db, {} as never) as unknown as { upsertPlaylistMeta(pl: TidalPlaylist): string; replacePlaylistTracks(id: string, items: TidalPlaylistItem[]): number };
		const item = (id: string, title: string, isrc: string | null): TidalPlaylistItem => ({
			addedAt: '2026-08-01T10:00:00Z',
			track: { id, title, version: null, duration: 300, isrc, bpm: null, key: null, keyScale: null, explicit: false, artists: [{ id: 'ta', name: 'Artist', main: true }], album: null, url: null },
		});
		const tdPl = sync.upsertPlaylistMeta({ id: 'td-pl', name: 'Crate', description: null, numberOfItems: 2, playlistType: 'USER', accessType: 'PRIVATE', lastModifiedAt: '2026-08-01T10:00:00Z' });
		const derivedBefore = derivedLinks(b);
		sync.replacePlaylistTracks(tdPl, [item('td0', 'Title trk-0', null), item('td2', 'Title trk-2', null)]);
		// Bound to A's recordings: the own row and the remote row (now B's own).
		expect(b.one(`SELECT track_id FROM source_link WHERE source = 'tidal' AND source_track_id = 'td0'`)).toBe('trk-0');
		const r2 = remoteTrackId(R('trk-2'));
		expect(b.one(`SELECT track_id FROM source_link WHERE source = 'tidal' AND source_track_id = 'td2'`)).toBe(r2);
		expect(b.one(`SELECT remote_only FROM track WHERE id = ?`, r2)).toBe(0);
		expect(derivedOf(b, 'trk-0')).toEqual({ spotify: 'sp0', beatport: '100' });
		expect(derivedOf(b, r2)).toEqual({ spotify: 'sp2' });
		// Every other derived link is left as it was.
		const derivedAfter = derivedLinks(b);
		delete derivedBefore[R('trk-0')]!.tidal;
		delete derivedBefore[R('trk-2')]!.tidal;
		expect(derivedAfter).toEqual(derivedBefore);
		const ownTidal = await b.svc.getTrackSourceLinks('trk-0');
		expect(ownTidal.find((l) => l.source === 'tidal')).toMatchObject({ sourceTrackId: 'td0' });
		expect(ownTidal.find((l) => l.source === 'tidal')!.derived).toBeUndefined();

		// ── B deletes: an own row and a remote row in A's Spotify playlist,
		//    both knowing Spotify and Tidal ids only from the account ───────
		const r3 = rowOf(b, 'trk-3');
		expect(derivedOf(b, r3)).toEqual({ spotify: 'sp3', tidal: '3003' });
		const del = await b.svc.deleteTracks(['trk-1', r3]);
		expect(del).toMatchObject({ deletedTracks: 2, errors: [] });
		// No adapter call (afterEach), no upstream op, no claim.
		expect(b.upstream).toEqual([]);
		expect(await opsOf(b, (o) => o.entity === 'recording_claim' || o.entity === 'upstream')).toEqual([]);
		await rig.settle();
		expect(a.upstream).toEqual([]);
		// The deleted rows keep their derived links for display (deleted chip
		// in followed playlists), and stay what they were.
		expect(derivedOf(b, 'trk-1')).toEqual({ spotify: 'sp1', tidal: 'td1', beatport: '101' });
		expect(b.one(`SELECT remote_only FROM track WHERE id = ?`, r3)).toBe(1);
	});
});

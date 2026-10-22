// Who states what (role.ts), across two desktops on one account: the master
// states the sources, a secondary only what it brought itself, and the
// user's curation from anywhere. Same rig and rails as the other two-desktop
// suites: generated DBs only, no remoteWritePolicy, streaming adapters that
// record and throw, no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { emitAlbumMeta } from './album-meta.js';
import { recordingIdForTrack } from './recording-id.js';
import { canonicalSpotifyCover } from '../sync/spotify-cover.js';
import { markPreOpLog, TRACKS, TwoDesktopRig, type Desktop } from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-role-'); });
afterEach(() => {
	const upstream = rig.upstreamCalls();
	rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
const SOURCE_KINDS = new Set(['library_track.set-meta', 'library_track.set-attrs', 'album.set-meta']);
const sourceOps = async (d: Desktop) => {
	const id = await d.deviceId();
	return rig.cloud.log.filter((o) => o.device_id === id && SOURCE_KINDS.has(`${o.entity}.${o.kind}`));
};
const row = (d: Desktop, recording: string): Record<string, unknown> =>
	d.raw.prepare(`SELECT * FROM track WHERE recording_id = ? ORDER BY remote_only, created_at LIMIT 1`).get(recording) as Record<string, unknown>;

describe('a secondary states source facts only for what it brought', () => {
	it('the master\'s recordings get nothing from it, even where its own copy differs; its own track reaches the master', async () => {
		const a = await rig.desktop('a', { catalogue: TRACKS, seed: (raw) => { raw.prepare(`UPDATE track SET bpm = 124 WHERE id = 'trk-0'`).run(); } });
		await rig.settle();
		const b = await rig.desktop('b', {
			catalogue: [...TRACKS.slice(0, 4), 'b-only'],
			seed: (raw) => {
				raw.prepare(`UPDATE track SET title = 'B spelling of ' || id, bpm = 99 WHERE id IN ('trk-0', 'trk-1')`).run();
				raw.prepare(`UPDATE track SET bpm = 101, key_camelot = '5A' WHERE id = 'b-only'`).run();
			},
		});
		await rig.settle();

		const fromB = await sourceOps(b);
		expect(new Set(fromB.map((o) => o.entity_id))).toEqual(new Set([R('b-only')]));
		expect(fromB.map((o) => o.kind).sort()).toEqual(['set-attrs', 'set-meta']);
		// The master's view is the master's; B's own track shows everywhere.
		expect(row(a, R('trk-0'))['title']).toBe('Title trk-0');
		expect(row(a, R('trk-0'))['bpm']).toBe(124);
		expect([row(a, R('b-only'))['remote_only'], row(a, R('b-only'))['title'], row(a, R('b-only'))['bpm']]).toEqual([1, 'Title b-only', 101]);

		// Later edits of B's copy of a master track stay unsaid as source facts.
		b.raw.prepare(`UPDATE track SET bpm = 98, genre = 'Dub' WHERE id = 'trk-1'`).run();
		await rig.settle();
		expect((await sourceOps(b)).length).toBe(fromB.length);
	});

	it('the user\'s curation on a master track still travels from the secondary', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'] });
		const b = await rig.desktop('b', { catalogue: ['trk-0'] });
		await rig.settle();
		b.raw.prepare(`UPDATE track SET comment = 'from B', color_label = 'blue' WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect([row(a, R('trk-0'))['comment'], row(a, R('trk-0'))['color_label']]).toEqual(['from B', 'blue']);
		expect(await sourceOps(b)).toEqual([]);
	});

	it('a device promoted to master states what it had left to the old one', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0', 'trk-1'] });
		const b = await rig.desktop('b', { catalogue: ['trk-0', 'trk-1'], seed: (raw) => { raw.prepare(`UPDATE track SET title = 'B spelling of ' || id`).run(); } });
		await rig.settle();
		expect(await sourceOps(b)).toEqual([]);
		await b.svc.setMasterDevice(await b.deviceId());
		await rig.settle();
		const metas = (await sourceOps(b)).filter((o) => o.kind === 'set-meta').map((o) => o.entity_id).sort();
		expect(metas).toEqual([R('trk-0'), R('trk-1')].sort());
		// A, now a secondary, says nothing more.
		const aOps = (await sourceOps(a)).length;
		a.raw.prepare(`UPDATE track SET genre = 'House' WHERE id = 'trk-0'`).run();
		await rig.settle();
		expect((await sourceOps(a)).length).toBe(aOps);
	});
});

describe('provider album metadata comes from the master only', () => {
	it('a secondary\'s album fill states nothing; the master\'s does', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'] });
		const b = await rig.desktop('b', { catalogue: ['trk-0'] });
		await rig.settle();
		const album = { providerId: 'al9', albumType: 'album', totalTracks: 9, releaseDate: '2024', label: 'L', upc: null, coverUrl: null, artists: ['X'], various: false };
		const emitted = (d: Desktop): number => d.one(`SELECT count(*) FROM sync_outbox WHERE entity = 'album'`);
		b.raw.transaction(() => emitAlbumMeta(b.raw, 'spotify', album))();
		a.raw.transaction(() => emitAlbumMeta(a.raw, 'spotify', album))();
		expect([emitted(a), emitted(b)]).toEqual([1, 0]);
	});
});

describe('playlists', () => {
	const seedPlaylist = (id: string, description: string) => (raw: Database.Database): void => {
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name, description, cover_url, sync_status) VALUES (?, 'local', ?, ?, ?, ?, 'synced')`)
			.run(id, id, `List ${id}`, description, 'https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84aaaa');
		markPreOpLog(raw);
	};
	const attrsOps = async (d: Desktop, id: string) => {
		const dev = await d.deviceId();
		return rig.cloud.log.filter((o) => o.device_id === dev && o.entity === 'playlist' && o.entity_id === id && o.kind === 'set-attrs');
	};

	it('on the master\'s playlist a secondary states only the user\'s choices; on its own, everything', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: seedPlaylist('pl-a', 'from A') });
		await rig.settle();
		const b = await rig.desktop('b', { catalogue: ['trk-0'], seed: seedPlaylist('pl-b', 'from B') });
		await rig.settle();
		expect(b.one(`SELECT description FROM playlist WHERE id = 'pl-a'`)).toBe('from A');
		b.raw.prepare(`UPDATE playlist SET description = 'B rewrote it', hybrid_tidal = 1 WHERE id = 'pl-a'`).run();
		await rig.settle();
		expect((await attrsOps(b, 'pl-a')).map((o) => o.payload)).toEqual([{ hybrid_tidal: true }]);
		expect(a.raw.prepare(`SELECT description, hybrid_tidal FROM playlist WHERE id = 'pl-a'`).get()).toEqual({ description: 'from A', hybrid_tidal: 1 });
		// B's own playlist: its description reaches A.
		expect(a.one(`SELECT description FROM playlist WHERE id = 'pl-b'`)).toBe('from B');
	});

	it('a cover that only changed CDN host states nothing', async () => {
		const a = await rig.desktop('a', { catalogue: ['trk-0'], seed: seedPlaylist('pl-a', 'x') });
		await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		// The playlist's details went up in the founder's base, not as an op.
		const n = (await attrsOps(a, 'pl-a')).length;
		expect(n).toBe(0);
		for (const host of ['fa', 'ak', 'fa']) {
			a.raw.prepare(`UPDATE playlist SET cover_url = ? WHERE id = 'pl-a'`).run(`https://image-cdn-${host}.spotifycdn.com/image/ab67706c0000da84aaaa`);
			await rig.settle();
		}
		expect((await attrsOps(a, 'pl-a')).length).toBe(n);
		// A new image is a change.
		a.raw.prepare(`UPDATE playlist SET cover_url = 'https://image-cdn-fa.spotifycdn.com/image/ab67706c0000da84bbbb' WHERE id = 'pl-a'`).run();
		await rig.settle();
		expect((await attrsOps(a, 'pl-a')).map((o) => (o.payload as { cover_url?: string }).cover_url).at(-1)).toBe('https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84bbbb');
	});

	it('canonicalSpotifyCover spells each image one way and leaves other URLs alone', () => {
		expect(canonicalSpotifyCover('https://image-cdn-fa.spotifycdn.com/image/abc')).toBe('https://image-cdn-ak.spotifycdn.com/image/abc');
		expect(canonicalSpotifyCover('https://mosaic.scdn.co/640/abc')).toBe('https://mosaic.scdn.co/640/abc');
		expect(canonicalSpotifyCover('https://i.scdn.co/image/abc')).toBe('https://i.scdn.co/image/abc');
		expect(canonicalSpotifyCover(null)).toBeNull();
	});
});

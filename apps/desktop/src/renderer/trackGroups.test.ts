// Grouping model — group order follows the sort (first appearance), the
// missing bucket sinks, album groups play in album order, collapsed groups
// drop out of the visible track list, the index maps line up, and the row
// geometry adds the inter-group gap. Pure functions, no DOM (same
// convention as shell.test.ts).

import { describe, expect, it } from 'vitest';
import type { Track } from '@curator/shared';
import { buildDisplayList, groupIdentity, groupStats, mainArtistOf, rowHeight, TRACK_ROW_H, GROUP_HEAD_H, ALBUM_HEAD_H, GROUP_GAP_H } from './trackGroups.js';

let n = 0;
function trk(p: Partial<Track> & { artist?: string }): Track {
	n++;
	const { artist, ...rest } = p;
	return {
		id: `t${n}`,
		title: `T${n}`,
		artists: artist ? [{ name: artist }] : [],
		albumTitle: null,
		label: null,
		bpm: null,
		keyCamelot: null,
		duration: 300,
		...rest,
	} as unknown as Track;
}

describe('groupIdentity / mainArtistOf', () => {
	it('files a track under its first non-remixer, non-featured artist and keys by artist id when known', () => {
		const t = trk({ artists: [{ name: 'Juno Halde', role: 'remixer' }, { name: 'Mira Kessel' }], artistIds: ['a1', 'a2'] } as Partial<Track>);
		expect(mainArtistOf(t)).toEqual({ name: 'Mira Kessel', id: 'a2' });
		expect(groupIdentity(t, 'artist')).toMatchObject({ key: 'artist:a2', title: 'Mira Kessel', missing: false });
	});

	it('keys albums by album id, falling back to title + main artist, and buckets the missing values', () => {
		expect(groupIdentity(trk({ albumId: 'al1', albumTitle: 'X' } as Partial<Track>), 'album').key).toBe('album:al1');
		expect(groupIdentity(trk({ albumTitle: 'Night', artist: 'Mira' }), 'album').key).toBe('album:t:night|mira');
		expect(groupIdentity(trk({}), 'album')).toMatchObject({ missing: true, title: 'No album' });
		expect(groupIdentity(trk({ label: '  ' }), 'label')).toMatchObject({ missing: true, title: 'No label' });
	});
});

describe('buildDisplayList', () => {
	it('passes through ungrouped lists with identity index maps', () => {
		const ts = [trk({}), trk({})];
		const d = buildDisplayList(ts, 'none');
		expect(d.visibleTracks).toBe(ts);
		expect(d.rows.map((r) => r.kind)).toEqual(['track', 'track']);
		expect(d.trackRow).toEqual([0, 1]);
	});

	it('orders groups by first sorted appearance, missing bucket last', () => {
		const a1 = trk({ label: 'Northfold' });
		const b1 = trk({});
		const c1 = trk({ label: 'Glasshouse' });
		const a2 = trk({ label: 'northfold' });
		const d = buildDisplayList([a1, b1, c1, a2], 'label');
		expect(d.groups.map((g) => g.title)).toEqual(['Northfold', 'Glasshouse', 'No label']);
		expect(d.visibleTracks).toEqual([a1, a2, c1, b1]);
		expect(d.rows.map((r) => (r.kind === 'group' ? `G:${r.group.title}` : r.track.id))).toEqual([
			'G:Northfold', a1.id, a2.id, 'G:Glasshouse', c1.id, 'G:No label', b1.id,
		]);
		expect(d.trackRow).toEqual([1, 2, 4, 6]);
		expect(d.groupRow.get('label:glasshouse')).toBe(3);
		expect(d.groupOfTrack.get(b1.id)).toBe('label:');
		expect(d.rows[0]).toMatchObject({ kind: 'group', first: true });
		expect(d.rows[3]).toMatchObject({ kind: 'group', first: false });
	});

	it('leaves collapsed groups out of the visible tracks but keeps their headers', () => {
		const a = trk({ label: 'A' });
		const b = trk({ label: 'B' });
		const d = buildDisplayList([a, b], 'label', new Set(['label:a']));
		expect(d.visibleTracks).toEqual([b]);
		expect(d.rows.map((r) => r.kind)).toEqual(['group', 'group', 'track']);
		expect(d.rows[0]).toMatchObject({ collapsed: true });
		expect(d.trackRow).toEqual([2]);
		expect(d.groupOfTrack.get(a.id)).toBe('label:a');
	});

	it('plays album groups in disc / track order, unnumbered members after', () => {
		const x = trk({ albumId: 'al', trackNumber: 3, discNumber: 1 } as Partial<Track>);
		const y = trk({ albumId: 'al' } as Partial<Track>);
		const z = trk({ albumId: 'al', trackNumber: 1, discNumber: 2 } as Partial<Track>);
		const w = trk({ albumId: 'al', trackNumber: 1, discNumber: 1 } as Partial<Track>);
		const d = buildDisplayList([x, y, z, w], 'album');
		expect(d.visibleTracks).toEqual([w, x, z, y]);
	});
});

describe('groupStats', () => {
	it('sums time, spans BPM, keeps 3 keys and counts releases', () => {
		const s = groupStats([
			trk({ bpm: 121.6, keyCamelot: '8A', duration: 400, albumId: 'r1', label: 'N' } as Partial<Track>),
			trk({ bpm: 119.2, keyCamelot: '9A', duration: 200, albumId: 'r1', label: 'N' } as Partial<Track>),
			trk({ bpm: 124, keyCamelot: '8A', duration: 100, albumTitle: 'Other', label: 'G' } as Partial<Track>),
			trk({ keyCamelot: '10A', label: 'G' } as Partial<Track>),
			trk({ keyCamelot: '11B', label: 'G' } as Partial<Track>),
		]);
		expect(s).toMatchObject({ count: 5, durationSec: 1300, bpmLo: 119, bpmHi: 124, keys: ['8A', '9A', '10A'], releaseCount: 2, labels: ['G', 'N'] });
	});
});

describe('rowHeight', () => {
	it('maps track rows by line mode and adds the gap above every group after the first', () => {
		const d = buildDisplayList([trk({ label: 'A' }), trk({ label: 'B' })], 'label');
		expect(rowHeight(d.rows[0]!, 2)).toBe(GROUP_HEAD_H);
		expect(rowHeight(d.rows[1]!, 2)).toBe(TRACK_ROW_H[2]);
		expect(rowHeight(d.rows[2]!, 1)).toBe(GROUP_HEAD_H + GROUP_GAP_H);
		expect(rowHeight(d.rows[3]!, 1)).toBe(TRACK_ROW_H[1]);
		const al = buildDisplayList([trk({ albumId: 'x' } as Partial<Track>)], 'album');
		expect(rowHeight(al.rows[0]!, 2)).toBe(ALBUM_HEAD_H);
	});
});

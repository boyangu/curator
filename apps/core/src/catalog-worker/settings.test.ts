// The user's tracking choices: everything on until said otherwise, a patch
// per tracker, null forgets.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { checkedTrackers, readCadence, readReadSources, writeReadCadence, writeReadSources } from './settings.js';

function db(): Database.Database {
	const raw = new Database(':memory:');
	raw.exec(`CREATE TABLE app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
	return raw;
}

describe('catalog read sources', () => {
	it('defaults to every source on, per kind, cloud-only ones marked', () => {
		const raw = db();
		const rs = readReadSources(raw);
		expect(rs.map((r) => r.kind)).toEqual(['artist', 'label', 'playlist', 'genre']);
		expect(rs.find((r) => r.kind === 'label')!.sources).toEqual(
			expect.arrayContaining([
				{ provider: 'beatport', checked: true, cloudOnly: false },
				{ provider: 'soundcloud', checked: true, cloudOnly: true },
			]),
		);
		expect(checkedTrackers(raw)).toContain('artist/spotify');
		expect(checkedTrackers(raw)).toContain('label/youtube');
	});

	it('applies a patch over what is stored, ignores unknown keys, and null forgets', () => {
		const raw = db();
		writeReadSources(raw, { 'label/beatport': false, 'artist/deezer': false, 'label/nope': false } as never);
		expect(checkedTrackers(raw)).not.toContain('label/beatport');
		expect(checkedTrackers(raw)).not.toContain('artist/deezer');
		expect(checkedTrackers(raw)).toContain('artist/spotify');
		// A later patch leaves the earlier choice alone.
		writeReadSources(raw, { 'artist/deezer': true });
		expect(checkedTrackers(raw)).toContain('artist/deezer');
		expect(checkedTrackers(raw)).not.toContain('label/beatport');
		expect(readReadSources(raw).find((r) => r.kind === 'label')!.sources.find((s) => s.provider === 'beatport')!.checked).toBe(false);
		writeReadSources(raw, null);
		expect(checkedTrackers(raw)).toContain('label/beatport');
	});

	it('reads every kind weekly until said otherwise, one kind at a time', () => {
		const raw = db();
		expect(readCadence(raw)).toEqual({ artist: 'weekly', label: 'weekly', playlist: 'weekly', genre: 'weekly' });
		const rs = writeReadCadence(raw, 'playlist', 'daily');
		expect(rs.map((r) => [r.kind, r.cadence])).toEqual([['artist', 'weekly'], ['label', 'weekly'], ['playlist', 'daily'], ['genre', 'weekly']]);
		writeReadCadence(raw, 'artist', 'source');
		expect(readCadence(raw)).toEqual({ artist: 'source', label: 'weekly', playlist: 'daily', genre: 'weekly' });
		// An unknown value or kind changes nothing, and forgetting the sources leaves the cadence.
		writeReadCadence(raw, 'artist', 'hourly' as never);
		writeReadCadence(raw, 'album' as never, 'daily');
		writeReadSources(raw, null);
		expect(readCadence(raw)).toEqual({ artist: 'source', label: 'weekly', playlist: 'daily', genre: 'weekly' });
	});
});

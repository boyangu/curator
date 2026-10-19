// One-off repair for the 2026-10-12 streaming-dedup mis-bind: the Fink version
// of Jan Blomqvist "More" (Spotify 06kVL2y6…, ISRC NLF712605939, 557s) was
// bound onto the curated "More - Klangkarussell Extended Remix" row (555s) by
// findExistingByContent's substring-title match. Its Spotify + Beatport links
// and the $to-download membership landed there, LibrarySink overwrote the
// Klangkarussell genre/release date, and a later Edit stored Fink metadata as
// overrides on top. Root cause fixed in apps/core/src/sync/match-existing.ts.
//
// This splits the Fink version onto its own canonical row (links + playlist
// row RE-POINTED, never deleted — nothing reads as a removal, nothing pushes
// upstream) and restores the Klangkarussell row to its pre-incident values
// (from curator.db.pre-undelete-3tracks-2026-10-05T10-41.bak).
//
// Dry-run by default. --apply requires Curator to be closed and writes a
// VACUUM INTO backup next to the DB first.
//
//   npx tsx scripts/repair-more-fink-2026-10-13.ts [--db <path>] [--apply]

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { asciify } from '@curator/shared';
import { track, type TrackArtist } from '@curator/shared/schema';
import { createDb } from '../src/db/client.js';
import { normalizeIncomingArtists, syncTrackArtists, syncTrackArtistsById } from '../src/library/artists.js';

const KLANG_ID = '1a96f429-656b-4564-a8d1-a0bab4a9e2de';
const SPOTIFY_LINK_ID = '9dcf710c-a7b9-45c5-a0c9-0240ed3398ca'; // spotify 06kVL2y6KhhGf7F2LG77GI
const BEATPORT_LINK_ID = 'b458a524-381a-4fab-97a8-23c5fea4ab08'; // beatport 30682390 (Original Mix)
const SPOTIFY_TRACK_ID = '06kVL2y6KhhGf7F2LG77GI';
const TO_DOWNLOAD_PLAYLIST_ID = 'de9d4fd4-dea1-4890-a849-0c1e584d7179';
const FINK_ISRC = 'NLF712605939';
const FLINK_ARTIST_ID = '08a55db6-1145-4fb3-9e88-77245b534300'; // minted by the mistaken Edit
const PROMOTED_AT = 1791805485443; // the Discover promote that mis-bound it

// Klangkarussell row as of the 2026-10-05 backup.
const KLANG_RESTORE = {
	genre: 'Melodic House & Techno',
	releaseDate: '2026-08-14T00:00:00',
	addedAt: 1786899600000,
	stateChangedAt: 1786939108545,
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbArgIdx = args.indexOf('--db');
const dbPath = dbArgIdx >= 0 ? args[dbArgIdx + 1]! : join(process.env.APPDATA ?? '', 'Curator', 'curator.db');

const { db, sqlite } = createDb(dbPath);
const raw = sqlite;

function show(label: string, id: string): void {
	const t = raw.prepare(`SELECT id, title, artists, album_title, genre, release_date, isrc, duration, bpm, key_camelot, state, added_at, state_changed_at, overrides, artists_ascii, artist_sort FROM track WHERE id = ?`).get(id);
	const links = raw.prepare(`SELECT id, source, source_track_id FROM source_link WHERE track_id = ? ORDER BY source`).all(id);
	const pls = raw.prepare(`SELECT p.name, pt.source_track_id FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id WHERE pt.track_id = ?`).all(id);
	const arts = raw.prepare(`SELECT a.name, ta.role, ta.position FROM track_artist ta JOIN artist a ON a.id = ta.artist_id WHERE ta.track_id = ? ORDER BY ta.position`).all(id);
	console.log(`\n── ${label} (${id})`);
	console.log(t);
	console.log('links:', links);
	console.log('playlists:', pls);
	console.log('track_artist:', arts);
}

// Preconditions — abort rather than half-repair a DB that's moved on.
const linkOwner = (linkId: string) => (raw.prepare(`SELECT track_id FROM source_link WHERE id = ?`).get(linkId) as { track_id: string } | undefined)?.track_id;
const problems: string[] = [];
if (linkOwner(SPOTIFY_LINK_ID) !== KLANG_ID) problems.push(`spotify link ${SPOTIFY_LINK_ID} is not on the Klangkarussell row`);
if (linkOwner(BEATPORT_LINK_ID) !== KLANG_ID) problems.push(`beatport link ${BEATPORT_LINK_ID} is not on the Klangkarussell row`);
const isrcHolder = raw.prepare(`SELECT id FROM track WHERE isrc = ? AND deleted_at IS NULL`).get(FINK_ISRC);
if (isrcHolder) problems.push(`a live track already carries ISRC ${FINK_ISRC}: ${JSON.stringify(isrcHolder)}`);
const spotifyLink = raw.prepare(`SELECT payload FROM source_link WHERE id = ?`).get(SPOTIFY_LINK_ID) as { payload: string } | undefined;
if (problems.length) {
	console.error('Preconditions failed — nothing written:\n  ' + problems.join('\n  '));
	process.exit(1);
}

const sp = JSON.parse(spotifyLink!.payload) as {
	name: string;
	explicit: boolean;
	duration_ms: number;
	artists: { name: string }[];
	album: { name: string; release_date: string; images: { url: string }[] };
};

console.log(apply ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ===');
console.log('DB:', dbPath);
show('BEFORE Klangkarussell', KLANG_ID);

if (!apply) {
	raw.close();
	process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
const backup = `${dbPath}.pre-fink-split-${stamp}.bak`;
if (existsSync(backup)) {
	console.error(`Backup ${backup} already exists — refusing to overwrite it.`);
	process.exit(1);
}
raw.prepare(`VACUUM INTO ?`).run(backup);
console.log('\nbackup written:', backup);

const finkId = randomUUID();
raw.transaction(() => {
	// Same shape SpotifySync.upsertTrack mints, plus the DJ fields the feed's
	// Beatport match (30682390: Electronica / Disconnected / 124 / Fm) carried.
	const artists: TrackArtist[] = normalizeIncomingArtists(db, sp.artists.map((a) => ({ name: a.name })), { title: sp.name, split: false });
	const promoted = new Date(PROMOTED_AT);
	db.insert(track)
		.values(
			asciify({
				id: finkId,
				isrc: FINK_ISRC,
				mbid: null,
				title: sp.name,
				artists,
				albumTitle: sp.album.name,
				releaseDate: sp.album.release_date,
				coverUrl: sp.album.images[0]?.url ?? null,
				duration: Math.round(sp.duration_ms / 1000),
				bpm: 124,
				keyCamelot: '4A',
				genre: 'Electronica',
				label: 'Disconnected',
				copyright: null,
				explicit: sp.explicit,
				state: 'backlog' as const,
				stateChangedAt: promoted,
				addedAt: promoted,
				createdAt: promoted,
				updatedAt: new Date(),
			}),
		)
		.run();
	syncTrackArtists(db, [{ id: finkId, artists, overrides: null }]);

	raw.prepare(`UPDATE source_link SET track_id = ? WHERE id IN (?, ?)`).run(finkId, SPOTIFY_LINK_ID, BEATPORT_LINK_ID);
	const moved = raw
		.prepare(`UPDATE playlist_track SET track_id = ? WHERE playlist_id = ? AND track_id = ? AND source_track_id = ?`)
		.run(finkId, TO_DOWNLOAD_PLAYLIST_ID, KLANG_ID, SPOTIFY_TRACK_ID);
	if (moved.changes !== 1) throw new Error(`expected 1 $to-download row to move, got ${moved.changes}`);

	// Restore the Klangkarussell row: drop the mistaken Edit and the fields the
	// Fink Beatport match overwrote. Re-asciify from the BASE values — the
	// shadow columns currently mirror the overrides.
	const base = raw.prepare(`SELECT title, artists, album_title, label FROM track WHERE id = ?`).get(KLANG_ID) as {
		title: string; artists: string; album_title: string | null; label: string | null;
	};
	db.update(track)
		.set(
			asciify({
				overrides: null,
				title: base.title,
				artists: JSON.parse(base.artists) as TrackArtist[],
				albumTitle: base.album_title,
				label: base.label,
				genre: KLANG_RESTORE.genre,
				releaseDate: KLANG_RESTORE.releaseDate,
				addedAt: new Date(KLANG_RESTORE.addedAt),
				stateChangedAt: new Date(KLANG_RESTORE.stateChangedAt),
				updatedAt: new Date(),
			}),
		)
		.where(eq(track.id, KLANG_ID))
		.run();
	syncTrackArtistsById(db, [KLANG_ID]);

	// "flink" existed only because of that Edit — drop it once nothing points at it.
	const refs = raw
		.prepare(`SELECT (SELECT COUNT(*) FROM track_artist WHERE artist_id = ?) + (SELECT COUNT(*) FROM artist_link WHERE artist_id = ?) + (SELECT COUNT(*) FROM artist WHERE merged_into = ?) AS n`)
		.get(FLINK_ARTIST_ID, FLINK_ARTIST_ID, FLINK_ARTIST_ID) as { n: number };
	if (refs.n === 0) raw.prepare(`DELETE FROM artist WHERE id = ?`).run(FLINK_ARTIST_ID);
	else console.log(`kept artist "flink" — still referenced ${refs.n}×`);
})();

show('AFTER Klangkarussell', KLANG_ID);
show('AFTER Fink (new)', finkId);
raw.close();

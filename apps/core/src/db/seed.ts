// Seed: ~30 mock tracks + playlists matching the Library.html design data.
// Phase-0 stand-in until real Spotify/Tidal sync lands.

import { createDb } from './client.js';
import { migrate } from './migrate.js';
import { randomUUID } from 'node:crypto';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { replaceRows } from '../library/playlist-order.js';
const nanoid = (): string => randomUUID();
import {
	track,
	playlist,
	playlistTrack,
	sourceLink,
	type NewTrack,
	type NewPlaylist,
} from '@curator/shared/schema';
import { asciify, searchFold, splitArtistCredit } from '@curator/shared';
import { syncTrackArtists } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import { log } from '../log.js';

const slog = log.for('seed');

const DB_PATH = process.env.CURATOR_DB_URL ?? './curator.db';

// (title, artist, album, label, genre, bpm, key, dur, ago, state, isrc?)
type Row = [string, string, string, string, string, number, string, number, number, string, string?];

const TRACKS: Row[] = [
	['Tessellate',                    'Sansibar, Kasper Marott',   'Tessellate EP',            'Hot Creations',       'Melodic House',  124, '8A',  258, 2,  'progress'],
	['Aleph (Solomun Edit)',          'Massano',                   'The Feeling',              'Diynamic',            'Melodic Techno', 122, '9A',  402, 4,  'progress'],
	['Submerged',                     'Anyma, Chris Avantgarde',   'Genesys II',               'Afterlife',           'Melodic Techno', 124, '10A', 351, 7,  'progress'],
	['Veridis Quo (Tale Of Us Remix)','Argy, Goom Gum',            'Pyramid Of Mirrors',       'A Tribe Called Kotori','Melodic Techno',126, '8B',  432, 7,  'progress'],
	['Closer To The Sun',             'Adam Port, Stryv',          'Monaberry Vol. 1',         'Keinemusik',          'Afro House',     122, '11A', 368, 14, 'progress'],
	['Nothing Else',                  'Cassian',                   'Nothing Else EP',          'Anjunadeep',          'Melodic House',  120, '5A',  393, 3,  'backlog'],
	['Strobe (Mix Cut)',              'Deadmau5',                  'For Lack Of A Better Name','mau5trap',            'Progressive',    128, '4B',  348, 1,  'backlog'],
	['Opium',                         'Mind Against, Adriatique',  'Siamese 12',               'Siamese',             'Melodic Techno', 124, '10B', 444, 5,  'progress'],
	['Solar Plexus',                  'Trikk',                     'Solar Plexus',             'Innervisions',        'Deep House',     121, '9B',  415, 6,  'backlog'],
	['Murano',                        'Âme',                       'Murano EP',                'Innervisions',        'Melodic House',  122, '6A',  482, 7,  'progress'],
	['Body Funk',                     'Purple Disco Machine',      'Body Funk',                'Defected',            'Disco House',    122, '3B',  314, 14, 'purchased'],
	['Vermilion (Massano Remix)',     'ARTBAT, Sailor & I',        'Vermilion',                'UPPERGROUND',         'Melodic Techno', 125, '11B', 421, 9,  'progress'],
	['Disconnect',                    'Yotto',                     'Erased Dreams',            'Anjunadeep',          'Progressive',    122, '7A',  408, 21, 'purchased'],
	['Polynia',                       'Cassian, RÜFÜS DU SOL',     'Polynia',                  'Rose Avenue',         'Melodic House',  120, '8A',  372, 4,  'progress'],
	['Vapor Trails',                  'Mathame',                   'Skygazing',                'Afterlife',           'Melodic Techno', 124, '10A', 428, 14, 'purchased'],
	['Free To Love',                  '&ME, Rampa, Adam Port',     '&ME, Rampa, Adam Port',    'Keinemusik',          'Afro House',     121, '9B',  382, 2,  'progress'],
	['Tycho’s Wake',             'Mind Against',              'Vaudeville',               'Life and Death',      'Melodic Techno', 123, '11A', 453, 8,  'backlog'],
	['Eternal Sunshine',              'Lunar Plane',               'Eternal Sunshine',         'Crosstown Rebels',    'Deep House',     120, '6A',  408, 7,  'progress'],
	['Wake Up',                       'Stimming',                  'Wake Up EP',               'Diynamic',            'Melodic House',  118, '5A',  435, 11, 'backlog'],
	['Gemini (Magdalena Remix)',      'Konstantin Sibold',         'Gemini',                   'Diynamic',            'Melodic Techno', 124, '8B',  481, 7,  'progress'],
	['Voyager',                       'Daft Punk',                 'Discovery',                'Virgin',              'French House',   118, '3B',  282, 9999, 'purchased'],
	['Phantom Vibration',             'DJ Tennis, Carlita',        'Phantom Vibration',        'Life and Death',      'Melodic House',  122, '10B', 408, 5,  'progress'],
	['Atlas',                         'Fred again..',              'Actual Life 3',            'Atlantic',            'UK Garage',      130, '2B',  258, 1,  'progress'],
	['Marea (We’ve Lost Dancing)','Fred again..',             'Actual Life',              'Atlantic',            'House',          126, '8A',  318, 14, 'purchased'],
	['Spell On You',                  'Black Coffee',              'Subconsciously',           'Gallo',               'Afro House',     120, '11B', 402, 21, 'purchased'],
	['Going Bad',                     'Sebastian Mullaert',        'Natthall',                 'Kontra-Musik',        'Melodic House',  118, '7A',  511, 12, 'backlog'],
	['Open Hearts',                   'Boris Brejcha',             'Mvtations',                'FCKNG SERIOUS',       'High-Tech Minimal', 122, '4A', 487, 19, 'unsorted'],
	['Salt',                          'Tale Of Us',                'Endless',                  'Afterlife',           'Melodic Techno', 122, '6B',  411, 25, 'unsorted'],
	['Mirror',                        'Mathame, Maverick Sabre',   'Mirror',                   'Sony',                'Melodic Techno', 124, '10A', 392, 30, 'unsorted'],
	['Drum Drama',                    'CamelPhat, Eli & Fur',      'Drum Drama',               'When Stars Align',    'Melodic House',  124, '8A',  362, 3,  'progress'],
];

// (source, sourceId-suffix, name, mark, hideIfTidal?)
type PlaylistRow = ['spotify' | 'tidal', string, string, string];
const PLAYLISTS: PlaylistRow[] = [
	['spotify', 'promo-weekly',      'Promo · Weekly',              'P'],
	['spotify', 'ra-picks',          'Resident Advisor — Picks',    'P'],
	['tidal',   'tidal-rising',      'Tidal Rising · Electronic',   'P'],
	['spotify', 'mixmag',            'Mixmag Fresh',                'P'],
	['tidal',   'djpool',            'DJ Pool · Promo',             'P'],
	['spotify', 'afterlife-015',     'Afterlife — Voyage 015',      'P'],
	['spotify', 'keinemusik',        'Keinemusik / Radio',          'P'],
	['tidal',   'anjuna-500',        'Anjunadeep Edition 500',      'P'],
	['spotify', 'sets-berlin',       'Sets — Berlin Spring ’26', 'P'],
	['spotify', 'sets-tulum',        'Sets — Tulum Closing',        'P'],
	['tidal',   'hires-picks',       'Master Hi-Res Picks',         'P'],
	['spotify', 'discovery-weekly',  'Discovery Weekly',            'D'],
	['spotify', 'liked',             'Liked Songs',                 '♡'],
	['tidal',   'my-mix-techno',     'My Mix · Melodic Techno',     'M'],
	['tidal',   'daily-discovery',   'Daily Discovery · 02',        'D'],
	['spotify', 'crate-alist',       'Crate — A-list 2026',         'P'],
	['spotify', 'crate-sunday',      'Crate — Sunday Brunch',       'P'],
	['tidal',   'for-you',           'For You',                     '★'],
];

// Idempotent seed. Pass `force: true` to wipe existing rows (used by the CLI
// `pnpm db:seed`). The Electron main process calls seedIfEmpty() instead.
export async function seed(dbPath: string = DB_PATH, opts: { force?: boolean } = {}): Promise<{ tracks: number; playlists: number }> {
	migrate(dbPath);
	const { db, sqlite } = createDb(dbPath);

	if (opts.force) {
		sqlite.exec(`DELETE FROM playlist_track; DELETE FROM source_link; DELETE FROM track; DELETE FROM playlist;`);
	}

	const now = new Date();
	const trackIds: string[] = [];

	for (const row of TRACKS) {
		const [title, artistsStr, album, label, genre, bpm, key, dur, daysAgo, state, isrc] = row;
		const id = nanoid();
		trackIds.push(id);
		const artists = splitArtistCredit(artistsStr);
		const created = new Date(now.getTime() - daysAgo * 86400_000);

		const newTrack: NewTrack = {
			id,
			recordingId: recordingIdForTrack(id),
			isrc: isrc ?? null,
			mbid: null,
			title,
			artists,
			albumTitle: album,
			releaseDate: null,
			duration: dur,
			bpm,
			keyCamelot: key,
			genre,
			label,
			copyright: null,
			explicit: false,
			state: state as NewTrack['state'],
			stateChangedAt: created,
			createdAt: created,
			updatedAt: created,
		};
		db.insert(track).values(asciify(newTrack)).run();
		syncTrackArtists(db, [{ id, artists, overrides: null }]);
		syncTrackAlbumsById(db, [id]);

		// fake a Spotify source link so the cross-source dedup path has something to chew on later
		db.insert(sourceLink).values({
			id: nanoid(),
			trackId: id,
			source: 'spotify',
			sourceTrackId: `seed_sp_${id}`,
			url: null,
			isrcLocal: isrc ?? null,
			titleLocal: title,
			artistsLocal: artists,
			albumLocal: album,
			durationLocal: dur,
			bpmLocal: null,
			keyLocal: null,
			payload: null,
			fetchedAt: created,
		}).run();
	}

	const playlistIds: { id: string; mark: string; source: 'spotify' | 'tidal' }[] = [];
	for (const [source, sourceIdSuffix, name, mark] of PLAYLISTS) {
		const id = nanoid();
		playlistIds.push({ id, mark, source });
		const newPlaylist: NewPlaylist = {
			id,
			source,
			sourceId: sourceIdSuffix,
			url: null,
			name,
			nameAscii: searchFold(name),
			description: null,
			ownerName: null,
			ownerId: null,
			coverUrl: null,
			trackCount: null,
			followers: null,
			isCollaborative: false,
			isPublic: true,
			lastSyncedAt: now,
			syncStatus: 'synced',
			syncError: null,
			syncCursor: null,
			mark,
			isFavorite: false,
			isHidden: false,
			createdAt: now,
			updatedAt: now,
		};
		db.insert(playlist).values(newPlaylist).run();
	}

	// attach the first 10 tracks to the first playlist so the sidebar selection has substance
	const firstPlaylist = playlistIds[0]!;
	const members = replaceRows(trackIds.slice(0, 10).map((trackId, i) => ({
		playlistId: firstPlaylist.id,
		trackId,
		addedAt: now,
		addedBy: null,
		sourceTrackId: `seed_${i}`,
	})));
	if (members.length) db.insert(playlistTrack).values(members).run();

	// updated track counts on each playlist (fake equal distribution)
	for (const p of playlistIds) {
		sqlite.prepare('UPDATE playlist SET track_count = ? WHERE id = ?').run(
			Math.floor(Math.random() * 200) + 10,
			p.id
		);
	}

	sqlite.close();
	slog.info('seeded', { tracks: TRACKS.length, playlists: PLAYLISTS.length, dbPath });
	return { tracks: TRACKS.length, playlists: PLAYLISTS.length };
}

// Auto-seed for the Electron startup path: only seeds when the DB is empty.
// Avoids the dual-ABI hassle of running tsx separately for the seed.
export async function seedIfEmpty(dbPath: string): Promise<void> {
	migrate(dbPath);
	const { sqlite } = createDb(dbPath);
	const row = sqlite.prepare('SELECT COUNT(*) as n FROM track').get() as { n: number };
	sqlite.close();
	if (row.n > 0) return;
	await seed(dbPath);
}

import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) seed(DB_PATH, { force: true }).catch((e) => { slog.error('seed failed', e); process.exit(1); });

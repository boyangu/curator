// The catalogue worker: its own Fly process (fly.toml [processes] worker), so
// crawling never shares a machine's event loop or memory with requests, and a
// restart of the API never interrupts a pass. It serves no HTTP.
//
// Every minute: the tracking pass (catalog/trackers/sweep.ts), then the
// identity planner (catalog/planner.ts). Both lease their work in Postgres
// and reserve provider calls there, so a second worker machine is safe (it
// splits the due work) though not needed.
//
// Providers are switched on by their configuration alone:
//   CURATOR_SPOTIFY_APP_CLIENT_ID + CURATOR_SPOTIFY_APP_CLIENT_SECRET
//     Spotify, app credentials (artist tracker + identity finder);
//   CURATOR_FEED_DEEZER=1
//     Deezer, key-less (artist + label trackers, identity finder);
//   CURATOR_FEED_BEATPORT=1
//     Beatport's pages, key-less (label + genre trackers; beatport-pages.ts
//     on the terms and the Cloudflare risk);
//   CURATOR_FEED_BANDCAMP=1
//     Bandcamp's app JSON, key-less (label tracker: discography + roster);
//   CURATOR_YOUTUBE_API_KEY
//     YouTube Data API (label channel uploads);
//   CURATOR_SOUNDCLOUD_CLIENT_ID + CURATOR_SOUNDCLOUD_CLIENT_SECRET
//     SoundCloud's official API (label profile uploads).
// The label profiler (MusicBrainz, Discogs: key-less) always runs.
//   CURATOR_SPOTIFY_CLIENT_ID + CURATOR_TOKEN_KEY (the API's gateway secrets)
//     Spotify playlists, read with a watcher's own Spotify login.
// A tracker row whose provider has no adapter here is skipped, not failed.

import { hostname } from 'node:os';
import { DeezerFinder, runPlanner, runRecordingResolver, SpotifyFinder, type IdentityFinder } from '../catalog/planner.js';
import { runLabelProfiler } from '../catalog/profile/label-profiler.js';
import { BandcampTracker } from '../catalog/trackers/bandcamp.js';
import { BeatportTracker } from '../catalog/trackers/beatport.js';
import { DeezerTracker } from '../catalog/trackers/deezer.js';
import { SoundCloudTracker } from '../catalog/trackers/soundcloud.js';
import { YouTubeTracker } from '../catalog/trackers/youtube.js';
import { soundcloudCredentials, tidalCredentials } from '../config.js';
import { runInboxDetectors } from '../catalog/inbox-detectors.js';
import { runLabelDedupe } from '../catalog/label-related.js';
import { runReleaseFiller } from '../catalog/release-fill.js';
import { runStoreLinker } from '../catalog/store-links.js';
import { AppleLookup } from '../catalog/trackers/apple.js';
import { TidalApp } from '../catalog/trackers/tidal-app.js';
import { SpotifyAppTracker } from '../catalog/trackers/spotify-app.js';
import { runCataloguePlaylists } from '../catalog/profile/catalogue-playlists.js';
import { runBackfill } from '../catalog/trackers/backfill.js';
import { runTrackers } from '../catalog/trackers/sweep.js';
import type { TrackerAdapter } from '../catalog/trackers/types.js';
import { ConfigError, flagOf, loadSpotify } from '../config.js';
import { SpotifyUserPlaylistTracker } from '../catalog/trackers/spotify-user-playlist.js';
import { TokenCrypto } from '../spotify/crypto.js';
import { SPOTIFY_TIMEOUT_MS } from '../spotify/gateway.js';
import { assertConnectionString, createPostgresDb } from '../db/db.js';
import { migrationGate } from '../db/migration-gate.js';
import { createLogger } from '../log.js';

const PASS_EVERY_MS = 60_000;

const log = createLogger();

function env(name: string): string | null {
	return process.env[name]?.trim() || null;
}

const databaseUrl = env('DATABASE_URL');
if (!databaseUrl) throw new ConfigError('DATABASE_URL is not set');
assertConnectionString(databaseUrl);

const adapters: TrackerAdapter[] = [];
const finders: IdentityFinder[] = [];
const spotifyId = env('CURATOR_SPOTIFY_APP_CLIENT_ID');
const spotifySecret = env('CURATOR_SPOTIFY_APP_CLIENT_SECRET');
if ((spotifyId === null) !== (spotifySecret === null)) throw new ConfigError('set both CURATOR_SPOTIFY_APP_CLIENT_ID and CURATOR_SPOTIFY_APP_CLIENT_SECRET, or neither');
let spotify: SpotifyAppTracker | null = null;
if (spotifyId && spotifySecret) {
	spotify = new SpotifyAppTracker({ clientId: spotifyId, clientSecret: spotifySecret });
	adapters.push(spotify);
	finders.push(new SpotifyFinder(spotify));
}
if (flagOf(process.env, 'CURATOR_FEED_DEEZER')) {
	adapters.push(new DeezerTracker());
	finders.push(new DeezerFinder());
}
const beatport = flagOf(process.env, 'CURATOR_FEED_BEATPORT');
if (beatport) adapters.push(new BeatportTracker());
const bandcamp = flagOf(process.env, 'CURATOR_FEED_BANDCAMP');
if (bandcamp) adapters.push(new BandcampTracker());
const youtubeKey = env('CURATOR_YOUTUBE_API_KEY');
if (youtubeKey) adapters.push(new YouTubeTracker(youtubeKey));
const sc = soundcloudCredentials(process.env);
if (sc) adapters.push(new SoundCloudTracker(sc));
// The stores a release is linked to by identifier (catalog/store-links.ts).
const tidalCreds = tidalCredentials(process.env);
const stores = { spotify, tidal: tidalCreds ? new TidalApp(tidalCreds) : null, apple: flagOf(process.env, 'CURATOR_FEED_APPLE') ? new AppleLookup() : null };
// A library's releases read in full from their stores (release-fill.ts).
const fillFetchers = {
	...stores,
	deezer: (adapters.find((a) => a instanceof DeezerTracker) as DeezerTracker | undefined) ?? null,
	beatport: (adapters.find((a) => a instanceof BeatportTracker) as BeatportTracker | undefined) ?? null,
	bandcamp: (adapters.find((a) => a instanceof BandcampTracker) as BandcampTracker | undefined) ?? null,
};

// Two connections are plenty: one pass at a time, a few statements each.
const db = createPostgresDb(databaseUrl, { max: 2 });
const gateway = loadSpotify(process.env).spotify;
if (gateway) {
	adapters.push(
		new SpotifyUserPlaylistTracker({
			db,
			log,
			gateway: { clientId: gateway.clientId, crypto: new TokenCrypto(gateway.keys), fetch: (url, init) => fetch(url, init), timeoutMs: SPOTIFY_TIMEOUT_MS },
		}),
	);
}
if (!(await migrationGate(db, log).catch(() => false))) {
	await db.close().catch(() => {});
	process.exit(1);
}
log.info('catalog_worker', { trackers: adapters.map((a) => a.provider), finders: finders.map((f) => f.provider) });

const holder = `${hostname()}:${process.pid}`;
let running = false;
let stopping = false;

async function pass(): Promise<void> {
	if (running || stopping) return;
	running = true;
	try {
		await runTrackers({ db, log, adapters, holder }).catch((e: unknown) => log.error('tracker_pass_failed', { error: e }));
		await runPlanner({ db, log, finders }).catch((e: unknown) => log.error('identity_pass_failed', { error: e }));
		if (spotify) await runRecordingResolver({ db, log, spotify }).catch((e: unknown) => log.error('recording_resolve_failed', { error: e }));
		await runStoreLinker({ db, log, readers: stores }).catch((e: unknown) => log.error('store_link_pass_failed', { error: e }));
		await runReleaseFiller({ db, log, fetchers: fillFetchers, holder }).catch((e: unknown) => log.error('release_fill_pass_failed', { error: e }));
		await runLabelProfiler({ db, log, spotify, providers: { beatport, bandcamp } }).catch((e: unknown) => log.error('label_profile_pass_failed', { error: e }));
		await runBackfill({ db, log, adapters, holder }).catch((e: unknown) => log.error('catalog_backfill_failed', { error: e }));
		await runCataloguePlaylists({ db, log, spotify, holder }).catch((e: unknown) => log.error('catalogue_playlists_pass_failed', { error: e }));
		await runLabelDedupe({ db, log }).catch((e: unknown) => log.error('label_dedupe_pass_failed', { error: e }));
		await runInboxDetectors({ db, log }).catch((e: unknown) => log.error('inbox_detectors_failed', { error: e }));
	} finally {
		running = false;
	}
}

const timer = setInterval(() => void pass(), PASS_EVERY_MS);
void pass();

function shutdown(signal: string): void {
	log.info('shutdown', { signal });
	stopping = true;
	clearInterval(timer);
	// A pass in flight finishes its current statement; its leases lapse on
	// their own if it does not get further.
	const wait = setInterval(() => {
		if (running) return;
		clearInterval(wait);
		void db.close().finally(() => process.exit(0));
	}, 200);
	setTimeout(() => process.exit(1), 12_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

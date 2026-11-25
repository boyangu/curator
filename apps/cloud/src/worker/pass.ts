// The catalogue's upkeep: one pass of everything that happens outside a
// request. It runs on the operator's machine, against the cloud's database
// (cli/cloud-worker.ts) or the local catalogue's (cli/local.ts), never on the
// cloud's own machines: the sources are read by the desktops and by this, and
// the cloud only keeps what they found.
//
// Every step leases its work in Postgres and reserves its provider calls
// there, so two copies split what is due. A step that throws is logged and
// the pass goes on: one store's outage must not stop the rest.
//
// Providers are switched on by their configuration:
//   CURATOR_SPOTIFY_APP_CLIENT_SECRET (and CURATOR_SPOTIFY_APP_CLIENT_ID, else
//     CURATOR_SPOTIFY_CLIENT_ID: Spotify allows one app per developer)
//     Spotify, app credentials (artist tracker, identity finder, fills);
//   Deezer, key-less, always (artist + label trackers, identity finder);
//   Beatport's pages, Bandcamp's app JSON, Apple's lookup and Spotify's public
//     artist pages, key-less, unless CURATOR_FEED_BEATPORT / _BANDCAMP /
//     _APPLE / _SPOTIFY_PAGES is 0 (beatport-pages.ts and spotify-page.ts on
//     the terms);
//   CURATOR_YOUTUBE_API_KEY, CURATOR_SOUNDCLOUD_CLIENT_ID + _SECRET,
//   CURATOR_TIDAL_CLIENT_ID + _SECRET, CURATOR_LASTFM_API_KEY.
// The label profiler (MusicBrainz, Discogs: key-less) always runs. A tracker
// row whose provider has no adapter here is skipped, not failed.

import {
	BandcampTracker,
	BeatportTracker,
	DeezerTracker,
	LastfmReader,
	SoundCloudTracker,
	SpotifyTracker,
	YouTubeTracker,
	type TrackerAdapter,
} from '@curator/catalog-readers';
import type { AgentReasonerConfig } from '../catalog/agent/config.js';
import { runAgentReasoner } from '../catalog/agent/reasoner.js';
import { runPageValidation } from '../catalog/artist-validation.js';
import { audienceReaders, runAudience } from '../catalog/audience.js';
import { runCreditFill } from '../catalog/credit-fill.js';
import { runInboxDetectors } from '../catalog/inbox-detectors.js';
import { runLabelDedupe } from '../catalog/label-related.js';
import { DeezerFinder, runIsrcFill, runPlanner, runRecordingResolver, SpotifyFinder, type IdentityFinder } from '../catalog/planner.js';
import { runCataloguePlaylists } from '../catalog/profile/catalogue-playlists.js';
import { runLabelProfiler } from '../catalog/profile/label-profiler.js';
import { runReachScores } from '../catalog/reach.js';
import { runReleaseFiller } from '../catalog/release-fill.js';
import { appCredentialsToken } from '../catalog/spotify-app-token.js';
import { createSpotifyPace } from '../catalog/spotify-pace.js';
import { runStoreLinker } from '../catalog/store-links.js';
import { AppleLookup } from '../catalog/trackers/apple.js';
import { runBackfill } from '../catalog/trackers/backfill.js';
import { runTrackers } from '../catalog/trackers/sweep.js';
import { TidalApp } from '../catalog/trackers/tidal-app.js';
import { soundcloudCredentials, tidalCredentials } from '../config.js';
import type { Db } from '../db/db.js';
import type { Logger } from '../log.js';

type ReasonerModel = Parameters<typeof runAgentReasoner>[0]['model'];

export type PassReaders = ReturnType<typeof readersFromEnv>;

export function readersFromEnv(env: NodeJS.ProcessEnv, db: Db) {
	const value = (name: string): string | null => env[name]?.trim() || null;
	const on = (name: string): boolean => env[name]?.trim() !== '0';
	const beatport = on('CURATOR_FEED_BEATPORT') ? new BeatportTracker() : null;
	const bandcamp = on('CURATOR_FEED_BANDCAMP') ? new BandcampTracker() : null;
	const deezer = new DeezerTracker();
	const adapters: TrackerAdapter[] = [deezer, ...(beatport ? [beatport] : []), ...(bandcamp ? [bandcamp] : [])];
	const finders: IdentityFinder[] = [new DeezerFinder()];
	// One pace for every Spotify read this process makes (spotify-pace.ts): the
	// client id is the desktops' too, so a ban any of them met is ours and our
	// share of the window is kept small.
	const pace = createSpotifyPace({ db: () => db });
	const spotifyId = value('CURATOR_SPOTIFY_APP_CLIENT_ID') ?? value('CURATOR_SPOTIFY_CLIENT_ID');
	const spotifySecret = value('CURATOR_SPOTIFY_APP_CLIENT_SECRET');
	const spotify = spotifyId && spotifySecret ? new SpotifyTracker({ token: appCredentialsToken({ clientId: spotifyId, clientSecret: spotifySecret }) }, pace.fetch) : null;
	if (spotify) {
		adapters.push(spotify);
		finders.push(new SpotifyFinder(spotify));
	}
	const youtubeKey = value('CURATOR_YOUTUBE_API_KEY');
	const youtube = youtubeKey ? new YouTubeTracker(youtubeKey) : null;
	if (youtube) adapters.push(youtube);
	const sc = soundcloudCredentials(env);
	const soundcloud = sc ? new SoundCloudTracker(sc) : null;
	if (soundcloud) adapters.push(soundcloud);
	const tidalCreds = tidalCredentials(env);
	// The stores a release is linked to by identifier (store-links.ts).
	const stores = { spotify, tidal: tidalCreds ? new TidalApp(tidalCreds) : null, apple: on('CURATOR_FEED_APPLE') ? new AppleLookup() : null };
	const lastfmKey = value('CURATOR_LASTFM_API_KEY');
	return {
		adapters,
		finders,
		spotify,
		soundcloud,
		stores,
		// A library's releases read in full from their stores (release-fill.ts).
		fetchers: { ...stores, deezer, beatport, bandcamp },
		// An artist's audience at each store, for its Reach score.
		audience: audienceReaders({
			deezer,
			tidal: stores.tidal,
			soundcloud,
			youtube,
			lastfm: lastfmKey ? new LastfmReader(lastfmKey) : null,
			spotifyPages: on('CURATOR_FEED_SPOTIFY_PAGES'),
		}),
		spotifyFetch: pace.fetch,
	};
}

export type PassDeps = {
	db: Db;
	log: Logger;
	// Names this process in the leases it takes.
	holder: string;
	readers: PassReaders;
	// The tracking pass's, when a reader comes and goes (the local catalogue's
	// Spotify login); the readers' own otherwise.
	adapters?: () => TrackerAdapter[];
	// The catalogue reasoner (catalog/agent), when one is configured.
	agent: { model: ReasonerModel; cfg: AgentReasonerConfig } | null;
};

type Step = { name: string; failed: string; run: (d: PassDeps) => Promise<unknown> };

const held = (d: PassDeps) => ({ db: d.db, log: d.log, holder: d.holder });

export const PASS_STEPS: readonly Step[] = [
	{ name: 'trackers', failed: 'tracker_pass_failed', run: (d) => runTrackers({ ...held(d), adapters: d.adapters?.() ?? d.readers.adapters }) },
	{ name: 'identity planner', failed: 'identity_pass_failed', run: (d) => runPlanner({ db: d.db, log: d.log, finders: d.readers.finders }) },
	{ name: 'page validation', failed: 'page_validation_failed', run: (d) => runPageValidation({ db: d.db, log: d.log, reader: d.readers.fetchers.deezer }) },
	{ name: 'audience', failed: 'audience_pass_failed', run: (d) => runAudience({ ...held(d), readers: d.readers.audience }) },
	{ name: 'reach scores', failed: 'reach_pass_failed', run: (d) => runReachScores({ db: d.db, log: d.log }) },
	{ name: 'recording resolver', failed: 'recording_resolve_failed', run: async (d) => d.readers.spotify && runRecordingResolver({ db: d.db, log: d.log, spotify: d.readers.spotify }) },
	{ name: 'isrc fill', failed: 'isrc_fill_failed', run: async (d) => d.readers.spotify && runIsrcFill({ db: d.db, log: d.log, spotify: d.readers.spotify }) },
	{ name: 'store links', failed: 'store_link_pass_failed', run: (d) => runStoreLinker({ db: d.db, log: d.log, readers: d.readers.stores }) },
	{ name: 'release fill', failed: 'release_fill_pass_failed', run: (d) => runReleaseFiller({ ...held(d), fetchers: d.readers.fetchers }) },
	{ name: 'track credits', failed: 'credit_fill_pass_failed', run: (d) => runCreditFill({ db: d.db, log: d.log, spotify: d.readers.spotify, beatport: d.readers.fetchers.beatport }) },
	{
		name: 'label profiles',
		failed: 'label_profile_pass_failed',
		run: (d) => runLabelProfiler({ db: d.db, log: d.log, spotify: d.readers.spotify, providers: { beatport: d.readers.fetchers.beatport !== null, bandcamp: d.readers.fetchers.bandcamp !== null }, batch: 10 }),
	},
	{ name: 'backfill', failed: 'catalog_backfill_failed', run: (d) => runBackfill({ ...held(d), adapters: d.readers.adapters, batch: 20 }) },
	{ name: 'catalogue playlists', failed: 'catalogue_playlists_pass_failed', run: (d) => runCataloguePlaylists({ ...held(d), spotify: d.readers.spotify, batch: 10 }) },
	{ name: 'label dedupe', failed: 'label_dedupe_pass_failed', run: (d) => runLabelDedupe({ db: d.db, log: d.log }) },
	{ name: 'inbox detectors', failed: 'inbox_detectors_failed', run: (d) => runInboxDetectors({ db: d.db, log: d.log, agent: d.agent !== null }) },
	{ name: 'reasoner', failed: 'agent_reasoner_failed', run: async (d) => d.agent && runAgentReasoner({ ...held(d), model: d.agent.model, cfg: d.agent.cfg }) },
];

// One pass, step after step; the names of the steps that threw. `only`: just
// the steps so named. `onStep` is told each step as it starts.
export async function runPass(d: PassDeps, opts: { only?: readonly string[]; onStep?: (name: string) => void; stopped?: () => boolean } = {}): Promise<string[]> {
	const failed: string[] = [];
	for (const step of PASS_STEPS) {
		if (opts.only && !opts.only.includes(step.name)) continue;
		if (opts.stopped?.()) break;
		opts.onStep?.(step.name);
		try {
			await step.run(d);
		} catch (e) {
			failed.push(step.name);
			d.log.error(step.failed, { error: e });
		}
	}
	return failed;
}

// The Global Catalog's provider readers: how one provider reads the
// collection of one kind of live object (an artist's releases, a label's
// uploads, a playlist's additions). A reader observes and returns claims over
// an injected `fetch`; it never writes the catalogue. The cloud worker runs
// them (apps/cloud catalog/trackers/sweep.ts leases, budgets, ingests and
// raises the events), and a desktop runs the same readers for its user's
// follows and reports the poll back — one code, two hosts, so a reader fixed
// in one place is fixed in both.
//
// Hosts supply what a provider needs: `fetch` (a desktop gives Beatport
// Electron's net.fetch), app credentials (YouTube, SoundCloud: the cloud
// only), or a Spotify token source (the cloud's app token, a desktop's own
// login). Nothing here imports a database, a logger or node:*.

export type { TrackerAdapter, TrackerPoll, TrackerTarget } from './types.js';
export { CALLS_PER_POLL, callsPerPoll, TrackerRateLimitedError } from './types.js';
export { getJson, listingHash, ProviderHttpError, rememberSeen, type FetchLike } from './http.js';
export { parseUploadTitle, splitCatalogNumber, splitCredit, stripFormatWord, type UploadCredit } from './upload-title.js';
export { DeezerTracker } from './deezer.js';
export { BeatportTracker } from './beatport.js';
export { BEATPORT, BROWSER_USER_AGENT, dateOf as beatportDateOf, fetchNextData, imageUrl as beatportImageUrl, isChallenge, publishedMs as beatportPublishedMs, queryData } from './beatport-pages.js';
export type { BpArtist, BpImage, BpLabel, BpPage, BpReleaseRef, BpTrack, NextData, NextQuery } from './beatport-pages.js';
export { BandcampTracker } from './bandcamp.js';
export { SoundCloudTracker, type SoundCloudCredentials } from './soundcloud.js';
export { YouTubeTracker } from './youtube.js';
export {
	fetchAlbumLabels,
	fetchAlbums,
	fetchPlaylistMeta,
	readPlaylistItems,
	releaseClaim as spotifyReleaseClaim,
	releaseClaimFromTrack,
	SpotifyTracker,
	trackOf,
	type SpotifyReader,
	type SpotifyTokenSource,
	type SpPlaylistEntry,
	type SpPlaylistTrack,
} from './spotify.js';
export { SpotifyUserPlaylistTracker, type SpotifyUserPlaylistDeps } from './spotify-user-playlist.js';

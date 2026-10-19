// Download configuration — user-editable surface for where files go, how
// they're named, and the codec/parallelism knobs ported from tidalext.
//
// Defaults are sensible for personal use on a fast connection. Edit in place
// or override individual fields via env vars (CURATOR_DOWNLOAD_DIR etc.).
//
// Filename template tokens (case-sensitive):
//   {trackNumber}  zero-padded 2-digit index in the playlist (or 01 if N/A)
//   {artist}       primary artist name
//   {title}        track title
//   {album}        album name (empty when unknown)
//   {ext}          file extension based on `audioQuality` ("flac" or "m4a")
// Disallowed in filenames: / \ : * ? " < > | (sanitised to "-").

import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;

export type TidalAudioQuality = 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'HIGH' | 'LOW';

export interface DownloadConfig {
	// Where files are written. Created on first run if missing.
	dir: string;
	// Where downloads land for tracks that ALREADY have a local file. Kept
	// separate from `dir` so re-downloads don't mix into the main download
	// folder (which acts as the to-import inbox for the library) — sweeping
	// that folder into a watched root would otherwise ingest duplicates of
	// tracks that are already bound to a local file.
	redownloadDir: string;
	// Per-playlist subdirectory under `dir` when downloading a playlist. False
	// puts everything in `dir`.
	subdirPerPlaylist: boolean;
	// Filename template — see token list at the top of this file.
	filenameTemplate: string;
	// Max concurrent track downloads (NOT segment-level; one whole track per
	// slot). 1 is safest; higher values risk Tidal rate-limiting.
	parallelTracks: number;
	// Max concurrent segment fetches WITHIN a single track. 1 streams
	// sequentially; 2-4 is faster but more memory-hungry. Higher than 4
	// rarely helps and often gets throttled.
	parallelSegments: number;
	// Delay between tracks — random pick from [min, max] in ms on each
	// inter-track wait. Randomised throttling looks less bot-like than a
	// fixed interval. Defaults to 1–6s; env overrides use the *MIN_MS and
	// *MAX_MS vars below.
	betweenTracksMs: [number, number];
	// Embed album artwork into the FLAC PICTURE block. Slower (extra fetch)
	// but produces a richer file.
	embedArtwork: boolean;
	// Save the cover image as a separate `cover.jpg` next to the FLAC. Useful
	// when your player doesn't read embedded artwork.
	saveArtworkAsFile: boolean;
	// Preferred audio quality. The Tidal API returns the closest available
	// quality at or below this; FLAC requires HiFi+ subscription.
	audioQuality: TidalAudioQuality;
	// Manifest type to request. "BTS" gives the DASH manifest used by the
	// FLAC processor; "EMU" / "DASH" are alternatives kept for future use.
	manifestType: 'BTS' | 'DASH' | 'EMU';
	// Write an m3u8 playlist file alongside playlist downloads.
	writeM3u8: boolean;
}

export const downloadConfig: DownloadConfig = {
	dir: env.CURATOR_DOWNLOAD_DIR ?? join(homedir(), 'Music', 'Curator'),
	redownloadDir: env.CURATOR_REDOWNLOAD_DIR ?? join(homedir(), 'Music', 'Curator Redownloads'),
	subdirPerPlaylist: true,
	filenameTemplate: '{artist} - {title}.{ext}',
	parallelTracks: Number(env.CURATOR_DOWNLOAD_PARALLEL_TRACKS ?? 2),
	parallelSegments: Number(env.CURATOR_DOWNLOAD_PARALLEL_SEGMENTS ?? 4),
	betweenTracksMs: [
		Number(env.CURATOR_DOWNLOAD_DELAY_MIN_MS ?? 1000),
		Number(env.CURATOR_DOWNLOAD_DELAY_MAX_MS ?? 6000),
	],
	embedArtwork: true,
	saveArtworkAsFile: false,
	audioQuality: (env.CURATOR_TIDAL_QUALITY as TidalAudioQuality | undefined) ?? 'HI_RES_LOSSLESS',
	manifestType: 'BTS',
	writeM3u8: false,
};

// Picks a random delay (ms) from the configured [min, max] range. Use this
// instead of reading `downloadConfig.betweenTracksMs` directly — keeps the
// randomisation in one place.
export function pickBetweenTracksDelay(): number {
	const [min, max] = downloadConfig.betweenTracksMs;
	if (max <= min) return min;
	return Math.floor(min + Math.random() * (max - min + 1));
}

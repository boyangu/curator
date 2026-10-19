// Coordinates a Tidal track download:
//   1. Pull track metadata via v1 (needs the sniffed session bearer)
//   2. Get playbackinfo manifest for the requested quality
//   3. Resolve filename per the user's template + sanitise
//   4. Fetch cover artwork if configured
//   5. Hand off to downloadFlac for the assemble-and-write step
//   6. Optionally write cover.jpg next to it

import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { promises as fsp, existsSync, statSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { track, sourceLink } from '@curator/shared/schema';
import { TidalV1Client, TidalApiError, type TidalV1PlaybackInfo } from '@curator/tidal';
import { downloadConfig, type DownloadConfig } from '../config.download.js';
import { downloadFlac, type FlacMetadata } from './download-flac.js';
import { applyOverrides } from '@curator/library-logic';
import { DownloadError } from './download-queue.js';
import type { Db } from '../db/client.js';
import type { AuthService } from '../auth/service.js';
import { log } from '../log.js';

const olog = log.for('download-orch');
const dllog = log.for('download');

export interface DownloadProgress {
	stage: 'starting' | 'manifest' | 'cover' | 'streaming' | 'done' | 'error';
	pct?: number;
	currentSegment?: number;
	totalSegments?: number;
	bytes?: number;
	outputPath?: string;
	error?: string;
}

export type DownloadProgressFn = (p: DownloadProgress) => void;

export class TidalDownloader {
	constructor(
		private readonly db: Db,
		private readonly auth: AuthService
	) {}

	async downloadTrack(
		trackId: string,
		progress: DownloadProgressFn = () => {}
	): Promise<{ outputPath: string; bytes: number; skipped?: boolean }> {
		progress({ stage: 'starting' });

		const rawTrack = this.db.select().from(track).where(eq(track.id, trackId)).get();
		if (!rawTrack) throw new Error('Track not found in library');

		// Apply user overrides — the Edit-Track modal lives at the override
		// layer, and the FLAC we write should reflect what the user sees in
		// the table, not the raw source values.
		const t = applyOverrides(rawTrack);

		// One pass over source_links to grab everything we need: the Tidal id
		// (download key), Beatport URL (WEBSITE tag), Tidal URL (URL tag).
		const links = this.db
			.select({ source: sourceLink.source, sourceTrackId: sourceLink.sourceTrackId, url: sourceLink.url, missingAt: sourceLink.missingAt })
			.from(sourceLink)
			.where(eq(sourceLink.trackId, trackId))
			.all();
		const tidalIdRow = links.find((l) => l.source === 'tidal');
		const beatportUrl = links.find((l) => l.source === 'beatport')?.url ?? null;
		const tidalUrl = tidalIdRow?.url ?? null;
		if (!tidalIdRow) throw new DownloadError('not_available', 'Track has no Tidal source-link — match it first');

		// Already-local tracks download to a SEPARATE folder. `dir` is the
		// to-import inbox the user sweeps into a watched library root — a
		// re-download of a track that's already bound to a local file must not
		// land there (sweeping it in would ingest a duplicate). The track's
		// local link is deliberately left untouched; the fresh file is just a
		// standalone copy. A link flagged missing_at is a file that vanished
		// (the row is a re-bind hint — see resolveLocalFile): this download is
		// its replacement, so it goes to the inbox and re-binds by audio hash
		// when swept in.
		const hasLocalFile = links.some((l) => l.source === 'local' && l.missingAt == null);
		const targetDir = hasLocalFile ? downloadConfig.redownloadDir : downloadConfig.dir;

		// Pre-flight skip: if the target file already exists, skip the whole
		// pipeline (no playbackinfo, no manifest, no fetch). The extension
		// derives from the REQUESTED quality so the path is stable without
		// hitting the Tidal API. If a user changed audioQuality after a prior
		// download, the new path differs and the skip won't false-positive.
		const expectedFormat = pickAudioFormat(downloadConfig.audioQuality);
		const expectedFilename = renderFilename(downloadConfig.filenameTemplate, t, expectedFormat.ext);
		const expectedPath = join(targetDir, expectedFilename);
		if (existsSync(expectedPath)) {
			const size = statSync(expectedPath).size;
			olog.info('skip (exists)', { path: expectedPath, bytes: size });
			progress({ stage: 'done', outputPath: expectedPath, bytes: size });
			return { outputPath: expectedPath, bytes: size, skipped: true };
		}

		const session = this.auth.getTidalSessionToken();
		if (!session) throw new DownloadError('auth_required', 'Tidal downloads require a sniffed session — enable downloads first');

		const client = new TidalV1Client(session);

		// Playback manifest
		progress({ stage: 'manifest' });
		let pb: TidalV1PlaybackInfo;
		try {
			pb = await client.getPlaybackInfo(tidalIdRow.sourceTrackId, {
				audioQuality: downloadConfig.audioQuality,
				manifestType: downloadConfig.manifestType,
			});
		} catch (err) {
			// Tidal's /playbackinfo answers in status + subStatus codes, not
			// prose. Translate the ones we actually hit into a download-row
			// message the user can read, instead of leaking the raw
			// `Tidal v1 403 … subStatus 4032 …` JSON blob into the error cell.
			throw explainPlaybackInfoError(err, session.countryCode);
		}

		// Log what Tidal actually returned. If we asked for HI_RES_LOSSLESS but
		// got LOSSLESS/HIGH, the user's account or this specific track doesn't
		// support the requested quality. Also flags region-downgrade (e.g. when
		// countryCode came back as "WW" / Worldwide instead of a real ISO code).
		olog.debug('playbackinfo', { audioQuality: pb.audioQuality, manifestMimeType: pb.manifestMimeType });
		if (downloadConfig.audioQuality !== pb.audioQuality) {
			olog.warn('quality downgrade. Likely cause: account tier (HiFi vs HiFi+) OR track unavailable at requested quality OR country restriction.', {
				requested: downloadConfig.audioQuality,
				got: pb.audioQuality,
				countryCode: session.countryCode,
			});
		}

		// Map Tidal's quality enum to codec + container extension. Single
		// source of truth so the filename, the validation gate, and (future)
		// M4A processor branch all read the same answer.
		const format = pickAudioFormat(pb.audioQuality);
		olog.debug('resolved format', { codec: format.codec, ext: format.ext });

		if (format.codec !== 'flac') {
			throw new DownloadError('unsupported_format',
				`Tidal returned audioQuality=${pb.audioQuality} (${format.codec.toUpperCase()}). The FLAC processor only handles FLAC streams. ` +
				`To download this track: upgrade to Tidal HiFi Plus, OR set audioQuality='LOSSLESS' in config.download.ts, OR wait for M4A processor port.`
			);
		}

		if (pb.manifestMimeType !== 'application/dash+xml' && pb.manifestMimeType !== 'application/vnd.tidal.bts') {
			throw new DownloadError('unsupported_format', `Unexpected manifest mime: ${pb.manifestMimeType}. FLAC port only handles DASH/BTS for now.`);
		}

		// Filename extension comes from the codec we actually got back. When
		// M4A support lands later, this same path picks .m4a automatically.
		const filename = renderFilename(downloadConfig.filenameTemplate, t, format.ext);
		const outputPath = join(targetDir, filename);

		// Cover art (optional). Same fallback pattern as service.getTrackCoverUrl
		// — when track.coverUrl is null (older sync), dig into the Spotify
		// source_link's saved payload for the album image. Avoids forcing a
		// resync just to populate one column.
		let coverRemoteUrl = t.coverUrl ?? null;
		if (!coverRemoteUrl) {
			const spLink = this.db
				.select({ payload: sourceLink.payload })
				.from(sourceLink)
				.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, 'spotify')))
				.get();
			const payload = spLink?.payload as { album?: { images?: { url?: string }[] } } | null;
			coverRemoteUrl = payload?.album?.images?.[0]?.url ?? null;
		}

		let cover: { data: Buffer; mime: string } | null = null;
		if (downloadConfig.embedArtwork && coverRemoteUrl) {
			progress({ stage: 'cover' });
			try {
				const res = await fetch(coverRemoteUrl);
				if (res.ok) {
					const ab = await res.arrayBuffer();
					cover = { data: Buffer.from(ab), mime: res.headers.get('content-type') ?? 'image/jpeg' };
				} else {
					dllog.warn('cover fetch http error', { status: res.status });
				}
			} catch (err) {
				dllog.warn('cover fetch failed', undefined, err);
			}
		} else if (downloadConfig.embedArtwork) {
			dllog.debug('no cover URL available for this track');
		}

		// Build Vorbis comments. Mirrors tidalext's tag set so DJ software
		// (Rekordbox, Serato, Engine DJ) sees BPM/Key/Label/Genre out of the
		// box. Order: identification → release info → DJ tags → source URLs.
		const allArtists = (t.artists ?? []).map((a) => a.name);
		const yearMatch = (t.releaseDate ?? '').match(/^(\d{4})/);
		const meta: FlacMetadata = {
			TITLE: t.title,
			ARTIST: allArtists.join('; ') || undefined,
			ALBUMARTIST: allArtists[0] ?? undefined,
			ALBUM: t.albumTitle ?? undefined,
			DATE: yearMatch?.[1] ?? undefined,
			ORIGINALDATE: t.releaseDate ?? undefined,
			TRACKNUMBER: '1',
			ISRC: t.isrc ?? undefined,
			// DJ-focused tags — these are what Rekordbox/Serato read. Both
			// LABEL and ORGANIZATION are written because different software
			// reads different keys. INITIALKEY duplicates KEY for the same
			// reason. Key is canonical Camelot (DJ-standard) — the only stored
			// form; musical notation is a UI projection, not written to tags.
			BPM: t.bpm != null ? String(t.bpm) : undefined,
			KEY: t.keyCamelot ?? undefined,
			INITIALKEY: t.keyCamelot ?? undefined,
			GENRE: t.genre ?? undefined,
			LABEL: t.label ?? undefined,
			ORGANIZATION: t.label ?? undefined,
			// Windows Explorer's "Producers" column reads PRODUCER for FLAC.
			// Mirror the label value here so Explorer shows the label alongside
			// the other DJ fields. Players that read PRODUCER as actual
			// producers will see the label name; tradeoff is acceptable for
			// the DJ workflow this app targets.
			PRODUCER: t.label ?? undefined,
			// Source provenance — useful when re-importing the file later.
			URL: tidalUrl ?? undefined,
			WEBSITE: beatportUrl ?? undefined,
		};

		// Diagnostic: confirm meta was built and cover resolved before we hand
		// off to downloadFlac. If this shows mostly undefined values, the issue
		// is the source data, not the FLAC writer.
		const present = Object.entries(meta).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}="${String(v).slice(0, 60)}"`);
		olog.debug('track meta built', { trackId, metaKeys: present.length, meta: present });
		olog.debug('cover resolved', { cover: cover ? `${cover.mime} (${cover.data.length} bytes)` : 'null (no t.coverUrl or fetch failed)' });

		// Stream + write
		progress({ stage: 'streaming', pct: 0, totalSegments: 0 });
		const result = await downloadFlac({
			manifestBase64: pb.manifest,
			outputPath,
			metadata: meta,
			cover,
			parallelSegments: downloadConfig.parallelSegments,
			onProgress: ({ pct, segIdx, segTotal, bytes }) => {
				progress({ stage: 'streaming', pct, currentSegment: segIdx, totalSegments: segTotal, bytes });
			},
		});

		// Save artwork file alongside (optional)
		if (downloadConfig.saveArtworkAsFile && cover) {
			const coverPath = outputPath.replace(/\.[^.]+$/, '.jpg');
			await fsp.writeFile(coverPath, cover.data);
		}

		progress({ stage: 'done', outputPath, bytes: result.bytes });
		return { outputPath, bytes: result.bytes };
	}
}

// Map a failed /playbackinfo call to a download-row error the user can act on.
// Tidal returns an HTTP status plus a finer `subStatus`; the status alone is
// ambiguous (403 covers both geo-blocks and entitlement gaps). Unknown shapes
// are rethrown untouched so a real bug isn't masked behind a friendly string.
function explainPlaybackInfoError(err: unknown, countryCode: string): Error {
	if (!(err instanceof TidalApiError)) return err instanceof Error ? err : new Error(String(err));

	// 403/4032 — "No content matching subscription location": the track is in
	// Tidal's catalog (so it shows in search) but its stream isn't licensed for
	// this account's region. Common for remixes/alternate masters with narrower
	// territorial rights. Folded into `not_available` (the kind documents this).
	if (err.status === 403 && err.subStatus === 4032) {
		return new DownloadError('not_available',
			`Not licensed for download in your Tidal region (${countryCode}). ` +
			`Tidal lists the track but blocks the stream for this account's location — common for remixes/alternate masters. ` +
			`If a track you know plays in the Tidal app also fails this way, re-run “enable downloads” to refresh the captured region.`);
	}
	// Other 403s are entitlement/quality, not geography.
	if (err.status === 403) {
		return new DownloadError('not_available',
			`Tidal denied playback access (403${err.subStatus != null ? `/${err.subStatus}` : ''}). ` +
			`This account may not be entitled to stream this track.`);
	}
	// 401 — the sniffed session bearer is stale/expired.
	if (err.status === 401) {
		return new DownloadError('auth_required',
			'Tidal session expired — re-run “enable downloads” to refresh it.');
	}
	// Anything else: keep Tidal's own userMessage when present, else the status.
	return new DownloadError('download_failed',
		`Tidal playbackinfo failed (${err.status}${err.userMessage ? `: ${err.userMessage}` : ''}).`);
}

// Tidal's audioQuality enum → codec + container. The enum values aren't
// self-describing (`HI_RES_LOSSLESS` doesn't say "FLAC") which is what bit
// us before — every download was getting the .m4a extension because of a
// string-includes('FLAC') check that always returned false. Centralising
// here keeps the mapping authoritative.
type AudioFormat = { codec: 'flac' | 'aac'; ext: 'flac' | 'm4a' };
function pickAudioFormat(audioQuality: string): AudioFormat {
	switch (audioQuality) {
		case 'HI_RES_LOSSLESS': // FLAC 24-bit / 96kHz+ (HiFi Plus)
		case 'LOSSLESS':         // FLAC 16-bit / 44.1kHz (HiFi)
			return { codec: 'flac', ext: 'flac' };
		case 'HIGH':             // AAC 320
		case 'LOW':              // AAC 96
			return { codec: 'aac', ext: 'm4a' };
		default:
			// Future-proof: default to m4a/aac so an unknown quality at least
			// gets a generic container ext. The processor will throw before
			// any file is written so wrong-extension isn't possible.
			return { codec: 'aac', ext: 'm4a' };
	}
}

// Replace {token} placeholders, sanitise illegal filename chars.
// `track` here is the canonical Track row; this is fine because download is
// always per-canonical-track regardless of which source linked it first.
function renderFilename(template: string, t: { title: string; artists: { name: string }[]; albumTitle: string | null }, ext: string): string {
	const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
	const primary = t.artists?.[0]?.name ?? 'Unknown Artist';
	return template
		.replace(/\{trackNumber\}/g, '01')
		.replace(/\{artist\}/g, safe(primary))
		.replace(/\{title\}/g, safe(t.title))
		.replace(/\{album\}/g, safe(t.albumTitle ?? ''))
		.replace(/\{ext\}/g, ext);
}

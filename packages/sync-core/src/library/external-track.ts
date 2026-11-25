// A track the library does not hold yet, from what a feed card says about it.
//
// The desktop promotes a feed track by fetching it from Spotify and ingesting
// it as its own row with a source link (apps/core sync/spotify.ts
// ingestExternalTrack). A phone has no provider of its own, so it states the
// recording on the op log — its existence, its metadata, what identifies it —
// and shows it the way it shows every other track: as a remote row made from
// the records (sync-log/remote-rows.ts). The lookup order is the desktop's:
// the exact Spotify id, then the id as another device claimed it, then the
// ISRC, and only then a new recording.
//
// What it states is source facts, so the role gate applies (sync-log/role.ts)
// and is applied here by hand: the drains that usually hold it read own rows
// only, and this writes none. A secondary may describe what it creates; of a
// recording that exists already it states nothing but the claim the ISRC
// match earned, exactly as the desktop's ingest does.
//
// Nothing here reaches Spotify, Tidal or rekordbox, and no device pushes
// anything upstream for it: those pushes follow playlist rows, and a
// recording's create, metadata, tag and state are none.

import { randomUUID } from 'node:crypto';
import type { TrackMeta } from '@curator/protocol';
import { normalizeIsrc } from '@curator/library-logic';
import type { Db } from '../db/client.js';
import { bindByClaim, projectAdoptedRecordings } from '../sync-log/claim-bind.js';
import { deriveClaimLinks } from '../sync-log/claim-links.js';
import { emitV4 } from '../sync-log/features.js';
import { emitOps, type EmitOp } from '../sync-log/outbox.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { claimOp } from '../sync-log/rows.js';
import { sourceRole } from '../sync-log/role.js';
import { httpCover } from '../sync-log/track-meta.js';
import { normalizeIncomingCreditsRaw, rawOf } from './artists.js';
import { addClaims, recordTrackStateChanges, tagTracks } from './mutators.js';
import type Database from 'better-sqlite3';

type Raw = Database.Database;

export type ExternalTrackFacts = {
	spotifyTrackId: string;
	isrc: string | null;
	title: string;
	artists: string[];
	albumTitle: string | null;
	releaseDate: string | null;
	label: string | null;
	genre: string | null;
	coverUrl: string | null;
	durationSec: number | null;
	trackNumber: number | null;
	bpm: number | null;
	keyCamelot: string | null;
};

export type EnsureResult =
	| { ok: true; trackId: string; recordingId: string; created: boolean }
	// 'not-ready': this device has not seen the account yet, or the server
	// does not read these ops. 'deleted': the user deleted this track, and a
	// new card for it must not bring it back.
	| { ok: false; reason: 'not-ready' | 'deleted' };

type Row = { id: string; recording_id: string; deleted_at: number | null };

const trimmed = (s: string | null | undefined): string | null => s?.trim() || null;
const count = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null);

// The row this device holds under an exact Spotify id: its own link first,
// then one derived from another device's claim; a live row before a deleted.
function rowBySpotifyId(raw: Raw, id: string): Row | undefined {
	return raw.prepare(`SELECT t.id, t.recording_id, t.deleted_at FROM (
			SELECT track_id, 0 AS ord FROM source_link WHERE source = 'spotify' AND source_track_id = ?
			UNION ALL SELECT track_id, 1 AS ord FROM claim_link WHERE source = 'spotify' AND source_track_id = ?
		) l JOIN track t ON t.id = l.track_id
		WHERE t.derived_from_track_id IS NULL
		ORDER BY t.deleted_at IS NOT NULL, l.ord LIMIT 1`).get(id, id) as Row | undefined;
}

function rowByIsrc(raw: Raw, isrc: string): Row | undefined {
	return raw.prepare(`SELECT id, recording_id, deleted_at FROM track
		WHERE isrc = ? AND +derived_from_track_id IS NULL ORDER BY deleted_at IS NOT NULL, remote_only LIMIT 1`).get(isrc) as Row | undefined;
}

function rowOfRecording(raw: Raw, recordingId: string): Row | undefined {
	return raw.prepare(`SELECT id, recording_id, deleted_at FROM track
		WHERE recording_id = ? AND +derived_from_track_id IS NULL ORDER BY deleted_at IS NOT NULL, remote_only LIMIT 1`).get(recordingId) as Row | undefined;
}

const found = (r: Row): EnsureResult => (r.deleted_at !== null ? { ok: false, reason: 'deleted' } : { ok: true, trackId: r.id, recordingId: r.recording_id, created: false });

export function ensureExternalTrack(db: Db, t: ExternalTrackFacts, now: Date = new Date()): EnsureResult {
	const raw = rawOf(db);
	return raw.transaction((): EnsureResult => {
		if (sourceRole(raw).speaks === 'none' || !emitV4(raw)) return { ok: false, reason: 'not-ready' };

		const here = rowBySpotifyId(raw, t.spotifyTrackId);
		if (here) return found(here);

		// Another device's claim on the id, with no row of it here yet.
		const bound = bindByClaim(raw, 'spotify', t.spotifyTrackId);
		if (bound) {
			if (bound.deleted) return { ok: false, reason: 'deleted' };
			if (!bound.trackId) projectAdoptedRecordings(raw, [bound.recordingId]);
			const row = rowOfRecording(raw, bound.recordingId);
			// Its metadata is still on the way: nothing to show it with, and
			// describing another device's recording is not this one's to do.
			return row ? found(row) : { ok: false, reason: 'not-ready' };
		}

		const isrc = normalizeIsrc(t.isrc);
		const byIsrc = isrc ? rowByIsrc(raw, isrc) : undefined;
		if (byIsrc) {
			const r = found(byIsrc);
			if (r.ok) {
				// 0.9: bound through the ISRC, not the provider's own id.
				addClaims(db, byIsrc.id, [{ kind: 'spotify', value: t.spotifyTrackId, confidence: 0.9 }]);
				deriveClaimLinks(raw, [byIsrc.recording_id]);
			}
			return r;
		}

		const recordingId = recordingIdForTrack(randomUUID());
		// The credits as the card spells them: each device maps them through
		// the account's artist rules itself (remote-rows.ts columnsOf).
		const credits = normalizeIncomingCreditsRaw(raw, t.artists.map((name) => ({ name })), { title: t.title, split: false });
		const meta: TrackMeta = {
			source: 'spotify',
			title: t.title,
			artists: credits.artistsBase?.list ?? credits.artists,
			album_title: trimmed(t.albumTitle),
			duration_sec: count(t.durationSec),
			isrc,
			release_date: trimmed(t.releaseDate),
			label: trimmed(t.label),
			genre: trimmed(t.genre),
			cover_url: httpCover(t.coverUrl),
			track_number: count(t.trackNumber),
			disc_number: null,
		};
		const bpm = t.bpm !== null && t.bpm > 0 && t.bpm <= 1000 ? t.bpm : null;
		const key = trimmed(t.keyCamelot);
		const ops: Array<EmitOp | null> = [
			{ entity: 'library_track', entity_id: recordingId, kind: 'create', payload: { added_at: now.getTime() } },
			{ entity: 'library_track', entity_id: recordingId, kind: 'set-meta', payload: meta },
			bpm !== null || key !== null
				? {
					entity: 'library_track', entity_id: recordingId, kind: 'set-attrs',
					payload: { source: 'spotify', bpm, key_camelot: key, key_source: key ? 'other' : null, explicit: null, mbid: null, copyright: null, play_count: null, provider_refs: [], artist_names: [] },
				}
				: null,
			// The provider's id at 1.0: it is what minted this recording.
			claimOp(recordingId, { kind: 'spotify', value: t.spotifyTrackId, confidence: 1 }),
			isrc ? claimOp(recordingId, { kind: 'isrc', value: isrc, confidence: 0.9 }) : null,
		];
		emitOps(raw, ops.filter((o): o is EmitOp => o !== null));
		// The records' own projection makes the row (a pull's path, step 1c).
		projectAdoptedRecordings(raw, [recordingId]);
		deriveClaimLinks(raw, [recordingId]);
		const row = rowOfRecording(raw, recordingId);
		if (!row) throw new Error(`recording ${recordingId} projected no row`);
		return { ok: true, trackId: row.id, recordingId, created: true };
	})();
}

// What Interested on a feed card does to the library, as feedPromote on the
// desktop: the track is there, in the backlog, tagged. A track the user
// already files further along (in progress, purchased) keeps its state.
export function promoteExternalTrack(db: Db, t: ExternalTrackFacts, now: Date = new Date()): EnsureResult {
	const raw = rawOf(db);
	return raw.transaction((): EnsureResult => {
		const r = ensureExternalTrack(db, t, now);
		if (!r.ok) return r;
		recordTrackStateChanges(db, [r.trackId], () => {
			raw.prepare(`UPDATE track SET state = 'backlog', state_changed_at = ?, updated_at = ? WHERE id = ? AND state IN ('unsorted', 'feed')`)
				.run(now.getTime(), now.getTime(), r.trackId);
		});
		tagTracks(db, [r.trackId], 'interested', { addedAt: now, bump: true });
		return r;
	})();
}

// Third-pass dedup for streaming upserts.
//
// Spotify/Tidal's upsertTrack resolves an incoming track by (source, id) then
// by ISRC. When both miss it used to mint a fresh canonical row — but the miss
// is common and benign: the same recording is often already held under a NULL
// ISRC (rekordbox-imported and scanner-created rows never carry a streaming
// ISRC) or under a different ISRC (Spotify issues multiple ids/ISRCs per
// recording). That minted the duplicate streaming-only rows that jammed
// Rekordbox playlist removals (diagnosed 2026-08-29).
//
// This adds the same title+artist+duration acceptance the scanner already
// trusts (sharedScorer), so the new source_link attaches to the existing
// canonical instead. It stays strict on purpose: the scorer's dur≤5 guard
// keeps genuinely different mixes of one title (Extended / Radio Edit, which
// differ in length) as separate rows.
//
// Duration alone can't separate mixes that happen to run the same length, and
// the scorer accepts a substring title — so "More" (Fink, 557s) bound onto
// "More - Klangkarussell Extended Remix" (555s) on 2026-10-12. Identity needs
// the version annotation to agree too, so candidates whose version differs are
// dropped before scoring (an ISRC match still wins). The veto lives here, not
// in sharedScorer: the scanner and Beatport enrichment rely on its leniency.

import { and, eq, isNull, like } from 'drizzle-orm';
import { track, type TrackArtist } from '@curator/shared/schema';
import { sharedScorer, type Candidate, type Target } from '@curator/matcher';
import { normalizeIsrc, versionOf } from '@curator/library-logic';
import type { Db } from '../db/client.js';

export interface ContentMatch {
	trackId: string;
	// The matched canonical carries no ISRC but the incoming provider track
	// does — the caller seeds track.isrc so pass-2 (ISRC) hits directly next
	// time, progressively healing the NULL-isrc rows that caused the miss.
	seedIsrc: string | null;
}

type CandRow = { id: string; title: string; artists: TrackArtist[] | null; duration: number | null; isrc: string | null };

function rowToCandidate(r: CandRow): Candidate {
	return {
		id: r.id,
		title: r.title,
		artists: (r.artists ?? []).map((a) => a.name),
		duration: r.duration ?? null,
		isrc: r.isrc ?? null,
	};
}

// Find an existing live canonical track that is the SAME recording as `target`,
// or null to create a fresh row. Candidate discovery mirrors the scanner's two
// cheap lookups (indexed ISRC + first-word title LIKE, scoped to non-deleted
// rows); the scorer's strict rule decides acceptance.
export function findExistingByContent(db: Db, target: Target): ContentMatch | null {
	const cols = {
		id: track.id,
		title: track.title,
		artists: track.artists,
		duration: track.duration,
		isrc: track.isrc,
	};
	const seen = new Set<string>();
	const candidates: Candidate[] = [];
	// Both sides canonical: the column is normalised (migration + every write
	// path), and the incoming value may still be hyphenated or lowercase.
	const targetIsrc = normalizeIsrc(target.isrc);
	const targetVersion = versionOf(target.title);
	const push = (r: CandRow) => {
		const isrcMatch = targetIsrc != null && normalizeIsrc(r.isrc) === targetIsrc;
		if (!isrcMatch && versionOf(r.title) !== targetVersion) return;
		if (!seen.has(r.id)) {
			seen.add(r.id);
			candidates.push(rowToCandidate(r));
		}
	};

	if (targetIsrc) {
		for (const r of db
			.select(cols)
			.from(track)
			.where(and(eq(track.isrc, targetIsrc), isNull(track.deletedAt), isNull(track.derivedFromTrackId)))
			.all()) {
			push(r);
		}
	}

	const firstWord = (target.title.match(/[A-Za-z0-9]{3,}/)?.[0] ?? '').toLowerCase();
	if (firstWord) {
		for (const r of db
			.select(cols)
			.from(track)
			// Derived copies (Convert to WAV) share title/artists/duration with
			// their original — a streaming track must bind to the original.
			.where(and(like(track.title, `%${firstWord}%`), isNull(track.deletedAt), isNull(track.derivedFromTrackId)))
			.limit(200)
			.all()) {
			push(r);
		}
	}

	// The scorer's ISRC rule compares case-insensitively but not
	// separator-insensitively, so hand it the canonical value.
	const best = sharedScorer.pick(candidates, { ...target, isrc: targetIsrc });
	if (!best) return null;
	const seedIsrc = targetIsrc && !best.isrc ? targetIsrc : null;
	return { trackId: String(best.id), seedIsrc };
}

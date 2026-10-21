// Library sink — persists an EnrichmentResult into curator.db: the track's DJ
// fields and a source_link row per matched source. This is the half that used
// to live inline in sync/spotify.ts's enrichTargets; pulling it behind a sink
// is both the decoupling (the runner no longer knows curator.db) and the cloud
// seam (the cloud build swaps this for a synced-library mutation).
//
// Merge policy — local wins for BPM/key, enricher wins for genre/label/release
// date: analyzer-measured or manually-edited BPM/key beat any catalog value,
// while genre/label/releaseDate have no local source of truth so the enricher
// fills/refreshes them. (releaseDate is sync-seeded from Spotify's album date;
// Beatport's track-level date is more accurate, so the enricher overrides it.)
// Shared by the library batch enrich AND feed promotion (see feedPromote) so
// both produce identical rows.

import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { track, sourceLink, SOURCES } from '@curator/shared/schema';
import { asciify } from '@curator/shared';
import { normalizeIsrc } from '@curator/library-logic';
import type { Db } from '../../db/client.js';
import { addClaims } from '../../library/mutators.js';
import type { DjMetadataPatch, EnrichmentResult } from '../contract.js';

export class LibrarySink {
	constructor(private readonly db: Db) {}

	// Apply a result to one track. Returns the final field values that were
	// written (for the renderer's per-row update), or null when nothing matched.
	async persist(trackId: string, result: EnrichmentResult): Promise<DjMetadataPatch | null> {
		if (!result.patch && result.sourceLinks.length === 0) return null;
		// A remote row (track.remoteOnly — another device's track projected
		// here) takes nothing. Its columns are the winning meta and are
		// re-derived on the next meta change, and a catalogue source_link
		// (beatport/traxsource) would trip the migrate.ts trigger that adopts
		// a remote row as this device's own — a row with no file or stream
		// here claiming to hold the track. The device that holds it enriches.
		const remote = this.db.select({ remoteOnly: track.remoteOnly }).from(track).where(eq(track.id, trackId)).get();
		if (remote?.remoteOnly) return null;

		let applied: DjMetadataPatch | null = null;
		if (result.patch) {
			const cur = this.db
				.select({
					bpm: track.bpm,
					keyCamelot: track.keyCamelot,
					genre: track.genre,
					label: track.label,
					releaseDate: track.releaseDate,
				})
				.from(track)
				.where(eq(track.id, trackId))
				.get();
			const p = result.patch;
			applied = {
				bpm: cur?.bpm ?? p.bpm ?? null,
				keyCamelot: cur?.keyCamelot ?? p.keyCamelot ?? null,
				genre: p.genre ?? cur?.genre ?? null,
				label: p.label ?? cur?.label ?? null,
				releaseDate: p.releaseDate ?? cur?.releaseDate ?? null,
			};
			// updatedAt only when a value moved: it means "Curator changed this
			// row" and feeds the rekordbox "Sync updates" selection, so a
			// re-enrich that lands the same values must not mark the track
			// edited. The values (and their ascii mirrors) are written anyway.
			const changed = !cur
				|| cur.bpm !== applied.bpm
				|| cur.keyCamelot !== applied.keyCamelot
				|| cur.genre !== applied.genre
				|| cur.label !== applied.label
				|| cur.releaseDate !== applied.releaseDate;
			this.db
				.update(track)
				.set(asciify(changed ? { ...applied, updatedAt: new Date() } : { ...applied }))
				.where(eq(track.id, trackId))
				.run();
		}

		for (const link of result.sourceLinks) {
			// The contract keeps `source` a plain string (no curator.db schema
			// dependency); narrow to the schema's source enum at this DB boundary.
			const source = link.source as (typeof SOURCES)[number];
			// Dedupe by (source, sourceTrackId) — the same Beatport track can back
			// more than one library row, but we keep one source_link per pairing.
			const existing = this.db
				.select({ id: sourceLink.id })
				.from(sourceLink)
				.where(and(eq(sourceLink.source, source), eq(sourceLink.sourceTrackId, link.sourceTrackId)))
				.get();
			if (!existing) {
				this.db
					.insert(sourceLink)
					.values({
						id: randomUUID(),
						trackId,
						source,
						sourceTrackId: link.sourceTrackId,
						url: link.url ?? null,
						// Beatport/Traxsource return ISRCs in mixed case and sometimes hyphenated;
						// every column that holds one carries the canonical form (see the
						// isrc_normalize migration), so normalise at the entry point.
						isrcLocal: normalizeIsrc(link.isrc),
						titleLocal: link.title ?? null,
						artistsLocal: link.artists ? link.artists.map((name) => ({ name })) : null,
						albumLocal: null,
						durationLocal: link.duration ?? null,
						bpmLocal: link.bpm ?? null,
						keyLocal: link.key ?? null,
						payload: link.payload,
						fetchedAt: new Date(),
					})
					.run();
				// A Beatport or Traxsource match is the account's claim for the
				// row's recording, so the other devices show the link (and their
				// bulk enrichment skips it) without crawling again
				// (sync-log/claim-links.ts). Fuzzy by nature (0.7); identity never
				// merges on either (identity.ts AUTO_MERGE_CLAIM_KINDS). The
				// traxsource kind is protocol v4: addClaims holds it back from a
				// v3 server and the claims reconcile states it later.
				if (source === 'beatport' || source === 'traxsource') addClaims(this.db, trackId, [{ kind: source, value: link.sourceTrackId, confidence: 0.7 }]);
			}
		}

		return applied;
	}
}

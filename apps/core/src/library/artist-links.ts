// Provider identities for artists. Spotify and Tidal hand us artist ids on
// every synced track (track.artists[].id); mapped through the artist table
// by identity key they give each artist a direct "Open in Spotify / Tidal"
// link. Beatport and Traxsource payloads carry names only, so those stay
// search links in the UI. Called from the sync loops (per track, cheap:
// INSERT OR IGNORE on the (source, id) key) and from the backfill.

import type Database from 'better-sqlite3';
import { artistKey } from '@curator/shared';
import type { Db } from '../db/client.js';
import { rawOf } from './artists.js';

type Raw = Database.Database;
export interface ProviderArtistRef { id?: string | number | null; name?: string | null; external_urls?: { spotify?: string } }

const STMTS = new WeakMap<Raw, { byKey: Database.Statement<[string], { id: string; merged_into: string | null }>; byId: Database.Statement<[string], { id: string; merged_into: string | null }>; ins: Database.Statement<[string, string, string, string | null]> }>();
function stmts(raw: Raw) {
	let s = STMTS.get(raw);
	if (!s) {
		s = {
			byKey: raw.prepare(`SELECT id, merged_into FROM artist WHERE name_ascii = ?`),
			byId: raw.prepare(`SELECT id, merged_into FROM artist WHERE id = ?`),
			ins: raw.prepare(`INSERT OR IGNORE INTO artist_link (artist_id, source, source_id, url) VALUES (?, ?, ?, ?)`),
		};
		STMTS.set(raw, s);
	}
	return s;
}

export function providerArtistUrl(source: string, id: string): string | null {
	switch (source) {
		case 'spotify': return `https://open.spotify.com/artist/${id}`;
		case 'tidal': return `https://tidal.com/browse/artist/${id}`;
		default: return null;
	}
}

// Returns how many link rows were inserted. Names that the library doesn't
// know as artists (a credit the splitter dropped, a feed-only artist) are
// skipped — a link needs an artist row to hang off.
export function upsertArtistLinksRaw(raw: Raw, source: string, refs: readonly ProviderArtistRef[]): number {
	const s = stmts(raw);
	let n = 0;
	for (const ref of refs) {
		if (ref?.id == null || !ref.name) continue;
		let row = s.byKey.get(artistKey(ref.name));
		for (let hops = 0; row?.merged_into && hops < 8; hops++) row = s.byId.get(row.merged_into);
		if (!row) continue;
		const id = String(ref.id);
		const url = ref.external_urls?.spotify ?? providerArtistUrl(source, id);
		n += s.ins.run(row.id, source, id, url).changes;
	}
	return n;
}

export function upsertArtistLinks(db: Db, source: string, refs: readonly ProviderArtistRef[]): number {
	return upsertArtistLinksRaw(rawOf(db), source, refs);
}

// Diacritic-insensitive search fold. The DIACRITIC rules here mirror
// @curator/matcher's `deaccent` — kept duplicated rather than
// cross-package-imported because matcher has no other dependency on shared
// and that edge would be one-way just for two regexes. If the diacritic
// rules change, update both.
//
// The connector-punctuation strip below is search-ONLY and intentionally
// does NOT live in matcher: matcher handles punctuation its own way
// (normalize() → space + whitespace-collapse + token scoring), so don't
// mirror that part.
//
// Used on BOTH sides of every user-facing text comparison so typing
// "Bohmer" matches a stored "Böhmer", "Kidso" matches "KIDSØ", etc.
// Stored on the `track` table as `*_ascii` shadow columns so the SQL
// pre-filter can hit them without a per-row function call.
//
// IMPORTANT: changing the fold rules invalidates every persisted `*_ascii`
// value. Bump FOLD_VERSION in apps/core/src/db/migrate.ts so the one-shot
// re-fold backfill re-runs over the whole library.

const COMBINING_DIACRITICS_RE = /[̀-ͯ]/g;

// Connector punctuation that's noise *inside* a token — stripped to nothing
// (not a space) so the surrounding characters fuse: "D.W.Y" ↔ "DWY",
// "Jay-Z" ↔ "jayz", "Don't" → "dont". Because the same fold runs on the
// needle and the stored text, the convergence is symmetric in both
// directions. Deliberately excludes:
//   - `&` — kept literal so "&ME" matches only "…&me…", not every "…me…".
//   - `/` — omnibar folder-path syntax (extractFolderSyntax in query.ts).
// Stripping `_` also defuses its LIKE single-char wildcard in the SQL
// pre-filter against the `*_ascii` columns.
const CONNECTOR_PUNCT_RE = /[._'‘’-]/g;

export function searchFold(s: string | null | undefined): string {
	if (!s) return '';
	return String(s)
		.normalize('NFD')
		.replace(COMBINING_DIACRITICS_RE, '')
		.replace(/ß/g, 'ss')
		.replace(/ø/gi, 'o')
		.replace(/æ/gi, 'ae')
		.replace(/œ/gi, 'oe')
		.replace(/ł/gi, 'l')
		.replace(CONNECTOR_PUNCT_RE, '')
		.toLowerCase();
}

// Artist IDENTITY key — searchFold with every space and remaining
// punctuation removed, `&` kept (searchFold keeps it literal for "&ME").
// "Pig & Dan" / "Pig&Dan", "Hunter/Game" / "Hunter_Game", "Ae:ther" /
// "Aether" are one artist; the audit of the live library (2026-09-21)
// found these spelling-only variants to be the one duplicate class with
// no false positives. artist.name_ascii stores this key; search folds the
// query the same way. Idempotent: artistKey(searchFold(x)) === artistKey(x).
export function artistKey(s: string | null | undefined): string {
	return searchFold(s).replace(/[^\p{L}\p{N}&]/gu, '');
}

// Folds the artists JSON array into the single TEXT column used by the SQL
// pre-filter (`artists_ascii`). Names joined by ' | ' so a LIKE substring
// search hits each name independently without splitting the column.
export function asciifyArtists(artists: ReadonlyArray<{ name?: string | null }> | null | undefined): string {
	if (!artists || artists.length === 0) return '';
	return artists
		.map((a) => searchFold(a?.name ?? ''))
		.filter(Boolean)
		.join(' | ');
}

type AsciifyExtra = {
	titleAscii?: string;
	albumTitleAscii?: string;
	labelAscii?: string;
	genreAscii?: string;
	artistsAscii?: string;
};

// Mirrors the searched text fields of a track patch onto their `*Ascii`
// shadow columns. Apply at EVERY `db.insert(track).values(...)` and
// `db.update(track).set(...)` site that may touch one of the searched
// fields. A patch that doesn't touch a field leaves the existing
// `*_ascii` column alone — no implicit clobber.
//
// Typed permissively (T extends object) so it accepts both strongly-typed
// NewTrack patches and the `Record<string, unknown>` patches built up
// dynamically by setTrackSourceLinks / clearTrackFields. Runtime
// `'field' in patch` checks guard the casts.
export function asciify<T extends object>(patch: T): T & AsciifyExtra {
	const p = patch as Record<string, unknown>;
	const out: T & AsciifyExtra = { ...patch };
	if ('title' in p) out.titleAscii = searchFold(p.title as string | null | undefined);
	if ('albumTitle' in p) out.albumTitleAscii = searchFold(p.albumTitle as string | null | undefined);
	if ('label' in p) out.labelAscii = searchFold(p.label as string | null | undefined);
	if ('genre' in p) out.genreAscii = searchFold(p.genre as string | null | undefined);
	if ('artists' in p) out.artistsAscii = asciifyArtists(p.artists as ReadonlyArray<{ name?: string | null }> | null | undefined);
	return out;
}

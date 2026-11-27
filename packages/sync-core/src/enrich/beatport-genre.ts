// Beatport's genre wins over every other source's: the catalogue's, a card's,
// a fallback store's. Beatport files a track at the depth a DJ sorts by
// ("Progressive House") where the other stores state the family ("House").
// Only the genre: a library track's BPM and key come from local analysis,
// which beats any store's.

import type { SourceLinkDraft } from './contract.js';
import type { FeedItemPayload } from '../feed/types.js';

// Beatport's genre for a track it matched, read off its source link.
export function beatportGenre(links: readonly SourceLinkDraft[] | null | undefined): string | null {
	const payload = links?.find((l) => l.source === 'beatport')?.payload as { genre?: unknown } | null | undefined;
	return typeof payload?.genre === 'string' && payload.genre ? payload.genre : null;
}

// A track Beatport matched takes its genre. Returns true when it changed it.
export function preferBeatportGenre(t: { genre?: string | null; sourceLinks?: SourceLinkDraft[] }): boolean {
	const g = beatportGenre(t.sourceLinks);
	if (!g || t.genre === g) return false;
	t.genre = g;
	return true;
}

// A whole card: a track item, or each of an album's tracks Beatport matched,
// takes Beatport's genre, and the album the commonest of its tracks' (a
// release carries one genre). `genre` is the album's Beatport genre, null
// when Beatport matched none of its tracks.
export function preferBeatportGenres(p: FeedItemPayload, isAlbum: boolean): { genre: string | null; changed: boolean } {
	if (!isAlbum) return { genre: null, changed: preferBeatportGenre(p) };
	let changed = false;
	const counts = new Map<string, number>();
	for (const t of p.tracks ?? []) {
		if (preferBeatportGenre(t)) changed = true;
		const g = beatportGenre(t.sourceLinks);
		if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
	}
	let genre: string | null = null;
	for (const [g, n] of counts) if (!genre || n > counts.get(genre)!) genre = g;
	if (genre && p.genre !== genre) { p.genre = genre; changed = true; }
	return { genre, changed };
}

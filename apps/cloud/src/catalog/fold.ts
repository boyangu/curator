// How an object's current attributes come from its facts.
//
// Static objects (recording, release) are enriched once: a field is taken
// while it is empty and kept after, whatever a later source says (that
// disagreement stays in catalog_fact, one row per source). Several sources
// answering in the same pass are ranked per field, because sources are good
// at different things: Beatport for DJ metadata, the streaming services for
// artwork, the catalogue databases for labels and catalogue numbers.
//
// Live objects (artist, label, playlist, ...) take each source's latest name
// and image in place; they are not history.

import type { CatalogFacts, CatalogProvider } from '@curator/protocol';

export type FactField = keyof CatalogFacts;

const DJ_META: CatalogProvider[] = ['curator', 'beatport', 'beatsource', 'traxsource', 'user', 'deezer', 'spotify', 'tidal', 'apple', 'musicbrainz', 'discogs'];
const STREAMING_FIRST: CatalogProvider[] = ['spotify', 'deezer', 'apple', 'tidal', 'beatport', 'beatsource', 'youtube', 'soundcloud', 'musicbrainz', 'discogs', 'traxsource', 'user', 'curator'];
const CATALOGUE_FIRST: CatalogProvider[] = ['beatport', 'discogs', 'musicbrainz', 'beatsource', 'spotify', 'deezer', 'apple', 'tidal', 'traxsource', 'youtube', 'soundcloud', 'user', 'curator'];
const DEFAULT: CatalogProvider[] = ['beatport', 'beatsource', 'spotify', 'deezer', 'apple', 'tidal', 'musicbrainz', 'discogs', 'traxsource', 'youtube', 'soundcloud', 'user', 'curator'];

// Which source wins a field when several answer at once.
export const FOLD_POLICY: Partial<Record<FactField, CatalogProvider[]>> = {
	bpm: DJ_META,
	key: DJ_META,
	coverUrl: STREAMING_FIRST,
	labelText: CATALOGUE_FIRST,
	catalogNumber: CATALOGUE_FIRST,
	country: ['musicbrainz', 'discogs', ...DEFAULT],
};

export type FactRow = { field: string; source: string; value: unknown };

function rank(field: string, source: string): number {
	const order = FOLD_POLICY[field as FactField] ?? DEFAULT;
	const i = order.indexOf(source as CatalogProvider);
	return i === -1 ? order.length : i;
}

// The attributes after folding `facts` into `current`: static objects only
// fill empty fields; live objects take the newest value of each field from
// the source that just spoke (`liveSource`).
export function foldAttrs(current: Record<string, unknown>, facts: FactRow[], opts: { live: boolean; liveSource?: string }): Record<string, unknown> {
	const next = { ...current };
	const sources = { ...((current._src as Record<string, string> | undefined) ?? {}) };
	const byField = new Map<string, FactRow[]>();
	for (const f of facts) {
		const list = byField.get(f.field) ?? [];
		list.push(f);
		byField.set(f.field, list);
	}
	for (const [field, rows] of byField) {
		if (opts.live && opts.liveSource) {
			const own = rows.find((r) => r.source === opts.liveSource);
			if (own) {
				next[field] = own.value;
				sources[field] = own.source;
				continue;
			}
		}
		if (next[field] !== undefined && next[field] !== null) continue;
		const best = [...rows].sort((a, b) => rank(field, a.source) - rank(field, b.source))[0]!;
		next[field] = best.value;
		sources[field] = best.source;
	}
	if (Object.keys(sources).length) next._src = sources;
	return next;
}

// '2026', '2026-10', '2026-10-23' → midnight UTC of the most precise day
// (the 1st for a month, 1 Jan for a year), or null.
export function releaseAtOf(date: string | undefined | null): number | null {
	if (!date) return null;
	const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
	if (!m) return null;
	const t = Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
	return Number.isFinite(t) ? t : null;
}

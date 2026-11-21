// World hits — the omnibar's World scope asks three places for one query
// (core entity/world-search.ts): the streaming service, the Global Catalog
// and the stores. Each answers when it can; this is how their answers become
// one list.
//
// Two hits are one thing when they share a key (an id either of them is
// known by): the artist Spotify found and the catalogue's object holding
// that Spotify page show as one row, opened by every id the two carry. A
// name alone merges nothing — two artists of one name are two rows.
//
// The parts are merged in a fixed order (streaming, catalogue, stores)
// whatever order they arrived in, so a late answer adds rows and details
// without reshuffling what is already on screen more than it must.
//
// Pure (types-only imports besides the fold): tested without a DOM.

import { searchFold, type EntityRef, type WorldHit, type WorldSearchPart, type WorldSearchResult } from '@curator/shared';

export const WORLD_PARTS: readonly WorldSearchPart[] = ['streaming', 'catalog', 'stores'];

const KIND_RANK: Record<WorldHit['kind'], number> = { artist: 0, label: 1, album: 2, track: 3 };

// The ids of both, the first one's where they differ.
function mergeRef(a: EntityRef, b: EntityRef): EntityRef {
	const out: EntityRef = { ...a };
	if (!out.catalogId && b.catalogId) out.catalogId = b.catalogId;
	if (!out.spotifyId && b.spotifyId) out.spotifyId = b.spotifyId;
	if (!out.libraryId && b.libraryId) out.libraryId = b.libraryId;
	return out;
}

// One list from what the parts answered so far: a hit per thing, a name that
// is exactly the query first, then artists, labels, albums, tracks — each in
// the order its source ranked it.
export function mergeWorldHits(parts: ReadonlyMap<WorldSearchPart, WorldSearchResult>, query: string): WorldHit[] {
	const out: WorldHit[] = [];
	const byKey = new Map<string, WorldHit>();
	for (const part of WORLD_PARTS) {
		for (const hit of parts.get(part)?.hits ?? []) {
			const known = hit.keys.map((k) => byKey.get(k)).find((h): h is WorldHit => !!h && h.kind === hit.kind);
			if (!known) {
				const own: WorldHit = { ...hit, keys: [...hit.keys], sources: [...hit.sources] };
				out.push(own);
				for (const k of own.keys) byKey.set(k, own);
				continue;
			}
			known.ref = mergeRef(known.ref, hit.ref);
			known.detail ??= hit.detail;
			known.imageUrl ??= hit.imageUrl;
			if (!known.recordingId && hit.recordingId) known.recordingId = hit.recordingId;
			for (const s of hit.sources) if (!known.sources.includes(s)) known.sources.push(s);
			for (const k of hit.keys) {
				if (!known.keys.includes(k)) known.keys.push(k);
				byKey.set(k, known);
			}
		}
	}
	const fold = searchFold(query).trim();
	const exact = (h: WorldHit): number => (fold && searchFold(h.name).trim() === fold ? 0 : 1);
	return out
		.map((h, i) => ({ h, i }))
		.sort((a, b) => exact(a.h) - exact(b.h) || KIND_RANK[a.h.kind] - KIND_RANK[b.h.kind] || a.i - b.i)
		.map((x) => x.h);
}

const SOURCE_NAMES: Record<string, string> = { spotify: 'Spotify', tidal: 'Tidal', catalog: 'Catalogue', beatport: 'Beatport', bandcamp: 'Bandcamp' };
export const worldSourceName = (s: string): string => SOURCE_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

// Where a hit was found, as the row's right-hand note.
export const worldSourcesText = (h: Pick<WorldHit, 'sources'>): string => h.sources.map(worldSourceName).join(' · ');

const PART_NAMES: Record<WorldSearchPart, string> = { streaming: 'your streaming service', catalog: 'the catalogue', stores: 'the stores' };

// What the list says under its rows: which parts are still out, and why a
// part has nothing to add when that is not "no matches". Null: nothing to say.
export function worldStatusText(parts: ReadonlyMap<WorldSearchPart, WorldSearchResult>, pending: ReadonlySet<WorldSearchPart>): string | null {
	const lines: string[] = [];
	const out = WORLD_PARTS.filter((p) => pending.has(p));
	if (out.length) lines.push(`Searching ${out.map((p) => PART_NAMES[p]).join(', ')}…`);
	const streaming = parts.get('streaming')?.note;
	if (streaming === 'not_connected') lines.push('Spotify is not available right now');
	else if (streaming === 'failed') lines.push('Spotify did not answer');
	const catalog = parts.get('catalog')?.note;
	if (catalog === 'signed_out') lines.push('Sign in to Curator Cloud to search the catalogue too');
	else if (catalog === 'unavailable' || catalog === 'failed') lines.push('The catalogue did not answer');
	if (parts.get('stores')?.note === 'failed') lines.push('The stores did not answer');
	return lines.length ? lines.join(' · ') : null;
}

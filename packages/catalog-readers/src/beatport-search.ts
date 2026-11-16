// Beatport's search pages and an artist's or label's release list, read as
// data (beatport-pages.ts): the candidates "Help us connect the dots" offers
// for an artist, a label or an album the catalogue has no Beatport page for,
// and the titles a candidate lists, to compare with the catalogue's own.
//
// The search queries hold flat rows named by their kind ("artist_id",
// "artist_name": the shape the label search and the desktop's track search
// already read); the plain `id` / `name` are taken too, since a page shape is
// Beatport's to change. One call per search, one per release list, under the
// same challenge park as every other page.

import type { FetchLike } from './http.js';
import { BEATPORT, fetchNextData, imageUrl, queryData, type BpImage, type BpPage, type BpReleaseRef } from './beatport-pages.js';

export type BeatportSearchKind = 'artist' | 'label' | 'release';
export type BeatportHit = { id: string; name: string; url: string; imageUrl: string | null; detail: string | null };

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const slugify = (name: string, fallback: string): string => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;

function image(row: Row, kind: BeatportSearchKind): string | null {
	const uri = text(row[`${kind}_image_uri`]) ?? text(row['image_uri']);
	if (uri) return uri;
	const dynamic = text(row[`${kind}_image_dynamic_uri`]);
	if (dynamic) return dynamic.replace('{w}x{h}', '500x500');
	return imageUrl(row['image'] as BpImage | undefined) ?? null;
}

// A release row's credit, label and date, as one line.
function releaseDetail(row: Row): string | null {
	const artists = Array.isArray(row['artists']) ? (row['artists'] as Row[]).map((a) => text(a['artist_name']) ?? text(a['name'])).filter((n): n is string => !!n) : [];
	const label = row['label'] && typeof row['label'] === 'object' ? (text((row['label'] as Row)['label_name']) ?? text((row['label'] as Row)['name'])) : null;
	const date = (text(row['release_date']) ?? text(row['new_release_date']) ?? '').slice(0, 10) || null;
	return [artists.slice(0, 4).join(', '), label, date].filter(Boolean).join(' · ') || null;
}

export async function searchBeatport(fetchFn: FetchLike, kind: BeatportSearchKind, q: string, signal?: AbortSignal): Promise<BeatportHit[]> {
	const data = await fetchNextData(fetchFn, `/search/${kind}s?q=${encodeURIComponent(q)}`, signal);
	const rows = queryData<{ data?: Row[] }>(data, (k) => k === `search-${kind}s`)?.data ?? [];
	const hits: BeatportHit[] = [];
	for (const row of rows) {
		const id = text(row[`${kind}_id`]) ?? text(row['id']);
		const name = text(row[`${kind}_name`]) ?? text(row['name']);
		if (!id || !/^\d+$/.test(id) || !name) continue;
		hits.push({ id, name, url: `${BEATPORT}/${kind}/${text(row['slug']) ?? slugify(name, kind)}/${id}`, imageUrl: image(row, kind), detail: kind === 'release' ? releaseDetail(row) : null });
	}
	return hits;
}

// The newest releases an artist's or a label's page lists (a page: 21 or so).
export async function beatportPageReleases(fetchFn: FetchLike, kind: 'artist' | 'label', id: string, signal?: AbortSignal): Promise<string[]> {
	const data = await fetchNextData(fetchFn, `/${kind}/${kind}/${encodeURIComponent(id)}/releases`, signal);
	return queryData<BpPage<BpReleaseRef>>(data, (k) => k.startsWith('releases'))?.results.map((r) => r.name) ?? [];
}

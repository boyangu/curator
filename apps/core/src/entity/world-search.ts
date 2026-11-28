// The omnibar's World scope: one query asked of the places that know music
// the library does not hold.
//
//   streaming   the user's streaming service's own search (entity/
//               streaming.ts): artists, albums and tracks, in one call. The
//               fastest answer, and the one a track plays from.
//   catalog     the Global Catalog: the artists, labels and releases it
//               holds whose name starts with the query. Slower, and the only
//               place that knows what a hit is across stores.
//   stores      the stores' own search, for what a streaming service does
//               not file: labels, at Beatport.
//
// Each part is asked by itself (the renderer shows the first answer without
// waiting for the last, and merges the rest in as they land), so a part that
// is slow, signed out or blocked costs the others nothing. Hits name what
// they are by every id they carry (`keys`): the same artist found on the
// streaming service and in the catalogue is one row.
//
// Read-only: nothing here registers anything. Opening a hit is an ordinary
// entity page, and that is where an unknown artist or album is shown from
// the streaming service and registered (entity/service.ts, entity/work.ts).

import type { CatalogObjectSummary, CatalogPageRelease, CatalogRef, CatalogTracksResult } from '@curator/protocol';
import { searchBeatport, type FetchLike } from '@curator/catalog-readers';
import { searchFold, type EntityTracksPage, type WorldHit, type WorldSearchPart, type WorldSearchResult } from '@curator/shared';
import type { CatalogClient } from '../catalog-client/service.js';
import { log } from '@curator/sync-core/log';
import { provisionalRelease, streamObjectId, type StreamingCatalog } from '@curator/catalog-work';

const slog = log.for('world-search');

const MIN_CHARS = 2;
const ARTISTS_MAX = 5;
const ALBUMS_MAX = 5;
const TRACKS_MAX = 8;
const CATALOG_PER_KIND = 5;
const STORE_LABELS_MAX = 5;
const STORE_TIMEOUT_MS = 15_000;
const TTL_MS = 2 * 60_000;
const HELD = 90;

export type WorldSearchDeps = {
	streaming(): StreamingCatalog | null;
	catalog(): Pick<CatalogClient, 'status' | 'find' | 'resolve'> | null;
	// Releases in the catalogue's page shape as World rows (entity/service.ts rows()).
	rows(result: CatalogTracksResult): EntityTracksPage;
	fetch?: FetchLike;
	// Electron's net.fetch for Beatport; plain fetch otherwise.
	beatportFetch?: FetchLike;
	now?: () => number;
};

export interface WorldSearch {
	search(query: string, part: WorldSearchPart): Promise<WorldSearchResult>;
}

// A store's own id for the object: not a reader's name key.
const ownId = (h: { provider: string; id: string }): boolean => h.provider !== 'user' && !h.id.includes('/');

const year = (date: string | null): string | null => (date && /^\d{4}/.test(date) ? date.slice(0, 4) : null);
const line = (...parts: (string | null | undefined)[]): string | null => parts.filter(Boolean).join(' · ') || null;

export function createWorldSearch(deps: WorldSearchDeps): WorldSearch {
	const now = deps.now ?? Date.now;
	const held = new Map<string, { at: number; result: Promise<WorldSearchResult> }>();

	async function streaming(q: string): Promise<WorldSearchResult> {
		const stream = deps.streaming();
		if (!stream) return { part: 'streaming', hits: [], note: 'not_connected' };
		const found = await stream.search(q);
		const service = stream.service;
		const ref = (kind: 'artist' | 'album', name: string, id: string) => ({ kind, name, ...(service === 'spotify' ? { spotifyId: id } : {}) });
		const hits: WorldHit[] = [];
		for (const a of found.filter((h) => h.kind === 'artist').slice(0, ARTISTS_MAX)) {
			hits.push({ kind: 'artist', name: a.name, detail: a.detail, imageUrl: a.imageUrl, ref: ref('artist', a.name, a.id), keys: [`${service}:artist:${a.id}`], sources: [service] });
		}
		for (const a of found.filter((h) => h.kind === 'album').slice(0, ALBUMS_MAX)) {
			hits.push({ kind: 'album', name: a.name, detail: line(a.artists.map((x) => x.name).join(', '), year(a.date)), imageUrl: a.imageUrl, ref: ref('album', a.name, a.id), keys: [`${service}:release:${a.id}`], sources: [service] });
		}
		const tracks = found.filter((h) => h.kind === 'track' && h.release && h.album).slice(0, TRACKS_MAX);
		const releases: CatalogPageRelease[] = [];
		for (const t of tracks) {
			const release = provisionalRelease(t.release!);
			releases.push(release);
			hits.push({
				kind: 'track',
				name: t.name,
				detail: line(t.artists.map((x) => x.name).join(', '), t.album!.name),
				imageUrl: t.imageUrl,
				ref: ref('album', t.album!.name, t.album!.id),
				keys: [`${service}:recording:${t.id}`],
				sources: [service],
				recordingId: streamObjectId(service, t.id),
			});
		}
		const rows = releases.length ? deps.rows({ object: { id: streamObjectId(service, 'search'), kind: 'release', name: q }, redirectedFrom: null, releases, nextCursor: null }) : undefined;
		return { part: 'streaming', hits, ...(rows ? { rows } : {}) };
	}

	const KIND_OF: Record<'artist' | 'label' | 'release', WorldHit['kind']> = { artist: 'artist', label: 'label', release: 'album' };

	function catalogHit(o: CatalogObjectSummary): WorldHit | null {
		if (o.kind !== 'artist' && o.kind !== 'label' && o.kind !== 'release') return null;
		const kind = KIND_OF[o.kind];
		const spotify = o.handles.find((h) => h.provider === 'spotify' && ownId(h))?.id;
		return {
			kind,
			name: o.name,
			detail: null,
			imageUrl: o.coverUrl,
			ref: { kind: kind as 'artist' | 'label' | 'album', name: o.name, catalogId: o.id, ...(spotify && kind !== 'label' ? { spotifyId: spotify } : {}) },
			keys: [`catalog:${o.id}`, ...o.handles.filter(ownId).map((h) => `${h.provider}:${o.kind}:${h.id}`)],
			sources: ['catalog'],
		};
	}

	async function catalog(q: string): Promise<WorldSearchResult> {
		const client = deps.catalog();
		if (!client) return { part: 'catalog', hits: [], note: 'signed_out' };
		const s = client.status();
		if (!s.available) return { part: 'catalog', hits: [], note: s.reason === 'signed_out' ? 'signed_out' : 'unavailable' };
		// One ask per kind: without one the catalogue's recordings, the most
		// numerous by far, would fill the answer.
		const asked = await Promise.allSettled((['artist', 'label', 'release'] as const).map((kind) => client.find(q, kind, CATALOG_PER_KIND)));
		if (asked.every((r) => r.status === 'rejected')) throw (asked[0] as PromiseRejectedResult).reason;
		const hits = asked.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).map(catalogHit).filter((h): h is WorldHit => h !== null);
		return { part: 'catalog', hits };
	}

	async function stores(q: string): Promise<WorldSearchResult> {
		const found = (await searchBeatport(deps.beatportFetch ?? deps.fetch ?? ((u, i) => fetch(u, i)), 'label', q, AbortSignal.timeout(STORE_TIMEOUT_MS))).slice(0, STORE_LABELS_MAX);
		// The catalogue's object for a label it already holds this page of.
		const client = deps.catalog();
		let known: (CatalogObjectSummary | null)[] = [];
		if (found.length && client?.status().available) {
			const refs: CatalogRef[] = found.map((h) => ({ provider: 'beatport', kind: 'label', providerId: h.id }));
			known = await client.resolve(refs).catch(() => []);
		}
		const hits: WorldHit[] = found.map((h, i) => {
			const object = known[i] ?? null;
			return {
				kind: 'label',
				name: h.name,
				detail: null,
				imageUrl: h.imageUrl,
				ref: { kind: 'label', name: object?.name ?? h.name, ...(object ? { catalogId: object.id } : {}) },
				keys: [`beatport:label:${h.id}`, ...(object ? [`catalog:${object.id}`] : [])],
				sources: ['beatport'],
			};
		});
		return { part: 'stores', hits };
	}

	const PARTS: Record<WorldSearchPart, (q: string) => Promise<WorldSearchResult>> = { streaming, catalog, stores };

	return {
		search(query, part) {
			const q = query.trim();
			if (q.length < MIN_CHARS || !PARTS[part]) return Promise.resolve({ part, hits: [] });
			const key = `${part}|${searchFold(q)}`;
			const hit = held.get(key);
			if (hit && now() - hit.at < TTL_MS) return hit.result;
			const result = PARTS[part](q).catch((e: unknown): WorldSearchResult => {
				// Not an answer: asked again by the next keystroke that lands here.
				held.delete(key);
				slog.info('a world search part did not answer', { part, error: e instanceof Error ? e.message : String(e) });
				return { part, hits: [], note: 'failed' };
			});
			// "Not connected" is true until it is not: never kept.
			void result.then((r) => { if (r.note && held.get(key)?.result === result) held.delete(key); });
			held.set(key, { at: now(), result });
			while (held.size > HELD) held.delete(held.keys().next().value!);
			return result;
		},
	};
}

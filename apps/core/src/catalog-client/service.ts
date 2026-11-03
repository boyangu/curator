// The desktop's side of the Global Catalog's watches ('global_catalog'): what
// the Following panel in Discover calls (apps/desktop renderer
// FollowingPanel.tsx). The cloud holds the watches and does the tracking;
// this module turns what the user typed or pasted into catalogue claims, and
// imports the artists the user already follows on Spotify.
//
// Lookups that need a provider run here, on public endpoints: Spotify's
// oEmbed names an artist from its link without any token, Deezer's API is
// open, and a name search uses the user's own Spotify connection when there is
// one. A label is followed by name (no provider we can reach has label ids
// yet): the claim is the user's statement, and the cloud's Deezer label tracker
// works by name.

import { createHash } from 'node:crypto';
import type { CatalogBrowseResult, CatalogClaim, CatalogKind, CatalogObjectSummary, CatalogRef, CatalogWatch, CatalogWatchSource, CloudService } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { SpotifyClient } from '@curator/spotify';
import { log } from '../log.js';

const clog = log.for('catalog');

export type CatalogClientStatus = { available: boolean; reason: 'ok' | 'signed_out' | 'server_off' };

// One row of the panel's search: an object the catalogue already holds, or a
// provider's candidate not yet in it (followed by its claim).
export type CatalogSearchHit = {
	key: string;
	kind: CatalogKind;
	name: string;
	imageUrl: string | null;
	providers: string[];
	objectId: string | null;
	claim: CatalogClaim | null;
	watchCount: number;
	watched: boolean;
};

export type CatalogFollowTarget = { objectId: string } | { claim: CatalogClaim } | { url: string } | { labelName: string } | { genreName: string };

export type CatalogFollowManyReport = { followed: number; already: number; failed: { name: string; error: string }[] };
export type CatalogEnrichReport = { labels: number; registered: number; queued: number };

export type CatalogImportReport = { found: number; created: number; watched: number; existing: number };

export interface CatalogClient {
	status(): CatalogClientStatus;
	watches(): Promise<CatalogWatch[]>;
	search(q: string): Promise<CatalogSearchHit[]>;
	follow(target: CatalogFollowTarget): Promise<CatalogWatch>;
	unfollow(objectId: string): Promise<void>;
	mute(objectId: string, muted: boolean): Promise<void>;
	refresh(objectId: string): Promise<{ dueAt: number | null }>;
	importSpotifyFollows(): Promise<CatalogImportReport>;
	// Many follows at once (the Manage following modal): claims and labels go
	// up as batched imports, genres one by one (each resolves to the
	// catalogue's genre object).
	followMany(targets: CatalogFollowTarget[]): Promise<CatalogFollowManyReport>;
	// Claims followed in content-keyed batches of 200 (a repeat of the same
	// batch is answered from the cloud's record, not redone).
	importClaims(claims: CatalogClaim[], source: CatalogWatchSource): Promise<CatalogImportReport>;
	enrichLabels(names: string[]): Promise<CatalogEnrichReport>;
	// The catalogue's objects for provider refs, in order (null: none), at
	// most 50 a call (catalog-refs.ts pages them).
	resolve(refs: CatalogRef[]): Promise<(CatalogObjectSummary | null)[]>;
	// An object with what hangs off it: a label's or an artist's releases, a
	// release's tracks, each with its store handles.
	browse(objectId: string): Promise<CatalogBrowseResult>;
}

// A label followed by name: one shared object per folded name, so everyone
// who follows "Innervisions" by name follows the same label.
export function labelClaim(name: string): CatalogClaim {
	const fold = nameFold(name);
	if (!fold) throw new CatalogInputError('Type the label name.');
	return { provider: 'user', kind: 'label', providerId: `name:${fold}`, name: name.trim() };
}

export type CatalogClientDeps = {
	catalog: CloudService['catalog'];
	signedIn: () => boolean;
	serverOffers: () => boolean;
	deviceId: () => string;
	spotifyToken: () => Promise<string | null>;
	fetch?: typeof fetch;
};

export class CatalogUnavailableError extends Error {
	override readonly name = 'CatalogUnavailableError';
}

export class CatalogInputError extends Error {
	override readonly name = 'CatalogInputError';
}

type ParsedLink = { provider: 'spotify' | 'deezer' | 'beatport' | 'bandcamp'; kind: 'artist' | 'playlist' | 'label'; id: string; url: string; slug?: string };

// "northfold-records" → "Northfold Records": the name a label link gives until
// the catalogue's own lookups say better (the label's tracker refreshes it).
const titleFromSlug = (slug: string): string =>
	slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');

// Spotify (open.spotify.com/[intl-xx/]artist/<id>, spotify:artist:<id>) and
// Deezer (deezer.com/[xx/]artist/<id>) artist and playlist links.
export function parseProviderLink(input: string): ParsedLink | null {
	const s = input.trim();
	const uri = /^spotify:(artist|playlist):([A-Za-z0-9]{22})$/.exec(s);
	if (uri) return { provider: 'spotify', kind: uri[1] as ParsedLink['kind'], id: uri[2]!, url: `https://open.spotify.com/${uri[1]}/${uri[2]}` };
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return null;
	}
	const host = u.hostname.replace(/^www\./, '');
	const parts = u.pathname.split('/').filter(Boolean);
	if (host === 'open.spotify.com') {
		const at = parts.findIndex((p) => p === 'artist' || p === 'playlist');
		const id = at >= 0 ? parts[at + 1] : undefined;
		if (id && /^[A-Za-z0-9]{22}$/.test(id)) return { provider: 'spotify', kind: parts[at] as ParsedLink['kind'], id, url: `https://open.spotify.com/${parts[at]}/${id}` };
	}
	if (host === 'deezer.com') {
		const at = parts.findIndex((p) => p === 'artist' || p === 'playlist');
		const id = at >= 0 ? parts[at + 1] : undefined;
		if (id && /^\d+$/.test(id)) return { provider: 'deezer', kind: parts[at] as ParsedLink['kind'], id, url: `https://www.deezer.com/${parts[at]}/${id}` };
	}
	// A label by its Beatport or Bandcamp page: the catalogue profiles it from there.
	if (host === 'beatport.com' && parts[0] === 'label' && parts[2] && /^\d+$/.test(parts[2])) {
		return { provider: 'beatport', kind: 'label', id: parts[2], url: `https://www.beatport.com/label/${parts[1]}/${parts[2]}`, slug: parts[1] };
	}
	if (host.endsWith('.bandcamp.com')) {
		const sub = host.slice(0, -'.bandcamp.com'.length);
		if (sub && !sub.includes('.')) return { provider: 'bandcamp', kind: 'label', id: sub, url: `https://${sub}.bandcamp.com`, slug: sub };
	}
	return null;
}

export function createCatalogClient(deps: CatalogClientDeps): CatalogClient {
	const fetchFn = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));

	const status = (): CatalogClientStatus => {
		if (!deps.signedIn()) return { available: false, reason: 'signed_out' };
		if (!deps.serverOffers()) return { available: false, reason: 'server_off' };
		return { available: true, reason: 'ok' };
	};
	const ready = () => {
		const s = status();
		if (!s.available) throw new CatalogUnavailableError(s.reason === 'signed_out' ? 'Sign in to Curator Cloud to follow artists and labels.' : 'The sync server does not offer Following yet.');
	};
	const deviceId = () => deps.deviceId();

	// The account's watches, held for a minute: thousands of them make a
	// megabytes-large answer, and the feed's unfollow/mute lookups, the
	// playlist handover and the panel all ask for it. This device's own
	// changes drop the copy; another device's show within the minute.
	const WATCHES_TTL_MS = 60_000;
	let watchesCache: { at: number; list: Promise<CatalogWatch[]> } | null = null;
	const listWatches = (): Promise<CatalogWatch[]> => {
		if (watchesCache && Date.now() - watchesCache.at < WATCHES_TTL_MS) return watchesCache.list;
		const list = deps.catalog.listWatches({ deviceId: deviceId() });
		watchesCache = { at: Date.now(), list };
		list.catch(() => { if (watchesCache?.list === list) watchesCache = null; });
		return list;
	};
	const changed = <T>(p: Promise<T>): Promise<T> => p.finally(() => { watchesCache = null; });

	async function getJson<T>(url: string): Promise<T | null> {
		try {
			const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
			return res.ok ? ((await res.json()) as T) : null;
		} catch (e) {
			clog.warn('provider lookup failed', { host: new URL(url).hostname }, e);
			return null;
		}
	}

	// A link's object as a claim, named by the provider.
	async function claimForLink(link: ParsedLink): Promise<CatalogClaim> {
		if (link.kind === 'playlist') throw new CatalogInputError('Following playlists comes in the next step; artists and labels work now.');
		if (link.kind === 'label') return { provider: link.provider, kind: 'label', providerId: link.id, name: titleFromSlug(link.slug ?? link.id), url: link.url };
		if (link.provider === 'spotify') {
			const o = await getJson<{ title?: string; thumbnail_url?: string }>(`https://open.spotify.com/oembed?url=${encodeURIComponent(link.url)}`);
			if (!o?.title) throw new CatalogInputError('Spotify did not recognise that link.');
			return { provider: 'spotify', kind: 'artist', providerId: link.id, name: o.title, url: link.url, ...(o.thumbnail_url ? { facts: { coverUrl: o.thumbnail_url } } : {}) };
		}
		const a = await getJson<{ id?: number; name?: string; picture_xl?: string; error?: unknown }>(`https://api.deezer.com/artist/${link.id}`);
		if (!a?.name || a.error) throw new CatalogInputError('Deezer did not recognise that link.');
		return { provider: 'deezer', kind: 'artist', providerId: link.id, name: a.name, url: link.url, ...(a.picture_xl ? { facts: { coverUrl: a.picture_xl } } : {}) };
	}

	async function providerArtists(q: string): Promise<CatalogSearchHit[]> {
		const hits: CatalogSearchHit[] = [];
		const token = await deps.spotifyToken().catch(() => null);
		if (token) {
			try {
				for (const a of await new SpotifyClient(token, 'catalog:search').searchArtists(q, 10)) {
					hits.push({
						key: `spotify:${a.id}`,
						kind: 'artist',
						name: a.name,
						imageUrl: a.images?.[0]?.url ?? null,
						providers: ['spotify'],
						objectId: null,
						claim: { provider: 'spotify', kind: 'artist', providerId: a.id, name: a.name, url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`, ...(a.images?.[0]?.url ? { facts: { coverUrl: a.images[0].url } } : {}) },
						watchCount: 0,
						watched: false,
					});
				}
			} catch (e) {
				clog.warn('spotify artist search failed', undefined, e);
			}
		}
		const dz = await getJson<{ data?: { id: number; name: string; picture_xl?: string; link?: string }[] }>(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=8`);
		for (const a of dz?.data ?? []) {
			hits.push({
				key: `deezer:${a.id}`,
				kind: 'artist',
				name: a.name,
				imageUrl: a.picture_xl ?? null,
				providers: ['deezer'],
				objectId: null,
				claim: { provider: 'deezer', kind: 'artist', providerId: String(a.id), name: a.name, url: a.link ?? `https://www.deezer.com/artist/${a.id}`, ...(a.picture_xl ? { facts: { coverUrl: a.picture_xl } } : {}) },
				watchCount: 0,
				watched: false,
			});
		}
		return hits;
	}

	async function importClaims(claims: CatalogClaim[], source: CatalogWatchSource): Promise<CatalogImportReport> {
		const report: CatalogImportReport = { found: claims.length, created: 0, watched: 0, existing: 0 };
		for (let i = 0; i < claims.length; i += 200) {
			const batch = claims.slice(i, i + 200);
			const key = `import:${source}:${createHash('sha256').update(batch.map((c) => `${c.provider}:${c.kind}:${c.providerId}`).join(',')).digest('hex').slice(0, 32)}`;
			const r = await deps.catalog.import({ deviceId: deviceId(), idempotencyKey: key, source, claims: batch });
			report.created += r.created;
			report.watched += r.watched;
			report.existing += r.existing;
		}
		return report;
	}

	// The catalogue's genre (Beatport's taxonomy) whose name is this one.
	async function genreObject(name: string): Promise<string> {
		const fold = nameFold(name);
		const r = await deps.catalog.search({ deviceId: deviceId(), q: name, kind: 'genre', limit: 10 });
		const hit = r.objects.find((o) => nameFold(o.name) === fold);
		if (!hit) throw new CatalogInputError(`“${name}” is not one of the catalogue's genres`);
		return hit.id;
	}

	const fromSummary = (o: CatalogObjectSummary, watched: Set<string>): CatalogSearchHit => ({
		key: `catalog:${o.id}`,
		kind: o.kind,
		name: o.name,
		imageUrl: o.coverUrl,
		providers: [...new Set(o.handles.map((h) => h.provider))],
		objectId: o.id,
		claim: null,
		watchCount: o.watchCount,
		watched: watched.has(o.id),
	});

	return {
		status,

		async watches() {
			ready();
			return listWatches();
		},

		// The catalogue's own artists and labels first (most watched first),
		// then provider candidates it does not hold yet. A provider candidate
		// whose id the catalogue already knows is shown once, as the object.
		async search(q) {
			ready();
			const query = q.trim();
			if (!query) return [];
			const watched = new Set((await listWatches()).map((w) => w.object.id));
			const [artists, labels] = await Promise.all([
				deps.catalog.search({ deviceId: deviceId(), q: query, kind: 'artist', limit: 10 }),
				deps.catalog.search({ deviceId: deviceId(), q: query, kind: 'label', limit: 5 }),
			]);
			const known = [...artists.objects, ...labels.objects];
			const knownHandles = new Set(known.flatMap((o) => o.handles.map((h) => `${h.provider}:${h.id}`)));
			const fresh = (await providerArtists(query)).filter((h) => !knownHandles.has(h.key));
			return [...known.map((o) => fromSummary(o, watched)), ...fresh];
		},

		follow(target) {
			return changed(follow(target));
		},

		followMany(targets) {
			return changed(followMany(targets));
		},

		async unfollow(objectId) {
			ready();
			await changed(deps.catalog.unwatch({ deviceId: deviceId(), objectId }));
		},

		async mute(objectId, muted) {
			ready();
			await changed(deps.catalog.mute({ deviceId: deviceId(), objectId, muted }));
		},

		async refresh(objectId) {
			ready();
			return deps.catalog.refreshNow({ deviceId: deviceId(), objectId });
		},

		// The artists the user follows on Spotify, as watches. Batches of 200
		// keyed by their content, so re-running the import after a few new
		// follows sends only what changed (the cloud answers repeats from its
		// record).
		async importSpotifyFollows() {
			ready();
			const token = await deps.spotifyToken();
			if (!token) throw new CatalogInputError('Connect Spotify first: the import reads the artists you follow there.');
			const artists = await new SpotifyClient(token, 'catalog:import').getFollowedArtists();
			const claims: CatalogClaim[] = artists.map((a) => ({
				provider: 'spotify',
				kind: 'artist',
				providerId: a.id,
				name: a.name,
				url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
				...(a.images?.[0]?.url ? { facts: { coverUrl: a.images[0].url } } : {}),
			}));
			const report = await changed(importClaims(claims, 'imported'));
			clog.info('spotify follows imported', report);
			return report;
		},

		importClaims(claims, source) {
			ready();
			return changed(importClaims(claims, source));
		},

		async resolve(refs) {
			ready();
			const out: (CatalogObjectSummary | null)[] = [];
			for (let i = 0; i < refs.length; i += 50) out.push(...(await deps.catalog.resolve({ deviceId: deviceId(), refs: refs.slice(i, i + 50) })).objects);
			return out;
		},

		browse(objectId) {
			ready();
			return deps.catalog.browse({ deviceId: deviceId(), id: objectId });
		},

		// The library's labels, registered with the catalogue by name (no
		// watch) and handed to its profiler and backfill: the shared catalogue
		// learns every label this DJ plays, whoever follows it later.
		async enrichLabels(names) {
			ready();
			const report: CatalogEnrichReport = { labels: names.length, registered: 0, queued: 0 };
			const ids: string[] = [];
			const claims = [...new Set(names.map((n) => n.trim()).filter(Boolean))].map(labelClaim);
			for (let i = 0; i < claims.length; i += 200) {
				const batch = claims.slice(i, i + 200);
				const key = `enrich:${createHash('sha256').update(batch.map((c) => c.providerId).join(',')).digest('hex').slice(0, 32)}`;
				const r = await deps.catalog.ingest({ deviceId: deviceId(), reason: 'library_import', idempotencyKey: key, claims: batch });
				for (const o of r.results) if ('objectId' in o) ids.push(o.objectId);
				report.registered += r.created;
			}
			for (let i = 0; i < ids.length; i += 200) {
				report.queued += (await deps.catalog.enrich({ deviceId: deviceId(), objectIds: ids.slice(i, i + 200) })).queued;
			}
			clog.info('library labels sent to the catalogue', report);
			return report;
		},
	};

	async function follow(target: CatalogFollowTarget): Promise<CatalogWatch> {
		ready();
		if ('objectId' in target) return (await deps.catalog.watch({ deviceId: deviceId(), objectId: target.objectId, source: 'manual' })).watch;
		let claim: CatalogClaim;
		if ('claim' in target) claim = target.claim;
		else if ('url' in target) {
			const link = parseProviderLink(target.url);
			if (!link) throw new CatalogInputError('Paste a Spotify or Deezer artist link, a Beatport or Bandcamp label page, or type a name.');
			claim = await claimForLink(link);
		} else if ('genreName' in target) {
			return (await deps.catalog.watch({ deviceId: deviceId(), objectId: await genreObject(target.genreName), source: 'manual' })).watch;
		} else claim = labelClaim(target.labelName);
		return (await deps.catalog.watch({ deviceId: deviceId(), claim, source: 'manual' })).watch;
	}

	async function followMany(targets: readonly CatalogFollowTarget[]): Promise<CatalogFollowManyReport> {
		ready();
		const report: CatalogFollowManyReport = { followed: 0, already: 0, failed: [] };
		const claims: CatalogClaim[] = [];
		for (const t of targets) {
			if ('claim' in t) claims.push(t.claim);
			else if ('labelName' in t) claims.push(labelClaim(t.labelName));
		}
		for (let i = 0; i < claims.length; i += 200) {
			const batch = claims.slice(i, i + 200);
			const key = `follow-many:${createHash('sha256').update(batch.map((c) => `${c.provider}:${c.kind}:${c.providerId}`).join(',')).digest('hex').slice(0, 32)}`;
			const r = await deps.catalog.import({ deviceId: deviceId(), idempotencyKey: key, source: 'manual', claims: batch });
			report.followed += r.watched;
			report.already += batch.length - r.watched - r.rejected;
			if (r.rejected) report.failed.push({ name: `${r.rejected} item${r.rejected === 1 ? '' : 's'}`, error: 'refused by the catalogue' });
		}
		for (const t of targets) {
			if (!('genreName' in t) && !('objectId' in t)) continue;
			const name = 'genreName' in t ? t.genreName : t.objectId;
			try {
				const objectId = 'genreName' in t ? await genreObject(t.genreName) : t.objectId;
				await deps.catalog.watch({ deviceId: deviceId(), objectId, source: 'manual' });
				report.followed++;
			} catch (e) {
				report.failed.push({ name, error: e instanceof Error ? e.message : String(e) });
			}
		}
		return report;
	}
}

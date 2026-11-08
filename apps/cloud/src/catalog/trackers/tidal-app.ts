// Tidal through the app's own credentials (client-credentials grant against
// openapi.tidal.com v2): the catalogue's lookups by identifier, for the
// store linker (../store-links.ts). An album by its barcode, a track by its
// ISRC; both are indexes, not searches, so a hit is the object itself.
//
// What the app token gets: titles, ISRCs, lengths, release dates and the
// tidal.com links. Not BPM or key — the fields exist on the resource type
// (the desktop's user-token client reads them) but every request shape
// tried on 2026-10-28 came back without them. Not genres either.
//
// Not the desktop's @curator/providers-tidal client: the cloud may import
// only the contract packages (scripts/check-package-boundaries.mjs), and the
// few calls here do not need it.

import type { CatalogClaim } from '@curator/protocol';
import { getJson, type FetchLike } from '@curator/catalog-readers';

const API = 'https://openapi.tidal.com/v2';

export type TidalAppCredentials = { clientId: string; clientSecret: string };

type Resource = { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id: string; type: string; meta?: Record<string, unknown> }[] | { id: string; type: string } }> };
type Doc = { data?: Resource | Resource[]; included?: Resource[] };

// "PT3M56S" → 236; Tidal's lengths are ISO 8601 durations.
export function isoSeconds(d: unknown): number | undefined {
	const m = typeof d === 'string' && /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d);
	if (!m) return undefined;
	return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const link = (a: Record<string, unknown> | undefined, kind: string, id: string): string => {
	const links = a?.externalLinks as { href?: string }[] | undefined;
	return links?.find((l) => l.href)?.href ?? `https://tidal.com/browse/${kind}/${id}`;
};

export class TidalApp {
	private token: { value: string; expiresAt: number } | null = null;

	constructor(
		private readonly creds: TidalAppCredentials,
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
		// A market the catalogue's labels publish in; the id and links are the same everywhere.
		private readonly country = 'DE',
	) {}

	async accessToken(signal?: AbortSignal): Promise<string> {
		if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
		const res = await this.fetchFn('https://auth.tidal.com/v1/oauth2/token', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: `Basic ${Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64')}`,
			},
			body: 'grant_type=client_credentials',
			signal,
		});
		if (!res.ok) throw new Error(`tidal token ${res.status}`);
		const j = (await res.json()) as { access_token: string; expires_in: number };
		this.token = { value: j.access_token, expiresAt: this.now() + j.expires_in * 1000 };
		return j.access_token;
	}

	private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Doc> {
		const token = await this.accessToken(signal);
		const qs = new URLSearchParams({ countryCode: this.country, ...params }).toString();
		return getJson<Doc>(this.fetchFn, 'tidal', `${API}${path}?${qs}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.api+json' }, signal, logPath: path });
	}

	// The album with that barcode, with its tracks (ISRCs, lengths) and artists.
	async albumByUpc(upc: string, signal?: AbortSignal): Promise<CatalogClaim | null> {
		const doc = await this.get('/albums', { 'filter[barcodeId]': upc, include: 'items,artists' }, signal);
		const album = (Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []).find((r) => r.type === 'albums');
		if (!album) return null;
		const included = new Map((doc.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
		const a = album.attributes ?? {};
		const artistRefs = album.relationships?.artists?.data;
		const artists = (Array.isArray(artistRefs) ? artistRefs : []).map((ref) => included.get(`artists:${ref.id}`)).filter((r): r is Resource => !!r);
		const itemRefs = album.relationships?.items?.data;
		const items = (Array.isArray(itemRefs) ? itemRefs : []).map((ref, i) => ({ res: included.get(`tracks:${ref.id}`), pos: Number(ref.meta?.trackNumber ?? i + 1) })).filter((x): x is { res: Resource; pos: number } => !!x.res);
		const date = str(a.releaseDate);
		return {
			provider: 'tidal',
			kind: 'release',
			providerId: album.id,
			name: str(a.title) ?? '',
			url: link(a, 'album', album.id),
			identifiers: [{ namespace: 'upc', value: str(a.barcodeId) ?? upc }],
			facts: {
				...(date ? { releaseDate: date } : {}),
				...(typeof a.numberOfItems === 'number' ? { trackCount: a.numberOfItems } : {}),
			},
			artists: artistClaims(artists),
			recordings: items.map(({ res, pos }) => trackClaim(res, pos, included)),
		};
	}

	// The track with that ISRC (the first when a market lists several copies).
	async trackByIsrc(isrc: string, signal?: AbortSignal): Promise<CatalogClaim | null> {
		const doc = await this.get('/tracks', { 'filter[isrc]': isrc, include: 'artists' }, signal);
		const track = (Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []).find((r) => r.type === 'tracks');
		if (!track) return null;
		const included = new Map((doc.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
		return trackClaim(track, undefined, included);
	}
}

// Tidal files compilations under an "artist" of that name: not an act.
const VARIOUS = /^various artists$/i;

function artistClaims(refs: Resource[]): CatalogClaim[] {
	return refs
		.filter((r) => !VARIOUS.test(str(r.attributes?.name) ?? ''))
		.map((r) => ({ provider: 'tidal' as const, kind: 'artist' as const, providerId: r.id, name: str(r.attributes?.name) ?? '', url: link(r.attributes, 'artist', r.id) }));
}

function trackClaim(r: Resource, pos: number | undefined, included: Map<string, Resource>): CatalogClaim {
	const a = r.attributes ?? {};
	const version = str(a.version);
	const refs = r.relationships?.artists?.data;
	const artists = (Array.isArray(refs) ? refs : []).map((ref) => included.get(`artists:${ref.id}`)).filter((x): x is Resource => !!x);
	const len = isoSeconds(a.duration);
	const isrc = str(a.isrc);
	return {
		provider: 'tidal',
		kind: 'recording',
		providerId: r.id,
		// Tidal keeps the mix apart from the title; the catalogue's titles carry it.
		name: version ? `${str(a.title) ?? ''} (${version})` : (str(a.title) ?? ''),
		url: link(a, 'track', r.id),
		identifiers: isrc ? [{ namespace: 'isrc', value: isrc }] : [],
		facts: { ...(len !== undefined ? { durationSec: len } : {}), ...(pos !== undefined ? { trackNumber: pos } : {}) },
		...(artistClaims(artists).length ? { artists: artistClaims(artists) } : {}),
	};
}

// Bandcamp, through the JSON its own apps read (CURATOR_FEED_BANDCAMP=1): no
// public API exists, and the pages served to a server carry no structured
// data. band_details gives a label's whole discography with release dates,
// its roster (the artists page) and its links; tralbum_details an item's
// tracks. No ISRCs anywhere: a Bandcamp release joins a Spotify or Beatport
// copy by title, credited names and date (identity.ts releaseByTitle), and
// its tracks stay Bandcamp's until a copy with ISRCs arrives.
//
// label: the discography newest first; a release not seen before and recent
// costs one more call for its tracks, an older one is ingested from the
// listing (title, artist, date, the label as entity). The roster rides on
// the label's own claim (`self.artists`), which ingestion turns into
// label-artist edges, matching a name only to an artist already credited on
// one of the label's releases.

import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { getJson, listingHash, rememberSeen, type FetchLike } from './http.js';
import type { TrackerAdapter, TrackerPoll, TrackerTarget } from './types.js';
import { splitCredit } from './upload-title.js';

const API = 'https://bandcamp.com/api/mobile/24';
const EXPAND_PER_POLL = 4;
const EXPAND_WITHIN_DAYS = 90;

type BcItem = { item_id: number; item_type: 'album' | 'track' | string; artist_name?: string; band_name?: string; title: string; art_id?: number; release_date?: string; band_id?: number };
type BcBand = { id: number; name: string; bandcamp_url?: string; bio_image_id?: number; discography?: BcItem[]; artists?: { id: number; name: string }[] };
type BcTralbum = {
	id: number;
	type?: string;
	title: string;
	bandcamp_url?: string;
	art_id?: number;
	band?: { band_id: number; name: string };
	tralbum_artist?: string;
	tracks?: { track_id: number; title: string; track_num?: number; duration?: number; track_url?: string }[];
	release_date?: number;
	label?: string;
	// Free tags, a mix of genres, artist names and the location (isloc).
	tags?: { name: string; isloc?: boolean }[];
};

// The genre tags of a release: whatever is not a place or a name already on
// it (labels tag their own artists). Mapped to the taxonomy by genre_alias
// (sql/0018), the rest kept as the source's 'genres' fact.
function genreTags(t: BcTralbum, names: string[]): string[] {
	const taken = new Set(names.map(nameFold));
	return (t.tags ?? [])
		.filter((g) => !g.isloc && g.name && !taken.has(nameFold(g.name)))
		.map((g) => g.name);
}

const art = (id?: number): string | undefined => (id ? `https://f4.bcbits.com/img/a${id}_16.jpg` : undefined);
const isoDate = (d?: string | number): string | undefined => {
	if (d === undefined) return undefined;
	const t = typeof d === 'number' ? d * 1000 : Date.parse(d);
	return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
};

export class BandcampTracker implements TrackerAdapter {
	readonly provider = 'bandcamp' as const;
	readonly kinds: readonly CatalogKind[] = ['label'];
	readonly callsPerPoll = 1 + EXPAND_PER_POLL;

	constructor(
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
	) {}

	private get<T>(path: string, signal: AbortSignal): Promise<T> {
		return getJson<T>(this.fetchFn, 'bandcamp', `${API}${path}`, { signal, logPath: path.split('?')[0]! });
	}

	async poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (!target.representation) throw new Error('bandcamp label tracker needs a band id');
		const bandId = target.representation.providerId;
		const band = await this.get<BcBand>(`/band_details?band_id=${encodeURIComponent(bandId)}`, signal);
		const labelClaim: CatalogClaim = {
			provider: 'bandcamp',
			kind: 'label',
			providerId: bandId,
			name: band.name || target.object.name,
			url: band.bandcamp_url ?? target.representation.url,
			artists: (band.artists ?? []).map((a) => ({ provider: 'bandcamp' as const, kind: 'artist' as const, providerId: String(a.id), name: a.name })),
		};
		const items = (band.discography ?? []).filter((i) => i.release_date).sort((a, b) => (isoDate(b.release_date) ?? '').localeCompare(isoDate(a.release_date) ?? ''));
		const seen = new Set(Array.isArray(target.cursor.seen) ? (target.cursor.seen as string[]) : []);
		const cutoff = new Date(this.now() - EXPAND_WITHIN_DAYS * 86400_000).toISOString().slice(0, 10);
		const unseen = items.filter((i) => !seen.has(String(i.item_id)));
		const old = unseen.filter((i) => (isoDate(i.release_date) ?? '9999') < cutoff);
		const fresh = unseen.filter((i) => !old.includes(i)).slice(0, EXPAND_PER_POLL);
		const label = { provider: 'bandcamp' as const, kind: 'label' as const, providerId: bandId, name: labelClaim.name };
		const children: CatalogClaim[] = old.map((i) => this.shallow(i, label, bandId));
		let calls = 1;
		for (const i of fresh) {
			const t = await this.get<BcTralbum>(`/tralbum_details?band_id=${i.band_id ?? bandId}&tralbum_id=${i.item_id}&tralbum_type=${i.item_type === 'track' ? 't' : 'a'}`, signal);
			calls++;
			children.push(this.full(i, t, label, bandId));
		}
		const pending = unseen.length > old.length + fresh.length;
		return {
			children,
			listingHash: pending ? `pending:${this.now()}` : listingHash(items.slice(0, 50).map((i) => String(i.item_id))),
			cursor: { seen: rememberSeen(target.cursor.seen, [...fresh, ...old].map((i) => String(i.item_id))) },
			calls,
			self: labelClaim,
		};
	}

	// One release in full (the back office's fill, release-fill.ts), read
	// under the band id it is listed with (`label`'s, the label's account).
	// The item type is not kept on a listed release: an album first, then a
	// track. Null when Bandcamp knows neither.
	async fetchRelease(itemId: string, label: CatalogClaim, signal: AbortSignal): Promise<CatalogClaim | null> {
		for (const type of ['a', 't'] as const) {
			const t = await this.get<BcTralbum & { error?: boolean }>(
				`/tralbum_details?band_id=${encodeURIComponent(label.providerId)}&tralbum_id=${encodeURIComponent(itemId)}&tralbum_type=${type}`,
				signal,
			);
			if (t.error || !t.title) continue;
			return this.full({ item_id: Number(itemId), item_type: type === 'a' ? 'album' : 'track', title: t.title, ...(t.band ? { band_id: t.band.band_id } : {}) }, t, label, label.providerId);
		}
		return null;
	}

	// Who a release is by. An item on the artist's own Bandcamp account names
	// it by that account's band id. One on the label's own account (most of a
	// label's discography: 436 of Steyoyoke's 573 on 2026-10-28) carries the
	// label's band id and the artist only as text, "Navid Kaya, AliPink":
	// each name the credit splitter reads is a credit ("DIN (Efdemin, Marcel
	// Fengler)" is the group and its members), identified within this label
	// (`<label band id>/<folded name>`), never by the label's id — which once
	// credited a label's first-seen artist on every release it hosts.
	private artist(i: { band_id?: number; artist_name?: string; band_name?: string }, labelBandId: string): CatalogClaim[] {
		const name = (i.artist_name ?? i.band_name ?? '').trim();
		if (!name) return [];
		if (i.band_id !== undefined && String(i.band_id) !== labelBandId) return [{ provider: 'bandcamp', kind: 'artist', providerId: String(i.band_id), name }];
		return splitCredit(name).map((n) => ({ provider: 'bandcamp' as const, kind: 'artist' as const, providerId: `${labelBandId}/${nameFold(n)}`, name: n }));
	}

	private shallow(i: BcItem, label: CatalogClaim, labelBandId: string): CatalogClaim {
		const date = isoDate(i.release_date);
		return {
			provider: 'bandcamp',
			kind: 'release',
			providerId: String(i.item_id),
			name: i.title,
			facts: { ...(date ? { releaseDate: date } : {}), ...(art(i.art_id) ? { coverUrl: art(i.art_id) } : {}), labelText: label.name },
			artists: this.artist(i, labelBandId),
			label,
		};
	}

	private full(i: BcItem, t: BcTralbum, label: CatalogClaim, labelBandId: string): CatalogClaim {
		const date = isoDate(t.release_date) ?? isoDate(i.release_date);
		// The item's own page says who it is by; the listing's text when the
		// page does not (the same label-account rule either way).
		const artists = this.artist({ band_id: t.band?.band_id ?? i.band_id, artist_name: t.tralbum_artist ?? i.artist_name, band_name: t.band?.name ?? i.band_name }, labelBandId);
		const genres = genreTags(t, [label.name, t.label ?? '', ...artists.map((a) => a.name)]);
		return {
			provider: 'bandcamp',
			kind: 'release',
			providerId: String(i.item_id),
			name: t.title || i.title,
			url: t.bandcamp_url ?? null,
			facts: {
				...(date ? { releaseDate: date } : {}),
				...(art(t.art_id ?? i.art_id) ? { coverUrl: art(t.art_id ?? i.art_id) } : {}),
				releaseType: (t.tracks?.length ?? 0) > 1 ? 'album' : 'single',
				labelText: t.label ?? label.name,
				trackCount: t.tracks?.length ?? 1,
			},
			artists,
			recordings: (t.tracks ?? []).map((tr, k) => ({
				provider: 'bandcamp' as const,
				kind: 'recording' as const,
				providerId: String(tr.track_id),
				name: tr.title,
				url: tr.track_url ?? null,
				facts: { trackNumber: tr.track_num ?? k + 1, ...(tr.duration ? { durationSec: Math.round(tr.duration) } : {}) },
				// The release's tags: Bandcamp has none per track.
				...(genres.length ? { genres } : {}),
			})),
			label,
			...(genres.length ? { genres } : {}),
			publishedAt: t.release_date ? t.release_date * 1000 : null,
		};
	}
}

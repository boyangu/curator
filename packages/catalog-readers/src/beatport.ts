// Beatport, through its pages (beatport-pages.ts; CURATOR_FEED_BEATPORT=1).
//
// label: /label/<slug>/<id>/releases, newest first, 21 a page. A release not
// seen before and recent costs one more page, /release/<slug>/<id>, for its
// tracks (ISRC, length, BPM, key, genre); an older one is ingested from the
// listing alone (UPC, artists, date, label). Every release names the label as
// an entity, Beatport's own: the catalogue's first provider with a real
// release-label edge (Deezer only knows a label string). The first poll
// walks a few pages so a newly followed label arrives with its recent
// catalogue; releases older than the event window raise nothing (events.ts).
//
// genre: /genre/<slug>/<id>/top-100, one page, the week's chart. Each row is
// a track with its release and label; the poll returns one release claim per
// row (the charted track nested) and the ranks beside, for chart_entry
// events. The listing changes weekly, so most polls ingest.

import type { CatalogClaim, CatalogKind, CatalogRef } from '@curator/protocol';
import { listingHash, rememberSeen, type FetchLike } from './http.js';
import {
	BEATPORT,
	dateOf,
	fetchNextData,
	imageUrl,
	publishedMs,
	queryData,
	type BpArtist,
	type BpLabel,
	type BpPage,
	type BpReleaseRef,
	type BpTrack,
} from './beatport-pages.js';
import type { TrackerAdapter, TrackerPoll, TrackerTarget } from './types.js';

// Release pages read per poll for new releases; the rest wait for the next.
const EXPAND_PER_POLL = 4;
// Only releases this recent get their own page; older ones come from the
// listing (no tracklist, no ISRCs: not worth a page each).
const EXPAND_WITHIN_DAYS = 90;
// The first poll of a label reads this many listing pages (63 releases).
const FIRST_POLL_PAGES = 3;

const artistClaim = (a: BpArtist): CatalogClaim => ({
	provider: 'beatport',
	kind: 'artist',
	providerId: String(a.id),
	name: a.name,
	url: `${BEATPORT}/artist/${a.slug ?? 'artist'}/${a.id}`,
	...(imageUrl(a.image) ? { facts: { coverUrl: imageUrl(a.image) } } : {}),
});

const labelClaim = (l: BpLabel): CatalogClaim => ({
	provider: 'beatport',
	kind: 'label',
	providerId: String(l.id),
	name: l.name,
	url: `${BEATPORT}/label/${l.slug ?? 'label'}/${l.id}`,
	...(imageUrl(l.image) ? { facts: { coverUrl: imageUrl(l.image) } } : {}),
});

// A Beatport track is a mix of a title: "Stay" + "Extended Mix".
const trackTitle = (t: BpTrack): string => (t.mix_name && !/^original mix$/i.test(t.mix_name) ? `${t.name} (${t.mix_name})` : t.name);

function recordingClaim(t: BpTrack, position: number, releaseArtists?: BpArtist[]): CatalogClaim {
	const artists = t.artists?.length ? t.artists : releaseArtists ?? [];
	return {
		provider: 'beatport',
		kind: 'recording',
		providerId: String(t.id),
		name: trackTitle(t),
		url: `${BEATPORT}/track/${t.slug ?? 'track'}/${t.id}`,
		identifiers: t.isrc ? [{ namespace: 'isrc', value: t.isrc }] : [],
		facts: {
			...(t.length_ms ? { durationSec: Math.round(t.length_ms / 100) / 10 } : {}),
			trackNumber: t.number ?? position,
			...(t.bpm ? { bpm: t.bpm } : {}),
			...(t.key?.name ? { key: t.key.name } : {}),
		},
		artists: [...artists.map(artistClaim), ...(t.remixers ?? []).map(artistClaim)],
		genres: [t.genre?.name, t.sub_genre?.name].filter((g): g is string => !!g),
	};
}

function releaseClaim(r: BpReleaseRef, tracks: BpTrack[] = [], genres: string[] = []): CatalogClaim {
	const artists = [...(r.artists ?? []), ...(r.remixers ?? [])];
	return {
		provider: 'beatport',
		kind: 'release',
		providerId: String(r.id),
		name: r.name,
		url: `${BEATPORT}/release/${r.slug ?? 'release'}/${r.id}`,
		identifiers: r.upc ? [{ namespace: 'upc', value: r.upc }] : [],
		facts: {
			...(dateOf(r.new_release_date) ? { releaseDate: dateOf(r.new_release_date) } : {}),
			...(imageUrl(r.image) ? { coverUrl: imageUrl(r.image) } : {}),
			...(r.track_count !== undefined ? { trackCount: r.track_count } : {}),
			...(r.catalog_number ? { catalogNumber: r.catalog_number } : {}),
			...(r.label?.name ? { labelText: r.label.name } : {}),
		},
		artists: artists.map(artistClaim),
		recordings: tracks.map((t, i) => recordingClaim(t, i + 1, r.artists)),
		...(r.label ? { label: labelClaim(r.label) } : {}),
		...(genres.length ? { genres } : {}),
		publishedAt: publishedMs(r.publish_date ?? r.new_release_date),
	};
}

// The slug Beatport put in the representation's url, or any word: the site
// resolves by id.
function slugOf(url: string | null, kind: string): string {
	const m = url && new RegExp(`/${kind}/([^/]+)/\\d+`).exec(url);
	return m?.[1] ?? kind;
}

export class BeatportTracker implements TrackerAdapter {
	readonly provider = 'beatport' as const;
	readonly kinds: readonly CatalogKind[] = ['label', 'genre'];
	readonly callsPerPoll = FIRST_POLL_PAGES + EXPAND_PER_POLL;

	constructor(
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
	) {}

	poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (!target.representation) throw new Error(`beatport ${target.object.kind} tracker needs a Beatport id`);
		return target.object.kind === 'genre' ? this.pollGenre(target, signal) : this.pollLabel(target, signal);
	}

	private async pollLabel(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		const rep = target.representation!;
		const slug = slugOf(rep.url, 'label');
		const seen = new Set(Array.isArray(target.cursor.seen) ? (target.cursor.seen as string[]) : []);
		const pages = seen.size ? 1 : FIRST_POLL_PAGES;
		const listed: BpReleaseRef[] = [];
		let calls = 0;
		let self: CatalogClaim | undefined;
		for (let page = 1; page <= pages; page++) {
			const data = await fetchNextData(this.fetchFn, `/label/${slug}/${rep.providerId}/releases${page > 1 ? `?page=${page}` : ''}`, signal);
			calls++;
			const list = queryData<BpPage<BpReleaseRef>>(data, (k) => k.startsWith('releases-label_id='));
			if (!list) throw new Error('beatport label page without its releases');
			listed.push(...list.results);
			if (page === 1) {
				const label = queryData<BpLabel>(data, `label-${rep.providerId}`);
				if (label?.name) self = labelClaim(label);
			}
			if (!list.next || list.results.length < 21) break;
		}
		const cutoff = new Date(this.now() - EXPAND_WITHIN_DAYS * 86400_000).toISOString().slice(0, 10);
		const unseen = listed.filter((r) => !seen.has(String(r.id)));
		const old = unseen.filter((r) => (dateOf(r.new_release_date) ?? '9999') < cutoff);
		const fresh = unseen.filter((r) => !old.includes(r)).slice(0, EXPAND_PER_POLL);
		const children: CatalogClaim[] = old.map((r) => releaseClaim(r));
		for (const ref of fresh) {
			children.push(await this.releasePage(ref, signal));
			calls++;
		}
		const pending = unseen.length > old.length + fresh.length;
		return {
			children,
			listingHash: pending ? `pending:${this.now()}` : listingHash(listed.slice(0, 21).map((r) => String(r.id))),
			cursor: { seen: rememberSeen(target.cursor.seen, [...fresh, ...old].map((r) => String(r.id))) },
			calls,
			...(self ? { self } : {}),
		};
	}

	// One release in full by its id (the slug is cosmetic): the back office's
	// fill (release-fill.ts).
	async fetchRelease(id: string, url: string | null, signal: AbortSignal): Promise<CatalogClaim> {
		const claim = await this.releasePage({ id: Number(id), name: '', slug: slugOf(url, 'release') }, signal);
		if (!claim.name) throw new Error(`beatport release ${id}: the page does not carry it`);
		return claim;
	}

	// A release page: the release with its tracks (ISRCs, BPM, key) and genres.
	private async releasePage(ref: BpReleaseRef, signal: AbortSignal): Promise<CatalogClaim> {
		const page = await fetchNextData(this.fetchFn, `/release/${ref.slug ?? 'release'}/${ref.id}`, signal);
		const release = queryData<BpReleaseRef>(page, `release-${ref.id}`) ?? ref;
		const tracks = queryData<BpPage<BpTrack>>(page, 'tracks')?.results ?? [];
		const genres = [...new Set(tracks.flatMap((t) => [t.genre?.name, t.sub_genre?.name]).filter((g): g is string => !!g))];
		return releaseClaim({ ...ref, ...release, label: release.label ?? ref.label }, tracks, genres);
	}

	private async pollGenre(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		const rep = target.representation!;
		const data = await fetchNextData(this.fetchFn, `/genre/${slugOf(rep.url, 'genre')}/${rep.providerId}/top-100`, signal);
		const top = queryData<BpPage<BpTrack>>(data, (k) => k.startsWith(`genre-${rep.providerId}-top-100`));
		if (!top) throw new Error('beatport genre page without its chart');
		const children: CatalogClaim[] = [];
		const chart: { index: number; rank: number; recording: CatalogRef }[] = [];
		top.results.forEach((t, i) => {
			const release: BpReleaseRef = t.release ?? { id: -t.id, name: t.name };
			if (release.id < 0) return;
			const claim = releaseClaim({ ...release, artists: release.artists ?? t.artists, image: release.image ?? t.image, new_release_date: release.new_release_date ?? t.new_release_date }, [t], [t.genre?.name, t.sub_genre?.name].filter((g): g is string => !!g));
			chart.push({ index: children.length, rank: i + 1, recording: { provider: 'beatport', kind: 'recording', providerId: String(t.id) } });
			children.push(claim);
		});
		return { children, listingHash: listingHash(top.results.map((t) => String(t.id))), cursor: {}, calls: 1, chart };
	}
}

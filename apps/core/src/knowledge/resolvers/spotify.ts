// Spotify structured resolver — the KB's v1 catalog source. Answers:
//   artist.detail      → images + genre stubs (one /artists batch call)
//   artist.releases    → full release walk, one /artists/{id}/albums page
//                        per fetchPage (offset cursor)
//   release.tracks     → full album (label lives ONLY on the full object)
//                        + tracklist + ISRCs, one shot
//
// An artist entity with no Spotify ref yet (an agent stub, or a library
// seed without a source link) is unified here: search by name, accept an
// exact folded match only, and emit the artist draft with the found id —
// identity's attachSourceRef then attaches or merges. No guessing between
// near-matches; no match = the aspect errors and the entity stays a stub.

import { searchFold } from '@curator/shared';
import type {
	SpotifyAlbum,
	SpotifyArtist,
	SpotifyFullAlbum,
	SpotifyPaginated,
	SpotifySimplifiedTrack,
	SpotifyTrack,
} from '@curator/spotify';
import type { KbAspect, KbEdgeDraft, KbEntityDraft, KbEntityKind, KbResolver, KbResolverPage } from '../types.js';

// Structural client port — the service injects a token-fresh SpotifyClient;
// tests inject a fake.
export interface SpotifyKbClient {
	getArtists(ids: string[]): Promise<SpotifyArtist[]>;
	getArtistAlbumsPage(
		artistId: string,
		opts?: { includeGroups?: string; limit?: number; offset?: number },
	): Promise<SpotifyPaginated<SpotifyAlbum>>;
	searchArtists(query: string, limit?: number): Promise<SpotifyArtist[]>;
	getAlbums(ids: string[]): Promise<SpotifyFullAlbum[]>;
	getAlbumTracks(albumId: string): Promise<SpotifySimplifiedTrack[]>;
	getTracksByIds(ids: string[]): Promise<SpotifyTrack[]>;
}

const PAGE_SIZE = 50;

function artistDraft(a: SpotifyArtist): KbEntityDraft {
	return {
		kind: 'artist',
		name: a.name,
		coverUrl: a.images?.[0]?.url ?? null,
		attrs: a.genres && a.genres.length > 0 ? { genres: a.genres } : undefined,
		source: 'spotify',
		sourceKind: 'artist',
		sourceId: a.id,
		url: a.external_urls?.spotify ?? null,
		payload: a,
	};
}

function genreDraft(name: string): KbEntityDraft {
	return {
		kind: 'genre',
		name,
		source: 'spotify',
		sourceKind: 'genre',
		sourceId: `name:${searchFold(name)}`,
	};
}

function labelDraft(name: string): KbEntityDraft {
	return {
		kind: 'label',
		name,
		source: 'spotify',
		sourceKind: 'label',
		sourceId: `name:${searchFold(name)}`,
	};
}

function releaseDraft(album: SpotifyAlbum): KbEntityDraft {
	return {
		kind: 'release',
		name: album.name,
		releaseDate: album.release_date ?? null,
		coverUrl: album.images?.[0]?.url ?? null,
		attrs: { albumType: album.album_type, totalTracks: album.total_tracks },
		source: 'spotify',
		sourceKind: 'album',
		sourceId: album.id,
		url: album.external_urls?.spotify ?? null,
		payload: album,
	};
}

const ref = (d: KbEntityDraft) => ({ source: d.source, sourceKind: d.sourceKind, sourceId: d.sourceId });

export class SpotifyKbResolver implements KbResolver {
	readonly source = 'spotify' as const;
	readonly tier = 'structured' as const;

	constructor(private readonly getClient: () => Promise<SpotifyKbClient | null>) {}

	supports(kind: KbEntityKind, aspect: KbAspect): boolean {
		return (kind === 'artist' && (aspect === 'detail' || aspect === 'releases'))
			|| (kind === 'release' && aspect === 'tracks');
	}

	async fetchPage(req: Parameters<KbResolver['fetchPage']>[0]): Promise<KbResolverPage> {
		const client = await this.getClient();
		if (!client) throw new Error('Spotify not connected');
		if (req.kind === 'artist') {
			const artistId = req.sourceId ?? await this.matchArtistByName(client, req.entity.name);
			return req.aspect === 'detail'
				? this.artistDetail(client, req.entity.id, artistId)
				: this.artistReleases(client, req.entity.id, artistId, req.cursor);
		}
		if (req.kind === 'release' && req.aspect === 'tracks') {
			if (!req.sourceId) throw new Error('release has no Spotify id');
			return this.releaseTracks(client, req.entity.id, req.sourceId);
		}
		throw new Error(`unsupported: ${req.kind}.${req.aspect}`);
	}

	// Stub unification: exact folded-name match only — a homonym-safe rule;
	// anything fuzzier belongs to a future interactive picker.
	private async matchArtistByName(client: SpotifyKbClient, name: string): Promise<string> {
		const folded = searchFold(name);
		const candidates = await client.searchArtists(name, 10);
		const hit = candidates.find((c) => searchFold(c.name) === folded);
		if (!hit) throw new Error(`no exact Spotify match for artist "${name}"`);
		return hit.id;
	}

	private async artistDetail(client: SpotifyKbClient, entityId: string, artistId: string): Promise<KbResolverPage> {
		const [artist] = await client.getArtists([artistId]);
		if (!artist) throw new Error('artist not found on Spotify');
		const a = artistDraft(artist);
		const genres = (artist.genres ?? []).map(genreDraft);
		const edges: KbEdgeDraft[] = genres.map((g) => ({
			kind: 'entity-genre',
			src: { entityId },
			dst: ref(g),
		}));
		return { entities: [a, ...genres], edges, cursor: null };
	}

	private async artistReleases(
		client: SpotifyKbClient,
		entityId: string,
		artistId: string,
		cursor: unknown,
	): Promise<KbResolverPage> {
		const offset = typeof cursor === 'object' && cursor !== null && 'offset' in cursor
			? Number((cursor as { offset: unknown }).offset) || 0
			: 0;
		const page = await client.getArtistAlbumsPage(artistId, { limit: PAGE_SIZE, offset });
		const entities: KbEntityDraft[] = [];
		const edges: KbEdgeDraft[] = [];
		for (const album of page.items) {
			const rel = releaseDraft(album);
			entities.push(rel);
			// Credit every listed artist. The expanded artist edges by KB id;
			// co-credited artists ride along as drafts — free collab seeding.
			for (const credit of album.artists) {
				if (credit.id === artistId) {
					edges.push({ kind: 'artist-release', src: { entityId }, dst: ref(rel), role: album.album_group ?? null });
				} else {
					const co = artistDraft({ id: credit.id, name: credit.name });
					entities.push(co);
					edges.push({ kind: 'artist-release', src: ref(co), dst: ref(rel), role: album.album_group ?? null });
				}
			}
		}
		const nextOffset = page.offset + page.items.length;
		const done = page.next === null || page.items.length === 0 || nextOffset >= page.total;
		return { entities, edges, cursor: done ? null : { offset: nextOffset } };
	}

	private async releaseTracks(client: SpotifyKbClient, entityId: string, albumId: string): Promise<KbResolverPage> {
		const [album] = await client.getAlbums([albumId]);
		const simplified = await client.getAlbumTracks(albumId);
		// Full track objects for ISRC — the KB's cross-source pivot.
		const full = await client.getTracksByIds(simplified.map((t) => t.id));
		const isrcById = new Map(full.map((t) => [t.id, t.external_ids?.isrc ?? null]));
		const entities: KbEntityDraft[] = [];
		const edges: KbEdgeDraft[] = [];
		if (album?.label) {
			const label = labelDraft(album.label);
			entities.push(label);
			edges.push({ kind: 'release-label', src: { entityId }, dst: ref(label) });
		}
		for (const t of simplified) {
			const track: KbEntityDraft = {
				kind: 'track',
				name: t.name,
				isrc: isrcById.get(t.id) ?? null,
				durationSec: Math.round(t.duration_ms / 1000),
				releaseDate: album?.release_date ?? null,
				coverUrl: album?.images?.[0]?.url ?? null,
				source: 'spotify',
				sourceKind: 'track',
				sourceId: t.id,
				payload: t,
			};
			entities.push(track);
			edges.push({ kind: 'release-track', src: { entityId }, dst: ref(track), position: t.track_number ?? null });
			for (const credit of t.artists) {
				const artist = artistDraft({ id: credit.id, name: credit.name });
				entities.push(artist);
				edges.push({ kind: 'track-artist', src: ref(track), dst: ref(artist) });
			}
		}
		return { entities, edges, cursor: null };
	}
}

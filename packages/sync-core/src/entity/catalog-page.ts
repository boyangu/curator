// An entity page as the Global Catalog describes it: the header's catalogue
// facts from a `catalog.browse` answer, and a `catalog.tracks` page as World
// rows. Shared by the desktop (apps/core entity/service.ts) and the phone
// (apps/mobile js/entity.ts), which reach the catalogue differently and know
// different things of the library, but lay out the same page.
//
// What an artist or a label IS comes from the catalogue alone, whichever side
// the list shows; the library contributes only which of its own entities this
// is and its files (the callers' part).

import type { CatalogBrowseResult, CatalogHandle, CatalogTracksResult } from '@curator/protocol';
import { isDistributor } from '@curator/library-logic';
import type { ArtistLink, EntityChip, EntityHeader, EntityRowPatch, EntityTracksPage } from '@curator/shared';
import { keyToCamelot } from '../enrich/keys.js';
import { artistBadges } from './badges.js';
import type { OwnershipMatch, OwnershipProbe } from './ownership.js';

export const CHIPS_MAX = 12;
// An artist's labels: every one the header can name (it shows the first few
// and the rest on asking).
export const LABELS_MAX = 50;
export const GENRES_MAX = 6;

// A handle a person can open: a store's own page, not a reader's name key.
const openable = (h: CatalogHandle): boolean => !!h.url && h.provider !== 'user' && !h.id.includes('/');
export const linksOf = (handles: readonly CatalogHandle[]): ArtistLink[] => handles.filter(openable).map((h) => ({ source: h.provider, sourceId: h.id, url: h.url }));

export function mergeLinks(local: ArtistLink[], remote: ArtistLink[]): ArtistLink[] {
	const out = new Map<string, ArtistLink>();
	for (const l of [...local, ...remote]) if (!out.has(l.source)) out.set(l.source, l);
	return [...out.values()].sort((a, b) => a.source.localeCompare(b.source));
}

const chip = (kind: EntityChip['ref']['kind'], c: { id: string; name: string; releases?: number }): EntityChip => ({ ref: { kind, name: c.name, catalogId: c.id }, ...(c.releases !== undefined ? { count: c.releases } : {}) });

// Lays the catalogue's account over a header holding what the library knows
// (its ref, links, owned side): picture, genres, store links, and per kind
// the labels / artists / collabs / activity / Reach. In place; returns it.
export function applyBrowse(header: EntityHeader, b: CatalogBrowseResult, now: number): EntityHeader {
	const kind = header.ref.kind;
	header.imageUrl = b.object.coverUrl ?? header.imageUrl;
	if (b.genres?.length) header.genres = b.genres.slice(0, GENRES_MAX).map((g) => ({ name: g.name, ...(g.count !== undefined ? { count: g.count } : {}) }));
	header.links = mergeLinks(header.links, linksOf(b.object.handles));
	if (kind === 'artist') {
		// The labels it releases on, most releases first: the catalogue's
		// label objects, and the ones its releases only name (a store with
		// no label pages) — by name alone; that label's own page finds the
		// catalogue's object. A distributor's name is not a label.
		const named = (b.labelTexts ?? []).filter((l) => !isDistributor(l.name)).map((l): EntityChip => ({ ref: { kind: 'label', name: l.name }, count: l.releases }));
		header.labels = [...(b.labels ?? []).map((l) => chip('label', l)), ...named].sort((x, y) => (y.count ?? 0) - (x.count ?? 0)).slice(0, LABELS_MAX);
		header.similar = (b.similar ?? []).slice(0, CHIPS_MAX).map((a) => chip('artist', a));
		header.collabs = (b.collabs ?? []).map((a): EntityChip => ({ ref: { kind: 'artist', name: a.name, catalogId: a.id }, count: a.tracks }));
		header.activity = b.activity ?? null;
		header.badges = artistBadges(header.activity, b.releaseCount ?? null, now);
		header.reach = b.reach ?? null;
	} else if (kind === 'label') {
		if (b.artists?.length) header.artists = b.artists.slice(0, CHIPS_MAX).map((a) => chip('artist', a));
	} else {
		if (b.artists?.length) header.artists = b.artists.map((a) => chip('artist', { id: a.id, name: a.name }));
		if (b.labels?.length) header.labels = b.labels.map((l) => chip('label', { id: l.id, name: l.name }));
		else if (b.release?.labelText && !header.labels.length) header.labels = [{ ref: { kind: 'label', name: b.release.labelText } }];
		header.facts = { releaseDate: b.release?.date ?? header.facts.releaseDate ?? null, albumType: b.release?.type ?? header.facts.albumType ?? null };
	}
	// `watch` absent: a server from before it answered one — no follow state to show.
	if (kind !== 'album' && b.watch !== undefined) header.follow = { following: b.watch !== null, muted: b.watch?.muted ?? false };
	return header;
}

const streamId = (handles: readonly CatalogHandle[], provider: 'spotify' | 'tidal'): string | null => handles.find((h) => h.provider === provider && !h.id.includes('/'))?.id ?? null;

// What a page's recordings are asked of the library as (ownership.ts).
export function worldProbes(result: CatalogTracksResult): OwnershipProbe[] {
	return result.releases.flatMap((r) =>
		r.tracks.map((t) => ({ recordingId: t.id, releaseId: r.id, releaseTitle: r.title, releaseDate: r.date, isrc: t.isrc, spotifyId: streamId(t.handles, 'spotify'), tidalId: streamId(t.handles, 'tidal') })),
	);
}

// A page of the catalogue's releases as World rows, each recording marked
// with the library track it is (`matches`, one per probe of worldProbes in
// order) and with what a lookup found for it (`patchOf`, the desktop's page
// work). The list's row template is the caller's.
export function worldPage(result: CatalogTracksResult, probes: OwnershipProbe[], matches: (OwnershipMatch | null)[], patchOf?: (recordingId: string) => EntityRowPatch | undefined): Omit<EntityTracksPage, 'template'> {
	let i = 0;
	return {
		albums: result.releases.map((r) => ({
			id: r.id,
			title: r.title,
			date: r.date,
			type: r.type,
			coverUrl: r.coverUrl,
			label: r.labels[0] ? { id: r.labels[0].id, name: r.labels[0].name } : r.labelText ? { id: null, name: r.labelText } : null,
			artists: r.artists,
			genres: r.genres,
			trackCount: r.trackCount,
			appearance: r.appearance,
			links: linksOf(r.handles),
		})),
		tracks: result.releases.flatMap((r) =>
			r.tracks.map((t) => {
				const probe = probes[i]!;
				const match = matches[i++] ?? null;
				const patch = patchOf?.(t.id);
				return {
					recordingId: t.id,
					releaseId: r.id,
					title: t.title,
					artists: t.artists.length ? t.artists : r.artists,
					position: t.position,
					disc: t.disc,
					durationSec: t.durationSec,
					isrc: t.isrc,
					bpm: t.bpm ?? patch?.bpm ?? null,
					keyCamelot: (t.key ? keyToCamelot(t.key) : null) ?? patch?.keyCamelot ?? null,
					// A patch's genre is set only for a row without one, or as
					// Beatport's, which wins (apps/core entity/work.ts factsRow).
					genre: patch?.genre ?? t.genres[0] ?? r.genres[0] ?? null,
					label: patch?.label ?? null,
					links: linksOf(t.handles),
					streamIds: { ...patch?.streamIds, ...(probe.spotifyId ? { spotify: probe.spotifyId } : {}), ...(probe.tidalId ? { tidal: probe.tidalId } : {}) },
					libraryTrackId: match?.libraryTrackId ?? null,
					libraryPrimary: match?.primary ?? false,
				};
			}),
		),
		nextCursor: result.nextCursor,
	};
}

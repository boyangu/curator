// Folding a repeat sighting's payload onto the row that already holds the
// item (store.ts upsertItems / accrueSources).
//
// The row and the draft can come from different producers — a Spotify
// playlist track and the catalogue's card for the same recording, or a
// catalogue release announced again after it gained a Spotify id — so the
// merge is FILL-ONLY: a value the row already has is kept (the user may have
// seen it, the enricher may have chosen it), a missing one is taken from the
// draft. Handles are the exception: they are facts about where the item
// lives, so the row gains every new one (that is how a re-announced release
// becomes playable in place).

import type { FeedHandle, FeedItemPayload, FeedTrackRef } from './types.js';

const FILL_FIELDS = ['catalogId', 'artistCatalogIds', 'labelCatalogId', 'catalogNumber', 'upc', 'genre', 'label', 'bpm', 'keyCamelot', 'releaseDate', 'albumType', 'trackCount', 'isrc', 'coverUrl', 'albumTitle', 'url'] as const satisfies readonly (keyof FeedItemPayload)[];
const REF_FILL_FIELDS = ['catalogId', 'artistCatalogIds', 'isrc', 'bpm', 'keyCamelot', 'genre', 'label', 'releaseDate'] as const satisfies readonly (keyof FeedTrackRef)[];

const empty = (v: unknown): boolean => v === undefined || v === null || v === '';

// Union by (provider, id), the row's own first. Returns the input array when
// nothing was added, so callers can tell a change by identity.
export function unionHandles(have: readonly FeedHandle[] | undefined, add: readonly FeedHandle[] | undefined): FeedHandle[] | undefined {
	if (!add || add.length === 0) return have ? [...have] : undefined;
	const out = [...(have ?? [])];
	let grew = !have;
	for (const h of add) {
		if (out.some((x) => x.provider === h.provider && x.id === h.id)) continue;
		out.push(h);
		grew = true;
	}
	return grew ? out : (have as FeedHandle[]);
}

const sameHandles = (a: readonly FeedHandle[] | undefined, b: readonly FeedHandle[] | undefined): boolean =>
	(a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((h, i) => h.provider === b![i]!.provider && h.id === b![i]!.id);

// A ref that carries its catalogue id in sourceTrackId cannot play on
// Spotify (feed/handles.ts); one with a Spotify id can.
const playable = (r: FeedTrackRef): boolean => !r.catalogId || r.sourceTrackId !== r.catalogId;

function matchRef(refs: readonly FeedTrackRef[], r: FeedTrackRef): FeedTrackRef | undefined {
	return (r.catalogId ? refs.find((x) => x.catalogId === r.catalogId) : undefined)
		?? (r.isrc ? refs.find((x) => x.isrc === r.isrc) : undefined)
		?? refs.find((x) => x.sourceTrackId === r.sourceTrackId);
}

function mergeRef(have: FeedTrackRef, add: FeedTrackRef): boolean {
	let changed = false;
	for (const f of REF_FILL_FIELDS) {
		if (empty(have[f]) && !empty(add[f])) {
			(have as unknown as Record<string, unknown>)[f] = add[f];
			changed = true;
		}
	}
	const handles = unionHandles(have.handles, add.handles);
	if (handles && !sameHandles(handles, have.handles)) {
		have.handles = handles;
		changed = true;
	}
	if (!playable(have) && playable(add)) {
		have.sourceTrackId = add.sourceTrackId;
		changed = true;
	}
	return changed;
}

// The fields a row's track keeps when the catalogue's card replaces the
// tracklist: what this device found or chose for it.
const REF_CARRY_FIELDS = [...REF_FILL_FIELDS, 'enrichStatus', 'enrichAsked', 'enrichProvisional', 'enrichReport', 'sourceLinks'] as const satisfies readonly (keyof FeedTrackRef)[];

// The draft is the catalogue's own card for the row's release: the same
// catalogue id, and every track a catalogue recording.
const catalogueCard = (current: FeedItemPayload, incoming: FeedItemPayload): boolean =>
	!!incoming.catalogId && incoming.catalogId === current.catalogId && !!incoming.tracks?.length && incoming.tracks.every((t) => !!t.catalogId);

// The row's track the card's track is, by the ids it carried: the catalogue
// id, the ISRC, the source id, or a Spotify id the row played it by — a
// recording merged away in the catalogue keeps its Spotify ids, which move
// onto the survivor, so the row's enrichment finds its new home.
function sameTrack(old: FeedTrackRef, next: FeedTrackRef): boolean {
	if (old.catalogId && next.catalogId && old.catalogId === next.catalogId) return true;
	if (old.isrc && next.isrc && old.isrc === next.isrc) return true;
	if (old.sourceTrackId === next.sourceTrackId) return true;
	const ids = new Set([next.sourceTrackId, ...(next.handles ?? []).map((h) => h.id)]);
	return ids.has(old.sourceTrackId) || (old.handles ?? []).some((h) => ids.has(h.id));
}

// The catalogue's tracklist, in its order, each track carrying what the row's
// matching track(s) had: the catalogue decides which recordings the release
// holds (two stores' copies of one track merged into one, release-fill.ts
// dedupeRelease), the device keeps what it found about them. A row track that
// matches nothing is gone — that is the merge landing here.
function replaceTracks(current: readonly FeedTrackRef[], incoming: readonly FeedTrackRef[]): FeedTrackRef[] {
	return incoming.map((t) => {
		const next: FeedTrackRef = { ...t };
		for (const old of current) {
			if (!sameTrack(old, t)) continue;
			for (const f of REF_CARRY_FIELDS) {
				if (empty(next[f]) && !empty(old[f])) (next as unknown as Record<string, unknown>)[f] = old[f];
			}
			next.handles = unionHandles(next.handles, old.handles);
			if (!playable(next) && playable(old)) next.sourceTrackId = old.sourceTrackId;
		}
		return next;
	});
}

// The row's payload with the draft's facts folded in, or null when nothing
// changed. `upgrade`: the row moves from 'catalog' to a playable source with
// this draft, so the draft's url (the Spotify page) replaces the store page.
export function mergeFeedPayload(current: FeedItemPayload, incoming: FeedItemPayload, opts: { upgrade?: boolean } = {}): FeedItemPayload | null {
	const next: FeedItemPayload = { ...current };
	let changed = false;
	for (const f of FILL_FIELDS) {
		if (empty(next[f]) && !empty(incoming[f])) {
			(next as unknown as Record<string, unknown>)[f] = incoming[f];
			changed = true;
		}
	}
	if (opts.upgrade && incoming.url && incoming.url !== next.url) {
		next.url = incoming.url;
		changed = true;
	}
	const handles = unionHandles(current.handles, incoming.handles);
	if (handles && !sameHandles(handles, current.handles)) {
		next.handles = handles;
		changed = true;
	}
	if (incoming.tracks && incoming.tracks.length > 0) {
		if (!current.tracks || current.tracks.length === 0) {
			next.tracks = incoming.tracks.map((t) => ({ ...t }));
			changed = true;
		} else if (catalogueCard(current, incoming)) {
			const tracks = replaceTracks(current.tracks, incoming.tracks);
			if (JSON.stringify(tracks) !== JSON.stringify(current.tracks)) {
				next.tracks = tracks;
				if (incoming.trackCount !== undefined && incoming.trackCount !== null) next.trackCount = incoming.trackCount;
				changed = true;
			}
		} else {
			const refs = current.tracks.map((t) => ({ ...t }));
			let refChanged = false;
			for (const r of incoming.tracks) {
				const m = matchRef(refs, r);
				if (m && mergeRef(m, r)) refChanged = true;
			}
			if (refChanged) {
				next.tracks = refs;
				changed = true;
			}
		}
	}
	return changed ? next : null;
}

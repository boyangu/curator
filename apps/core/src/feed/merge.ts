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

const FILL_FIELDS = ['catalogId', 'catalogNumber', 'upc', 'genre', 'label', 'bpm', 'keyCamelot', 'releaseDate', 'albumType', 'trackCount', 'isrc', 'coverUrl', 'albumTitle', 'url'] as const satisfies readonly (keyof FeedItemPayload)[];
const REF_FILL_FIELDS = ['catalogId', 'isrc', 'bpm', 'keyCamelot', 'genre', 'label', 'releaseDate'] as const satisfies readonly (keyof FeedTrackRef)[];

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

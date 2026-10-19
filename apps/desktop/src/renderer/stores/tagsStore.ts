// tagsStore — central cache of user tags (Rekordbox MyTags) and per-track
// membership. Single source of truth for the player chip row, the track-list
// "tags" column, and the omnibar's `#tag` autocomplete / filter parsing.
//
// Why this lives outside main.ts:
//   • The omnibar, NowPlayingCard, and TrackListView all need synchronous
//     `tagId → name` and `trackId → tagIds` lookups during render. Pushing
//     IPC into the render path would either block or cause flicker.
//   • Membership is bulk-fetched per page of tracks (one IN-query) — see
//     ensureTracksLoaded(). The track-list virt loop calls this with the
//     visible window; the omnibar passes the result list.
//   • Tag definitions (id, name, color) refresh on demand. Rekordbox sync
//     adds/edits tags, so callers can fire refreshTags() after a sync
//     completes; otherwise the initial boot fetch carries through.
//
// We deliberately hide the four MyTag-category roots (Genre / Components /
// Situation / Attributes — rb_1..rb_4 in the user's library). They're
// folders in Rekordbox, not tags applied to tracks, so their tag-count is
// always zero. The filter on `getTagCounts()` doubles as the "is this a
// real leaf" check, mirroring how the sidebar will eventually show them.

import type { Tag } from '@curator/shared';
import { log } from '../data/log.js';

const slog = log.for('tags');

let tagsById: Map<string, Tag> = new Map();
let userTagsSorted: Tag[] = [];
let userTagsByName: Map<string, Tag> = new Map();
let tagCountsById: Map<string, number> = new Map();
const tagsByTrackId: Map<string, string[]> = new Map();

let definitionsLoaded = false;
let definitionsLoadingPromise: Promise<void> | null = null;

const tagsChangedListeners = new Set<() => void>();

// ── Definitions: id/name/color ──────────────────────────────────────────────

export async function loadTagDefinitions(force = false): Promise<void> {
	if (definitionsLoaded && !force) return;
	if (definitionsLoadingPromise) return definitionsLoadingPromise;
	definitionsLoadingPromise = (async () => {
		const [tags, counts] = await Promise.all([
			window.api['tags:list'](),
			window.api['tags:counts'](),
		]);
		tagsById = new Map(tags.map((t) => [t.id, t]));
		tagCountsById = new Map(Object.entries(counts));
		// "User" tags surfaced to the UI = kind='user' with at least one
		// member. This filters out the four category roots whose membership
		// is always zero. Sort by member-count desc then alpha so the most-
		// used tags rise to the top of the autocomplete list.
		const usable = tags.filter((t) => t.kind === 'user' && (tagCountsById.get(t.id) ?? 0) > 0);
		usable.sort((a, b) => {
			const ca = tagCountsById.get(a.id) ?? 0;
			const cb = tagCountsById.get(b.id) ?? 0;
			if (cb !== ca) return cb - ca;
			return a.name.localeCompare(b.name);
		});
		userTagsSorted = usable;
		userTagsByName = new Map(usable.map((t) => [t.name.toLowerCase(), t]));
		definitionsLoaded = true;
		for (const cb of tagsChangedListeners) {
			try { cb(); } catch (err) { slog.error('tagsStore listener threw', err); }
		}
	})().finally(() => { definitionsLoadingPromise = null; });
	return definitionsLoadingPromise;
}

export function refreshTagDefinitions(): Promise<void> {
	return loadTagDefinitions(true);
}

export function getTagById(id: string): Tag | undefined {
	return tagsById.get(id);
}

// Sorted list of user-applied tags, most-used first. Used for the omnibar
// autocomplete dropdown and the eventual sidebar tag-section.
export function getUserTagsSorted(): readonly Tag[] {
	return userTagsSorted;
}

// Resolve a user-typed tag name to its id. Case-insensitive — Rekordbox
// preserves the casing the user picked but autocomplete matching shouldn't
// care. Returns null when the name doesn't match any known tag (the omnibar
// surfaces that as "unknown tag" in the result list).
export function resolveTagByName(name: string): Tag | null {
	return userTagsByName.get(name.toLowerCase()) ?? null;
}

export function onTagsChanged(cb: () => void): () => void {
	tagsChangedListeners.add(cb);
	return () => tagsChangedListeners.delete(cb);
}

// ── Membership: per-track tag ids ───────────────────────────────────────────

// Per-id in-flight fetch tracking. The pre-seeded [] placeholder makes
// `tagsByTrackId.has(id)` true the instant a fetch STARTS, which is right
// for render paths ("[] until loaded") but wrong for the filter pipeline —
// evaluating a `#tag` query against placeholders silently drops every
// match for the IPC round-trip window. `inflight` lets areTracksSettled()
// tell the two states apart, and lets a second ensureTracksLoaded() call
// await an overlapping batch instead of resolving while data is pending.
const inflight = new Map<string, Promise<void>>();

// Fetch tag-id arrays for any of the supplied track ids that aren't already
// cached. The track-list virt loop calls this with the current page's ids
// before painting the "tags" column; the omnibar calls it with its result
// list. Idempotent — repeated calls with the same ids are free. Resolves
// only once EVERY requested id has settled, including ids being fetched by
// an earlier overlapping call.
export async function ensureTracksLoaded(trackIds: readonly string[]): Promise<void> {
	const missing = trackIds.filter((id) => !tagsByTrackId.has(id));
	if (missing.length > 0) {
		// Pre-seed empties so a track with zero tags doesn't keep re-fetching.
		for (const id of missing) tagsByTrackId.set(id, []);
		const batchPromise = (async () => {
			const batch = await window.api['tracks:tags-batch'](missing);
			for (const id of missing) {
				const got = batch[id];
				if (got && got.length) tagsByTrackId.set(id, got);
			}
		})();
		for (const id of missing) inflight.set(id, batchPromise);
		void batchPromise.catch(() => { /* surfaced via the await below */ }).finally(() => {
			for (const id of missing) {
				if (inflight.get(id) === batchPromise) inflight.delete(id);
			}
		});
	}
	const waits = new Set<Promise<void>>();
	for (const id of trackIds) {
		const p = inflight.get(id);
		if (p) waits.add(p);
	}
	if (waits.size > 0) await Promise.all(waits);
}

// True when every supplied id has SETTLED membership — fetched, not just
// pre-seeded by an in-flight batch. The filter pipeline gates `#tag`
// evaluation on this so it never paints results computed from placeholders.
export function areTracksSettled(trackIds: readonly string[]): boolean {
	return trackIds.every((id) => tagsByTrackId.has(id) && !inflight.has(id));
}

// Synchronous read for renderers. Returns [] when the track hasn't been
// loaded yet — callers should kick ensureTracksLoaded() in their data path.
// (The "[] until loaded" semantic means the row paints without tags at first
// and re-paints when the batch returns; same shape as our peaks/analysis
// stores.)
export function getTagsForTrack(trackId: string): readonly string[] {
	return tagsByTrackId.get(trackId) ?? [];
}

// Invalidate cached memberships — call after a track is re-tagged via
// addTrackTag / removeTrackTag so the next render reflects the change.
export function invalidateTrack(trackId: string): void {
	tagsByTrackId.delete(trackId);
}

export function invalidateAllMembership(): void {
	tagsByTrackId.clear();
}

// Patch the per-track membership cache to reflect a single-tag diff that just
// landed in the DB, then fan out a change event so every consumer
// (NowPlayingCard's tagsRev signal, the omnibar tag autocomplete list, the
// TagPickerDialog membership memo) re-paints with the new state.
//
// Patch-in-place instead of invalidate-and-refetch: TagPickerDialog reads
// `getTagsForTrack` synchronously inside its membership memo, so clearing the
// entry would make every chip render in the 'none' state until a background
// batch fetch repopulated it — the click would look like a no-op. Same shape
// as commitPlaylistChanges patching its local playlistMembership map.
export function applyTagDiff(
	tagId: string,
	addToTrackIds: readonly string[],
	removeFromTrackIds: readonly string[],
): void {
	for (const trackId of addToTrackIds) {
		const cur = tagsByTrackId.get(trackId);
		if (!cur) { tagsByTrackId.set(trackId, [tagId]); continue; }
		if (!cur.includes(tagId)) tagsByTrackId.set(trackId, [...cur, tagId]);
	}
	for (const trackId of removeFromTrackIds) {
		const cur = tagsByTrackId.get(trackId);
		if (!cur) continue;
		const next = cur.filter((t) => t !== tagId);
		if (next.length !== cur.length) tagsByTrackId.set(trackId, next);
	}
	for (const cb of tagsChangedListeners) {
		try { cb(); } catch (err) { slog.error('tagsStore listener threw', err); }
	}
}

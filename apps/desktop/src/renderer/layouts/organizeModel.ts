// Pure model + classification helpers for the Organize modal, split out of the
// .tsx so they can be unit-tested without pulling in the Solid JSX runtime
// (importing the component eagerly evaluates its module-level JSX consts).
// The component and its tests both import from here.

export type OrganizeSource = 'spotify' | 'tidal' | 'rekordbox' | 'local';
export type OrganizeKind = 'tag' | 'playlist';
export type ColKey = 'tag' | 'local' | 'stream';

export interface OrganizeItem {
	id: string;
	kind: OrganizeKind;
	name: string;
	// Playlists carry their real source; tags set 'local' (unread — tags are
	// coloured/columned by kind, not source).
	source: OrganizeSource;
	// Folder ancestry (root-first) for playlists; joined with " / " for search
	// + the path sub-label. Tags omit it.
	folderPath?: readonly string[];
	// False for streaming playlists owned by another user — the row renders
	// disabled (can't push add/remove upstream). Tags are always owned.
	ownedByMe: boolean;
	// Optional tag colour (from the Tag row). Used as the check-fill accent.
	color?: string | null;
}

export const COL_TITLE: Record<ColKey, string> = {
	tag: 'Tags',
	local: 'Local · Rekordbox',
	stream: 'Streaming · Spotify',
};

export type Tristate = 'all' | 'some' | 'none';
// The three-state cycle is the heart of the picker: none → add-all, some →
// add-to-the-missing, all → remove-all.
export function tristate(count: number, total: number): Tristate {
	if (total === 0 || count === 0) return 'none';
	if (count >= total) return 'all';
	return 'some';
}

// Which of the three columns an item lives in. Tags first; playlists split by
// whether the source is local-side (Rekordbox/local) or streaming.
export function columnOf(it: OrganizeItem): ColKey {
	if (it.kind === 'tag') return 'tag';
	return it.source === 'rekordbox' || it.source === 'local' ? 'local' : 'stream';
}

// data-source drives per-source colour via CSS (tag=accent, rekordbox/local=
// orange, spotify=green, tidal=fg).
export function dataSource(it: OrganizeItem): string {
	return it.kind === 'tag' ? 'tag' : it.source;
}

export function pathString(it: OrganizeItem): string {
	return it.folderPath && it.folderPath.length ? it.folderPath.join(' / ') : '';
}

const SOURCE_LABEL: Record<OrganizeSource, string> = {
	spotify: 'Spotify', tidal: 'Tidal', rekordbox: 'Rekordbox', local: 'Curator',
};

// Hover text for a chip/pill — the chip itself shows only the name, so the
// tooltip carries the source + folder path that disambiguate same-named
// playlists across Spotify / Tidal / Rekordbox. "Tidal playlist: Warm
// hypnotic electronica", "Rekordbox playlist: Sets / SetX / Opening".
export function describeItem(it: OrganizeItem): string {
	if (it.kind === 'tag') return `Tag: ${it.name}`;
	const path = pathString(it);
	return `${SOURCE_LABEL[it.source]} playlist: ${path ? `${path} / ` : ''}${it.name}`;
}

// What a column's inline "Create …" row would create for the search query, or
// null when it shouldn't show. Exact-name matching is case-insensitive.
// Tags and Local create curator-side rows; Streaming creates a real playlist on
// the user's Spotify account, so it's offered only when Spotify is connected and
// is deduped against Spotify playlists alone (a same-named local playlist
// isn't a reason to refuse a Spotify one). Tidal has no write adapter.
export type CreateKind = 'tag' | 'playlist' | 'spotify-playlist';
export function createKindFor(
	key: ColKey,
	query: string,
	items: readonly OrganizeItem[],
	canCreateStreaming: boolean,
): CreateKind | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	const named = (pred: (it: OrganizeItem) => boolean): boolean =>
		items.some((it) => pred(it) && it.name.toLowerCase() === q);
	if (key === 'tag') return named((it) => it.kind === 'tag') ? null : 'tag';
	if (key === 'local') return named((it) => it.kind === 'playlist') ? null : 'playlist';
	if (!canCreateStreaming) return null;
	return named((it) => it.kind === 'playlist' && it.source === 'spotify') ? null : 'spotify-playlist';
}

// Reorder a ranked list so the FIRST PAGE carries at least `minPerKind` of
// each kind that exists in the list (when available) — raw affinity scores
// favour big playlists, so a straight top-N slice can bury every tag behind
// two "more…" clicks. Order is otherwise preserved: page-1 picks run down the
// ranking, skipping items only when the remaining slots are reserved for an
// underrepresented kind; everything else follows in original order for the
// pager. Pure + generic for unit tests.
export function balanceFirstPage<T>(
	list: readonly T[],
	kindOf: (item: T) => string,
	pageSize: number,
	minPerKind: number,
): T[] {
	if (list.length <= pageSize) return [...list];
	// Quota per kind = what we want on page 1, capped by availability.
	const avail = new Map<string, number>();
	for (const it of list) avail.set(kindOf(it), (avail.get(kindOf(it)) ?? 0) + 1);
	const quota = new Map<string, number>();
	for (const [k, n] of avail) quota.set(k, Math.min(minPerKind, n));
	const page: T[] = [];
	const rest: T[] = [];
	for (const it of list) {
		if (page.length >= pageSize) { rest.push(it); continue; }
		const k = kindOf(it);
		const q = quota.get(k) ?? 0;
		// Slots not yet earmarked for OTHER kinds' unmet quotas.
		let reserved = 0;
		for (const [ok, oq] of quota) if (ok !== k) reserved += oq;
		if (q > 0) {
			page.push(it);
			quota.set(k, q - 1);
		} else if (pageSize - page.length > reserved) {
			page.push(it);
		} else {
			rest.push(it);
		}
	}
	return [...page, ...rest];
}

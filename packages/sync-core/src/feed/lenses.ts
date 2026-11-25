// Standing lenses on the Discover feed: typed predicates the user (or the
// assistant, on the user's explicit "from now on…") sets once and the feed
// obeys until the chip is removed. Filter, never re-rank: a lens only hides.
//
// Stored as one JSON list under the account setting `feed.lenses` (synced, so
// every device shows the same feed). The label is the user's own words — the
// chip shows exactly what they asked for, which is the confirmation; there is
// no dialog.
//
// Pure: no DB, no I/O. The signals a rule reads come in as an ArtistSignals
// snapshot built by the ports (library + set plays from curator.db, archive
// counts from feed.db), so this module runs wherever the feed service runs.

import { artistKey } from '@curator/shared';
import type { FeedItem } from './types.js';

export const FEED_LENSES_SETTING = 'feed.lenses';

export type FeedLensRule =
	| { kind: 'genre'; value: string }
	| { kind: 'label'; value: string }
	// has:false = "artists I don't have"; has:true = "only artists I already have".
	| { kind: 'library-artist'; has: boolean }
	// Hide items whose artist the user archived or dismissed at least N times.
	| { kind: 'archived-artist'; atLeast: number }
	// Only items by an artist with at least N plays in rekordbox sets.
	| { kind: 'set-artist'; atLeast: number };

export type FeedLensKind = FeedLensRule['kind'];

export interface FeedLens {
	id: string;
	label: string;
	rule: FeedLensRule;
	by: 'user' | 'assistant';
	createdAt: number;
	// Read-side only, never stored: a lens a newer Curator wrote, whose kind
	// this build can't evaluate. Shown as a chip (so it can be removed, and so
	// the other device's feed isn't silently overwritten) but filters nothing.
	inert?: true;
}

export const MAX_LENSES = 12;
export const MAX_LENS_LABEL = 80;
const KINDS: ReadonlySet<string> = new Set<FeedLensKind>(['genre', 'label', 'library-artist', 'archived-artist', 'set-artist']);
const ARTIST_KINDS: ReadonlySet<string> = new Set<FeedLensKind>(['library-artist', 'archived-artist', 'set-artist']);

// The per-artist facts artist lenses read. Keys are `id:<spotifyArtistId>` and
// `name:<artistKey(name)>` (artistKey is the fold artist.name_ascii stores, so
// a feed credit and a library artist meet on the same string).
export interface ArtistSignals {
	library: ReadonlySet<string>;
	setPlays: ReadonlyMap<string, number>;
	archives: ReadonlyMap<string, number>;
}

export const EMPTY_SIGNALS: ArtistSignals = { library: new Set(), setPlays: new Map(), archives: new Map() };

export function idKey(spotifyArtistId: string): string {
	return `id:${spotifyArtistId}`;
}

export function nameKey(name: string): string | null {
	const k = artistKey(name);
	return k ? `name:${k}` : null;
}

// One artist on an item, with the keys it can match under (id first).
export interface ItemArtist {
	name: string;
	keys: string[];
}

// The artists a lens judges an item by: payload.artists aligned with
// payload.artistIds. For a track, its credits; for an album, the album-level
// primaries only — per-track guests on a compilation don't decide the card.
// The cloud producer writes '' for an artist without a Spotify id, so an
// empty id falls back to the name.
export function itemArtists(payload: { artists?: readonly string[] | null; artistIds?: readonly string[] | null }): ItemArtist[] {
	const names = payload.artists ?? [];
	const ids = payload.artistIds ?? [];
	const out: ItemArtist[] = [];
	for (let i = 0; i < names.length; i++) {
		const name = names[i] ?? '';
		const keys: string[] = [];
		const id = ids[i];
		if (id) keys.push(idKey(id));
		const nk = nameKey(name);
		if (nk) keys.push(nk);
		if (keys.length > 0) out.push({ name, keys });
	}
	return out;
}

function inSet(a: ItemArtist, set: ReadonlySet<string>): boolean {
	return a.keys.some((k) => set.has(k));
}

// Id first: a Spotify id is an identity, a folded name can be a namesake.
function countOf(a: ItemArtist, map: ReadonlyMap<string, number>): number {
	for (const k of a.keys) {
		const n = map.get(k);
		if (n !== undefined) return n;
	}
	return 0;
}

export function isArtistLens(lens: FeedLens): boolean {
	return !lens.inert && ARTIST_KINDS.has(lens.rule.kind);
}

export function hasArtistLens(lenses: readonly FeedLens[]): boolean {
	return lenses.some(isArtistLens);
}

// Whether an item survives every artist lens. genre/label lenses are applied
// in SQL by the store and are ignored here. An item with no matchable artist
// passes "artists I don't have" and fails "only artists I have / played".
export function passesArtistLenses(artists: readonly ItemArtist[], lenses: readonly FeedLens[], signals: ArtistSignals): boolean {
	for (const lens of lenses) {
		if (lens.inert) continue;
		const r = lens.rule;
		switch (r.kind) {
			case 'library-artist': {
				const any = artists.some((a) => inSet(a, signals.library));
				if (r.has !== any) return false;
				break;
			}
			case 'archived-artist':
				if (artists.some((a) => countOf(a, signals.archives) >= r.atLeast)) return false;
				break;
			case 'set-artist':
				if (!artists.some((a) => countOf(a, signals.setPlays) >= r.atLeast)) return false;
				break;
			default:
				break;
		}
	}
	return true;
}

export function passes(item: Pick<FeedItem, 'payload'>, lenses: readonly FeedLens[], signals: ArtistSignals): boolean {
	return passesArtistLenses(itemArtists(item.payload), lenses, signals);
}

// The genre/label lenses as the store's SQL filter.
export function sqlFilterOf(lenses: readonly FeedLens[]): { genre?: string; label?: string } {
	const out: { genre?: string; label?: string } = {};
	for (const l of lenses) {
		if (l.inert) continue;
		if (l.rule.kind === 'genre') out.genre = l.rule.value;
		if (l.rule.kind === 'label') out.label = l.rule.value;
	}
	return out;
}

export function defaultLabel(rule: FeedLensRule): string {
	switch (rule.kind) {
		case 'genre': return rule.value;
		case 'label': return `Label: ${rule.value}`;
		case 'library-artist': return rule.has ? 'Artists I have' : 'Artists I don’t have';
		case 'archived-artist': return `Hide artists archived ${rule.atLeast}+ times`;
		case 'set-artist': return rule.atLeast <= 1 ? 'Artists I’ve played in sets' : `Artists with ${rule.atLeast}+ set plays`;
	}
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 10_000) : null);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// A rule from untrusted input (the assistant's tool args, IPC, a synced value),
// or null when it isn't a valid rule of a kind this build knows.
export function parseRule(raw: unknown): FeedLensRule | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	switch (r['kind']) {
		case 'genre': case 'label': {
			const value = nonEmpty(r['value']);
			return value ? { kind: r['kind'], value } : null;
		}
		case 'library-artist':
			return typeof r['has'] === 'boolean' ? { kind: 'library-artist', has: r['has'] } : null;
		case 'archived-artist': case 'set-artist': {
			const atLeast = posInt(r['atLeast']);
			return atLeast ? { kind: r['kind'], atLeast } : null;
		}
		default:
			return null;
	}
}

function cleanLabel(label: unknown, rule: FeedLensRule | null): string {
	const s = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim() : '';
	const out = s || (rule ? defaultLabel(rule) : 'Lens');
	return out.length > MAX_LENS_LABEL ? `${out.slice(0, MAX_LENS_LABEL - 1)}…` : out;
}

// The stored list, read back. Malformed entries are dropped; a well-formed
// lens of a kind this build doesn't know is kept, marked inert, with its rule
// passed through untouched so writing the list back preserves it.
export function normalizeLenses(raw: unknown): FeedLens[] {
	if (!Array.isArray(raw)) return [];
	const out: FeedLens[] = [];
	const seenKinds = new Set<string>();
	for (const e of raw) {
		if (!e || typeof e !== 'object') continue;
		const o = e as Record<string, unknown>;
		const id = nonEmpty(o['id']);
		const ruleRaw = o['rule'];
		const kind = ruleRaw && typeof ruleRaw === 'object' ? (ruleRaw as Record<string, unknown>)['kind'] : undefined;
		if (!id || typeof kind !== 'string' || seenKinds.has(kind)) continue;
		const by = o['by'] === 'assistant' ? 'assistant' : 'user';
		const createdAt = typeof o['createdAt'] === 'number' ? o['createdAt'] : 0;
		if (!KINDS.has(kind)) {
			seenKinds.add(kind);
			out.push({ id, label: cleanLabel(o['label'], null), rule: ruleRaw as FeedLensRule, by, createdAt, inert: true });
			continue;
		}
		const rule = parseRule(ruleRaw);
		if (!rule) continue;
		seenKinds.add(kind);
		out.push({ id, label: cleanLabel(o['label'], rule), rule, by, createdAt });
		if (out.length >= MAX_LENSES) break;
	}
	return out;
}

// The list as stored (no read-side fields).
export function serializeLenses(lenses: readonly FeedLens[]): Omit<FeedLens, 'inert'>[] {
	return lenses.map(({ inert: _inert, ...l }) => l);
}

// Add (or replace) the lens of `rule.kind`: one lens per kind, newest wins.
export function withLens(
	lenses: readonly FeedLens[],
	input: { rule: FeedLensRule; label?: string | null; by: 'user' | 'assistant' },
	now: number = Date.now(),
	newId: () => string = () => globalThis.crypto.randomUUID(),
): FeedLens[] {
	const rest = lenses.filter((l) => l.rule.kind !== input.rule.kind);
	if (rest.length >= MAX_LENSES) throw new Error(`at most ${MAX_LENSES} lenses`);
	return [...rest, { id: newId(), label: cleanLabel(input.label, input.rule), rule: input.rule, by: input.by, createdAt: now }];
}

export function withoutLens(lenses: readonly FeedLens[], id: string): FeedLens[] {
	return lenses.filter((l) => l.id !== id);
}

export function withoutKind(lenses: readonly FeedLens[], kind: FeedLensKind): FeedLens[] {
	return lenses.filter((l) => l.rule.kind !== kind);
}

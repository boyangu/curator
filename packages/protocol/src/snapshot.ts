// Snapshot body: the reducer's raw `LibraryState` as canonical JSON.
//
// Raw state rather than the materialised view, because the view has no
// clocks: an op pulled after the snapshot must merge onto exactly the records
// a full replay would have, and the reducer's rules are functions of those
// clocks. The same state folded from the same ops always serialises to the
// same string (maps as key-sorted entry lists, object keys sorted), so two
// builds can be compared byte for byte.
//
// Only the JSON half lives here. Compression is the transport's
// (`SNAPSHOT_STORAGE_ENCODING`, cloud-service.ts) and each runtime does it
// with its own primitives (node:zlib on the desktop, a JS or native inflater
// on the phone), which keeps this package free of node:* imports.

import { createLibraryState, type LibraryState } from './state.js';

export const SNAPSHOT_FORMAT = 'curator.library-state';
export const SNAPSHOT_FORMAT_VERSION = 1;

// Every map in `LibraryState`, named once. `satisfies` makes a field added to
// the state a compile error here until it is listed, instead of a snapshot
// that silently drops it.
const STATE_KEYS = {
	tags: true,
	trackTags: true,
	playlists: true,
	playlistFolders: true,
	playlistTracks: true,
	libraryTracks: true,
	cues: true,
	pinnedSearches: true,
	settings: true,
	playSessions: true,
	playEvents: true,
	claims: true,
	upstreamAcks: true,
	merges: true,
	recordingAlias: true,
	artistAliases: true,
	artistAlias: true,
	feedItems: true,
	feedSuppressions: true,
	albums: true,
	tombstones: true,
} as const satisfies Record<keyof LibraryState, true>;

type StateKey = keyof typeof STATE_KEYS;

// Maps added after format v1 was first written (protocol v2's artist
// aliases, v4's feed decisions and releases). Adding a map is additive: an
// older reader ignores it, and a snapshot an older server built simply has
// none of them, so a missing one reads as empty instead of failing the
// bootstrap. (An older reader that ignored one has to re-read it once it
// can: the desktop re-bootstraps once after its v4 upgrade.)
const ADDED_MAPS: ReadonlySet<StateKey> = new Set(['artistAliases', 'artistAlias', 'feedItems', 'feedSuppressions', 'albums']);
const KEYS = Object.keys(STATE_KEYS) as StateKey[];

// Plain code-unit order: stable across runtimes, unlike localeCompare.
const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

function canonical(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonical);
	if (v instanceof Map) throw new TypeError('nested Map in library state');
	if (v !== null && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort()) {
			const x = (v as Record<string, unknown>)[k];
			// JSON drops undefined anyway; skipping it here keeps the key-order
			// claim true for what is actually written.
			if (x !== undefined) out[k] = canonical(x);
		}
		return out;
	}
	return v;
}

export function serializeLibraryState(state: LibraryState): string {
	const extra = Object.keys(state).filter((k) => !(k in STATE_KEYS));
	if (extra.length > 0) throw new TypeError(`library state has fields the snapshot codec does not know: ${extra.join(', ')}`);
	const maps: Record<string, unknown> = {};
	for (const k of KEYS) maps[k] = [...(state[k] as Map<string, unknown>).entries()].sort(byKey).map(([key, value]) => [key, canonical(value)]);
	return JSON.stringify({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_FORMAT_VERSION, maps });
}

// ── streaming form ──────────────────────────────────────────────────────────
// The same JSON as `serializeLibraryState`, byte for byte, written from one
// sorted entry source per map instead of a whole `LibraryState`: the master
// device publishes the account's snapshot from its persisted records
// ('snapshot_storage', cloud-service.ts), and the main library's is 227 MB of
// JSON — one string of it, or the whole state in memory at once, is what the
// streaming form exists to avoid. The server's verifier compares sha256 of
// the JSON with its own fold at the same seq, so this must never drift from
// `serializeLibraryState`: same map order, same key order, same `canonical`
// values, same per-entry `JSON.stringify([key, value])` (protocol tests pin
// it on random states).

export type LibraryStateMapName = StateKey;
// Every map, in the order the snapshot writes them.
export const LIBRARY_STATE_MAPS: readonly LibraryStateMapName[] = KEYS;

// The entry order inside a map: plain UTF-16 code-unit order. Not SQLite's
// BINARY collation, which is UTF-8 byte (code point) order: the two differ
// where a surrogate pair meets a character in U+E000..U+FFFF.
export function compareSnapshotKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// `source(map)` is called once per map, in LIBRARY_STATE_MAPS order, and
// must yield that map's entries in compareSnapshotKeys order: a key out of
// order or repeated throws rather than write a snapshot that differs from
// the fold. Yields the JSON in pieces (one entry each, plus the frame); their
// concatenation is the document.
export function* serializeLibraryStateChunks(source: (map: LibraryStateMapName) => Iterable<readonly [string, unknown]>): Generator<string, void, undefined> {
	// `{"format":…,"version":1` exactly as JSON.stringify writes the object's
	// head, then the maps.
	yield `${JSON.stringify({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_FORMAT_VERSION }).slice(0, -1)},"maps":{`;
	for (let i = 0; i < KEYS.length; i++) {
		const k = KEYS[i]!;
		yield `${i === 0 ? '' : ','}${JSON.stringify(k)}:[`;
		let prev: string | null = null;
		for (const [key, value] of source(k)) {
			if (prev !== null && !(prev < key)) throw new TypeError(`snapshot entries of ${k} out of order or repeated at ${JSON.stringify(key)}`);
			yield `${prev === null ? '' : ','}${JSON.stringify([key, canonical(value)])}`;
			prev = key;
		}
		yield ']';
	}
	yield '}}';
}

export class SnapshotFormatError extends Error {
	override readonly name = 'SnapshotFormatError';
}

export function deserializeLibraryState(json: string): LibraryState {
	const doc = JSON.parse(json) as { format?: unknown; version?: unknown; maps?: Record<string, unknown> };
	if (doc.format !== SNAPSHOT_FORMAT || doc.version !== SNAPSHOT_FORMAT_VERSION || !doc.maps || typeof doc.maps !== 'object') {
		throw new SnapshotFormatError(`not a ${SNAPSHOT_FORMAT} v${SNAPSHOT_FORMAT_VERSION} snapshot`);
	}
	const state = createLibraryState();
	for (const k of KEYS) {
		const entries = doc.maps[k];
		if (entries === undefined && ADDED_MAPS.has(k)) continue;
		if (!Array.isArray(entries)) throw new SnapshotFormatError(`snapshot is missing ${k}`);
		const map = state[k] as Map<string, unknown>;
		for (const e of entries) {
			if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') throw new SnapshotFormatError(`malformed entry in ${k}`);
			map.set(e[0], e[1]);
		}
	}
	return state;
}

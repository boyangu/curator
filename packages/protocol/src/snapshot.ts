// Snapshot body: the reducer's raw `LibraryState` as canonical JSON.
//
// Raw state rather than the materialised view, because the view has no
// clocks: an op pulled after the snapshot must merge onto exactly the records
// a full replay would have, and the reducer's rules are functions of those
// clocks. The same state folded from the same ops always serialises to the
// same string (maps as key-sorted entry lists, object keys sorted), so two
// builds can be compared byte for byte.
//
// Only the JSON half lives here. Compression and base64 are the transport's
// (`SNAPSHOT_ENCODING`) and each runtime does them with its own primitives
// (node:zlib on the server and desktop, a JS or native inflater on the
// phone), which keeps this package free of node:* imports.

import { createLibraryState, type LibraryState } from './state.js';

export const SNAPSHOT_FORMAT = 'curator.library-state';
export const SNAPSHOT_FORMAT_VERSION = 1;
// What `sync.bootstrap`'s `snapshot` string is: this JSON, gzipped, base64.
export const SNAPSHOT_ENCODING = 'curator.library-state.v1+json+gzip+base64';

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
	tombstones: true,
} as const satisfies Record<keyof LibraryState, true>;

type StateKey = keyof typeof STATE_KEYS;

// Maps added after format v1 was first written (protocol v2's artist
// aliases). Adding a map is additive: an older reader ignores it, and a
// snapshot an older server built simply has no rules, so a missing one
// reads as empty instead of failing the bootstrap.
const ADDED_MAPS: ReadonlySet<StateKey> = new Set(['artistAliases', 'artistAlias']);
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

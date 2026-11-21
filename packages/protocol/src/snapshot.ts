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

// ── reading it as it arrives ────────────────────────────────────────────────
// The same document taken apart without ever holding it: a device loading
// the account's snapshot feeds the inflated text in pieces and gets each
// entry back as its own JSON text, map by map in the order written. The main
// library's snapshot is ~250 MB of JSON and ~310k entries; parsed in one go
// it is about a gigabyte of objects before a single row is written (measured
// 2026-11-20: a join peaked at 3 GB on the desktop and could not run on a
// phone).
//
// It leans on what the writers above guarantee: the exact head, maps as
// arrays of `["key", value]` entries with no whitespace anywhere. An entry
// then ends at the first `]` that is followed by the next entry (`,["`), by
// the next map (`],"`) or by the end of the document (`]}}`) AND closes the
// text into valid JSON. The second half matters: a value may itself hold
// `]],"` or `]]}}`, and a cut there leaves an array unclosed, which
// JSON.parse refuses — so the scan moves on to the next candidate. (A proper
// prefix of an array's text is never itself valid JSON.)

export type SnapshotEntry = { map: string; json: string };

const HEAD = `${JSON.stringify({ format: SNAPSHOT_FORMAT, version: SNAPSHOT_FORMAT_VERSION }).slice(0, -1)},"maps":{`;
// How far the scan may look for something it cannot find before the text is
// declared not a snapshot rather than buffered without end.
const MAX_NAME = 256;
// What can follow an entry's closing bracket: the next entry, the next map,
// the end of the document.
const TAILS = ['],["', ']],"', ']]}}'] as const;

export class SnapshotEntryScanner {
	private buf = '';
	private at = 0;
	private stage: 'head' | 'map' | 'entries' | 'done' = 'head';
	private map = '';
	private firstMap = true;
	private firstEntry = true;
	// Where the search for the current entry's end resumes, so a long entry
	// split over many pieces is not rescanned from its start each time.
	private searchFrom = 0;
	// Per tail: where it next occurs (-1: nowhere in the text searched), from
	// where that search started, and how long the text was. The next map and
	// the end of the document are megabytes ahead of most entries: looking
	// for them afresh from every entry read the whole buffer a thousand
	// times a megabyte, which an engine with a plain indexOf did not survive
	// (QuickJS, 2026-11-20). Each stretch of text is searched once per tail.
	private readonly next = [-1, -1, -1];
	private readonly nextFrom = [0, 0, 0];
	private readonly nextLen = [0, 0, 0];

	private find(i: number, from: number): number {
		const cached = this.next[i]!;
		if (cached >= from) return cached;
		const tail = TAILS[i]!;
		let start = from;
		if (cached < 0 && this.nextFrom[i]! <= from) {
			// Nothing up to the text there was then: only what arrived since.
			if (this.nextLen[i] === this.buf.length) return -1;
			start = Math.max(from, this.nextLen[i]! - (tail.length - 1));
		}
		const pos = this.buf.indexOf(tail, start);
		this.next[i] = pos;
		this.nextFrom[i] = from;
		this.nextLen[i] = this.buf.length;
		return pos;
	}

	// The entries completed by this piece, in order.
	push(chunk: string): SnapshotEntry[] {
		if (this.at > 0) {
			this.buf = this.buf.slice(this.at);
			this.searchFrom = Math.max(0, this.searchFrom - this.at);
			for (let i = 0; i < TAILS.length; i++) {
				// A position behind the cut is consumed: forget it and search again.
				if (this.next[i]! >= this.at) this.next[i]! -= this.at;
				else if (this.next[i]! >= 0) { this.next[i] = -1; this.nextFrom[i] = 0; this.nextLen[i] = 0; continue; }
				this.nextFrom[i] = Math.max(0, this.nextFrom[i]! - this.at);
				this.nextLen[i] = Math.max(0, this.nextLen[i]! - this.at);
			}
			this.at = 0;
		}
		this.buf += chunk;
		const out: SnapshotEntry[] = [];
		const buf = this.buf;
		for (;;) {
			if (this.stage === 'head') {
				if (buf.length < HEAD.length) {
					if (!HEAD.startsWith(buf)) throw new SnapshotFormatError(`not a ${SNAPSHOT_FORMAT} v${SNAPSHOT_FORMAT_VERSION} snapshot`);
					return out;
				}
				if (!buf.startsWith(HEAD)) throw new SnapshotFormatError(`not a ${SNAPSHOT_FORMAT} v${SNAPSHOT_FORMAT_VERSION} snapshot`);
				this.at = HEAD.length;
				this.stage = 'map';
			} else if (this.stage === 'map') {
				// `}}` ends the document; else `"name":[`, after a comma from the second map on.
				if (buf.length - this.at < 2) return out;
				if (buf.startsWith('}}', this.at)) {
					this.at += 2;
					this.stage = 'done';
					continue;
				}
				let p = this.at;
				if (!this.firstMap) {
					if (buf[p] !== ',') throw new SnapshotFormatError('malformed snapshot: expected the next map');
					p++;
				}
				if (p >= buf.length) return out;
				if (buf[p] !== '"') throw new SnapshotFormatError('malformed snapshot: expected a map name');
				const end = buf.indexOf('":[', p + 1);
				if (end < 0) {
					if (buf.length - p > MAX_NAME) throw new SnapshotFormatError('malformed snapshot: a map name without its entries');
					return out;
				}
				this.map = buf.slice(p + 1, end);
				this.at = end + 3;
				this.stage = 'entries';
				this.firstMap = false;
				this.firstEntry = true;
				this.searchFrom = this.at;
			} else if (this.stage === 'entries') {
				if (this.at >= buf.length) return out;
				if (buf[this.at] === ']') {
					this.at++;
					this.stage = 'map';
					continue;
				}
				let start = this.at;
				if (!this.firstEntry) {
					if (buf[start] !== ',') throw new SnapshotFormatError(`malformed entry in ${this.map}`);
					start++;
				}
				if (start >= buf.length) return out;
				if (buf[start] !== '[') throw new SnapshotFormatError(`malformed entry in ${this.map}`);
				let from = Math.max(this.searchFrom, start);
				let found = -1;
				for (;;) {
					// The nearest `]` followed by one of the three things that can follow an entry.
					let q = -1;
					for (let t = 0; t < TAILS.length; t++) {
						const i = this.find(t, from);
						if (i >= 0 && (q < 0 || i < q)) q = i;
					}
					if (q < 0) break;
					try {
						JSON.parse(buf.slice(start, q + 1));
						found = q;
						break;
					} catch {
						from = q + 1;
					}
				}
				if (found < 0) {
					// Not here yet. A tail may straddle the end of this piece: resume a few characters back.
					this.searchFrom = Math.max(from, buf.length - 3);
					return out;
				}
				out.push({ map: this.map, json: buf.slice(start, found + 1) });
				this.at = found + 1;
				this.searchFrom = this.at;
				this.firstEntry = false;
			} else {
				if (this.at < buf.length) throw new SnapshotFormatError('malformed snapshot: text after its end');
				return out;
			}
		}
	}

	// After the last piece: throws unless the document was whole.
	end(): void {
		if (this.stage !== 'done') throw new SnapshotFormatError('the snapshot ends before its document does');
	}
}

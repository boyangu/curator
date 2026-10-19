// Shared query grammar for the omnibar (global quick-open) and the tracklist
// filterbox. Same parser, same evaluator, two surfaces.
//
// Grammar:
//
//   expr      := orExpr
//   orExpr    := andExpr (OR_OP orExpr)?
//   andExpr   := primary (AND_OP? primary)*          // implicit AND between terms
//   primary   := '(' expr ')' | term
//   term      := tag | source | attr | cmp | free
//
//   tag       := '#' name (',' name)*                // names can be quoted
//   source    := ('source'|'src') (':'|'={') value   // source membership
//   attr      := ident ':' value                     // substring in attribute
//              | ident '=' '{' value '}'             // exact match in attribute
//   cmp       := ident OP number                     //   bpm<120, rating>=4
//              | ident '=' number                    //   bpm=122, rating=5
//              | number OP ident                     //   120<bpm
//              | number OP ident OP number           //   120<=bpm<=122
//   free      := QSTRING | BAREWORD                  // global substring (all attrs)
//
//   OP        := '<' | '<=' | '>' | '>='
//   AND_OP    := '&' | 'AND' (case-insensitive)
//   OR_OP     := '|' | 'OR' (case-insensitive)
//
// Examples (all valid):
//
//   ben böhmer                       — two bare terms, AND across all attrs
//   "ben böhmer"                     — phrase, AND across all attrs
//   ben artist:böhmer                — bare ben AND substring 'böhmer' in artist
//   artist={Ben Böhmer}              — exact artist
//   bpm<120                          — bpm comparison
//   bpm=122                          — numeric equality (works for any number field)
//   rating>=4                        — rating bound
//   120<=bpm<=122                    — bpm range
//   #deep #balkan                    — two tag MUSTs (AND)
//   (#b1 | #b2) & #p3                — boolean grouping
//   source:rekordbox ben             — only tracks in the Rekordbox collection
//   (source:rekordbox | source:local) — any-of membership (the Rekordbox tab root)
//
// Precedence (high → low): parens, NOT (n/a), AND, OR. Implicit AND has the
// same precedence as explicit AND/&. So `a OR b c` reads as `a OR (b AND c)`.

import type { Track } from '@curator/shared';
import { searchFold } from '@curator/shared';
import { KEY_MAP } from './music-utils.js';

// Musical spelling of a Camelot key, ASCII-folded (♯→#, ♭→b) so a user typing
// "C#m" matches. Key is stored only as Camelot; musical is derived for search.
function keyMusicalOf(keyCamelot: string | null | undefined): string {
	if (!keyCamelot) return '';
	const name = KEY_MAP[keyCamelot]?.name;
	return name ? name.replace(/♯/g, '#').replace(/♭/g, 'b') : '';
}

// ─── Public AST ─────────────────────────────────────────────────────────────

export interface Bound { value: number; inclusive: boolean }

export type StringField = 'title' | 'artist' | 'album' | 'label' | 'genre' | 'key' | 'artistid' | 'albumid';
export type NumField =
	| 'bpm' | 'time' | 'rating' | 'playcount' | 'dropcount' | 'breakdowncount'
	| 'lra' | 'diss' | 'dens' | 'bright' | 'punch'
	| 'intro' | 'outro' | 'drop';

export type Expr =
	| { kind: 'and'; left: Expr; right: Expr }
	| { kind: 'or'; left: Expr; right: Expr }
	| { kind: 'free'; value: string }                                       // global substring
	| { kind: 'attr'; field: StringField; value: string; exact: boolean }   // attr substring / exact
	| { kind: 'cmp'; field: NumField; min?: Bound; max?: Bound }            // numeric range
	| { kind: 'tag'; name: string }                                         // tag by name
	| { kind: 'source'; value: string }                                     // source membership (source_link ∪ rekordbox)
	| { kind: 'similar'; seeds: string[]; text: string | null }             // AI-engine similarity (SQL pushdown only)
	| { kind: 'true' };                                                     // empty / no constraint

// ─── Attribute resolution ───────────────────────────────────────────────────

// Maps a user-typed identifier (lowercased) to a canonical field id. Aliases
// kept short so the grammar is fast to type. `key` matches both Camelot and
// musical spellings; `artist` indexes into the JSON artists blob.
const STRING_ALIASES: Record<string, StringField> = {
	title: 'title',
	artist: 'artist', artists: 'artist',
	// Curator artist id — what the artist chips / drill menu build. Exact
	// only in practice (`artistid={…}`); pushed to SQL as an indexed EXISTS.
	artistid: 'artistid', aid: 'artistid',
	// Curator album id — the Drill Into ▶ Album scope. Exact only in
	// practice (`albumid={…}`); pushed to SQL as the indexed album_id.
	albumid: 'albumid', alb: 'albumid',
	album: 'album',
	label: 'label',
	genre: 'genre',
	key: 'key',
};

const NUM_ALIASES: Record<string, NumField> = {
	bpm: 'bpm',
	time: 'time', duration: 'time', dur: 'time', length: 'time', len: 'time',
	rating: 'rating', stars: 'rating',
	playcount: 'playcount', plays: 'playcount',
	dropcount: 'dropcount', drops: 'dropcount',
	breakdowncount: 'breakdowncount', breakdowns: 'breakdowncount',
	lra: 'lra', loudness: 'lra', loudnessrange: 'lra',
	diss: 'diss', dissonance: 'diss',
	dens: 'dens', density: 'dens',
	bright: 'bright', brightness: 'bright',
	punch: 'punch', dynamics: 'punch', dynamiccomplexity: 'punch',
	intro: 'intro', introlength: 'intro',
	outro: 'outro', outrolength: 'outro',
	drop: 'drop', firstdrop: 'drop',
};

const canonString = (name: string): StringField | null => STRING_ALIASES[name.toLowerCase()] ?? null;
const canonNum = (name: string): NumField | null => NUM_ALIASES[name.toLowerCase()] ?? null;

// `source:` / `src:` — membership in a provider (spotify / tidal / local /
// beatport, via source_link) or in the Rekordbox collection (rekordbox_link;
// core resolves the 'rekordbox' value). Not a StringField: a track carries a
// SET of sources, not one value, and the SQL pushdown goes to the hasSource
// membership slot rather than the LIKE chain. Unknown values match nothing —
// same shape as a known attr with a value nothing carries.
const isSourceIdent = (name: string): boolean => {
	const n = name.toLowerCase();
	return n === 'source' || n === 'src';
};
const SOURCE_VALUE_ALIASES: Record<string, string> = { rb: 'rekordbox' };
const canonSourceValue = (v: string): string => {
	const n = v.trim().toLowerCase();
	return SOURCE_VALUE_ALIASES[n] ?? n;
};

// Numeric field accessors — null when the track hasn't been analyzed.
const NUM_GETTERS: Record<NumField, (t: Track) => number | null> = {
	bpm:            (t) => t.bpm ?? null,
	time:           (t) => t.duration ?? null,
	rating:         (t) => t.rating ?? null,
	playcount:      (t) => t.playCount ?? null,
	dropcount:      (t) => t.dropCount ?? null,
	breakdowncount: (t) => t.breakdownCount ?? null,
	lra:            (t) => t.loudnessRangeLu ?? null,
	diss:           (t) => t.dissonance ?? null,
	dens:           (t) => t.density ?? null,
	bright:         (t) => t.brightness ?? null,
	punch:          (t) => t.dynamicComplexity ?? null,
	intro:          (t) => t.introLengthSec ?? null,
	outro:          (t) => t.outroLengthSec ?? null,
	drop:           (t) => t.firstDropSec ?? null,
};

// String field accessors — return one or more strings to test against. `key`
// returns both Camelot + musical spellings so the user can type either.
const STRING_GETTERS: Record<StringField, (t: Track) => string[]> = {
	title:  (t) => [t.title ?? ''],
	artist: (t) => (t.artists ?? []).map((a) => a.name),
	artistid: (t) => t.artistIds ?? [],
	albumid: (t) => (t.albumId ? [t.albumId] : []),
	album:  (t) => [t.albumTitle ?? ''],
	label:  (t) => [t.label ?? ''],
	genre:  (t) => [t.genre ?? ''],
	key:    (t) => [t.keyCamelot ?? '', keyMusicalOf(t.keyCamelot)],
};

// Fields scanned by a bare freetext term — every attribute the user might
// reasonably search across. Mirrors the SQL `search` columns in
// service.ts/getTracksImpl plus bpm-as-exact-number.
const FREE_GETTERS: Array<(t: Track) => string | null | undefined> = [
	(t) => t.title,
	(t) => t.albumTitle,
	(t) => t.label,
	(t) => t.genre,
	(t) => t.keyCamelot,
	(t) => keyMusicalOf(t.keyCamelot),
	(t) => (t.artists ?? []).map((a) => a.name).join(' '),
];

// ─── Tokenizer ──────────────────────────────────────────────────────────────

type Tok =
	| { kind: 'lparen' }
	| { kind: 'rparen' }
	| { kind: 'and' }
	| { kind: 'or' }
	| { kind: 'tag'; name: string }
	| { kind: 'attr'; field: StringField; value: string; exact: boolean }
	| { kind: 'cmp'; field: NumField; min?: Bound; max?: Bound }
	| { kind: 'source'; value: string }
	| { kind: 'similar'; seeds: string[]; text: string | null }
	| { kind: 'free'; value: string };

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
// Bareword stops: whitespace, parens, comparison ops. `:` and `=` are NOT in
// the stop set so they can attach attribute names — we strip the attr-prefix
// path before reaching the bareword reader. `&` / `|` are NOT stops either:
// they're boolean operators only when standalone (space-delimited), so glued
// to a word — "&ME", "D&B", "a|b" — they stay part of the bareword. The
// standalone-operator detection lives in the main tokenize loop below.
const isBareStop = (c: string): boolean => isWs(c) || '()<>'.includes(c);
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentCont = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigitStart = (c: string): boolean => /[0-9]/.test(c) || c === '.' || c === '-';

function tokenize(raw: string): Tok[] {
	const out: Tok[] = [];
	const n = raw.length;
	let i = 0;

	const peek = (off = 0): string => raw[i + off] ?? '';
	const eatWs = (): void => { while (i < n && isWs(raw[i]!)) i++; };

	// Quoted string ("…", '…', `…`). Caller has verified the opening quote.
	// Returns the unquoted body; caller advances `i` to just past the closing
	// quote (or end-of-string if the user forgot to close it).
	const readQuoted = (): string => {
		const q = raw[i]!;
		i++;
		const start = i;
		while (i < n && raw[i] !== q) i++;
		const body = raw.slice(start, i);
		if (i < n) i++;
		return body;
	};

	// Bareword scan up to the next stop char. Returns empty string at EOF.
	const readBareword = (extraStop: string = ''): string => {
		const start = i;
		while (i < n) {
			const c = raw[i]!;
			if (isBareStop(c)) break;
			if (extraStop && extraStop.includes(c)) break;
			i++;
		}
		return raw.slice(start, i);
	};

	// Read a numeric literal. Returns null if what follows isn't a number.
	// We accept integer / decimal / negative. Caller restores `i` on null.
	const tryReadNumber = (): { value: number; end: number } | null => {
		const start = i;
		let j = i;
		if (raw[j] === '+' || raw[j] === '-') j++;
		let sawDigit = false;
		while (j < n && raw[j]! >= '0' && raw[j]! <= '9') { j++; sawDigit = true; }
		if (raw[j] === '.') {
			j++;
			while (j < n && raw[j]! >= '0' && raw[j]! <= '9') { j++; sawDigit = true; }
		}
		if (!sawDigit) return null;
		// Must be followed by a stop char, comparison op, or EOF to count as
		// a clean number (so "120abc" doesn't lex as 120 + bareword).
		const next = raw[j] ?? '';
		if (next && !isWs(next) && !'()&|<>'.includes(next)) return null;
		const value = Number(raw.slice(start, j));
		if (!Number.isFinite(value)) return null;
		return { value, end: j };
	};

	// Read a comparison operator at position `i`. Returns the op string and
	// advances past it, or null. Skips leading whitespace.
	const tryReadCmpOp = (): '<' | '<=' | '>' | '>=' | null => {
		const save = i;
		eatWs();
		const c = raw[i] ?? '';
		const c2 = raw[i + 1] ?? '';
		let op: '<' | '<=' | '>' | '>=' | null = null;
		if (c === '<' && c2 === '=') { op = '<='; i += 2; }
		else if (c === '>' && c2 === '=') { op = '>='; i += 2; }
		else if (c === '<') { op = '<'; i += 1; }
		else if (c === '>') { op = '>'; i += 1; }
		if (op === null) { i = save; return null; }
		eatWs();
		return op;
	};

	// Read an identifier (attribute/operator-keyword candidate). Returns the
	// raw text without advancing on failure.
	const tryReadIdent = (): string | null => {
		if (i >= n || !isIdentStart(raw[i]!)) return null;
		const start = i;
		i++;
		while (i < n && isIdentCont(raw[i]!)) i++;
		return raw.slice(start, i);
	};

	// `# … (, …)*` — tag run. Already at the '#'.
	const readTagRun = (): void => {
		i++; // skip '#'
		const readOne = (): string | null => {
			if (i >= n) return null;
			const c = raw[i]!;
			if (c === '"' || c === "'" || c === '`') return readQuoted();
			// Bareword tag name: stop at ',' too (it separates tags within a run)
			// and at '#' (next run).
			const v = readBareword(',#');
			return v.length > 0 ? v : null;
		};
		const first = readOne();
		if (first !== null) out.push({ kind: 'tag', name: first });
		// Comma-list continues the run; we materialize each as a tag MUST so the
		// caller naturally ANDs them via the implicit-AND parser path below.
		while (i < n && raw[i] === ',') {
			i++;
			const nxt = readOne();
			if (nxt !== null) out.push({ kind: 'tag', name: nxt });
		}
	};

	// ident followed by `:` or `={...}` or `<`/`<=`/`>`/`>=`. The caller has
	// already saved `i`; on a non-match we restore and let the bareword path
	// take over.
	const tryReadAttrOrCmp = (): boolean => {
		const save = i;
		const ident = tryReadIdent();
		if (ident === null) return false;
		// AI-engine similarity: `similar:<id>[,<id>…]` / `like:` (seed track
		// ids — what "Find similar" writes) and `sounds:"…"` (a text
		// description). Read before the attr path: neither is a track field.
		const simIdent = ident.toLowerCase();
		if ((simIdent === 'similar' || simIdent === 'like' || simIdent === 'sounds') && (raw[i] === ':' || (raw[i] === '=' && raw[i + 1] === '{'))) {
			const braced = raw[i] === '=';
			i += braced ? 2 : 1;
			const c = raw[i] ?? '';
			let value: string;
			if (c === '"' || c === "'" || c === '`') value = readQuoted();
			else if (braced) {
				const start = i;
				while (i < n && raw[i] !== '}') i++;
				value = raw.slice(start, i).trim();
			} else value = readBareword();
			if (braced && raw[i] === '}') i++;
			if (simIdent === 'sounds') out.push({ kind: 'similar', seeds: [], text: value });
			else out.push({ kind: 'similar', seeds: value.split(',').map((v) => v.trim()).filter(Boolean), text: null });
			return true;
		}
		// `attr:value`
		if (raw[i] === ':') {
			i++; // skip ':'
			const c = raw[i] ?? '';
			let value: string;
			if (c === '"' || c === "'" || c === '`') value = readQuoted();
			else value = readBareword();
			const field = canonString(ident);
			if (field) out.push({ kind: 'attr', field, value, exact: false });
			else if (isSourceIdent(ident)) out.push({ kind: 'source', value: canonSourceValue(value) });
			// Unknown attr name → silently drop (won't filter anything).
			return true;
		}
		// `attr={value}`
		if (raw[i] === '=' && raw[i + 1] === '{') {
			i += 2; // skip '={'
			// Allow quoted body for clarity, but bare body is fine — `}` closes it.
			const c = raw[i] ?? '';
			let value: string;
			if (c === '"' || c === "'" || c === '`') {
				value = readQuoted();
				// Skip trailing `}` if present
				if (raw[i] === '}') i++;
			} else {
				const start = i;
				while (i < n && raw[i] !== '}') i++;
				value = raw.slice(start, i).trim();
				if (raw[i] === '}') i++;
			}
			const field = canonString(ident);
			if (field) out.push({ kind: 'attr', field, value, exact: true });
			else if (isSourceIdent(ident)) out.push({ kind: 'source', value: canonSourceValue(value) });
			return true;
		}
		// `attr=num` — numeric equality (e.g. `bpm=122`, `rating=5`). Lowers
		// to a min==max inclusive range so the existing SQL prefilter and
		// in-memory matcher handle it without a new code path. The `={`
		// string-exact branch above already consumed the curly-brace form.
		if (raw[i] === '=') {
			const save2 = i;
			i++; // skip '='
			const num = tryReadNumber();
			if (num !== null) {
				i = num.end;
				const field = canonNum(ident);
				if (field) {
					out.push({
						kind: 'cmp',
						field,
						min: { value: num.value, inclusive: true },
						max: { value: num.value, inclusive: true },
					});
				}
				return true;
			}
			i = save2; // not a number — let the bareword tail path absorb `=…`
		}
		// `attr<num`, `attr<=num`, `attr>num`, `attr>=num`
		const op = tryReadCmpOp();
		if (op !== null) {
			const num = tryReadNumber();
			if (num === null) { i = save; return false; }
			i = num.end;
			const field = canonNum(ident);
			if (field) {
				if (op === '<' || op === '<=') {
					out.push({ kind: 'cmp', field, max: { value: num.value, inclusive: op === '<=' } });
				} else {
					out.push({ kind: 'cmp', field, min: { value: num.value, inclusive: op === '>=' } });
				}
			}
			return true;
		}
		// Not an attribute construct. Check if the ident is a boolean keyword
		// (AND / OR). Keywords are only recognized when followed by whitespace
		// or end-of-input — otherwise they're part of a bareword.
		const after = raw[i] ?? '';
		if ((after === '' || isWs(after) || '()&|'.includes(after)) && (ident.toLowerCase() === 'and' || ident.toLowerCase() === 'or')) {
			out.push({ kind: ident.toLowerCase() === 'and' ? 'and' : 'or' });
			return true;
		}
		// Plain bareword — but the ident may continue with more bareword chars
		// (e.g. punctuation, `-`). Keep reading and emit as FREE.
		const tail = readBareword();
		out.push({ kind: 'free', value: ident + tail });
		return true;
	};

	// Leading-number paths: a number on its own is a FREE term (matches BPM
	// exact), but `120<bpm` / `120<=bpm<=122` lex as CMP.
	const tryReadLeadingNumber = (): boolean => {
		const save = i;
		const num = tryReadNumber();
		if (num === null) return false;
		// Peek past whitespace for a comparison op.
		const probeEnd = num.end;
		let p = probeEnd;
		while (p < n && isWs(raw[p]!)) p++;
		const c = raw[p] ?? '';
		const c2 = raw[p + 1] ?? '';
		let op1: '<' | '<=' | '>' | '>=' | null = null;
		if (c === '<' && c2 === '=') op1 = '<=';
		else if (c === '>' && c2 === '=') op1 = '>=';
		else if (c === '<') op1 = '<';
		else if (c === '>') op1 = '>';
		if (op1 === null) {
			// Just a bare number — FREE.
			i = probeEnd;
			out.push({ kind: 'free', value: String(num.value) });
			return true;
		}
		// Advance past op1.
		i = p + (op1.length);
		while (i < n && isWs(raw[i]!)) i++;
		const ident = tryReadIdent();
		if (ident === null) {
			// `120<` with no follow-up — treat the number as FREE, leave the op
			// for the next iteration. Restore.
			i = save;
			const n2 = tryReadNumber();
			if (n2 !== null) {
				i = n2.end;
				out.push({ kind: 'free', value: String(n2.value) });
				return true;
			}
			return false;
		}
		const field = canonNum(ident);
		if (!field) { i = save; return false; }
		// Optional second op + number → chained range.
		const op2 = tryReadCmpOp();
		if (op2 !== null) {
			const num2 = tryReadNumber();
			if (num2 === null) { i = save; return false; }
			i = num2.end;
			// `a OP1 field OP2 b` — the directions should agree (both `<*` or
			// both `>*`). Pick the bound that makes sense for each.
			const cmp: { kind: 'cmp'; field: NumField; min?: Bound; max?: Bound } = { kind: 'cmp', field };
			// Treat OP1 as the constraint between `num` (left) and `field`.
			// If OP1 is `<*`, `num <(=) field` → field has a lower bound at `num`.
			// If OP1 is `>*`, `num >(=) field` → field has an upper bound at `num`.
			if (op1 === '<' || op1 === '<=') cmp.min = { value: num.value, inclusive: op1 === '<=' };
			else cmp.max = { value: num.value, inclusive: op1 === '>=' };
			// Same logic for OP2 between `field` and `num2`.
			if (op2 === '<' || op2 === '<=') cmp.max = { value: num2.value, inclusive: op2 === '<=' };
			else cmp.min = { value: num2.value, inclusive: op2 === '>=' };
			out.push(cmp);
			return true;
		}
		// `a OP field` (no second op) — same as `field reverse(OP) a`.
		if (op1 === '<' || op1 === '<=') {
			out.push({ kind: 'cmp', field, min: { value: num.value, inclusive: op1 === '<=' } });
		} else {
			out.push({ kind: 'cmp', field, max: { value: num.value, inclusive: op1 === '>=' } });
		}
		return true;
	};

	while (i < n) {
		eatWs();
		if (i >= n) break;
		const c = raw[i]!;
		if (c === '(') { out.push({ kind: 'lparen' }); i++; continue; }
		if (c === ')') { out.push({ kind: 'rparen' }); i++; continue; }
		// `&` / `|` are boolean operators ONLY when standalone — the next char
		// is whitespace, EOF, or a paren. Glued to a word ("&ME", "D&B", "a|b")
		// they fall through to the bareword path and stay literal, so artist
		// names survive. The spaced form `a & b` still ANDs; so does plain
		// `a b` via implicit AND, so requiring the space costs nothing.
		if (c === '&' || c === '|') {
			const next = peek(1);
			if (next === '' || isWs(next) || next === '(' || next === ')') {
				out.push({ kind: c === '&' ? 'and' : 'or' });
				i++;
				continue;
			}
			// else: not an operator — fall through to the bareword reader.
		}
		if (c === '#') { readTagRun(); continue; }
		if (c === '"' || c === "'" || c === '`') {
			const value = readQuoted();
			out.push({ kind: 'free', value });
			continue;
		}
		// Try leading-number path first (so `120<bpm` doesn't lex as bareword).
		if (isDigitStart(c)) {
			if (tryReadLeadingNumber()) continue;
		}
		// Try attribute / comparison / keyword path.
		if (isIdentStart(c)) {
			if (tryReadAttrOrCmp()) continue;
		}
		// Fallback: bareword FREE.
		const bw = readBareword();
		if (bw.length > 0) out.push({ kind: 'free', value: bw });
		else i++; // unknown single char — skip
	}
	return out;
}

// ─── Parser (recursive descent) ─────────────────────────────────────────────

class Parser {
	private p = 0;
	constructor(private readonly toks: Tok[]) {}

	parse(): Expr {
		const e = this.parseOr();
		// Stray closing parens / trailing tokens are tolerated — we've already
		// consumed everything meaningful. Anything else gets dropped silently
		// since the grammar is user-typed and noisy.
		return e;
	}

	private peek(off = 0): Tok | undefined { return this.toks[this.p + off]; }
	private eat(): Tok | undefined { return this.toks[this.p++]; }

	private parseOr(): Expr {
		let left = this.parseAnd();
		while (this.peek()?.kind === 'or') {
			this.eat();
			const right = this.parseAnd();
			left = { kind: 'or', left, right };
		}
		return left;
	}

	private parseAnd(): Expr {
		let left = this.parsePrimary();
		while (true) {
			const tk = this.peek();
			if (!tk) break;
			if (tk.kind === 'or' || tk.kind === 'rparen') break;
			// Explicit AND eats the token; implicit AND keeps reading without one.
			if (tk.kind === 'and') this.eat();
			const right = this.parsePrimary();
			if (right.kind === 'true') break; // nothing more to consume
			left = left.kind === 'true' ? right : { kind: 'and', left, right };
		}
		return left;
	}

	private parsePrimary(): Expr {
		const tk = this.peek();
		if (!tk) return { kind: 'true' };
		if (tk.kind === 'lparen') {
			this.eat();
			const e = this.parseOr();
			if (this.peek()?.kind === 'rparen') this.eat();
			return e;
		}
		if (tk.kind === 'rparen' || tk.kind === 'and' || tk.kind === 'or') return { kind: 'true' };
		this.eat();
		if (tk.kind === 'tag') return { kind: 'tag', name: tk.name };
		if (tk.kind === 'attr') return { kind: 'attr', field: tk.field, value: tk.value, exact: tk.exact };
		if (tk.kind === 'cmp') return { kind: 'cmp', field: tk.field, min: tk.min, max: tk.max };
		if (tk.kind === 'source') return { kind: 'source', value: tk.value };
		if (tk.kind === 'similar') return { kind: 'similar', seeds: tk.seeds, text: tk.text };
		if (tk.kind === 'free') return { kind: 'free', value: tk.value };
		return { kind: 'true' };
	}
}

export function parseQuery(raw: string): Expr {
	const s = (raw ?? '').trim();
	if (!s) return { kind: 'true' };
	const toks = tokenize(s);
	if (toks.length === 0) return { kind: 'true' };
	return new Parser(toks).parse();
}

// ─── Evaluator ──────────────────────────────────────────────────────────────

export interface TagResolver {
	idsForTrack: (trackId: string) => readonly string[];
	nameToId: (name: string) => string | null;
	// Optional: does any playlist in the user's library have this ascii-folded
	// name? When provided, lets extractSqlPrefilter declare a `#name` token
	// unresolved iff NEITHER a tag NOR a playlist matches — preserving the
	// fast "empty result" short-circuit in the merged `#` namespace. Omitted
	// → assume the name might match a playlist (safe but skips the optimisation).
	hasPlaylistName?: (asciiName: string) => boolean;
}

// Match a single track against the parsed expression. Returns true when the
// expression as a whole is satisfied. Pure-function over the in-memory Track
// — no DB. Tag matching is the caller's responsibility (pass a resolver to
// enable it; without one, tag terms match true).
export function matchTrack(expr: Expr, t: Track, tags?: TagResolver): boolean {
	switch (expr.kind) {
		case 'true':  return true;
		case 'and':   return matchTrack(expr.left, t, tags) && matchTrack(expr.right, t, tags);
		case 'or':    return matchTrack(expr.left, t, tags) || matchTrack(expr.right, t, tags);
		case 'free':  return freeMatches(t, expr.value);
		// Similarity is decided by the engine in SQL (the fetched set IS the
		// ranked result); per-row there is nothing to check. Under an OR it
		// can't be pushed and so constrains nothing.
		case 'similar': return true;
		case 'attr':  return attrMatches(t, expr.field, expr.value, expr.exact);
		case 'cmp':   return cmpMatches(t, expr.field, expr.min, expr.max);
		case 'source': {
			// `sources` is decorated by getTracks (source_link ∪ rekordbox_link).
			// An undecorated read path can't evaluate membership — pass rather
			// than filter, mirroring the tag-without-resolver behavior above.
			if (!t.sources) return true;
			return t.sources.includes(expr.value);
		}
		case 'tag': {
			if (!tags) return true;
			// Merged `#` namespace — track satisfies `#name` if any of:
			//   (a) it carries a user/system tag whose name resolves here, OR
			//   (b) it's in a playlist whose ascii-folded name equals `searchFold(name)`.
			// (b) reads `t.playlistNamesAscii`, decorated by getTracks; an empty
			// array (or undefined) just means no playlist match contributes.
			const id = tags.nameToId(expr.name);
			if (id) {
				const have = tags.idsForTrack(t.id);
				for (const h of have) if (h === id) return true;
			}
			const folded = searchFold(expr.name);
			for (const p of t.playlistNamesAscii ?? []) {
				if (p === folded) return true;
			}
			return false;
		}
	}
}

function freeMatches(t: Track, needle: string): boolean {
	// Diacritic-insensitive: fold both sides so "Bohmer" matches "Böhmer".
	// Same searchFold used by the SQL pre-filter (which hits the `*_ascii`
	// shadow columns) so JS-side post-filtering can't reject what SQL kept.
	const n = searchFold(needle);
	for (const get of FREE_GETTERS) {
		const v = get(t);
		if (v && searchFold(v).includes(n)) return true;
	}
	// Numeric bare terms (e.g. typing "120") also match exact BPM, mirroring
	// the SQL `search` column treatment in service.ts/getTracksImpl. Round —
	// bpm carries decimals now (91.13), so "91" must still match.
	if (/^\d+$/.test(needle) && t.bpm != null && Math.round(t.bpm) === Number(needle)) return true;
	return false;
}

function attrMatches(t: Track, field: StringField, value: string, exact: boolean): boolean {
	const v = searchFold(value);
	const vs = STRING_GETTERS[field](t);
	for (const s of vs) {
		const ls = searchFold(s ?? '');
		if (exact ? ls === v : ls.includes(v)) return true;
	}
	return false;
}

function cmpMatches(t: Track, field: NumField, min?: Bound, max?: Bound): boolean {
	const v = NUM_GETTERS[field](t);
	if (v == null) return false; // unanalyzed / missing — comparisons can't pass
	if (min != null) {
		if (min.inclusive ? v < min.value : v <= min.value) return false;
	}
	if (max != null) {
		if (max.inclusive ? v > max.value : v >= max.value) return false;
	}
	return true;
}

// ─── SQL prefilter extraction (omnibar) ─────────────────────────────────────
//
// Walks the AST and pulls out constraints that the backend `tracks:list`
// filter can express directly, so the candidate set fetched from SQLite is
// already narrow before we run the full AST in memory.
//
// Only TOP-LEVEL MUSTs contribute — anything inside an OR can't be pushed
// (the SQL would over-filter). `complete` is true when every node in the
// AST got expressed as a SQL constraint, in which case the caller can skip
// the in-memory match pass.

// One `#name` MUST in the AST → one NameClause. The SQL builder ANDs across
// clauses and ORs within each clause: a track satisfies the clause if it
// carries any tag id OR sits in any playlist by the named ascii. Folder
// names are reserved for v2 (recursive CTE over playlist_folder).
export interface NameClause {
	tagIds: string[];
	playlistNamesAscii: string[];
}

// Mirror of ZTrackFilter.scalarBounds (packages/shared/src/types.ts) —
// maps the grammar's short NumField ids to canonical track columns.
export interface ScalarBound {
	field: 'rating' | 'duration' | 'playCount' | 'dropCount' | 'breakdownCount'
		| 'loudnessRangeLu' | 'dissonance' | 'density'
		| 'brightness' | 'dynamicComplexity'
		| 'introLengthSec' | 'outroLengthSec' | 'firstDropSec';
	min?: number;
	max?: number;
}

const SCALAR_BOUND_FIELDS: Record<Exclude<NumField, 'bpm'>, ScalarBound['field']> = {
	time: 'duration',
	rating: 'rating',
	playcount: 'playCount',
	dropcount: 'dropCount',
	breakdowncount: 'breakdownCount',
	lra: 'loudnessRangeLu',
	diss: 'dissonance',
	dens: 'density',
	bright: 'brightness',
	punch: 'dynamicComplexity',
	intro: 'introLengthSec',
	outro: 'outroLengthSec',
	drop: 'firstDropSec',
};

export interface SqlPrefilter {
	search?: string;
	keyCamelot?: string;
	genre?: string;
	label?: string;
	bpmMin?: number;
	bpmMax?: number;
	// Source-membership MUST → ZTrackFilter.hasSource: one `source:` term, or
	// an OR made only of `source:` terms as the any-of array ('rekordbox'
	// included — core resolves it to rekordbox_link). An exact pushdown (SQL
	// enforces the same predicate matchTrack would), so it doesn't mark the
	// filter incomplete on its own. One slot: a second distinct source MUST
	// falls to the in-memory pass.
	hasSource?: string | string[];
	// `artistid={…}` MUSTs → ZTrackFilter.artistIds (OR within the list, an
	// indexed EXISTS on track_artist). One term is a complete pushdown; two
	// AND-ed terms widen the SQL set to the OR, so `complete` drops and the
	// in-memory pass enforces "credited to both".
	artistIds?: string[];
	// `albumid={…}` MUSTs → ZTrackFilter.albumIds, same shape as artistIds
	// (a track is on one release, so two AND-ed ids can only both match
	// when they're aliases of each other — the in-memory pass decides).
	albumIds?: string[];
	// `similar:` / `sounds:` MUSTs → ZTrackFilter.similarTo (seeds union,
	// texts joined). Exact pushdown: the engine's ranking is the result.
	similarTo?: { seeds?: string[]; text?: string };
	scalarBounds?: ScalarBound[];
	nameClauses?: NameClause[];
	complete: boolean;
	// True when a top-level `#name` MUST resolves to neither a known tag NOR
	// a known playlist (i.e. the resolver carries enough lookup tables to
	// prove the empty result). Caller can short-circuit to "no matches"
	// without firing the query. Without `hasPlaylistName`, the resolver
	// can't make that claim safely — the clause goes through with the
	// ascii-folded name as a speculative playlist match, and an empty result
	// just means no rows.
	hasUnresolvedRequiredTag: boolean;
}

// The source values of an OR tree made ONLY of `source:` terms, else null.
// `(source:rekordbox | source:local)` is how the Rekordbox omnibar pill bakes
// itself into a JIT query, and it maps exactly onto the hasSource any-of
// array — the one OR shape SQL can take whole.
function sourceDisjunction(e: Expr): string[] | null {
	if (e.kind === 'source') return [e.value];
	if (e.kind !== 'or') return null;
	const l = sourceDisjunction(e.left);
	const r = l && sourceDisjunction(e.right);
	return l && r ? [...l, ...r] : null;
}
// Order- and duplicate-insensitive identity of a hasSource slot value.
const sourceSlotKey = (s: string | string[]): string => [...new Set(Array.isArray(s) ? s : [s])].sort().join('|');

export function extractSqlPrefilter(expr: Expr, tags?: TagResolver): SqlPrefilter {
	const out: SqlPrefilter = { complete: true, hasUnresolvedRequiredTag: false };
	const frees: string[] = [];
	const nameClauses: NameClause[] = [];
	const scalarBounds: ScalarBound[] = [];
	let complete = true;

	const walk = (e: Expr): void => {
		switch (e.kind) {
			case 'true': return;
			case 'and':  walk(e.left); walk(e.right); return;
			case 'free': frees.push(e.value); return;
			case 'attr': {
				// Push only `key={...}` to the SQL eq slot — keyCamelot values
				// are normalized uppercase in the DB so the binary eq is safe.
				// genre / label / album / title / artist all stay case-sensitive
				// under SQLite's default eq collation; pushing them as eq would
				// silently miss rows with a different case, so we fall through
				// to the case-insensitive `search` LIKE chain instead and let
				// the in-memory pass enforce the precise semantics.
				if (e.exact && e.field === 'key') {
					out.keyCamelot = e.value.toUpperCase();
				} else if (e.exact && e.field === 'artistid') {
					if (out.artistIds && out.artistIds.length > 0) complete = false;
					(out.artistIds ??= []).push(e.value);
				} else if (e.exact && e.field === 'albumid') {
					if (out.albumIds && out.albumIds.length > 0) complete = false;
					(out.albumIds ??= []).push(e.value);
				} else {
					frees.push(e.value);
					complete = false;
				}
				return;
			}
			case 'cmp': {
				if (e.field === 'bpm') {
					if (e.min != null) {
						const lo = e.min.inclusive ? e.min.value : e.min.value + 1;
						out.bpmMin = out.bpmMin == null ? lo : Math.max(out.bpmMin, lo);
					}
					if (e.max != null) {
						const hi = e.max.inclusive ? e.max.value : e.max.value - 1;
						out.bpmMax = out.bpmMax == null ? hi : Math.min(out.bpmMax, hi);
					}
				} else {
					// Push as an INCLUSIVE bound — SQL is the coarse prefilter.
					// The analyzer scalars are REAL columns, so an exclusive
					// bound can't be ±1-adjusted like bpm; instead the pushed
					// bound over-approximates by including the boundary value
					// and `complete=false` keeps the in-memory pass on to
					// enforce strictness. Inclusive bounds round-trip exactly.
					const field = SCALAR_BOUND_FIELDS[e.field];
					const bound: ScalarBound = { field };
					if (e.min != null) {
						bound.min = e.min.value;
						if (!e.min.inclusive) complete = false;
					}
					if (e.max != null) {
						bound.max = e.max.value;
						if (!e.max.inclusive) complete = false;
					}
					scalarBounds.push(bound);
				}
				return;
			}
			case 'source': {
				if (out.hasSource == null || sourceSlotKey(out.hasSource) === e.value) {
					out.hasSource = e.value;
				} else {
					// Two distinct source MUSTs — the filter carries one membership
					// slot; the in-memory pass enforces the rest.
					complete = false;
				}
				return;
			}
			case 'tag': {
				if (!tags) { complete = false; return; }
				const id = tags.nameToId(e.name);
				const ascii = searchFold(e.name);
				const tagIdsForClause = id ? [id] : [];
				// If hasPlaylistName is provided we trust it; otherwise we
				// optimistically include the ascii name and let the SQL
				// return empty when nothing matches.
				const playlistMatch = tags.hasPlaylistName ? tags.hasPlaylistName(ascii) : true;
				const playlistNamesAsciiForClause = playlistMatch ? [ascii] : [];
				if (tagIdsForClause.length === 0 && playlistNamesAsciiForClause.length === 0) {
					out.hasUnresolvedRequiredTag = true;
				} else {
					nameClauses.push({ tagIds: tagIdsForClause, playlistNamesAscii: playlistNamesAsciiForClause });
				}
				return;
			}
			case 'similar': {
				const st = (out.similarTo ??= {});
				if (e.seeds.length > 0) st.seeds = [...new Set([...(st.seeds ?? []), ...e.seeds])];
				if (e.text) st.text = st.text ? `${st.text}, ${e.text}` : e.text;
				return;
			}
			case 'or': {
				// Only an OR of nothing but `source:` terms is pushable — as the
				// hasSource any-of array. Every other OR stays in-memory.
				const sources = sourceDisjunction(e);
				if (sources && (out.hasSource == null || sourceSlotKey(out.hasSource) === sourceSlotKey(sources))) {
					out.hasSource = [...new Set(sources)];
				} else {
					complete = false;
				}
				return;
			}
		}
	};
	walk(expr);

	if (frees.length > 0) {
		// SQL has one `search` slot — pick the longest needle (most selective
		// against the LIKE chain). Other frees get re-checked in the in-memory
		// pass, so picking only one isn't lossy.
		frees.sort((a, b) => b.length - a.length);
		out.search = frees[0];
		if (frees.length > 1) complete = false;
	}
	if (nameClauses.length > 0) out.nameClauses = nameClauses;
	if (scalarBounds.length > 0) out.scalarBounds = scalarBounds;
	out.complete = complete;
	return out;
}

// ─── AST introspection helpers ──────────────────────────────────────────────

// Walks the tree and pulls out every distinct tag name referenced anywhere.
// Used by the omnibar to seed tag resolution + the autocomplete leaderboard.
export function collectTagNames(expr: Expr): string[] {
	const seen = new Set<string>();
	const walk = (e: Expr): void => {
		switch (e.kind) {
			case 'and': case 'or': walk(e.left); walk(e.right); return;
			case 'tag': seen.add(e.name); return;
			default: return;
		}
	};
	walk(expr);
	return Array.from(seen);
}

// True when the expression has no actionable content — empty query, only
// stray noise. Caller can use this to render the "recent" empty-state.
// True when the query carries a top-level AI-similarity MUST (`similar:` /
// `like:` / `sounds:`) — the tracklist then defaults to Match order and shows
// the Match column.
export function hasSimilarTerm(raw: string): boolean {
	return extractSqlPrefilter(parseQuery(raw)).similarTo !== undefined;
}

export function isEmptyExpr(expr: Expr): boolean {
	return expr.kind === 'true';
}

// Folder-path syntax (`zen/uplifting/track`) is omnibar-specific and predates
// the boolean grammar — it doesn't compose with AND/OR/parens, but it does
// coexist with tags and other terms (e.g. `zen/up/ #deep`). This helper
// walks the top-level AND chain, pulls out the first FREE node whose text
// contains `/`, and returns its parsed path/leaf plus the remaining AST.
//
// Examples (FREE node value → result):
//   "zen"            → path=[],            leaf="zen"      (no `/` → not folder syntax)
//   "zen/"           → path=["zen"],       leaf=""
//   "zen/up"         → path=["zen"],       leaf="up"
//   "zen/up/track"   → path=["zen","up"],  leaf="track"
export function extractFolderSyntax(expr: Expr): { path: string[]; leaf: string; remaining: Expr } {
	type Found = { path: string[]; leaf: string } | null;
	const walk = (e: Expr): { remaining: Expr; found: Found } => {
		if (e.kind === 'free' && e.value.includes('/')) {
			return { remaining: { kind: 'true' }, found: splitFolderPath(e.value) };
		}
		if (e.kind === 'and') {
			const lr = walk(e.left);
			if (lr.found) {
				const r: Expr = lr.remaining.kind === 'true'
					? e.right
					: { kind: 'and', left: lr.remaining, right: e.right };
				return { remaining: r, found: lr.found };
			}
			const rr = walk(e.right);
			if (rr.found) {
				const r: Expr = rr.remaining.kind === 'true'
					? e.left
					: { kind: 'and', left: e.left, right: rr.remaining };
				return { remaining: r, found: rr.found };
			}
			return { remaining: e, found: null };
		}
		return { remaining: e, found: null };
	};
	const { remaining, found } = walk(expr);
	if (!found) return { path: [], leaf: '', remaining };
	return { path: found.path, leaf: found.leaf, remaining };
}

// Build an `attr={value}` exact-match clause for the grammar from raw
// track metadata — used by the drill-down menu in main.ts to construct
// queries like `label={Anjunadeep}`. The tokenizer reads the value up
// to the first literal `}` (no `\}` escape supported), so a stray `}`
// in metadata would truncate the clause. Strip them defensively —
// `}` is vanishingly rare in real artist / album / label / genre
// strings, so the loss is acceptable.
export function buildExactAttr(field: string, value: string): string {
	return `${field}={${value.replace(/}/g, '')}}`;
}

function splitFolderPath(s: string): { path: string[]; leaf: string } {
	if (!s.includes('/')) return { path: [], leaf: s };
	const parts = s.split('/');
	const trailing = parts[parts.length - 1] === '';
	if (trailing) parts.pop();
	const leaf = trailing ? '' : (parts.pop() ?? '');
	return { path: parts.map((p) => p.trim()).filter((p) => p.length > 0), leaf };
}

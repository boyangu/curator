// Lone-surrogate scrubbing for JSON-RPC boundaries.
//
// JS strings tolerate unpaired UTF-16 surrogates (split emoji halves from
// malformed tags, mid-pair slices, etc.). ECMA-262 well-formed JSON.stringify
// escapes them as legal `\uDC90`-style JSON, Python's json.loads faithfully
// reconstructs them — and then any strict UTF-8 encode on the Python side
// (SQLAlchemy binding to SQLite) throws "surrogates not allowed" and, in the
// rekordbox writer's case, used to roll back an entire sync batch. Scrub them
// to U+FFFD before they cross the wire.

const hasWellFormed = typeof String.prototype.isWellFormed === 'function';

export function isWellFormedString(s: string): boolean {
	if (hasWellFormed) return s.isWellFormed();
	// Fallback for runtimes below Node 20 (tests under old node, etc.).
	return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function scrubString(s: string): string {
	if (isWellFormedString(s)) return s;
	if (hasWellFormed) return s.toWellFormed();
	return s.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		'�',
	);
}

// Deep-walk `value`, replacing every string that fails isWellFormed() with
// its toWellFormed() form (unpaired surrogates → U+FFFD). Object keys are
// scrubbed too. Copy-on-write: the overwhelmingly common all-clean case
// returns the original references untouched — the hot-path cost is one native
// isWellFormed() check per string.
export function scrubLoneSurrogates<T>(value: T): T {
	if (typeof value === 'string') {
		return scrubString(value) as T;
	}
	if (Array.isArray(value)) {
		let out: unknown[] | null = null;
		for (let i = 0; i < value.length; i++) {
			const scrubbed = scrubLoneSurrogates(value[i]);
			if (scrubbed !== value[i] && out === null) out = value.slice();
			if (out !== null) out[i] = scrubbed;
		}
		return (out ?? value) as T;
	}
	if (value !== null && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		let out: Record<string, unknown> | null = null;
		for (const key of Object.keys(obj)) {
			const cleanKey = scrubString(key);
			const cleanVal = scrubLoneSurrogates(obj[key]);
			if ((cleanKey !== key || cleanVal !== obj[key]) && out === null) out = { ...obj };
			if (out !== null) {
				if (cleanKey !== key) delete out[key];
				out[cleanKey] = cleanVal;
			}
		}
		return (out ?? value) as T;
	}
	return value;
}

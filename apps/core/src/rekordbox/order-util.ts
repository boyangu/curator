// Shared order primitives for the rekordbox 3-way membership merge. The import
// side (mergePlaylistMembership) and the export side (buildWriteOps) must make
// the SAME "did this side reorder relative to baseline?" decision — drift
// between two copies of this logic is exactly the clobber bug class. Extracting
// them here keeps the two halves provably symmetric.

// Positional array equality.
export function eqArr(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Project `order` down to the `common` members, preserving order's sequence.
// Set-backed so it's O(n) rather than O(n·m) on Array.includes.
export function seqIn(order: string[], common: ReadonlySet<string>): string[] {
	return order.filter((cid) => common.has(cid));
}

// The rb-kind baseline after a pull has merged rekordbox's membership into
// Curator. The baseline is "what both sides last agreed on"; until now only
// the exporter advanced it (after a verified push), so everything the pull
// adopted FROM rekordbox — rb-side adds at their rb positions, a member
// that just gained its rekordbox_link — looked to the next push like a
// Curator edit: `add` ops for members rb already had, and a spurious full
// TrackNo rewrite because the no-reorder projection put those members at
// the tail (2026-09-15: that rewrite baked a colliding-TrackNo interleaving
// into `# backlog`). Members are advanced per the 3-way rules:
//
//   R ∩ includeRb          agreed — rb has it, Curator has it after merge
//   B ∩ R − includeRb      Curator-pending removal — keep, so the push's
//                          B−C diff still removes it from rb
//   includeRb − R          Curator-pending add — NOT in rb yet, stays out
//   B − R                  rb removed it (Curator dropped it) — gone
//
// Order: `mergedOrder` (what Curator's playlist_track now holds) for the
// agreed members, then pending removals in their old baseline order. When
// `keepBaseOrder` (only Curator reordered — the push will send Curator's
// order and advance afterwards) existing members keep the baseline sequence
// and rb-side adds append in rb order, so the projection still detects the
// Curator reorder. Callers must skip this on a both-sides order conflict.
export function advanceRbBaselineAfterPull(args: {
	baseRbOrder: string[];
	rOrder: string[];
	includeRb: ReadonlySet<string>;
	mergedOrder: string[];
	keepBaseOrder: boolean;
}): string[] {
	const rSet = new Set(args.rOrder);
	const baseSet = new Set(args.baseRbOrder);
	const next = new Set<string>();
	for (const cid of args.rOrder) {
		if (args.includeRb.has(cid) || baseSet.has(cid)) next.add(cid);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (cid: string): void => {
		if (next.has(cid) && !seen.has(cid)) { out.push(cid); seen.add(cid); }
	};
	if (args.keepBaseOrder) {
		for (const cid of args.baseRbOrder) push(cid);
		for (const cid of args.rOrder) push(cid);
	} else {
		for (const cid of args.mergedOrder) if (rSet.has(cid)) push(cid);
		for (const cid of args.baseRbOrder) push(cid);
	}
	return out;
}

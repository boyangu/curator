// Translate a playlist permutation into a minimal sequence of positional
// moves (Spotify's range_start / insert_before form). Used by the drag-
// reorder upstream push instead of a full uris-replace: a replace re-adds
// every item and RESETS the provider's per-item added-at, which is how the
// 2026-06-27 recovery flattened ~80 playlists' recency. Positional moves
// leave untouched items alone.
//
// `perm[k]` = the OLD index of the item that should end up at NEW index k
// (a permutation of 0..N-1). The minimal set of items to move is everything
// outside one longest increasing subsequence of `perm` — those items keep
// their relative order and everything else is threaded between them.
//
// Wire semantics (per Spotify): indices refer to the list state BEFORE that
// individual move; moves apply sequentially. Moving the item at `rangeStart`
// to FINAL index k therefore needs insertBefore = k when the item moves up
// (rangeStart > k) but k+1 when it moves down (rangeStart < k) — removal
// shifts everything after it left by one before the insert happens.

export interface PositionalMove {
	rangeStart: number;
	insertBefore: number;
}

// Indices (into `seq`) of one longest strictly-increasing subsequence. For a
// permutation these are the NEW indices whose items can stay put while
// everything else moves around them — the minimal move set is the rest.
// Exported for the local order-key rewrite, which rekeys only those rows.
export function unmovedIndices(seq: number[]): Set<number> {
	const tailIdx: number[] = []; // index into seq of the smallest tail per length
	const parent = new Array<number>(seq.length).fill(-1);
	for (let i = 0; i < seq.length; i++) {
		let lo = 0, hi = tailIdx.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (seq[tailIdx[mid]!]! < seq[i]!) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) parent[i] = tailIdx[lo - 1]!;
		tailIdx[lo] = i;
	}
	const keep = new Set<number>();
	let cur = tailIdx.length > 0 ? tailIdx[tailIdx.length - 1]! : -1;
	while (cur !== -1) {
		keep.add(cur);
		cur = parent[cur]!;
	}
	return keep;
}

export function computePositionalMoves(perm: number[]): PositionalMove[] {
	const keep = unmovedIndices(perm);
	// Simulated current list state, as OLD indices. Mirrors the remote after
	// each emitted move so rangeStart is always the item's live position.
	const work = Array.from({ length: perm.length }, (_, i) => i);
	const moves: PositionalMove[] = [];
	for (let k = 0; k < perm.length; k++) {
		if (keep.has(k)) continue;
		const item = perm[k]!;
		const j = work.indexOf(item);
		if (j === k) continue;
		moves.push({ rangeStart: j, insertBefore: j < k ? k + 1 : k });
		work.splice(j, 1);
		work.splice(k, 0, item);
	}
	return moves;
}

// Turn "remove these rows" into provider calls that leave every other row
// where it is. Spotify's remove names URIs, not rows, and takes out EVERY
// occurrence of each — so dropping one copy of a track that is in a playlist
// twice is a remove of the URI plus an insert of the surviving copy back at
// its position. A removed row whose URI survives nowhere else is a plain
// remove and touches nothing else.
//
// `items` is the provider's list as it stands, in its own index space: a
// null is a row with no addressable id (a local file, a track pulled from
// the catalogue) that is never removed but still occupies an index, so the
// insert positions are counted with it.
//
// Re-inserts come back in ascending final index. Applied in that order
// (after the removes), each insert lands on its final index: every row that
// ends up before it is already in place.

export interface RowRemovalPlan {
	removeUris: string[];
	reinserts: Array<{ uri: string; index: number }>;
}

export function planRowRemoval(items: ReadonlyArray<string | null>, removeIndices: Iterable<number>): RowRemovalPlan {
	const remove = new Set(removeIndices);
	for (const i of remove) {
		if (!Number.isInteger(i) || i < 0 || i >= items.length) throw new Error(`row ${i} is outside the playlist (0..${items.length - 1})`);
		if (items[i] == null) throw new Error(`row ${i} has no provider id to remove`);
	}
	const removeUris = [...new Set([...remove].map((i) => items[i]!))];
	const hit = new Set(removeUris);
	const reinserts: Array<{ uri: string; index: number }> = [];
	let index = 0;
	for (let i = 0; i < items.length; i++) {
		if (remove.has(i)) continue;
		const uri = items[i];
		if (uri != null && hit.has(uri)) reinserts.push({ uri, index });
		index++;
	}
	return { removeUris, reinserts };
}

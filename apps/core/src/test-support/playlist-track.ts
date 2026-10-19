// Order fields for playlist_track rows that tests insert with raw SQL. Rows
// written by the service get theirs from library/playlist-order.ts; a fixture
// that seeds by position needs a valid key that sorts the same way, or the
// first append/reorder in the test would read the playlist in another order.

import { randomUUID } from 'node:crypto';
import { rebalance } from '@curator/protocol';

export function orderKeyAt(position: number): string {
	return rebalance(position + 1)[position]!;
}

// [id, order_key] to prefix a raw INSERT's bound values with.
export function memberOrder(position: number): [string, string] {
	return [randomUUID(), orderKeyAt(position)];
}

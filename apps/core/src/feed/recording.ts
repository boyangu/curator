// Feed-side recording keys. The key itself (and why it is title + artist set)
// lives in @curator/library-logic so the cloud and the phone collapse feed
// items the same way.

import { recordingKey } from '@curator/library-logic';
import type { FeedItemPayload, FeedItemType } from './types.js';

// Every recording an item carries: a track item is one recording; an album is
// its resolved tracklist (none until the expander / lazy expand fills it).
export function recordingKeysFor(type: FeedItemType, payload: FeedItemPayload): string[] {
	if (type === 'track') return payload.title ? [recordingKey(payload.title, payload.artists ?? [])] : [];
	if (type === 'album') return [...new Set((payload.tracks ?? []).map((t) => recordingKey(t.title, t.artists ?? [])))];
	return [];
}

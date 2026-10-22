// Spotify serves a playlist's uploaded cover from more than one CDN host
// (image-cdn-ak / image-cdn-fa .spotifycdn.com) and its API answers with
// either, call to call, for the same image id. Stored as given, every
// read-sync flipped the column, and the master stated ~700 cover-only
// playlist changes a day that carried nothing new (2026-10-22 sync review).
// One spelling per image: the column, the op and the baseline all agree.

const CDN_HOST = /^https:\/\/image-cdn-[a-z]{2}\.spotifycdn\.com\/image\//i;
const CANONICAL = 'https://image-cdn-ak.spotifycdn.com/image/';

export function canonicalSpotifyCover<T extends string | null | undefined>(url: T): T {
	return (typeof url === 'string' ? url.replace(CDN_HOST, CANONICAL) : url) as T;
}

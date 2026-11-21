// What kind of release this is, as a DJ files it: Mix, VA, Single, EP, Album.
//
// The stores only say album / single / compilation (Spotify, Bandcamp), a few
// add ep (Deezer, SoundCloud), and several say nothing (Beatport, Traxsource).
// None knows a DJ mix, and "single" covers everything short — Spotify files a
// six-track EP under it. So the kind is read off everything a caller has, in
// this order (the first that answers wins):
//
//   Mix     the title says so — "(DJ Mix)", "Mixed by …", "(Mixed)",
//           "Continuous Mix" — or most of its tracks are mixed versions
//           ("… (Mixed)", "… - Mixed"), which is how the stores list the
//           cuts of a mix album.
//   VA      a compilation by the store's word, or credited to Various Artists.
//   EP      the store's word; else "EP" in the title; else 4–6 tracks on a
//           release the store calls a single or does not type at all.
//   Single  the store's word (with no sign of an EP), or 1–3 tracks untyped.
//   Album   the store's word, or 7+ tracks untyped.
//
// Null when nothing answers (no type, no track count, a plain title): a
// caller shows nothing rather than a guess.

export type ReleaseKind = 'mix' | 'va' | 'single' | 'ep' | 'album';

export interface ReleaseKindInput {
	// The store's release type, as it came ('album', 'single', 'compilation',
	// 'ep', Deezer's 'compile', …).
	type?: string | null;
	title?: string | null;
	trackCount?: number | null;
	// The release's own credit — not its tracks' artists.
	artists?: readonly string[];
	// The release is known to be by various artists.
	various?: boolean;
	// Titles of the tracks at hand (any subset).
	trackTitles?: readonly string[];
}

export const RELEASE_KIND_LABEL: Record<ReleaseKind, string> = { mix: 'Mix', va: 'VA', single: 'Single', ep: 'EP', album: 'Album' };

const MIX_TITLE = /\bdj[\s-]?mix\b|\bmixed\s+by\b|\bcontinuous\s+(dj\s+)?mix\b|[([]\s*mixed\s*[)\]]|\s[-–—]\s*mixed\s*$/i;
// A track that is a cut of a mix: "Title (Mixed)", "Title - Mixed", "Title [Mixed]".
const MIXED_TRACK = /[([]\s*mixed\s*[)\]]\s*$|\s[-–—]\s*mixed\s*$/i;
const EP_TITLE = /(^|[\s([\-–—])e\.?p\.?(?=$|[\s)\]:,\-–—])/i;
const VARIOUS = /^(various(\s+artists?)?|v\.?\s?a\.?)$/i;

export function releaseKind(r: ReleaseKindInput): ReleaseKind | null {
	const type = (r.type ?? '').trim().toLowerCase();
	const title = r.title ?? '';
	const n = r.trackCount && r.trackCount > 0 ? r.trackCount : null;

	if (MIX_TITLE.test(title)) return 'mix';
	const titles = r.trackTitles ?? [];
	if (titles.length >= 3 && titles.filter((t) => MIXED_TRACK.test(t)).length * 2 > titles.length) return 'mix';

	if (type === 'compilation' || type === 'compile' || r.various || (r.artists ?? []).some((a) => VARIOUS.test(a.trim()))) return 'va';

	if (type === 'ep' || EP_TITLE.test(title)) return 'ep';
	const short = type === 'single' || type === '';
	if (short && n !== null && n >= 4 && n <= 6) return 'ep';
	if (type === 'single') return 'single';
	if (type === 'album') return 'album';
	// Untyped (or a word no rule knows): by size alone.
	if (n === null) return null;
	return n <= 3 ? 'single' : 'album';
}

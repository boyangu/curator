// A label's upload title, read as a credit: channels and profiles write
// "Artist - Title (Mix)", "Artist & Other – Title [Official Video]", "Title
// | Artist" is rare enough to ignore. The suffixes that name the medium, not
// the music, are dropped; the remix segment stays in the title (the credit
// rules read remixers off it, as everywhere else).

import { splitArtistCredit } from '@curator/shared/artist-credit';

const MEDIUM_RE = /\s*[([]\s*(official\s+)?(music\s+)?(video|audio|visuali[sz]er|lyric(s)?(\s+video)?|premiere|stream|hq|hd|4k|out\s+now|full\s+track)\s*[)\]]\s*/gi;
const TRAILING_LABEL_RE = /\s*[|•·]\s*[^|•·]{2,60}$/;
const DASH_RE = /\s+[-–—]\s+/;
// "Keinemusik (Rampa, Adam Port, &ME)": a collective with its members in
// parentheses, as the stores credit it — the group, then each member. Only a
// list does ("Kaske (UK)" is one name); a "(feat. X)" is the splitter's.
const GROUP_RE = /\s*\((?!\s*(?:feat|featuring|ft)\b)([^()]*[,;][^()]*)\)/gi;

export type UploadCredit = { title: string; artists: string[] };

// A credit string as its artists: "Mano Le Tough, DJ Koze". The library's one
// splitter, so `&`, `x` and `vs` stay inside a name (Stil & Bense, &ME): split
// there, "Keinemusik (Rampa, Adam Port, &ME)" became "Keinemusik (Rampa",
// "Adam Port)" and "Me" (2026-11-01).
export function splitCredit(s: string): string[] {
	const seen = new Set<string>();
	return splitArtistCredit(s.replace(GROUP_RE, ', $1'))
		.map((a) => a.name)
		.filter((n) => !seen.has(n.toLowerCase()) && !!seen.add(n.toLowerCase()));
}

// A label's own sets name the catalogue number first: "Maeve 034 - Jonathan
// Kaspar - Can't Stop". The number is the label's first word and digits.
// "Abiogenesis EP" is the release "Abiogenesis" whose type is EP: the word
// goes when the type already says it, so the stores' naming joins.
export function stripFormatWord(title: string, releaseType: string): string {
	const m = /^(.+?)\s+(EP|LP)$/i.exec(title.trim());
	return m && m[2]!.toLowerCase() === (releaseType === 'album' ? 'lp' : releaseType) ? m[1]! : title.trim();
}

export function splitCatalogNumber(raw: string, labelName: string): { catalogNumber?: string; rest: string } {
	const word = labelName.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, '');
	if (!word) return { rest: raw };
	const m = new RegExp(`^\\s*(${word})\\s*(\\d{1,4}[a-z]?)\\s*[-–—:|]\\s*`, 'iu').exec(raw);
	if (!m) return { rest: raw };
	return { catalogNumber: `${m[1]}${m[2]}`.toUpperCase(), rest: raw.slice(m[0].length) };
}

// Artist "Title": a label's own wording for an album set.
const QUOTED_RE = /^(.{2,60}?)\s+["“](.+)["”]$/;

export function parseUploadTitle(raw: string): UploadCredit {
	let s = raw.replace(MEDIUM_RE, ' ').replace(/\s{2,}/g, ' ').trim();
	s = s.replace(TRAILING_LABEL_RE, '').trim();
	const q = QUOTED_RE.exec(s);
	if (q) return { title: q[2]!.trim(), artists: splitCredit(q[1]!) };
	const m = DASH_RE.exec(s);
	if (!m || m.index === 0) return { title: s, artists: [] };
	const left = s.slice(0, m.index).trim();
	const right = s.slice(m.index + m[0].length).trim();
	if (!left || !right) return { title: s, artists: [] };
	return { title: right, artists: splitCredit(left) };
}

// Shared matching primitives. Same strict-acceptance rule and normalization
// for every provider — Tidal, Beatport, MusicBrainz all delegate here.
//
// Common candidate shape:   { id, title, version?, artists: string[], duration, isrc }
// Common target shape:      { title, artists: string[], duration, isrc }
//
// Acceptance rule (strict):  ISRC match alone, OR (title + artist + dur ≤ 5s)

const SPECIAL_CHARS_RE = /[\/\\?\-=+()"'<>{}\[\]!@#$%^&*,;]/g;

// Artist-string joiners. Rekordbox-imported tracks carry ALL credited artists
// as one comma-joined string ("Madloch, Subnode, Bookwood"); file tags and
// streaming APIs deliver them as separate entries. Both sides are split with
// the same rule before comparison, so multi-word names that contain a joiner
// ("Frankey & Sandrino") still compare equal — they just compare as their
// token parts on both sides.
const ARTIST_SPLIT_RE = /[,;&]|\bfeat(?:uring)?\b\.?|\bft\b\.?/i;
const COMBINING_DIACRITICS_RE = /[̀-ͯ]/g;

export interface Candidate {
	id: string | number;
	title: string;
	version?: string | null;
	artists: string[];
	duration?: number | null;
	isrc?: string | null;
}

export interface Target {
	title: string;
	artists: string[];
	duration?: number | null;
	isrc?: string | null;
}

export interface ScoreSignals {
	isrcMatch: boolean;
	titleExact: boolean;
	titlePartial: boolean;
	artistMatch: boolean;
	artistMatchCount: number;
	versionMatch: boolean;
	dDiff: number;
}

export interface ScoreResult {
	acceptable: boolean;
	score: number;
	signals: ScoreSignals;
}

export interface TraceCandidate {
	cand: string;
	score: number;
	why: string;
	candDetail: Candidate;
}

export interface Trace {
	candidates?: TraceCandidate[];
	bestScore?: number;
	picked?: Candidate | null;
	zeroCandidates?: boolean;
}

export class Scorer {
	// Strip accents + special characters + collapse whitespace. The special-char
	// list is deliberately broad: anything that's noise for title/artist comparison
	// (dashes, slashes, brackets, punctuation) folds to a space, then runs of
	// whitespace collapse. "Hunter/Game", "Hunter Game", "Hunter-Game" all equal.
	normalize(s: string | null | undefined): string {
		if (!s) return '';
		return this.deaccent(s)
			.toLowerCase()
			.replace(SPECIAL_CHARS_RE, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	deaccent(s: string | null | undefined): string {
		if (!s) return '';
		return String(s)
			.normalize('NFD')
			.replace(COMBINING_DIACRITICS_RE, '')
			.replace(/ß/g, 'ss')
			.replace(/ø/gi, 'o')
			.replace(/æ/gi, 'ae')
			.replace(/œ/gi, 'oe')
			.replace(/ł/gi, 'l');
	}

	artistTokens(artists: string[] | null | undefined): Set<string> {
		const out = new Set<string>();
		for (const a of artists || []) {
			for (const part of String(a).split(ARTIST_SPLIT_RE)) {
				const n = this.normalize(part);
				if (n) out.add(n);
			}
		}
		return out;
	}

	// Strip ONLY the meaningless "(Original Mix)" / "- Original Mix" annotations
	// Spotify appends. Preserves all other parenthesized content (remix names,
	// version info) because those are part of the recording's identity.
	// The bare (unbracketed, undashed) "Foo Original Mix" form is stripped too —
	// Beatport sometimes folds the mix name into the title — so it matches an
	// unversioned DB title exactly rather than only as a weaker partial.
	baseTitle(title: string | null | undefined): string {
		if (!title) return '';
		return String(title)
			.replace(/\s*[\(\[]\s*original(\s+mix)?\s*[\)\]]\s*$/i, '')
			.replace(/\s+-\s+original(\s+mix)?\s*$/i, '')
			.replace(/\s+original\s+mix\s*$/i, '')
			.trim();
	}

	score(target: Target, c: Candidate): ScoreResult {
		const targetTitleN = this.normalize(target.title);
		const targetTitleBaseN = this.normalize(this.baseTitle(target.title));
		const targetDur = target.duration ?? 0;

		const isrcMatch = !!(
			target.isrc &&
			c.isrc &&
			target.isrc.toUpperCase() === c.isrc.toUpperCase()
		);

		const candTitleFullN = this.normalize([c.title, c.version].filter(Boolean).join(' '));
		const candTitleBareN = this.normalize(c.title);
		const candTitleBareBaseN = this.normalize(this.baseTitle(c.title));

		const titleEquals = (a: string, b: string) => a.length > 0 && a === b;
		const titleContains = (a: string, b: string) =>
			a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));

		const titleExact =
			titleEquals(candTitleFullN, targetTitleN) ||
			titleEquals(candTitleBareN, targetTitleN) ||
			titleEquals(candTitleFullN, targetTitleBaseN) ||
			titleEquals(candTitleBareBaseN, targetTitleBaseN);

		const titlePartial =
			!titleExact &&
			(titleContains(candTitleFullN, targetTitleN) ||
				titleContains(candTitleBareN, targetTitleN) ||
				titleContains(candTitleFullN, targetTitleBaseN));

		// Compare artist TOKENS, not whole strings — see ARTIST_SPLIT_RE. A
		// whole-string comparison can never match an RB comma-joined artist
		// field against individually-tagged artists, which made the scanner
		// mint duplicate rows for curated tracks (2026-06-25 incident).
		const candArtistTokens = this.artistTokens(c.artists);
		const targetArtistTokens = this.artistTokens(target.artists);
		let artistMatchCount = 0;
		for (const t of targetArtistTokens) {
			if (candArtistTokens.has(t)) artistMatchCount++;
		}
		const artistMatch = artistMatchCount > 0;

		// Version preference. When target.title has no version annotation,
		// candidates with no version (or "Original Mix") are the right pick;
		// "Extended Mix" / "Radio Edit" entries are different recordings of
		// the same composition and would carry different BPM/key. We can't
		// strictly reject mismatches here (Beatport sometimes ships only an
		// Extended Mix), but a score nudge keeps the right mix on top.
		const targetHasVersion = /[\(\[][^)\]]+[\)\]]\s*$|\s+-\s+[^-]+$/.test(
			(target.title || '').replace(/\s*[\(\[]\s*original(\s+mix)?\s*[\)\]]\s*$/i, '').replace(/\s+-\s+original(\s+mix)?\s*$/i, '')
		);
		const candVersionN = this.normalize(c.version);
		const candHasVersion = candVersionN.length > 0 && candVersionN !== 'original mix';
		const versionMatch = !targetHasVersion && !candHasVersion;

		const dDiff = c.duration && targetDur ? Math.abs(c.duration - targetDur) : Infinity;

		const acceptable =
			isrcMatch || ((titleExact || titlePartial) && artistMatch && dDiff <= 5);

		let score = 0;
		if (acceptable) {
			if (isrcMatch) score += 1000;
			if (titleExact) score += 50;
			else if (titlePartial) score += 20;
			// Per-artist weight — a candidate matching all 4 credited artists
			// beats one matching just the primary by 30pts, enough to break
			// ties between different "Feeling" tracks sharing one artist.
			score += Math.min(artistMatchCount * 15, 60);
			if (dDiff <= 2) score += 100;
			else if (dDiff <= 5) score += 50;
			// Same-version preference. Pushes "Feeling" (no version) above
			// "Feeling (Extended Mix)" when the target is the original.
			if (versionMatch) score += 25;
			else if (targetHasVersion && candHasVersion) {
				// Both have versions — exact normalized match nudges score up.
				const targetVersionN = this.normalize(this.baseTitle(target.title) === target.title
					? ''
					: target.title.slice(this.baseTitle(target.title).length).replace(/^[\s\-\(\[]+|[\)\]\s]+$/g, ''));
				if (targetVersionN && targetVersionN === candVersionN) score += 25;
			}
		}

		return {
			acceptable,
			score,
			signals: { isrcMatch, titleExact, titlePartial, artistMatch, artistMatchCount, versionMatch, dDiff },
		};
	}

	pick<C extends Candidate>(candidates: C[], target: Target, trace: Trace | null = null): C | null {
		if (!candidates?.length) {
			if (trace) trace.candidates = [];
			return null;
		}

		let best: C | null = null;
		let bestScore = 0;
		const traceCands: TraceCandidate[] | null = trace ? [] : null;

		for (const c of candidates) {
			const { acceptable, score, signals } = this.score(target, c);

			if (traceCands) {
				traceCands.push({
					cand: `${(c.artists || []).join('/')} — ${c.title}${
						c.version ? ' [' + c.version + ']' : ''
					} (id:${c.id}, dur:${c.duration}s, isrc:${c.isrc})`,
					score,
					why: acceptable
						? `accept: ${this._whyAccept(signals)}`
						: `reject: ${this._whyReject(signals)}`,
					candDetail: c,
				});
			}

			if (acceptable && score > bestScore) {
				bestScore = score;
				best = c;
			}
		}

		if (trace) {
			trace.candidates = traceCands ?? [];
			trace.bestScore = bestScore;
			trace.picked = best;
		}

		return best;
	}

	private _whyAccept(s: ScoreSignals): string {
		const parts: string[] = [];
		if (s.isrcMatch) parts.push('isrc');
		if (s.titleExact) parts.push('titleExact');
		else if (s.titlePartial) parts.push('titlePartial');
		if (s.artistMatchCount > 0) parts.push(`artist×${s.artistMatchCount}`);
		if (s.versionMatch) parts.push('versionMatch');
		if (s.dDiff <= 2) parts.push(`dur±2(${s.dDiff}s)`);
		else if (s.dDiff <= 5) parts.push(`dur±5(${s.dDiff}s)`);
		return parts.join(', ');
	}

	private _whyReject(s: ScoreSignals): string {
		return `isrc:${s.isrcMatch} title:${s.titleExact || s.titlePartial} artist×${s.artistMatchCount} dur≤5:${s.dDiff <= 5}(diff ${s.dDiff}s)`;
	}
}

export const sharedScorer = new Scorer();
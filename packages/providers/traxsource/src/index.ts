// Traxsource HTML-scrape client — the fallback to @curator/beatport for tracks
// Beatport's catalog doesn't carry. Same shape and scoring as BeatportClient
// (the shared Scorer in @curator/matcher), so acceptance stays consistent
// across providers.
//
// Why scrape, and only ONE endpoint: Traxsource has no public API, and its
// Cloudflare WAF 403s Node/undici (pass an Electron net.fetch). Worse, only the
// combined `/search?term=` page survives the WAF — the dedicated
// `/search/tracks` path and every `/track/<id>` detail page return a 403
// challenge. So everything we can read comes from the search rows:
//   title, version/mix, duration, artists, label, key, bpm, genre.
// ISRC and release date live only on the (blocked) detail page, so the
// ISRC level of the match chain is dark here — matching degrades to the
// title + artist + duration rule (plus the original/extended fallback).
//
// One line per lookup by default; CURATOR_TX_DEBUG=1 adds the verbose trace.

import {
	sharedScorer,
	ProviderBlockedError,
	Cooldown,
	cloudflareChallengeReason,
	type Trace,
} from '@curator/matcher';

declare const process: { env?: Record<string, string | undefined> } | undefined;

const DEBUG = (typeof process !== 'undefined' ? process?.env?.CURATOR_TX_DEBUG : null) === '1';

// See @curator/beatport for the rationale — same Cloudflare, same backoff.
const BLOCK_COOLDOWN_MS = 5 * 60 * 1000;

export interface TraxsourceTrack {
	id: number;
	url: string;
	title: string;
	mix: string | null;
	// Always null — Traxsource doesn't expose ISRC on the accessible search
	// page. Kept on the shape so callers/scorer treat it like BeatportTrack.
	isrc: string | null;
	duration: number | null;
	bpm: number | null;
	// Musical notation as Traxsource prints it ("D#min", "Emin"). The enricher
	// converts to Camelot via keyToCamelot at the boundary.
	key: string | null;
	genre: string | null;
	label: string | null;
	artists: string[];
	// Always null — release date is detail-page only (Cloudflare-blocked).
	release_date: string | null;
}

export interface TraxsourceTarget {
	title: string;
	artists: string[];
	duration: number | null;
	isrc?: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TraxsourceClientOptions {
	// Inject a fetch impl. In Electron main, pass `net.fetch` — its Chromium
	// network stack presents a real Chrome TLS fingerprint + UA, required to
	// clear Traxsource's Cloudflare WAF.
	fetchImpl?: FetchLike;
}

const HEADERS = {
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
	'Accept-Language': 'en-US,en;q=0.9',
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

export class TraxsourceClient {
	private readonly fetchImpl: FetchLike;
	private readonly cooldown = new Cooldown(BLOCK_COOLDOWN_MS);

	constructor(opts: TraxsourceClientOptions = {}) {
		this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	}

	// True while backing off after a detected Cloudflare challenge — the
	// enricher gates applicableTo() on this.
	isCoolingDown(): boolean {
		return this.cooldown.active;
	}

	private _blocked(status: number, reason: string): never {
		const firstHit = !this.cooldown.active;
		this.cooldown.trip();
		if (firstHit) {
			console.warn(`[traxsource] Cloudflare challenge (${reason}, HTTP ${status}) — backing off ${BLOCK_COOLDOWN_MS / 1000}s`);
		}
		throw new ProviderBlockedError('traxsource', status, reason);
	}

	async lookup(target: TraxsourceTarget): Promise<TraxsourceTrack | null> {
		const logResult = (matched: boolean) =>
			console.log(`[traxsource] ${(target.artists ?? []).join(', ')} - ${target.title} : matched:${matched}`);

		if (!target.title || !target.artists?.[0]) {
			logResult(false);
			return null;
		}
		if (DEBUG) console.log(`[traxsource] ───────── lookup "${target.title}" by ${target.artists.join('/')} (dur:${target.duration}s)`);

		// Same fallback chain as Beatport: title + all artists first (the most
		// distinctive query), then per-artist. The strict scorer prevents false
		// positives even when later queries widen the pool.
		const queries = this._buildQueries(target);
		const seenIds = new Set<number>();
		const pool: TraxsourceTrack[] = [];
		for (const q of queries) {
			const candidates = await this._search(q);
			if (DEBUG) console.log(`[traxsource] got ${candidates.length} candidate(s) for query "${q}"`);
			for (const c of candidates) {
				if (!seenIds.has(c.id)) {
					seenIds.add(c.id);
					pool.push(c);
				}
			}
			const picked = this._pickBest(pool, target);
			if (picked) {
				if (DEBUG) console.log(`[traxsource] ✔ picked id=${picked.id} "${picked.title}" bpm=${picked.bpm} key=${picked.key} label=${picked.label} genre=${picked.genre} (after "${q}")`);
				logResult(true);
				return picked;
			}
		}
		// Last resort: original↔extended differ by minutes, which the strict
		// duration rule rejects. Same bridge as Beatport — same base title, same
		// artist, neither side a named remix → accept despite the length gap.
		const fallback = this._pickExtendedFallback(pool, target);
		if (fallback) {
			if (DEBUG) console.log(`[traxsource] ⤷ extended/original fallback id=${fallback.id} "${fallback.title}${fallback.mix ? ` (${fallback.mix})` : ''}" (dur ${fallback.duration}s vs target ${target.duration}s)`);
			logResult(true);
			return fallback;
		}
		if (DEBUG) console.log(`[traxsource] ✗ no acceptable candidate for "${target.title}" across ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
		logResult(false);
		return null;
	}

	private _buildQueries(target: TraxsourceTarget): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const push = (q: string) => {
			const k = q.toLowerCase().trim();
			if (k && !seen.has(k)) {
				seen.add(k);
				out.push(q);
			}
		};
		const artists = target.artists.filter(Boolean);
		if (artists.length) push(`${target.title} ${artists.join(' ')}`);
		for (const a of artists) push(`${target.title} ${a}`);
		return out;
	}

	private async _search(query: string): Promise<TraxsourceTrack[]> {
		// Combined search page — the only endpoint that clears the WAF. Returns
		// ~10–25 track rows; the scorer picks among them.
		if (this.cooldown.active) throw new ProviderBlockedError('traxsource', 0, 'cooldown');
		const url = `https://www.traxsource.com/search?term=${encodeURIComponent(query)}`;
		if (DEBUG) console.log(`[traxsource] GET ${url}`);
		const res = await this.fetchImpl(url, { credentials: 'omit', headers: HEADERS }).catch((err: unknown) => {
			if (DEBUG) console.warn('[traxsource] fetch threw', err instanceof Error ? err.message : err);
			return null;
		});
		if (!res) return [];
		const cfHeader = cloudflareChallengeReason(res.status, res.headers, null);
		if (cfHeader) this._blocked(res.status, cfHeader);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			const reason = cloudflareChallengeReason(res.status, res.headers, body);
			if (reason) this._blocked(res.status, reason);
			if (DEBUG) console.warn(`[traxsource] non-OK response (${res.status}), bailing`);
			return [];
		}
		const html = await res.text();
		return parseTraxsourceRows(html);
	}

	private _pickBest(candidates: TraxsourceTrack[], target: TraxsourceTarget): TraxsourceTrack | null {
		if (!candidates.length) return null;
		const adapted = candidates.map((c) => ({
			id: c.id,
			title: c.title,
			version: c.mix,
			artists: c.artists,
			duration: c.duration,
			isrc: c.isrc,
			__src: c,
		}));
		const trace: Trace | null = DEBUG ? {} : null;
		const picked = sharedScorer.pick(adapted, {
			title: target.title,
			artists: target.artists,
			duration: target.duration,
			isrc: target.isrc ?? null,
		}, trace);
		if (DEBUG && trace?.candidates?.length) {
			console.log(`[traxsource] scorer breakdown (best=${trace.bestScore ?? 0}):`);
			for (const tc of trace.candidates) console.log(`[traxsource]   score=${tc.score} ${tc.why} :: ${tc.cand}`);
		}
		return picked ? (picked as typeof adapted[number]).__src : null;
	}

	// Original↔Extended last-resort match — identical rule to BeatportClient.
	// Duration is ignored; only Original/Extended of the same base title +
	// artist qualify, never a named remix.
	private _pickExtendedFallback(candidates: TraxsourceTrack[], target: TraxsourceTarget): TraxsourceTrack | null {
		if (!candidates.length) return null;
		const norm = (s: string | null | undefined) => sharedScorer.normalize(s);
		const targetBaseN = norm(sharedScorer.baseTitle(target.title));
		if (!targetBaseN) return null;
		const targetVersion = this._titleVersion(target.title);
		if (targetVersion && this._versionClass(targetVersion) === null) return null;
		const targetArtistSet = new Set((target.artists || []).map(norm).filter(Boolean));

		let best: TraxsourceTrack | null = null;
		let bestRank = -1;
		for (const c of candidates) {
			const vc = this._versionClass(c.mix);
			if (vc === null) continue;
			if (norm(sharedScorer.baseTitle(c.title)) !== targetBaseN) continue;
			if (!(c.artists || []).some((a) => targetArtistSet.has(norm(a)))) continue;
			const rank = vc === 'original' ? 1 : 0;
			if (rank > bestRank) {
				bestRank = rank;
				best = c;
			}
		}
		return best;
	}

	private _versionClass(v: string | null | undefined): 'original' | 'extended' | null {
		const n = sharedScorer.normalize(v);
		if (!n || n === 'original mix' || n === 'original') return 'original';
		if (n === 'extended mix' || n === 'extended') return 'extended';
		return null;
	}

	private _titleVersion(title: string | null | undefined): string {
		if (!title) return '';
		const s = String(title);
		const m = s.match(/[\(\[]([^)\]]+)[\)\]]\s*$/) ?? s.match(/\s+-\s+(.+?)\s*$/);
		return m ? (m[1] ?? '').trim() : '';
	}
}

// Decode the handful of HTML entities Traxsource emits, strip tags, collapse
// whitespace. Exported alongside parseTraxsourceRows for the fixture test.
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function strip(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cellOf(block: string, cls: string): string {
	// Cells we read (title/artists/label/key-bpm/genre) contain spans but no
	// nested <div>, so a non-greedy match to the first </div> is the cell.
	const m = block.match(new RegExp(`<div class="trk-cell ${cls}">([\\s\\S]*?)</div>`));
	return m ? m[1]! : '';
}

// Parse the `.trk-row` blocks out of a Traxsource search page. Exported so the
// scrape can be tested against a saved HTML fixture without a network call.
export function parseTraxsourceRows(html: string): TraxsourceTrack[] {
	const blocks = html.split(/(?=<div data-trid=")/).filter((b) => b.startsWith('<div data-trid="'));
	const out: TraxsourceTrack[] = [];
	for (const block of blocks.slice(0, 25)) {
		const idM = block.match(/data-trid="(\d+)"/);
		if (!idM) continue;
		const id = Number(idM[1]);
		if (!Number.isFinite(id) || id === 0) continue;

		const titleCell = cellOf(block, 'title');
		const hrefM = titleCell.match(/<a href="(\/track\/\d+[^"]*)">([\s\S]*?)<\/a>/);
		const title = strip(hrefM?.[2] ?? '');
		if (!title) continue;
		const href = hrefM?.[1] ?? `/track/${id}/-`;

		const durM = titleCell.match(/<span class="duration">\((\d+):(\d+)\)<\/span>/);
		const duration = durM ? Number(durM[1]) * 60 + Number(durM[2]) : null;

		// version/mix = whatever's left in the title cell after the title link
		// and the duration span (empty for an Original).
		const mix =
			strip(
				titleCell
					.replace(/<a href="\/track\/[\s\S]*?<\/a>/, '')
					.replace(/<span class="duration">[\s\S]*?<\/span>/, ''),
			) || null;

		const artists = [...cellOf(block, 'artists').matchAll(/data-aid="\d+">([\s\S]*?)<\/a>/g)]
			.map((m) => strip(m[1]!))
			.filter(Boolean);

		const label = strip(cellOf(block, 'label')) || null;
		const genre = strip(cellOf(block, 'genre')) || null;

		// key-bpm cell: "D#min<br>126" → key "D#min", bpm 126.
		const kb = strip(cellOf(block, 'key-bpm').replace(/<br\s*\/?>/g, ' '));
		const bpmM = kb.match(/(\d+)\s*$/);
		const bpm = bpmM ? Number(bpmM[1]) : null;
		const key = kb.replace(/\d+\s*$/, '').trim() || null;

		out.push({
			id,
			url: `https://www.traxsource.com${href}`,
			title,
			mix,
			isrc: null,
			duration,
			bpm,
			key,
			genre,
			label,
			artists,
			release_date: null,
		});
	}
	return out;
}

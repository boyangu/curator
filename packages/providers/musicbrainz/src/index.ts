// MusicBrainz client — ISRC-pivot lookup + cross-platform URL harvester.
// Rate-limited to 1.1 req/sec internally per MB's policy.
// Cache is the caller's responsibility (inject via constructor options).

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MIN_REQ_INTERVAL_MS = 1100;

export interface MBRecordingNormalized {
	mbid: string;
	title: string;
	length: number | null;
	disambiguation: string;
	artists: string[];
	urls: Record<string, { url: string; id: string | null; relType: string }>;
	allUrls: { type: string; url: string }[];
	releases: {
		id: string;
		title: string;
		date?: string;
		country?: string;
		status?: string;
		releaseGroupId?: string;
	}[];
}

export interface MusicBrainzClientOptions {
	userAgent: string; // REQUIRED. Format: "App/Version ( contact )"
	cache?: {
		get: (key: string) => Promise<MBRecordingNormalized | null | undefined>;
		set: (key: string, value: MBRecordingNormalized) => Promise<void>;
	};
	fetch?: typeof fetch;
}

interface MBRecording {
	id: string;
	title: string;
	length?: number | null;
	disambiguation?: string;
	'artist-credit'?: { name?: string; artist?: { name?: string } }[];
	relations?: {
		'target-type'?: string;
		type?: string;
		url?: { resource?: string };
	}[];
	releases?: {
		id: string;
		title: string;
		date?: string;
		country?: string;
		status?: string;
		'release-group'?: { id?: string };
	}[];
}

interface MBIsrcResponse {
	recordings?: MBRecording[];
}

export class MusicBrainzClient {
	private lastRequestAt = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly fetchFn: typeof fetch;

	constructor(private readonly opts: MusicBrainzClientOptions) {
		this.fetchFn = opts.fetch ?? globalThis.fetch;
	}

	async lookupByIsrc(isrc: string): Promise<MBRecordingNormalized | null> {
		if (!isrc) return null;
		const key = `mb:isrc:${isrc.toUpperCase()}`;

		if (this.opts.cache) {
			const cached = await this.opts.cache.get(key);
			if (cached !== undefined) return cached ?? null;
		}

		const url = `${MB_BASE}/isrc/${encodeURIComponent(isrc)}?inc=url-rels+artist-credits+releases&fmt=json`;
		const res = (await this.fetch(url)) as MBIsrcResponse | null;

		if (!res || !res.recordings?.length) return null;

		// when multiple recordings share the ISRC (different masters), prefer the
		// one with the most url-relationships — that's the one MB editors have
		// invested in
		const recording = res.recordings
			.slice()
			.sort((a, b) => (b.relations?.length || 0) - (a.relations?.length || 0))[0]!;

		const normalized = this.normalize(recording);

		if (this.opts.cache) await this.opts.cache.set(key, normalized);

		return normalized;
	}

	private fetch(url: string): Promise<unknown> {
		const task = async (): Promise<unknown> => {
			await this.waitTurn();
			try {
				const res = await this.fetchFn(url, {
					headers: {
						'User-Agent': this.opts.userAgent,
						Accept: 'application/json',
					},
				});

				if (res.status === 503) {
					// rate-limited; back off and retry once
					await new Promise((r) => setTimeout(r, 2500));
					const retry = await this.fetchFn(url, {
						headers: {
							'User-Agent': this.opts.userAgent,
							Accept: 'application/json',
						},
					});
					if (!retry.ok) return null;
					return retry.json();
				}

				if (!res.ok) return null;
				return res.json();
			} catch {
				return null;
			}
		};

		this.queue = this.queue.then(task, task);
		return this.queue;
	}

	private async waitTurn(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastRequestAt;
		if (elapsed < MIN_REQ_INTERVAL_MS) {
			await new Promise((r) => setTimeout(r, MIN_REQ_INTERVAL_MS - elapsed));
		}
		this.lastRequestAt = Date.now();
	}

	private normalize(recording: MBRecording): MBRecordingNormalized {
		const urls: MBRecordingNormalized['urls'] = {};
		const allUrls: MBRecordingNormalized['allUrls'] = [];

		for (const rel of recording.relations ?? []) {
			if (rel['target-type'] !== 'url') continue;
			const u = rel.url?.resource;
			if (!u) continue;
			allUrls.push({ type: rel.type ?? '', url: u });
			const classified = classifyUrl(u);
			if (classified && !urls[classified.service]) {
				urls[classified.service] = {
					url: u,
					id: classified.id ?? null,
					relType: rel.type ?? '',
				};
			}
		}

		return {
			mbid: recording.id,
			title: recording.title,
			length: recording.length ?? null,
			disambiguation: recording.disambiguation ?? '',
			artists: (recording['artist-credit'] ?? [])
				.map((a) => a.name ?? a.artist?.name ?? '')
				.filter(Boolean),
			urls,
			allUrls,
			releases: (recording.releases ?? []).map((r) => ({
				id: r.id,
				title: r.title,
				date: r.date,
				country: r.country,
				status: r.status,
				releaseGroupId: r['release-group']?.id,
			})),
		};
	}
}

export function classifyUrl(url: string): { service: string; id?: string | null } | null {
	let m: RegExpMatchArray | null;
	if ((m = url.match(/(?:listen\.)?tidal\.com\/(?:browse\/)?track\/(\d+)/i)))
		return { service: 'tidal', id: m[1] };
	if ((m = url.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/i)))
		return { service: 'spotify', id: m[1] };
	if ((m = url.match(/beatport\.com\/(?:[a-z]{2}\/)?track\/[^\/]+\/(\d+)/i)))
		return { service: 'beatport', id: m[1] };
	if (/bandcamp\.com\//i.test(url)) return { service: 'bandcamp' };
	if (/soundcloud\.com\//i.test(url)) return { service: 'soundcloud' };
	if ((m = url.match(/(?:music\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/i)))
		return { service: 'youtube', id: m[1] };
	if ((m = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/i))) return { service: 'youtube', id: m[1] };
	if ((m = url.match(/discogs\.com\/(?:[a-z-]+\/)?release\/(\d+)/i)))
		return { service: 'discogs_release', id: m[1] };
	if ((m = url.match(/discogs\.com\/(?:[a-z-]+\/)?master\/(\d+)/i)))
		return { service: 'discogs_master', id: m[1] };
	if (/music\.apple\.com\//i.test(url)) {
		const ai = url.match(/[?&]i=(\d+)/);
		return { service: 'apple', id: ai?.[1] ?? null };
	}
	if ((m = url.match(/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i)))
		return { service: 'deezer', id: m[1] };
	if (/last\.fm\//i.test(url)) return { service: 'lastfm' };
	if ((m = url.match(/wikidata\.org\/wiki\/(Q\d+)/i))) return { service: 'wikidata', id: m[1] };
	if (/wikipedia\.org\//i.test(url)) return { service: 'wikipedia' };
	if (/genius\.com\//i.test(url)) return { service: 'genius' };
	if (/musixmatch\.com\//i.test(url)) return { service: 'musixmatch' };
	if (/mixcloud\.com\//i.test(url)) return { service: 'mixcloud' };
	return null;
}

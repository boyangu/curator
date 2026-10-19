// Agent result sets — the citable, playable track/release lists the agent
// presents into the Discover view. Anti-hallucination by construction: every
// item must reference an id the agent obtained from a prior tool call this
// turn (validated host-side against the DBs / the turn's provider-hit
// cache); badges and play refs are derived here, never trusted from the
// model.

export type AgentResultItemKind = 'library-track' | 'feed-item' | 'kb-entity' | 'provider-hit';

export interface AgentResultItem {
	kind: AgentResultItemKind;
	title: string;
	artists: string[];
	// Exactly one strong ref, matching `kind`.
	trackId?: string;
	feedItemId?: string;
	kbEntityId?: string;
	providerRef?: { provider: 'spotify' | 'beatport' | 'tidal' | 'traxsource'; id: string; url?: string };
	meta?: {
		bpm?: number | null;
		keyCamelot?: string | null;
		genre?: string | null;
		label?: string | null;
		releaseDate?: string | null;
		durationSec?: number | null;
		coverUrl?: string | null;
	};
	// Agent-supplied web citations (URLs it actually read this turn).
	citations?: { url: string; note?: string }[];
	// One-line "why this is here" — rendered on the row.
	note?: string;
	// Host-derived (never model-supplied):
	badge: 'library' | 'feed' | 'kb' | 'web';
	playRef?: { source: 'spotify'; sourceTrackId: string } | null;
}

export interface AgentResultSet {
	id: string;
	sessionId: string;
	turnId: string;
	title: string;
	summary: string | null;
	createdAt: number;
	items: AgentResultItem[];
}

// What the model actually submits via present_result_set — the host-derived
// fields absent, refs unvalidated.
export interface AgentResultItemDraft {
	kind: AgentResultItemKind;
	title: string;
	artists: string[];
	trackId?: string;
	feedItemId?: string;
	kbEntityId?: string;
	providerRef?: { provider: 'spotify' | 'beatport' | 'tidal' | 'traxsource'; id: string; url?: string };
	meta?: AgentResultItem['meta'];
	citations?: { url: string; note?: string }[];
	note?: string;
}

// What result-set validation needs from a provider-hit source. Satisfied by
// the per-turn ProviderHitCache and by CompositeProviderHits (turn cache +
// the workspace manager's session-scoped cache — rows host-loaded into the
// workspace in PRIOR turns stay presentable, fabricated ids never are).
export interface ProviderHits {
	get(provider: string, id: string): { url?: string; playSpotifyId?: string } | undefined;
}

export class CompositeProviderHits implements ProviderHits {
	constructor(private readonly caches: ProviderHits[]) {}
	get(provider: string, id: string): { url?: string; playSpotifyId?: string } | undefined {
		for (const c of this.caches) {
			const hit = c.get(provider, id);
			if (hit) return hit;
		}
		return undefined;
	}
}

// Per-turn record of every provider id the host returned to the model — a
// provider-hit ref is only accepted if the model actually saw it this turn.
export class ProviderHitCache implements ProviderHits {
	private hits = new Map<string, { url?: string; playSpotifyId?: string }>();

	private key(provider: string, id: string): string {
		return `${provider}:${id}`;
	}

	record(provider: string, id: string, extra?: { url?: string; playSpotifyId?: string }): void {
		this.hits.set(this.key(provider, id), extra ?? {});
	}

	get(provider: string, id: string): { url?: string; playSpotifyId?: string } | undefined {
		return this.hits.get(this.key(provider, id));
	}

	has(provider: string, id: string): boolean {
		return this.hits.has(this.key(provider, id));
	}
}

// Deterministic lookups the validator needs — implemented in service.ts
// composition where the DBs live; tests inject fakes.
export interface ResultRefPorts {
	// curator.db: id → spotify source-track id (null when linked but no
	// spotify ref; absent key when the track doesn't exist).
	libraryTracks(ids: string[]): Promise<Map<string, string | null>>;
	// feed.db: id → { spotify track id when the item is a playable track }.
	feedItems(ids: string[]): Promise<Map<string, { playSpotifyId: string | null }>>;
	// knowledge.db: id → { resolvedId (post-merge), spotify track ref } —
	// follows mergedInto so a merged entity still validates.
	kbEntities(ids: string[]): Promise<Map<string, { resolvedId: string; playSpotifyId: string | null }>>;
}

export interface ValidatedResultItems {
	accepted: AgentResultItem[];
	rejected: { index: number; reason: string }[];
}

// Map workspace query rows into result-item drafts by column convention:
// `_kind` + `_ref_id` (the host-written provenance columns) plus `title` and
// `artists` are required; `_provider`/`_url` rebuild provider refs; meta
// columns are picked up by name. Loaded tables emit exactly these names, so
// `SELECT * FROM picks LIMIT 40` presents directly. Pure — drafts still go
// through validateResultItems, which is where fabrication dies.
const WORKSPACE_META_COLUMNS = ['bpm', 'key_camelot', 'genre', 'label', 'release_date', 'duration_sec', 'cover_url'] as const;
const META_KEYS: Record<(typeof WORKSPACE_META_COLUMNS)[number], keyof NonNullable<AgentResultItem['meta']>> = {
	bpm: 'bpm',
	key_camelot: 'keyCamelot',
	genre: 'genre',
	label: 'label',
	release_date: 'releaseDate',
	duration_sec: 'durationSec',
	cover_url: 'coverUrl',
};

export function draftsFromWorkspaceRows(
	columns: string[],
	rows: unknown[][],
): { drafts: AgentResultItemDraft[]; errors: string[] } {
	const idx = new Map(columns.map((c, i) => [c, i]));
	const missing = ['_kind', '_ref_id'].filter((c) => !idx.has(c));
	if (!idx.has('title') && !idx.has('name')) missing.push('title');
	if (missing.length > 0) {
		return { drafts: [], errors: [`result query must select columns: ${missing.join(', ')} (SELECT * from a loaded table includes them)`] };
	}
	const col = (row: unknown[], name: string): unknown => (idx.has(name) ? row[idx.get(name)!] : null);
	const drafts: AgentResultItemDraft[] = [];
	const errors: string[] = [];
	rows.forEach((row, i) => {
		const kind = col(row, '_kind');
		const refId = col(row, '_ref_id');
		// KB loads carry `name`; everything else `title` — accept either.
		const title = col(row, 'title') ?? col(row, 'name');
		if (typeof kind !== 'string' || typeof refId !== 'string' || typeof title !== 'string') {
			errors.push(`row ${i}: _kind/_ref_id/title must be non-null strings`);
			return;
		}
		const rawArtists = col(row, 'artists');
		let artists: string[] = [];
		if (typeof rawArtists === 'string') {
			// Loaded tables store ' | '-joined names; scratch tables may carry
			// JSON arrays (of strings or {name} objects) — accept both.
			if (rawArtists.trim().startsWith('[')) {
				try {
					const parsed = JSON.parse(rawArtists) as unknown[];
					artists = parsed
						.map((a) => (typeof a === 'string' ? a : (a as { name?: string })?.name))
						.filter((a): a is string => typeof a === 'string');
				} catch { artists = [rawArtists]; }
			} else {
				artists = rawArtists.split(' | ').filter((a) => a.length > 0);
			}
		}
		const meta: NonNullable<AgentResultItem['meta']> = {};
		for (const c of WORKSPACE_META_COLUMNS) {
			const v = idx.has(c) ? col(row, c) : null;
			if (v != null && v !== '') (meta as Record<string, unknown>)[META_KEYS[c]] = v;
		}
		const note = idx.has('note') ? col(row, 'note') : null;
		const provider = idx.has('_provider') ? col(row, '_provider') : null;
		const url = idx.has('_url') ? col(row, '_url') : null;
		const base: AgentResultItemDraft = {
			kind: kind as AgentResultItemKind,
			title,
			artists,
			...(Object.keys(meta).length > 0 ? { meta } : {}),
			...(typeof note === 'string' && note.length > 0 ? { note } : {}),
		};
		switch (kind) {
			case 'library-track': drafts.push({ ...base, trackId: refId }); return;
			case 'feed-item': drafts.push({ ...base, feedItemId: refId }); return;
			case 'kb-entity': drafts.push({ ...base, kbEntityId: refId }); return;
			case 'provider-hit':
				if (typeof provider !== 'string' || provider.length === 0) {
					errors.push(`row ${i}: provider-hit rows need a _provider column value`);
					return;
				}
				drafts.push({
					...base,
					providerRef: {
						provider: provider as 'spotify',
						id: refId,
						...(typeof url === 'string' && url.length > 0 ? { url } : {}),
					},
				});
				return;
			default:
				errors.push(`row ${i}: unknown _kind "${kind}"`);
		}
	});
	return { drafts, errors };
}

const BADGE_BY_KIND: Record<AgentResultItemKind, AgentResultItem['badge']> = {
	'library-track': 'library',
	'feed-item': 'feed',
	'kb-entity': 'kb',
	'provider-hit': 'web',
};

export async function validateResultItems(
	drafts: AgentResultItemDraft[],
	ports: ResultRefPorts,
	providerHits: ProviderHits,
): Promise<ValidatedResultItems> {
	const accepted: AgentResultItem[] = [];
	const rejected: { index: number; reason: string }[] = [];

	// Batch the deterministic lookups up front (one probe per store).
	const trackIds = drafts.filter((d) => d.kind === 'library-track' && d.trackId).map((d) => d.trackId!);
	const feedIds = drafts.filter((d) => d.kind === 'feed-item' && d.feedItemId).map((d) => d.feedItemId!);
	const kbIds = drafts.filter((d) => d.kind === 'kb-entity' && d.kbEntityId).map((d) => d.kbEntityId!);
	const tracks = trackIds.length > 0 ? await ports.libraryTracks(trackIds) : new Map<string, string | null>();
	const feed = feedIds.length > 0 ? await ports.feedItems(feedIds) : new Map<string, { playSpotifyId: string | null }>();
	const kb = kbIds.length > 0 ? await ports.kbEntities(kbIds) : new Map<string, { resolvedId: string; playSpotifyId: string | null }>();

	drafts.forEach((draft, index) => {
		if (typeof draft.title !== 'string' || draft.title.trim().length === 0) {
			rejected.push({ index, reason: 'missing title' });
			return;
		}
		const base = {
			kind: draft.kind,
			title: draft.title,
			artists: Array.isArray(draft.artists) ? draft.artists.filter((a): a is string => typeof a === 'string') : [],
			...(draft.meta ? { meta: draft.meta } : {}),
			...(draft.citations ? { citations: draft.citations.filter((c) => typeof c?.url === 'string').slice(0, 5) } : {}),
			...(draft.note ? { note: draft.note } : {}),
			badge: BADGE_BY_KIND[draft.kind],
		};
		switch (draft.kind) {
			case 'library-track': {
				if (!draft.trackId) { rejected.push({ index, reason: 'library-track item requires trackId' }); return; }
				if (!tracks.has(draft.trackId)) { rejected.push({ index, reason: `unknown trackId ${draft.trackId} — use ids returned by query_library` }); return; }
				const spotifyId = tracks.get(draft.trackId) ?? null;
				accepted.push({ ...base, trackId: draft.trackId, playRef: spotifyId ? { source: 'spotify', sourceTrackId: spotifyId } : null });
				return;
			}
			case 'feed-item': {
				if (!draft.feedItemId) { rejected.push({ index, reason: 'feed-item item requires feedItemId' }); return; }
				const hit = feed.get(draft.feedItemId);
				if (!hit) { rejected.push({ index, reason: `unknown feedItemId ${draft.feedItemId} — use ids returned by query_feed` }); return; }
				accepted.push({ ...base, feedItemId: draft.feedItemId, playRef: hit.playSpotifyId ? { source: 'spotify', sourceTrackId: hit.playSpotifyId } : null });
				return;
			}
			case 'kb-entity': {
				if (!draft.kbEntityId) { rejected.push({ index, reason: 'kb-entity item requires kbEntityId' }); return; }
				const hit = kb.get(draft.kbEntityId);
				if (!hit) { rejected.push({ index, reason: `unknown kbEntityId ${draft.kbEntityId} — use ids returned by search_kb / get_kb_entity` }); return; }
				accepted.push({ ...base, kbEntityId: hit.resolvedId, playRef: hit.playSpotifyId ? { source: 'spotify', sourceTrackId: hit.playSpotifyId } : null });
				return;
			}
			case 'provider-hit': {
				const ref = draft.providerRef;
				if (!ref || typeof ref.id !== 'string' || typeof ref.provider !== 'string') {
					rejected.push({ index, reason: 'provider-hit item requires providerRef {provider, id}' });
					return;
				}
				const hit = providerHits.get(ref.provider, ref.id);
				if (!hit) {
					rejected.push({ index, reason: `provider ref ${ref.provider}:${ref.id} was not returned by any tool call this turn` });
					return;
				}
				accepted.push({
					...base,
					providerRef: { provider: ref.provider, id: ref.id, ...(ref.url ?? hit.url ? { url: ref.url ?? hit.url } : {}) },
					playRef: ref.provider === 'spotify'
						? { source: 'spotify', sourceTrackId: ref.id }
						: hit.playSpotifyId
							? { source: 'spotify', sourceTrackId: hit.playSpotifyId }
							: null,
				});
				return;
			}
			default:
				rejected.push({ index, reason: `unknown item kind ${String((draft as { kind?: unknown }).kind)}` });
		}
	});

	return { accepted, rejected };
}

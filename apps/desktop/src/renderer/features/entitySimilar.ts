// Similar artists for an artist page, by research — the one source there is
// (Spotify withdrew related-artists; the catalogue holds no such edges yet).
// The knowledge service asks the agent on demand and keeps what it answered,
// so a second ask for the same artist is instant. Claims, shown as such: the
// header marks them "via research".
//
// Runs only when asked (a button): it costs the user's own model key.

import { createSignal } from 'solid-js';
import type { EntityChip, EntityRef } from '@curator/shared';
import { kbApi } from '../data/api.js';
import { log } from '../data/log.js';

const slog = log.for('entity-similar');

export type SimilarState = 'idle' | 'running' | 'done' | 'unavailable' | 'error';

const [state, setState] = createSignal<SimilarState>('idle');
const [chips, setChips] = createSignal<EntityChip[]>([]);

// Which artist the signals describe; a stale answer is dropped.
let token = 0;
let stopEvents: (() => void) | null = null;

function reset(): void {
	token++;
	stopEvents?.();
	stopEvents = null;
	setState('idle');
	setChips([]);
}

// The researched artists as page links: by Spotify id where the knowledge
// base holds one for them (what a page can be opened by), by name otherwise.
async function chipsOf(entityId: string): Promise<EntityChip[]> {
	const detail = await kbApi.entity(entityId);
	if (!detail) return [];
	const edges = detail.edges.filter((e) => e.kind === 'similar-artist').sort((a, b) => b.confidence - a.confidence);
	return Promise.all(
		edges.map(async (e): Promise<EntityChip> => {
			const name = detail.neighbors[e.dstId]?.name ?? '';
			const spotify = (await kbApi.entity(e.dstId))?.sources.find((s) => s.source === 'spotify' && s.sourceKind === 'artist');
			return { ref: { kind: 'artist', name, ...(spotify ? { spotifyId: spotify.sourceId } : {}) } };
		}),
	);
}

export const entitySimilar = {
	state,
	chips,
	reset,

	// Can this artist be researched at all: the knowledge base names an
	// artist by its Spotify id.
	canResearch: (ref: EntityRef): boolean => ref.kind === 'artist' && !!ref.spotifyId,

	async research(ref: EntityRef): Promise<void> {
		if (!ref.spotifyId) return;
		reset();
		const mine = token;
		setState('running');
		try {
			const detail = await kbApi.resolve({ kind: 'source-ref', source: 'spotify', sourceKind: 'artist', sourceId: ref.spotifyId, entityKind: 'artist', name: ref.name });
			if (mine !== token) return;
			if (!detail.availableAspects.some((a) => a.aspect === 'similar-artists')) { setState('unavailable'); return; }
			const entityId = detail.entity.id;
			const land = async (): Promise<void> => {
				const found = await chipsOf(entityId);
				if (mine !== token) return;
				setChips(found.filter((c) => c.ref.name));
				setState('done');
			};
			// Research answers later, as an event; a remembered answer at once.
			stopEvents = kbApi.onEvent((e) => {
				if (e.kind !== 'expansion' || e.entityId !== entityId || e.aspect !== 'similar-artists') return;
				if (e.status === 'complete') void land();
				else if (e.status === 'error' && mine === token) setState('error');
			});
			const first = await kbApi.expand(entityId, 'similar-artists');
			if (mine !== token) return;
			if (first.status === 'complete') await land();
			else if (first.status === 'error') setState('error');
		} catch (e) {
			slog.warn('similar-artists research failed', undefined, e);
			if (mine === token) setState('error');
		}
	},
};

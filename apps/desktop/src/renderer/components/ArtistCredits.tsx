// ArtistCredits — inline artist credit rendered as one span per artist,
// joined by the separators artistCreditParts decides (user's separator,
// "feat.", remix style — Settings → User Interface). Used by the Discover cards and the
// now-playing surfaces; the virtualized track list has its own static-HTML
// twin (track-list.ts artistCreditHtml) because that path attaches no
// listeners per row.
//
// Names are the contract — Curator artist ids are resolved by the caller
// on click (artists:resolve), since feed items only know Spotify ids and
// player state only knows names.

import { For } from 'solid-js';
import type { TrackArtist } from '@curator/shared';
import { artistCreditParts } from '@curator/shared';
import { artistCreditFormat } from '../features/uiSettings.js';

export interface ArtistCreditsProps {
	artists: readonly (TrackArtist | string)[];
	onClick?: ((name: string, index: number) => void) | null;
	onContextMenu?: ((evt: MouseEvent, name: string, index: number) => void) | null;
}

export function ArtistCredits(props: ArtistCreditsProps) {
	// artistCreditFormat() reads the UI-settings signal, so a Settings
	// change re-renders the line without any plumbing.
	const parts = () => artistCreditParts(props.artists.map((a) => (typeof a === 'string' ? { name: a } : a)), artistCreditFormat());
	const interactive = (): boolean => !!props.onClick || !!props.onContextMenu;

	return (
		<For each={parts()}>{(p) => p.kind === 'sep'
			? <span class="artist-sep">{p.text}</span>
			: <span
				class="artist-link"
				classList={{ 'is-interactive': interactive() }}
				data-role={p.artist.role ?? ''}
				onClick={(e) => { if (!props.onClick) return; e.stopPropagation(); props.onClick(p.artist.name, p.index); }}
				onContextMenu={(e) => { if (!props.onContextMenu) return; e.preventDefault(); e.stopPropagation(); props.onContextMenu(e, p.artist.name, p.index); }}
			>{p.artist.name}</span>
		}</For>
	);
}

// NowPlayingChip — floating pill shown when playback was STARTED from a tab
// with the other context class than the one being browsed (e.g. a local file
// started on the Rekordbox tab while the user browses Discover). Pure
// wayfinding: the docked player stays up — it already shows the right
// surface for the playing track — and this chip is the "take me back to
// where this started" button.
//
// Info-only by design: no transport controls. The whole chip is one button
// that jumps to the origin tab — main.ts supplies the onJump callback
// (reading the origin the shell captured at play time).

import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import * as player from '../player.js';
import { coverImage } from './NowPlayingCard.jsx';

export interface NowPlayingChipProps {
	// shell.chipVisible — origin context ≠ current tab context.
	visible: Accessor<boolean>;
	onJump: () => void;
}

export function NowPlayingChip(props: NowPlayingChipProps) {
	const state = player.getState();

	const coverStyle = () => {
		const cur = state.current;
		if (!cur) return {};
		return {
			'background-image': coverImage(cur),
			'background-size': 'cover, cover',
			'background-position': 'center, center',
		};
	};

	return (
		<button
			type="button"
			class="np-chip"
			// Paused playback needs no trace — the chip exists to show that
			// something is audibly running in another tab. `loading` counts
			// as running so the chip doesn't blink in late on a fresh play.
			classList={{ 'is-visible': props.visible() && state.current != null && (state.playing || state.loading) }}
			title="Go to the playing track's tab"
			onClick={props.onJump}
		>
			<div class="np-chip-cover" style={coverStyle()} />
			<div class="np-chip-meta">
				<div class="np-chip-title">{state.current?.title ?? ''}</div>
				<div class="np-chip-artist">{state.current?.artist ?? ''}</div>
			</div>
			<Show when={state.current != null}>
				<span
					class="now-playing-eq np-chip-eq"
					classList={{ 'is-paused': !state.playing }}
				><i /><i /><i /><i /></span>
			</Show>
		</button>
	);
}

export interface NowPlayingChipHandle {
	destroy(): void;
}

export function mountNowPlayingChip(host: HTMLElement, props: NowPlayingChipProps): NowPlayingChipHandle {
	const dispose = render(() => <NowPlayingChip {...props} />, host);
	return { destroy: dispose };
}

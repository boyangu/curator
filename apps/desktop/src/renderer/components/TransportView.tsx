// TransportView — the transport panel in the player footer.
//
// Layout: a standalone play/pause button followed by a sunken jump-button
// row — three sizes each direction (±4 / ±16 / ±32, i.e. Jump / Jumpx4 /
// Jumpx16). Play sits outside the sunken container so it reads as the primary
// transport control rather than a peer of the jump nudges.
// Prev/next removed — queue navigation lives in the now-playing strip /
// keyboard, not the transport.
//
// Second Solid JSX component. Same shape as NowPlayingCard: subscribes
// to the playerStore directly, owns its own DOM, returns a destroy().
//
// Two pieces of state cross the boundary:
//   1. Play icon — read from player.getState().playing (createMutable
//      proxy; reads inside JSX auto-track).
//   2. Jump-button availability — host supplies an Accessor<boolean>
//      backed by a signal that main.ts updates when the cached
//      beatgrid changes. Component just reads beatsAvailable() inside
//      JSX and re-renders the `disabled` attribute. No DOM
//      query-selector needed.
//
// The beat-jump action itself (delta → seek to nearest beat) stays in
// main.ts for now (jumpByBeats reads currentAnalysis, which is module-
// local to main.ts until the analysisStore extraction in Phase 1.C).
// Component dispatches the delta back via onBeatJump.

import { render } from 'solid-js/web';
import type { Accessor } from 'solid-js';
import * as player from '../player.js';

export interface TransportViewProps {
	// Reactive accessor for "we have a usable beatgrid for the current
	// track." Host updates the underlying signal when the analysis cache
	// changes; the component's `disabled` attribute follows automatically.
	beatsAvailable: Accessor<boolean>;
	// Caller-side beat-jump dispatcher. Component supplies the delta
	// (-16 / -4 / +4 / +16); host computes the next beat from its
	// beatgrid + current playback position and calls player.seekBy.
	onBeatJump: (deltaBeats: number) => void;
}

// Standalone play/pause. Big-mode CSS turns .play-wrap into a sunken
// container; elsewhere it's a display:contents passthrough.
function PlayPauseButton() {
	const state = player.getState();
	const togglePause = () => { player.togglePause().catch(() => {}); };
	return (
		<div class="play-wrap">
			<button class="t-btn play standalone" title="Play / Pause (Space)" onClick={togglePause}>
				{state.playing ? (
					<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
						<path d="M6 4h4v16H6zM14 4h4v16h-4z" />
					</svg>
				) : (
					<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
						<path d="M5 3v18l15-9z" />
					</svg>
				)}
			</button>
		</div>
	);
}

// Sunken jump row. Three sizes (Jump / Jumpx4 / Jumpx16 = 4 / 16 / 32) each
// direction. The magnitude is BEATS when the current track has a beatgrid
// (analyzed local) and SECONDS otherwise (Spotify/Discover) — the host's
// onBeatJump branches; the unit shown in the tooltip follows beatsAvailable.
// Enabled whenever a track is loaded (Spotify included), not just when a
// beatgrid exists.
function BeatJumpRow(props: TransportViewProps) {
	const state = player.getState();
	const jumpDisabled = () => !state.current;
	const unit = (mag: number) => (props.beatsAvailable() ? `${mag} beats` : `${mag}s`);
	const Jump = (mag: number) => {
		const dir = mag < 0 ? 'Back' : 'Forward';
		const label = mag < 0 ? `‹${-mag}` : `${mag}›`;
		return (
			<button
				class="t-btn t-jump"
				title={`${dir} ${unit(Math.abs(mag))}`}
				disabled={jumpDisabled()}
				classList={{ 'is-disabled': jumpDisabled() }}
				onClick={() => props.onBeatJump(mag)}
			>{label}</button>
		);
	};
	return (
		<div class="transport sunken">
			{Jump(-32)}{Jump(-16)}{Jump(-4)}
			{Jump(4)}{Jump(16)}{Jump(32)}
		</div>
	);
}

export function TransportView(props: TransportViewProps) {
	return (
		<>
			<PlayPauseButton />
			<BeatJumpRow beatsAvailable={props.beatsAvailable} onBeatJump={props.onBeatJump} />
		</>
	);
}

export interface TransportViewHandle {
	destroy(): void;
}

export function mountTransportView(
	host: HTMLElement,
	props: TransportViewProps,
): TransportViewHandle {
	const dispose = render(() => <TransportView {...props} />, host);
	return { destroy: dispose };
}

// VolumeControl — the volume strip in the top-frame's user cluster.
// Tiny single-instance widget. Reads state.volume from the playerStore
// (createMutable proxy) for the fill width + knob x-position; dispatches
// changes via player.setVolume / player.nudgeVolume.
//
// Drag-to-set is not wired yet (matches the previous DOM-only version);
// keyboard Ctrl+↑/↓ still flows through main.ts's existing keyboard
// handler → player.nudgeVolume → playerStore update → this component
// re-renders the new width/position.

import { render } from 'solid-js/web';
import * as player from '../player.js';

export function VolumeControl() {
	const state = player.getState();
	// Read state.volume inside JSX so the reactivity registers — when
	// nudgeVolume / setVolume / drag updates the proxy, both the fill
	// and the knob's left position re-paint automatically.
	const pct = () => Math.round(state.volume * 100);
	return (
		<div class="vol" title="Volume (Ctrl+↑ / Ctrl+↓)">
			<div class="vol-track">
				<div class="vol-fill" style={{ width: `${pct()}%` }} />
				<div class="vol-knob" style={{ left: `${pct()}%` }} />
			</div>
		</div>
	);
}

export interface VolumeControlHandle {
	destroy(): void;
}

export function mountVolumeControl(host: HTMLElement): VolumeControlHandle {
	const dispose = render(() => <VolumeControl />, host);
	return { destroy: dispose };
}

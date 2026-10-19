// Renderer-side cue palette — single source of truth for cue color lookups
// inside the desktop app. Mirrors the rb sidecar's static palette via the
// `rekordbox:cue-palette` IPC channel.
//
// Boundary invariant: nothing above this module should know what "cti:22"
// or any rb-side color id means. Components paint hex strings looked up by
// id; the cue context menu renders swatches sourced from `cuePaletteEntries()`.
// When we sync to rb, only the opaque ids ride down — the Python sidecar
// owns the (id → DjmdCue.Color/ColorTableIndex) translation.

import type { CuePaletteEntry } from '@curator/core';
import { log } from './data/log.js';

const slog = log.for('cuePalette');

// Default color used when an id isn't in the palette map yet — covers two
// cases: (a) first paint before loadCuePalette() resolves, (b) legacy
// "red"/"green"/etc strings still in the DB before the migration runs.
const FALLBACK_HEX = '#ff9028';

const byId = new Map<string, CuePaletteEntry>();
let entries: CuePaletteEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();

// Load the rb palette into the renderer cache. Idempotent — re-callable on
// sidecar respawn if/when the palette ever becomes dynamic; today it's
// process-life static so one call at boot is enough.
export async function loadCuePalette(): Promise<void> {
	try {
		const list = await window.api['rekordbox:cue-palette']();
		byId.clear();
		for (const e of list) byId.set(e.id, e);
		entries = list;
		loaded = true;
		for (const cb of listeners) {
			try { cb(); } catch (err) { slog.error('listener threw', err); }
		}
	} catch (err) {
		// rb sidecar disabled / IPC failed — leave the map empty. cueColor()
		// returns the fallback for every id, components paint orange-by-
		// default until the next reload. Logged, not thrown, so a missing
		// rb sidecar doesn't take down the rest of the app.
		slog.warn('failed to load — using fallback for all cue colors', undefined, err);
	}
}

// Look up the hex for a stored cue.color id. Unknown ids (including null
// for "no color") and the legacy named-palette strings fall back to the
// default — visually graceful while users re-color through the new picker.
export function cueColor(id: string | null | undefined): string {
	if (!id) return FALLBACK_HEX;
	return byId.get(id)?.hex ?? FALLBACK_HEX;
}

// The palette as a swatch list. Caller renders one item per entry plus a
// "No color" item before/after (which dispatches `color: null` on click).
export function cuePaletteEntries(): CuePaletteEntry[] {
	return entries;
}

// Subscribe to palette-ready / palette-changed events. Returns an
// unsubscribe fn. Components that need to repaint on first load (e.g. the
// big-waveform cue ribbon — painted via a memo that closes over entries)
// can register here.
export function onCuePaletteChange(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function isCuePaletteLoaded(): boolean {
	return loaded;
}

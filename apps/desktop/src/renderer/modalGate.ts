// Modal keyboard gate — the single place the app asks "is a modal up right now?".
//
// Every modal/overlay already owns an `isOpen` accessor (a Solid signal, or a
// plain closure boolean for the omnibar). They register that accessor here once
// at mount; nothing has to pair enter/exit calls, so the gate stays correct
// across *every* close path (Cancel, Esc, backdrop click, save-and-close).
//
// The global main-view keyboard hooks (the command dispatcher, the window zoom
// shortcuts, the omnibar hotkey) consult `isModalOpen()` and stand down while a
// modal owns the keyboard — that's how we keep a bare Space/arrow/`e`/`Del`/`Shift+Del`
// from leaking past an open dialog to the player, tracklist, and nav beneath it.

import type { Accessor } from 'solid-js';

const openAccessors = new Set<Accessor<boolean>>();

/** Register a modal's open-state accessor. Call once at mount; never unregister
 *  — modals are mounted for the app's lifetime and only toggle visibility. */
export function registerModalOpenSignal(isOpen: Accessor<boolean>): void {
	openAccessors.add(isOpen);
}

/** True if any registered modal/overlay is currently open. */
export function isModalOpen(): boolean {
	for (const isOpen of openAccessors) {
		if (isOpen()) return true;
	}
	return false;
}

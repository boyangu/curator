// "Help us connect the dots" — the one door to the modal
// (layouts/ConnectDotsDialog.tsx) for every surface that offers it: the
// Discover toolbar's button (the user's queue), and "Help connect…" on an
// artist, a label or an album (that one object).
//
// The feature exists only signed in to a catalogue server that offers it;
// `available` is what the surfaces show their entry by. `remaining` is the
// queue's size: the follows whose store pages this desktop's background
// search could not settle (core catalog-client/connect-finder.ts), counted
// there from what it already holds — asked when Discover asks and after a
// sitting, never of the cloud.

import { createSignal } from 'solid-js';
import type { ConnectDotsHandle } from '../layouts/ConnectDotsDialog.jsx';
import { connectApi } from '../data/api.js';

const [available, setAvailable] = createSignal(false);
const [remaining, setRemaining] = createSignal<number | null>(null);
let dialog: ConnectDotsHandle | null = null;
let asked = 0;
// The count is for a button's label: a few minutes stale is fine.
const RECOUNT_MS = 10 * 60_000;

async function refresh(opts: { force?: boolean } = {}): Promise<void> {
	if (!opts.force && Date.now() - asked < RECOUNT_MS) return;
	asked = Date.now();
	try {
		const on = (await connectApi.status()).available;
		setAvailable(on);
		setRemaining(on ? (await connectApi.pending()).count : null);
	} catch {
		// Signed out mid-ask, or the server away: no entry until the next ask.
		setAvailable(false);
		setRemaining(null);
	}
}

export const connectDots = {
	available,
	remaining,
	setRemaining,
	refresh,
	attach(handle: ConnectDotsHandle): void {
		dialog = handle;
	},
	open(): void {
		dialog?.open();
	},
	openFor(objectIds: string[]): void {
		if (objectIds.length) dialog?.openFor(objectIds);
	},
};

// The account-level library picture (core AccountLibraryInfo): the master
// device, how many of the account's tracks are remote rows here ("not on
// this device"), whether the server shares track details at all. Two
// surfaces read it — Settings → Account (the count line, the master
// selector) and the track-list toolbar (the "This device" chip only shows
// once there is something to hide) — so it is fetched once here and both
// subscribe, rather than each polling.
//
// When it changes: a pull materialises or absorbs remote rows, and a master
// change re-picks them on the next cycle. So it refreshes, debounced, on
// cloud-sync applied events and when a sync cycle finishes (running → idle,
// or a sign-in/out) — never per row. The count is one indexed COUNT in core
// (the partial remote_only index).

import { createSignal } from 'solid-js';
import type { AccountLibraryInfo } from '@curator/core';
import { accountApi, cloudSyncApi } from '../data/api.js';
import { log } from '../data/log.js';

const alog = log.for('account-library');

const [info, setInfo] = createSignal<AccountLibraryInfo | null>(null);
// Reactive (Solid) read for the toolbar chip.
export const accountLibraryInfo = info;

const listeners = new Set<(i: AccountLibraryInfo) => void>();

// Vanilla subscription for the Settings panel; returns the unsubscribe.
export function onAccountLibraryInfo(cb: (i: AccountLibraryInfo) => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

// Also the landing spot for setMasterDevice's answer (it returns the
// refreshed info), so both surfaces see the change at once.
export function setAccountLibraryInfo(next: AccountLibraryInfo): void {
	setInfo(next);
	for (const cb of listeners) cb(next);
}

let inflight: Promise<AccountLibraryInfo | null> | null = null;

export function refreshAccountLibraryInfo(): Promise<AccountLibraryInfo | null> {
	if (inflight) return inflight;
	inflight = accountApi.libraryInfo()
		.then((next) => { setAccountLibraryInfo(next); return next; })
		.catch((err) => { alog.warn('library info failed', { err: String(err) }); return info(); })
		.finally(() => { inflight = null; });
	return inflight;
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(ms: number): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => { timer = null; void refreshAccountLibraryInfo(); }, ms);
}

let started = false;
// Called once from boot(); idempotent.
export function startAccountLibraryWatch(): void {
	if (started) return;
	started = true;
	void refreshAccountLibraryInfo();
	cloudSyncApi.onApplied((a) => { if (a.tracks.length > 0) schedule(1500); });
	let running = false;
	let signedIn: boolean | null = null;
	cloudSyncApi.onStatus((s) => {
		if ((running && !s.running) || (signedIn !== null && signedIn !== s.signedIn)) schedule(300);
		running = s.running;
		signedIn = s.signedIn;
	});
}

// The Cloud Admin tab's side in the renderer (main/cloud-admin.ts is the
// rest): whether this app has it, whether it is showing, and where. The page
// itself is a view main lays over the app's body (`.app`, between the top
// frame and the player), so this only reports that area — on open, on every
// resize — and hides the view the moment anything else in the top frame is
// chosen. Kept on its own, outside the shell's views: the operator's tools
// are to leave the open-source repo.

import { createSignal } from 'solid-js';
import type { CloudAdminBounds } from '../../ipc.js';
import { cloudAdminApi } from '../data/api.js';

const [available, setAvailable] = createSignal(false);
const [showing, setShowing] = createSignal(false);
const [failure, setFailure] = createSignal<string | null>(null);

export const cloudAdminAvailable = available;
export const cloudAdminShowing = showing;
export const cloudAdminFailure = failure;

let asked = false;
let observer: ResizeObserver | null = null;

// The app's body in the window's coordinates: CSS pixels times the page zoom.
function bodyBounds(): CloudAdminBounds | null {
	const el = document.querySelector<HTMLElement>('.app');
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const zoom = cloudAdminApi.zoomFactor();
	return { x: r.left * zoom, y: r.top * zoom, width: r.width * zoom, height: r.height * zoom };
}

const follow = (): void => {
	const b = bodyBounds();
	if (b && showing()) void cloudAdminApi.bounds(b);
};

export async function initCloudAdmin(): Promise<void> {
	if (asked) return;
	asked = true;
	setAvailable(await cloudAdminApi.available().catch(() => false));
	if (!available()) return;
	// Anything else in the top frame puts the app's own view back.
	document.getElementById('topframe-host')?.addEventListener(
		'click',
		(e) => {
			const t = e.target as HTMLElement | null;
			if (showing() && t && !t.closest('[data-cloud-admin-tab]') && t.closest('button')) hideCloudAdmin();
		},
		true,
	);
	window.addEventListener('resize', follow);
}

export async function showCloudAdmin(): Promise<void> {
	const b = bodyBounds();
	if (!b) return;
	setShowing(true);
	const el = document.querySelector<HTMLElement>('.app');
	if (el && !observer) {
		observer = new ResizeObserver(follow);
		observer.observe(el);
	}
	const status = await cloudAdminApi.open(b);
	setFailure(status.state === 'failed' || status.state === 'unavailable' ? status.reason : null);
	if (status.state === 'unavailable') hideCloudAdmin();
}

export function hideCloudAdmin(): void {
	if (!showing()) return;
	setShowing(false);
	observer?.disconnect();
	observer = null;
	void cloudAdminApi.hide();
}

export function toggleCloudAdmin(): void {
	if (showing()) hideCloudAdmin();
	else void showCloudAdmin();
}

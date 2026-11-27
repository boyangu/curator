// Settings → Discover: how the feed looks and which sources are read for
// the user's follows.
//
//   • Feed → "Source logos": the small brand marks on every card for each
//     service the item is known on. A renderer preference (localStorage,
//     per browser origin — nothing in core gates on it), exposed as a signal
//     so the cards repaint without a remount.
//   • Feed → the read sources per follow kind: the same checkboxes the
//     Refresh menu offers (core catalog-worker/settings.ts). Unchecked means
//     nobody reads that source for the user's follows, this computer and the
//     cloud alike — the hint says so, as the menu does.
//   • Feed → how often each kind is read: once a week in the Friday window
//     (the default — releases land on Friday), daily, or as often as the
//     source allows. Sent with the worker's next ask; the master times the
//     reads by it. The Refresh menu's "check now" reads at once regardless.
//   • Beatport access: the FlareSolverr service (main/flaresolverr-host.ts)
//     Beatport lookups go through — its live state and why, Start / Stop, and
//     whether Curator starts it when it loads.

import { createSignal } from 'solid-js';
import type { CatalogReadSources } from '@curator/core';
import type { FlareSolverrStatus } from '../../ipc.js';
import { catalogApi, flareSolverrApi } from '../data/api.js';
import { providerLabel } from './feedHandles.js';
import { escapeHtml } from '../ui/format.js';
import { showToast } from '../ui/toast.js';
import { log } from '../data/log.js';

const dlog = log.for('discover-settings');
const KEY = 'curator.discover-settings.v1';

export interface DiscoverSettings {
	showSourceLogos: boolean;
}

const DEFAULTS: DiscoverSettings = { showSourceLogos: true };

function load(): DiscoverSettings {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return { ...DEFAULTS };
		return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DiscoverSettings>) };
	} catch {
		return { ...DEFAULTS };
	}
}

export const [discoverSettingsSignal, setDiscoverSettingsSignal] = createSignal<DiscoverSettings>(load());

export function updateDiscoverSettings(patch: Partial<DiscoverSettings>): void {
	const next = { ...discoverSettingsSignal(), ...patch };
	setDiscoverSettingsSignal(next);
	try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

const KIND_TITLES: Record<CatalogReadSources[number]['kind'], string> = { artist: 'Artists', label: 'Labels', playlist: 'Playlists', genre: 'Genres' };

type ReadCadence = CatalogReadSources[number]['cadence'];
const CADENCE_LABELS: Record<ReadCadence, string> = { weekly: 'Every week (Friday morning)', daily: 'Every day', source: 'As often as the source allows' };
const CADENCE_HINT = 'How often these follows are read for new music, set by Curator for everyone. Weekly reads once, on Friday morning (UTC), when releases land.';

const CLOUD_ONLY_HINT ='Only the cloud can read this source (its keys are the cloud’s). Unchecked, nobody reads it for your follows.';
const ANYWHERE_HINT = 'Unchecked, nobody reads this source for your follows — not this computer, not the cloud.';

const FS_HINT = 'Beatport sits behind a Cloudflare check that turns Curator’s own requests away. FlareSolverr loads its pages in a real browser, in a Docker container inside WSL. While it is off, Beatport lookups wait for it — tracks are not marked “not found”.';

function fsLine(s: FlareSolverrStatus): string {
	if (!s.enabled) return 'Turned off (CURATOR_DISABLE_FLARESOLVERR=1) — Beatport is asked directly.';
	switch (s.state) {
		case 'running': return `Running${s.version ? ` — FlareSolverr ${s.version}` : ''} at ${s.url}${s.managed ? ' (started by Curator)' : ''}`;
		case 'starting': return 'Starting… (the first start downloads the browser image and can take a few minutes)';
		case 'stopping': return 'Stopping…';
		case 'stopped': return `Stopped${s.reason ? ` — ${s.reason}` : ''}`;
		case 'failed': return `Could not start — ${s.reason ?? 'unknown error'}`;
		default: return 'Checking…';
	}
}

function paintFlareSolverr(s: FlareSolverrStatus): void {
	const panel = document.querySelector<HTMLElement>('[data-fs-panel]');
	if (!panel) return;
	const busy = s.state === 'starting' || s.state === 'stopping';
	panel.innerHTML = `
		<div class="settings-discover__fs-state settings-discover__fs-state--${escapeHtml(s.state)}">${escapeHtml(fsLine(s))}</div>
		<div class="settings-discover__fs-actions">
			<button class="btn-secondary" data-fs-start ${!s.enabled || busy || s.state === 'running' ? 'disabled' : ''}>Start</button>
			<button class="btn-secondary" data-fs-stop ${!s.enabled || busy || s.state !== 'running' ? 'disabled' : ''}>Stop</button>
		</div>
		<label class="settings-toggle">
			<input type="checkbox" data-fs-auto ${s.autoStart ? 'checked' : ''} ${s.enabled ? '' : 'disabled'} />
			<span class="settings-toggle__label">Start with Curator</span>
			<span class="settings-toggle__hint">Start it when Curator loads, and restart it if a lookup finds it down.</span>
		</label>`;
	const act = (sel: string, run: () => Promise<FlareSolverrStatus>, what: string) => {
		panel.querySelector<HTMLButtonElement>(sel)?.addEventListener('click', async (e) => {
			(e.currentTarget as HTMLButtonElement).disabled = true;
			try {
				paintFlareSolverr(await run());
			} catch (err) {
				dlog.warn(`flaresolverr ${what} failed`, undefined, err);
				showToast(`Could not ${what} FlareSolverr`, { kind: 'error', sub: err instanceof Error ? err.message : String(err) });
				paintFlareSolverr(await flareSolverrApi.status(true));
			}
		});
	};
	act('[data-fs-start]', () => flareSolverrApi.start(), 'start');
	act('[data-fs-stop]', () => flareSolverrApi.stop(), 'stop');
	panel.querySelector<HTMLInputElement>('[data-fs-auto]')?.addEventListener('change', async (e) => {
		const input = e.target as HTMLInputElement;
		try {
			await flareSolverrApi.setAutoStart(input.checked);
		} catch (err) {
			input.checked = !input.checked;
			showToast('Could not save that choice', { kind: 'error', sub: err instanceof Error ? err.message : String(err) });
		}
	});
}

// One subscription for the app's lifetime; it repaints the panel when open.
let fsSubscribed = false;

export async function renderSettingsDiscover(): Promise<void> {
	const wrap = document.getElementById('settings-discover');
	if (!wrap) return;
	const s = discoverSettingsSignal();
	let sources: CatalogReadSources | null = null;
	let sourcesError: string | null = null;
	try {
		sources = await catalogApi.readSources();
	} catch (err) {
		sourcesError = err instanceof Error ? err.message : String(err);
	}
	// The panel may have been closed or switched away while the read ran.
	if (!document.getElementById('settings-discover')) return;

	const sourceRows = (r: CatalogReadSources[number]): string => r.sources.map((src) => `
		<label class="settings-toggle" title="${src.cloudOnly ? CLOUD_ONLY_HINT : ANYWHERE_HINT}">
			<input type="checkbox" data-read-source="${escapeHtml(`${r.kind}/${src.provider}`)}" ${src.checked ? 'checked' : ''} />
			<span class="settings-toggle__label">${escapeHtml(providerLabel(src.provider))}${src.cloudOnly ? ' <span class="settings-discover__cloud">cloud</span>' : ''}</span>
		</label>`).join('');

	const sourcesBlock = sources
		? sources.map((r) => `
			<div class="settings-discover__kind">
				<div class="settings-discover__kind-label">${escapeHtml(KIND_TITLES[r.kind])}</div>
				<span class="settings-toggle__hint settings-discover__cadence" title="${escapeHtml(CADENCE_HINT)}">${escapeHtml(CADENCE_LABELS[r.cadence])}</span>
				${sourceRows(r)}
			</div>`).join('')
		: `<div class="settings-toggle__hint">Could not read your tracking choices${sourcesError ? ` — ${escapeHtml(sourcesError)}` : ''}.</div>`;

	wrap.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Feed</div>
			<label class="settings-toggle">
				<input type="checkbox" data-discover-source-logos ${s.showSourceLogos ? 'checked' : ''} />
				<span class="settings-toggle__label">Source logos</span>
				<span class="settings-toggle__hint">Show a small logo on each card for every service the item is known on — Spotify, Beatport, Bandcamp, SoundCloud and the rest. Click one to open the item there.</span>
			</label>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Sources read for your follows</div>
			<div class="settings-toggle__hint" style="margin-bottom: 6px;">Which services are checked for what you follow, and how often Curator reads each kind. Unchecked sources are read by nobody — not this computer, not the cloud. The same checkboxes sit in the feed's Refresh menu, whose “check now” reads at once whatever is set here.</div>
			<div class="settings-discover__sources">${sourcesBlock}</div>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Beatport access</div>
			<div class="settings-toggle__hint" style="margin-bottom: 6px;">${escapeHtml(FS_HINT)}</div>
			<div data-fs-panel><div class="settings-discover__fs-state">Checking…</div></div>
		</div>
	`;
	if (!fsSubscribed) {
		fsSubscribed = true;
		flareSolverrApi.onStatus((s) => paintFlareSolverr(s));
	}
	void flareSolverrApi.status(true).then(paintFlareSolverr, (err: unknown) => dlog.warn('flaresolverr status failed', undefined, err));

	wrap.querySelector<HTMLInputElement>('[data-discover-source-logos]')?.addEventListener('change', (e) => {
		updateDiscoverSettings({ showSourceLogos: (e.target as HTMLInputElement).checked });
	});
	for (const input of wrap.querySelectorAll<HTMLInputElement>('[data-read-source]')) {
		input.addEventListener('change', async () => {
			const key = input.dataset.readSource!;
			const next = input.checked;
			try {
				await catalogApi.setReadSources({ [key]: next });
			} catch (err) {
				input.checked = !next;
				dlog.warn('set read source failed', { key, next }, err);
				showToast('Could not save that choice', { kind: 'error', sub: err instanceof Error ? err.message : String(err) });
			}
		});
	}
}

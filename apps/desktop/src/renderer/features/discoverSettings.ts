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

import { createSignal } from 'solid-js';
import type { CatalogReadSources } from '@curator/core';
import { catalogApi } from '../data/api.js';
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
const CADENCE_OPTIONS: { value: ReadCadence; label: string }[] = [
	{ value: 'weekly', label: 'Every week (Friday morning)' },
	{ value: 'daily', label: 'Every day' },
	{ value: 'source', label: 'As often as the source allows' },
];
const CADENCE_HINT = 'How often these follows are read for new music. Weekly reads once, on Friday morning (UTC), when releases land; "as often as the source allows" is hourly for playlists and daily for artists, more on Fridays.';

const CLOUD_ONLY_HINT ='Only the cloud can read this source (its keys are the cloud’s). Unchecked, nobody reads it for your follows.';
const ANYWHERE_HINT = 'Unchecked, nobody reads this source for your follows — not this computer, not the cloud.';

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
				<select class="settings-ui__select settings-discover__cadence" data-read-cadence="${escapeHtml(r.kind)}" title="${escapeHtml(CADENCE_HINT)}">${CADENCE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === r.cadence ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>
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
			<div class="settings-toggle__hint" style="margin-bottom: 6px;">Which services are checked for what you follow, and how often. Unchecked sources are read by nobody — not this computer, not the cloud. The same checkboxes sit in the feed's Refresh menu, whose “check now” reads at once whatever is set here.</div>
			<div class="settings-discover__sources">${sourcesBlock}</div>
		</div>
	`;

	wrap.querySelector<HTMLInputElement>('[data-discover-source-logos]')?.addEventListener('change', (e) => {
		updateDiscoverSettings({ showSourceLogos: (e.target as HTMLInputElement).checked });
	});
	for (const select of wrap.querySelectorAll<HTMLSelectElement>('[data-read-cadence]')) {
		let current = select.value as ReadCadence;
		select.addEventListener('change', async () => {
			const kind = select.dataset.readCadence as CatalogReadSources[number]['kind'];
			const next = select.value as ReadCadence;
			try {
				await catalogApi.setReadCadence(kind, next);
				current = next;
			} catch (err) {
				select.value = current;
				dlog.warn('set read cadence failed', { kind, next }, err);
				showToast('Could not save that choice', { kind: 'error', sub: err instanceof Error ? err.message : String(err) });
			}
		});
	}
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

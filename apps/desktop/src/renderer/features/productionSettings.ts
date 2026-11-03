// Settings → Library → "Production quality": judgment counts, the fitted
// probe's accuracy, and the two actions (compare pairs, fit the model). Core
// owns every number (production:stats); this is a thin painter like the AI
// engine block.

import type { ProductionStats } from '@curator/core';
import { productionApi } from '../data/api.js';
import { showToast } from '../ui/toast.js';

export interface ProductionSettingsDeps {
	openCompare: () => void;
}

function pct(v: number | null): string {
	return v == null ? '—' : `${Math.round(v * 100)} %`;
}

function render(host: HTMLElement, s: ProductionStats, deps: ProductionSettingsDeps): void {
	const canFit = s.judgments >= s.minPairsToFit;
	const model = s.model;
	host.innerHTML = `
		<div class="settings-ui__section production-settings">
			<div class="settings-ui__section-label">Production quality</div>
			<div class="settings-toggle__hint">
				Tick <b>Production quality</b> in the Analyze window to measure tracks (loudness, true peak, clipping, tonal balance, stereo, lossy-source check). Right-click a track → Production profile for the read.
				Then compare pairs so Curator can learn what <i>you</i> hear as well produced: a Bradley-Terry model over the measurements, shown as the Prod column.
			</div>
			<div class="production-compare__stats">
				<span>${s.measuredTracks} tracks measured (${s.playableMeasured} playable)</span>
				<span>${s.judgments} judgments${s.ties ? ` (${s.ties} ties)` : ''} over ${s.judgedTracks} tracks</span>
				<span>${model
					? `model fitted ${new Date(model.fittedAt).toLocaleDateString()} on ${model.pairs} pairs · train ${pct(model.trainAccuracy)} · held-out ${pct(model.cvAccuracy)} · ${s.judgmentsSinceFit} new since`
					: `no model yet — ${Math.max(0, s.minPairsToFit - s.judgments)} more judgments needed`}</span>
			</div>
			<div class="production-settings__row">
				<button class="btn-primary" data-prod-compare ${s.playableMeasured < 2 ? 'disabled' : ''}>Compare pairs…</button>
				<button class="btn-secondary" data-prod-fit ${canFit ? '' : 'disabled'} title="${canFit ? 'Refit the model over every judgment and rescore the library' : `Needs ${s.minPairsToFit} judgments`}">${model ? 'Refit model' : 'Fit model'}</button>
			</div>
		</div>`;
	host.querySelector<HTMLButtonElement>('[data-prod-compare]')?.addEventListener('click', () => deps.openCompare());
	host.querySelector<HTMLButtonElement>('[data-prod-fit]')?.addEventListener('click', (e) => {
		const btn = e.currentTarget as HTMLButtonElement;
		btn.disabled = true;
		btn.textContent = 'Fitting…';
		productionApi.fit()
			.then((m) => {
				showToast('Production model fitted', { sub: `${m.pairs} pairs · held-out accuracy ${pct(m.cvAccuracy)} · ${m.scoredTracks} tracks scored` });
				return productionApi.stats().then((st) => { if (host.isConnected) render(host, st, deps); });
			})
			.catch((err) => {
				showToast('Could not fit the production model', { sub: String(err), kind: 'error' });
				productionApi.stats().then((st) => { if (host.isConnected) render(host, st, deps); }).catch(() => undefined);
			});
	});
}

let configured: ProductionSettingsDeps = { openCompare: () => undefined };
// main.ts registers the dialog opener at boot; the Library panel mounts
// the block without knowing about dialogs.
export function configureProductionSettings(deps: ProductionSettingsDeps): void { configured = deps; }

export function mountProductionSettings(host: HTMLElement, deps: ProductionSettingsDeps = configured): void {
	productionApi.stats()
		.then((s) => { if (host.isConnected) render(host, s, deps); })
		.catch((err) => { host.innerHTML = `<div class="settings-toggle__hint">Production quality unavailable: ${String(err)}</div>`; });
}

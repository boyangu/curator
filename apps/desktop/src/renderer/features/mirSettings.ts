// Settings → Similarity → "AI audio engine": status, set-up, background
// analysis toggle, default model, executor and coverage for apps/mir.
//
// Core owns every value (app_setting), so this panel is a thin view: render
// from mir:status, write through mirApi, re-render on the engine's coalesced
// status events while the host is still in the DOM.

import type { MirStatus } from '@curator/core';
import { mirApi } from '../data/api.js';
import { log } from '../data/log.js';
import { escapeHtml } from '../ui/format.js';
import { showToast } from '../ui/toast.js';

let unsubscribe: (() => void) | null = null;

const DEVICE_LABEL: Record<string, string> = { xpu: 'Intel GPU', cuda: 'NVIDIA GPU', cpu: 'CPU' };

function stateLine(s: MirStatus): string {
	if (s.provisioning) return `Setting up… ${s.provisionLog ?? ''}`;
	if (s.state === 'ready') return `Ready on ${DEVICE_LABEL[s.device ?? ''] ?? s.device ?? 'unknown device'}`;
	if (s.state === 'starting') return 'Starting…';
	return s.reason ?? (s.state === 'unavailable' ? 'Unavailable' : 'Off');
}

function render(host: HTMLElement, s: MirStatus): void {
	const enabled = new Set(s.settings.models);
	const local = s.coverage.localTracks;
	const modelRows = s.models.filter((m) => m.key !== 'stub').map((m) => {
		const cov = s.coverage.perModel[m.modelId];
		const done = cov?.done ?? 0;
		return `
			<label class="settings-toggle" title="${escapeHtml(m.summary)}">
				<input type="checkbox" data-mir-model value="${escapeHtml(m.key)}" ${enabled.has(m.key) ? 'checked' : ''}
					${enabled.has(m.key) && enabled.size === 1 ? 'disabled' : ''} />
				<span class="settings-toggle__label">${escapeHtml(m.key)}${m.text ? ' · text search' : ''}</span>
				<span class="settings-toggle__hint">${done} / ${local} analyzed${cov?.failed ? ` · ${cov.failed} failed` : ''} · ${escapeHtml(m.license)}</span>
			</label>`;
	}).join('');
	const err = s.lastError && s.state === 'ready' ? `<div class="settings-toggle__hint">Last error: ${escapeHtml(s.lastError)}</div>` : '';
	host.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">AI audio engine</div>
			<div class="settings-toggle__hint">${escapeHtml(stateLine(s))}${s.running ? ' · analyzing…' : ''}${s.pending ? ` · ${s.pending} pending` : ''}</div>
			${err}
			${s.provisionable ? `<p><button class="btn-primary" data-mir-provision ${s.provisioning ? 'disabled' : ''}>Set up AI engine</button>
				<span class="settings-toggle__hint">Downloads the Python/torch environment (several GB) into Curator's app data. Model weights download on first use.</span></p>` : ''}
			<label class="settings-toggle">
				<input type="checkbox" data-mir-enabled ${s.settings.enabled ? 'checked' : ''} ${s.state === 'disabled' ? 'disabled' : ''} />
				<span class="settings-toggle__label">Analyze my library in the background</span>
				<span class="settings-toggle__hint">Embeds every local track with the model below so Find Similar and sounds:"…" searches cover the whole library. Pauses while the beat/key analyzer runs.</span>
			</label>
			<div class="settings-ui__section-label">Models</div>
			<div class="settings-toggle__hint">Find Similar blends every checked model (the combination matched your tags and DJ sets best); sounds:"…" uses the first one with text search. Each extra model adds analysis time.</div>
			${modelRows || '<div class="settings-toggle__hint">Models appear once the engine has started.</div>'}
			<div class="settings-ui__section-label">Run on</div>
			<label class="settings-radio"><input type="radio" name="mir-exec" data-mir-exec value="local" ${s.settings.executor === 'local' ? 'checked' : ''} />
				<span class="settings-radio__label">This computer</span></label>
			<label class="settings-radio" title="${s.cloudConfigured ? '' : 'Needs `modal token new` and `modal deploy modal_app.py` in apps/mir'}">
				<input type="radio" name="mir-exec" data-mir-exec value="cloud" ${s.settings.executor === 'cloud' ? 'checked' : ''} ${s.cloudConfigured ? '' : 'disabled'} />
				<span class="settings-radio__label">Cloud GPU (Modal)
					<span class="settings-toggle__hint">Uploads compressed audio for analysis; only vectors come back.</span></span></label>
			<div class="settings-toggle__hint">Tips: right-click tracks → Find Similar. Search by sound with sounds:"warm rolling bassline" (text-capable models).</div>
		</div>`;

	const write = (patch: Parameters<typeof mirApi.setSettings>[0]): void => {
		mirApi.setSettings(patch).then((st) => render(host, st)).catch((e) => {
			showToast('Could not save AI engine settings', { sub: String(e), kind: 'error' });
		});
	};
	host.querySelector<HTMLInputElement>('[data-mir-enabled]')?.addEventListener('change', (e) => {
		write({ enabled: (e.target as HTMLInputElement).checked });
	});
	host.querySelectorAll<HTMLInputElement>('[data-mir-model]').forEach((r) => r.addEventListener('change', () => {
		// Registry order, not click order, so the text-search model stays stable.
		const keys = [...host.querySelectorAll<HTMLInputElement>('[data-mir-model]')].filter((x) => x.checked).map((x) => x.value);
		if (keys.length > 0) write({ models: keys });
	}));
	host.querySelectorAll<HTMLInputElement>('[data-mir-exec]').forEach((r) => r.addEventListener('change', () => {
		write({ executor: r.value === 'cloud' ? 'cloud' : 'local' });
	}));
	host.querySelector<HTMLButtonElement>('[data-mir-provision]')?.addEventListener('click', () => {
		mirApi.provision().then((st) => render(host, st)).catch((e) => {
			showToast('AI engine set-up failed', { sub: String(e), kind: 'error', durationMs: 8000 });
		});
	});
}

export function mountMirSettings(host: HTMLElement): void {
	unsubscribe?.();
	unsubscribe = mirApi.onEvent((e) => {
		if (!host.isConnected) { unsubscribe?.(); unsubscribe = null; return; }
		if (e.kind === 'status') render(host, e.status);
	});
	mirApi.status().then((s) => { if (host.isConnected) render(host, s); }).catch((err) => {
		log.for('mir').warn('status failed', { err: String(err) });
		host.innerHTML = '';
	});
}

// The single analysis-flags view, shared by the manual Analyze modal and the
// Settings → Library auto-analyze panel. One controlled Solid component
// renders the per-aspect checkboxes + the overwrite toggle; each surface wraps
// it with its own chrome (the modal adds track count + Analyze button; the
// settings panel adds the master "auto-analyze new tracks" toggle).
//
// The per-flag copy below is the canonical user-facing description for each
// flag — edit it here and both surfaces update.

import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { PRODUCTION_QUALITY_ENABLED } from '@curator/library-logic';
import type { AnalysisFlags, AutoAnalyzeSettings, AnalyzerResources } from '@curator/core';
import { loadAutoAnalyzeSettings, saveAutoAnalyzeSettings, pushAutoAnalyzeToCore } from './analysisFlags.js';
import { analysisApi } from '../data/api.js';

interface FlagDef {
	key: keyof AnalysisFlags;
	label: string;
	hint: string;
}

// Basic pipeline — independently skippable stages.
export const BASIC_FLAGS: FlagDef[] = [
	{ key: 'beatgrid', label: 'Beatgrid + BPM', hint: 'Detect beats, downbeats and tempo (~2-3 s/track).' },
	{ key: 'key',      label: 'Key',            hint: 'Detect musical key, Camelot (~0.5-1 s/track).' },
	{ key: 'segments', label: 'Segments',       hint: 'Detect intro / build / drop / breakdown / outro structure (~1-3 s/track).' },
	{ key: 'peaks',    label: 'Waveform',       hint: 'Build the stereo L/R waveform peaks. Tick to (re)build.' },
	{ key: 'fingerprint', label: 'Fingerprint', hint: 'Chromaprint for cross-device identity (~0.1 s/track).' },
];

// Advanced features collapse to ONE toggle: MusicExtractor is all-or-nothing in
// Essentia, so requesting any scalar runs the whole pass and computes all seven
// together. Per-feature checkboxes would be an illusion.
const ADVANCED_FLAG: FlagDef = {
	key: 'advanced',
	label: 'Advanced features',
	hint: 'MusicExtractor pass — slow, +5-15 s/track. Computes all together: Brightness, Power, Dynamic range, Punch, Dissonance, Density.',
};

// Production measurements: a stereo decode plus DSP; the whole set lands
// together, so one toggle.
export const PRODUCTION_FLAG: FlagDef = {
	key: 'production',
	label: 'Production quality',
	hint: 'Loudness, true peak, clipping, tonal balance, stereo image, lossy-source check, kick punch, per-section rows (+2-7 s/track). Feeds the Production profile and its flags.',
};

export function AnalysisFlagsForm(props: {
	flags: AnalysisFlags;
	onChange: (next: AnalysisFlags) => void;
	// Visually muted but still interactive — used by the settings panel so the
	// user can pre-configure flags while the master "auto-analyze" toggle is off.
	dimmed?: boolean;
}): JSX.Element {
	const set = (key: keyof AnalysisFlags, on: boolean): void => {
		props.onChange({ ...props.flags, [key]: on });
	};
	const row = (f: FlagDef): JSX.Element => (
		<label class="analyze-feature">
			<input
				type="checkbox"
				checked={props.flags[f.key]}
				onChange={(e) => set(f.key, e.currentTarget.checked)}
			/>
			<span class="analyze-feature__label">{f.label}</span>
			<span class="analyze-feature__hint">{f.hint}</span>
		</label>
	);
	return (
		<div class="analysis-flags" classList={{ 'analysis-flags--dimmed': props.dimmed }}>
			<div class="analysis-flags__group">
				<div class="analysis-flags__title">Basic pipeline</div>
				<For each={BASIC_FLAGS}>{row}</For>
			</div>
			<div class="analysis-flags__group analysis-flags__group--advanced">
				{row(ADVANCED_FLAG)}
				<Show when={PRODUCTION_QUALITY_ENABLED}>{row(PRODUCTION_FLAG)}</Show>
			</div>
		</div>
	);
}

// Mount the Settings → Library auto-analyze block (master toggle + shared
// flags view) into a host element. Owns its own state from localStorage,
// persists + pushes to core on every change. Returns the Solid dispose fn so
// the caller can tear it down before repainting the panel.
export function mountAutoAnalyzeSettings(host: HTMLElement): () => void {
	const [settings, setSettings] = createSignal<AutoAnalyzeSettings>(loadAutoAnalyzeSettings());
	const persist = (next: AutoAnalyzeSettings): void => {
		setSettings(next);
		saveAutoAnalyzeSettings(next);
		void pushAutoAnalyzeToCore(next);
	};
	return render(() => (
		<div class="lib-settings" data-auto-enabled={settings().enabled ? '1' : '0'}>
			<label class="settings-toggle">
				<input
					type="checkbox"
					checked={settings().enabled}
					onChange={(e) => persist({ ...settings(), enabled: e.currentTarget.checked })}
				/>
				<span class="settings-toggle__label">Automatically analyze new tracks</span>
				<span class="settings-toggle__hint">When on, each newly-ingested local file is queued for offline analysis with the stages ticked below. Off by default — keeps a fresh install from chewing through your library without consent. Manual analyze (Analyze window, “Sync grids from Rekordbox”) is unaffected.</span>
			</label>
			<AnalysisFlagsForm
				flags={settings().flags}
				dimmed={!settings().enabled}
				onChange={(flags) => persist({ ...settings(), flags })}
			/>
			<AnalyzerResourcesRow />
		</div>
	), host);
}

// "Parallel analyses" — the one knob over how much machine the analyzer may
// take. Core owns the value (app_setting) and clamps it to the sidecar's core
// count, so this row only reflects what core returns. Not dimmed with the
// auto toggle: it governs manual analyses too.
function AnalyzerResourcesRow(): JSX.Element {
	const [res, setRes] = createSignal<AnalyzerResources | null>(null);
	onMount(() => { void analysisApi.resources().then(setRes).catch(() => setRes(null)); });
	const apply = (raw: string): void => {
		const workers = Number.parseInt(raw, 10);
		if (!Number.isFinite(workers)) return;
		void analysisApi.setResources({ workers }).then(setRes).catch(() => { /* row keeps the last applied state */ });
	};
	return (
		<Show when={res()}>{(r) => {
			const pct = (): number => Math.round((r().workers / Math.max(1, r().cpuCount)) * 100);
			return (
				<label class="settings-toggle analyzer-resources">
					<input
						type="number"
						class="settings-ui__number"
						min="1"
						max={r().cpuCount}
						step="1"
						value={r().workers}
						onChange={(e) => apply(e.currentTarget.value)}
					/>
					<span class="settings-toggle__label">Parallel analyses</span>
					<span class="settings-toggle__hint">
						{r().workers} of {r().cpuCount} cores — at most ~{pct()}% of the CPU. Each analysis uses one core, so this is the analyzer's CPU ceiling. Changes apply right away; analyses already running finish first.
					</span>
				</label>
			);
		}}</Show>
	);
}

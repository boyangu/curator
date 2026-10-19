// AnalyzeModal — user-driven "analyze these tracks" dialog. The opt-in
// surface for the expensive MusicExtractor scalars (skipped by default to keep
// scanning fast) plus the basic pipeline + overwrite controls.
//
// It edits a unified AnalysisFlags object — the same shape the Settings →
// Library auto-analyze panel edits — and renders it through the shared
// AnalysisFlagsForm view. The selection persists across sessions
// (loadManualFlags / saveManualFlags); on submit it's handed to the caller,
// which enqueues with `analyzeFlags` (core converts to the sidecar wire
// shape).
//
// Shape:
//   • opened with a list of trackIds (from selection or right-click)
//   • shows count + the shared flags view
//   • Analyze button enqueues; modal closes; chip drains.

import { createSignal, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import { registerModalOpenSignal } from '../modalGate.js';
import type { AnalysisFlags } from '@curator/core';
import { AnalysisFlagsForm, BASIC_FLAGS } from '../features/analysisFlagsForm.jsx';
import { loadManualFlags, saveManualFlags } from '../features/analysisFlags.js';
import { mirApi } from '../data/api.js';
import { showToast } from '../ui/toast.js';

// AI-engine embeddings (apps/mir) are a separate pipeline from the Essentia
// analyzer, so the flag lives beside the shared AnalysisFlags form rather than
// inside it (the auto-analyze settings have their own background toggle under
// Settings → Similarity). Remembered per machine like the manual flags.
const AI_FLAG_KEY = 'curator.analyze-ai.v1';
function loadAiFlag(): boolean {
	try { return localStorage.getItem(AI_FLAG_KEY) !== '0'; } catch { return true; }
}
function saveAiFlag(on: boolean): void {
	try { localStorage.setItem(AI_FLAG_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

export interface AnalyzeModalProps {
	// Called when the user clicks "Analyze". Caller dispatches the IPC enqueue
	// with these flags at priority 100 (user-initiated work preempts the
	// scanner backlog).
	onSubmit: (trackIds: string[], flags: AnalysisFlags) => void;
	// Fired on backdrop click / ESC / Cancel / X. Caller does state cleanup
	// (e.g. forgetting the in-flight target trackIds).
	onClose: () => void;
}

export interface AnalyzeModalHandle {
	destroy(): void;
	open(trackIds: string[]): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

// Every toggle in the form — used by the Select all / none shortcuts and the
// "is there any work to do?" guard.
const ASPECT_KEYS: (keyof AnalysisFlags)[] = [
	...BASIC_FLAGS.map((f) => f.key),
	'advanced',
];

export function mountAnalyzeModal(host: HTMLElement, props: AnalyzeModalProps): AnalyzeModalHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [targetTrackIds, setTargetTrackIds] = createSignal<string[]>([]);
	// Flags persist across sessions — open() re-loads the last selection so the
	// dialog remembers what the user picked last time.
	const [flags, setFlagsSignal] = createSignal<AnalysisFlags>(loadManualFlags());
	const setFlags = (next: AnalysisFlags): void => {
		setFlagsSignal(next);
		saveManualFlags(next);
	};

	const [ai, setAiSignal] = createSignal(loadAiFlag());
	const setAi = (on: boolean): void => { setAiSignal(on); saveAiFlag(on); };
	// Why the AI flag is unavailable (engine not installed / failed), null = usable.
	const [aiBlocked, setAiBlocked] = createSignal<string | null>(null);
	const aiOn = (): boolean => ai() && aiBlocked() === null;

	const open = (trackIds: string[]): void => {
		setTargetTrackIds([...trackIds]);
		setFlagsSignal(loadManualFlags());
		setAiSignal(loadAiFlag());
		setAiBlocked(null);
		mirApi.status()
			.then((st) => setAiBlocked(st.state === 'disabled' || st.state === 'unavailable' ? (st.reason ?? 'AI engine unavailable') : null))
			.catch(() => setAiBlocked('AI engine unavailable'));
		setIsOpen(true);
	};
	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		props.onClose();
	};

	// ESC closes — only while open so other ESC consumers (omnibar,
	// SettingsModal, TrackEditModal) keep working when this modal is hidden.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape') return;
		if (!isOpen()) return;
		e.preventDefault();
		close();
	};
	document.addEventListener('keydown', onKeyDown);

	const toggleAll = (on: boolean): void => {
		const next = { ...flags() };
		for (const k of ASPECT_KEYS) next[k] = on;
		setFlags(next);
		setAi(on);
	};

	// Any work to do = at least one Essentia aspect or the AI flag selected.
	const hasEssentiaWork = (): boolean => ASPECT_KEYS.some((k) => flags()[k]);
	const hasWork = (): boolean => hasEssentiaWork() || aiOn();

	const submit = (): void => {
		const ids = targetTrackIds();
		if (hasEssentiaWork()) props.onSubmit(ids, flags());
		if (aiOn()) {
			mirApi.analyzeNow(ids)
				.then(({ queued }) => showToast(`AI engine: ${queued} track${queued === 1 ? '' : 's'} queued`, { kind: 'info', durationMs: 3500 }))
				.catch((err) => showToast('AI engine unavailable', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 }));
		}
		close();
	};

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				class="modal-overlay"
				onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
			>
				<div class="modal" role="dialog" aria-modal="true" aria-labelledby="analyze-title">
					<header class="modal__head">
						<h3 id="analyze-title">
							Analyze {targetTrackIds().length} track{targetTrackIds().length === 1 ? '' : 's'}
						</h3>
						<button
							class="modal__close"
							type="button"
							aria-label="Close"
							onClick={(e) => { e.preventDefault(); close(); }}
						>×</button>
					</header>
					<div class="modal__body analyze-body">
						<p class="analyze-intro">
							Pick what to analyze. Curator's analysis is stored alongside any
							Rekordbox-imported values — neither overwrites the other; pick which
							the app shows in Settings → Analysis source. Unticked basic stages
							keep their existing Curator values; tick one to recompute it.
						</p>
						<AnalysisFlagsForm flags={flags()} onChange={setFlags} />
						<div class="analysis-flags">
							<div class="analysis-flags__group">
								<div class="analysis-flags__title">AI engine</div>
								<label class="analyze-feature" classList={{ 'analyze-feature--disabled': aiBlocked() !== null }}>
									<input
										type="checkbox"
										checked={aiOn()}
										disabled={aiBlocked() !== null}
										onChange={(e) => setAi(e.currentTarget.checked)}
									/>
									<span class="analyze-feature__label">AI similarity embeddings</span>
									<span class="analyze-feature__hint">
										{aiBlocked() ?? 'MERT-v2 + MuQ-MuLan sound embeddings for Find Similar and sounds:"…" search (~5 s/track on the GPU). Skips tracks already embedded.'}
									</span>
								</label>
							</div>
						</div>
						<div class="analyze-shortcuts">
							<button type="button" class="btn-link" onClick={(e) => { e.preventDefault(); toggleAll(true); }}>Select all</button>
							<span class="analyze-shortcuts__sep">·</span>
							<button type="button" class="btn-link" onClick={(e) => { e.preventDefault(); toggleAll(false); }}>Select none</button>
						</div>
					</div>
					<footer class="modal__foot">
						<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Cancel</button>
						<button
							type="button"
							class="btn-primary"
							disabled={targetTrackIds().length === 0 || !hasWork()}
							onClick={(e) => { e.preventDefault(); submit(); }}
						>
							Analyze
						</button>
					</footer>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => {
			document.removeEventListener('keydown', onKeyDown);
			dispose();
		},
		open,
		close,
		isOpen,
	};
}

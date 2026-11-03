// Production profile — one track's mastering/mix read: integrity flags, every
// measurement with its percentile inside a genre/era cohort (and a plain
// sentence when it sits off its peers in the defect direction), per-section
// rows, Audiobox's PQ, and the learned probe score when a model has been fit.
//
// Everything shown comes from production:profile; the dialog holds no
// thresholds of its own. "Not measured" is a real state — the stage is
// opt-in — so the empty body offers to run it.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { ProductionProfile, ProductionDeviation } from '@curator/core';
import { productionApi } from '../data/api.js';
import { showToast } from '../ui/toast.js';
import { registerModalOpenSignal } from '../modalGate.js';

export interface ProductionProfileDialogProps {
	// Run the production stage on this track (opens the Analyze flow).
	onAnalyze: (trackId: string) => void;
	onCompare: () => void;
}

export interface ProductionProfileDialogHandle {
	destroy(): void;
	open(trackId: string, title: string): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

const fmt = (v: number | null | undefined, d = 1): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const pct = (p: number): string => {
	const n = Math.round(p);
	const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
	return `${n}${suffix}`;
};

function cohortLine(p: ProductionProfile): string {
	const c = p.cohort;
	if (!c) return '';
	if (c.kind === 'genre+era') return `vs ${c.size} ${c.genre} tracks released ${c.yearFrom}–${c.yearTo}`;
	if (c.kind === 'genre') return `vs ${c.size} ${c.genre} tracks`;
	return `vs ${c.size} tracks in your library (no genre cohort large enough)`;
}

function deviationValue(d: ProductionDeviation): string {
	if (d.key === 'cutoff_hz') return d.value >= 22000 ? 'full band' : `${(d.value / 1000).toFixed(1)} kHz`;
	if (d.key === 'sub_corr') return d.value.toFixed(2);
	return `${fmt(d.value, d.unit === 'dB/oct' ? 2 : 1)}${d.unit ? ' ' + d.unit : ''}`;
}

export function mountProductionProfileDialog(host: HTMLElement, props: ProductionProfileDialogProps): ProductionProfileDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [title, setTitle] = createSignal('');
	const [trackId, setTrackId] = createSignal('');
	const [profile, setProfile] = createSignal<ProductionProfile | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [showAll, setShowAll] = createSignal(false);

	const load = (id: string): void => {
		setLoading(true);
		productionApi.profile(id)
			.then((p) => { if (trackId() === id) setProfile(p); })
			.catch((err) => { showToast('Could not load the production profile', { sub: String(err), kind: 'error' }); })
			.finally(() => setLoading(false));
	};

	const open = (id: string, t: string): void => {
		setTrackId(id);
		setTitle(t);
		setProfile(null);
		setShowAll(false);
		setIsOpen(true);
		load(id);
	};
	const close = (): void => { setIsOpen(false); };

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const notes = (): ProductionDeviation[] => (profile()?.deviations ?? []).filter((d) => d.note);
	const rows = (): ProductionDeviation[] => {
		const all = profile()?.deviations ?? [];
		return showAll() ? all : all.slice(0, 8);
	};

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
				<div class="modal modal--wide production-profile" role="dialog" aria-modal="true" aria-labelledby="production-profile-title">
					<header class="modal__head">
						<h3 id="production-profile-title">Production profile</h3>
						<button class="modal__close" type="button" aria-label="Close" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
					</header>
					<div class="modal__body">
						<div class="production-profile__track">{title()}</div>
						<Show when={loading()}><div class="production-profile__hint">Reading…</div></Show>
						<Show when={!loading() && profile() && !profile()!.measured}>
							<div class="production-profile__empty">
								<p>This track has no production measurements yet.</p>
								<p class="production-profile__hint">The stage is opt-in: tick <b>Production quality</b> in the Analyze window, or run it on this track now.</p>
								<button type="button" class="btn-primary" onClick={() => { props.onAnalyze(trackId()); close(); }}>Analyze production quality</button>
								<Show when={profile()!.audiobox}>{(a) => (
									<p class="production-profile__hint">Audiobox PQ {fmt(a().pq, 2)} / 10 is already available from the AI engine.</p>
								)}</Show>
							</div>
						</Show>
						<Show when={!loading() && profile()?.measured}>
							{(() => {
								const p = profile()!;
								const m = p.measurements!;
								return (
									<>
										<section class="production-profile__flags">
											<Show when={p.flags.length === 0}>
												<div class="production-flag production-flag--ok">No integrity problems: full band, no clipping, peaks under 0 dBTP, mono-compatible low end.</div>
											</Show>
											<For each={p.flags}>{(f) => (
												<div class={`production-flag production-flag--${f.severity}`} title={f.detail}>
													<span class="production-flag__label">{f.label}</span>
													<span class="production-flag__detail">{f.detail}</span>
												</div>
											)}</For>
										</section>

										<section class="production-profile__grid">
											<div class="production-stat"><span class="production-stat__k">Loudness</span><span class="production-stat__v">{fmt(m.lufs_i)} LUFS</span></div>
											<div class="production-stat"><span class="production-stat__k">True peak</span><span class="production-stat__v">{fmt(m.true_peak_dbtp)} dBTP</span></div>
											<div class="production-stat"><span class="production-stat__k">PLR</span><span class="production-stat__v">{fmt(m.plr)} dB</span></div>
											<div class="production-stat"><span class="production-stat__k">Loudness range</span><span class="production-stat__v">{fmt(m.lra)} LU</span></div>
											<div class="production-stat"><span class="production-stat__k">Bandwidth</span><span class="production-stat__v">{m.cutoff_hz >= 22000 ? 'full' : `${(m.cutoff_hz / 1000).toFixed(1)} kHz`}</span></div>
											<div class="production-stat"><span class="production-stat__k">Sub correlation</span><span class="production-stat__v">{m.stereo_source ? m.sub_corr.toFixed(2) : 'mono file'}</span></div>
											<Show when={p.audiobox} fallback={
												<div class="production-stat" title="Meta Audiobox Aesthetics production-quality rating (0–10). The AI engine scores tracks in the background with the audiobox-aesthetics model; tick AI embeddings in the Analyze window to score this one now.">
													<span class="production-stat__k">Audiobox PQ</span>
													<span class="production-stat__v production-stat__v--pending">not scored yet</span>
												</div>
											}>{(a) => (
												<div class="production-stat" title={`Meta Audiobox Aesthetics (0–10). CE ${fmt(a().ce, 2)} · CU ${fmt(a().cu, 2)} · PC ${fmt(a().pc, 2)} · PQ ${fmt(a().pq, 2)}`}>
													<span class="production-stat__k">Audiobox PQ</span>
													<span class="production-stat__v">{fmt(a().pq, 2)} / 10<Show when={a().pqPercentile != null}> · {pct(a().pqPercentile!)} pct</Show></span>
												</div>
											)}</Show>
											<Show when={p.learned}>{(l) => (
												<div class="production-stat" title="Your pairwise comparisons, fitted as a Bradley-Terry probe over these measurements.">
													<span class="production-stat__k">Learned score</span>
													<span class="production-stat__v">{fmt(l().score, 2)}<Show when={l().percentile != null}> · {pct(l().percentile!)} pct</Show></span>
												</div>
											)}</Show>
										</section>

										<Show when={notes().length > 0}>
											<section class="production-profile__notes">
												<div class="production-profile__section-title">Against comparable tracks <span class="production-profile__hint">{cohortLine(p)}</span></div>
												<For each={notes()}>{(d) => (
													<div class="production-note">
														<span class="production-note__text">{d.note}</span>
														<span class="production-note__num">{deviationValue(d)} · {pct(d.percentile)} pct · z {d.z.toFixed(1)}</span>
													</div>
												)}</For>
											</section>
										</Show>
										<Show when={notes().length === 0 && p.cohort}>
											<div class="production-profile__hint">Nothing stands out {cohortLine(p)}.</div>
										</Show>

										<section class="production-profile__table">
											<div class="production-profile__section-title">Measurements</div>
											<table class="production-table">
												<thead><tr><th>Feature</th><th>Value</th><th>Percentile</th><th>z</th></tr></thead>
												<tbody>
													<For each={rows()}>{(d) => (
														<tr classList={{ 'is-note': !!d.note }}>
															<td>{d.label}</td><td>{deviationValue(d)}</td><td>{pct(d.percentile)}</td><td>{d.z >= 0 ? '+' : ''}{d.z.toFixed(1)}</td>
														</tr>
													)}</For>
												</tbody>
											</table>
											<Show when={(p.deviations.length > 8)}>
												<button type="button" class="btn-link" onClick={() => setShowAll(!showAll())}>{showAll() ? 'Show fewer' : `Show all ${p.deviations.length}`}</button>
											</Show>
										</section>

										<Show when={p.sections.length > 0}>
											<section class="production-profile__sections">
												<div class="production-profile__section-title">Sections</div>
												<table class="production-table">
													<thead><tr><th>Section</th><th>Loudness</th><th>Crest</th><th>Sub corr</th><th>Low-mids</th><th>Upper mids</th><th>Width low</th></tr></thead>
													<tbody>
														<For each={p.sections}>{(s) => (
															<tr>
																<td>{s.label ?? 'section'} {Math.floor(s.startSec / 60)}:{String(Math.floor(s.startSec % 60)).padStart(2, '0')}</td>
																<td>{fmt(s.lufs)} LUFS</td><td>{fmt(s.crest_db)} dB</td><td>{s.sub_corr.toFixed(2)}</td>
																<td>{fmt(s.bands_db.lowmid)} dB</td><td>{fmt(s.bands_db.himid)} dB</td><td>{fmt(s.width_db.low)} dB</td>
															</tr>
														)}</For>
													</tbody>
												</table>
											</section>
										</Show>
									</>
								);
							})()}
						</Show>
					</div>
					<footer class="modal__foot">
						<button type="button" class="btn-secondary" onClick={() => { close(); props.onCompare(); }}>Compare pairs…</button>
						<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); close(); }}>Close</button>
					</footer>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => { document.removeEventListener('keydown', onKeyDown, true); dispose(); },
		open, close, isOpen,
	};
}

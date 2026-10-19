// MergeTracksDialog — "this provider URL already belongs to another track;
// merge the two?" Opened by the Edit Track save flow (features/editTrack.ts)
// when tracks:set-source-links reports an already-linked conflict.
//
// Shows both tracks side by side with a "Keep" radio per card (default =
// the more-curated side, as suggested by core), the dry-run summary for the
// selected direction, warnings (duration / ISRC mismatch), and — when the
// merge is refused (both rekordbox-linked) — the blocker text in place of
// the Merge button. Callback-based like NamePromptDialog: one mounted
// instance, open(opts) per use, Esc = cancel.

import { createSignal, createMemo, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { TrackMergePreview, TrackMergeSide, TrackMergePlan } from '@curator/core';
import { registerModalOpenSignal } from '../modalGate.js';
import { KeyChip } from '../components/KeyChip.jsx';
import { formatBpmInt } from '../music-utils.js';
import { fmtTime } from '../ui/format.js';

export interface MergeTracksOptions {
	// Provider whose id collided — named in the intro sentence.
	source: string;
	preview: TrackMergePreview;
	onConfirm: (keepId: string, dropId: string) => void;
	onCancel?: () => void;
}

export interface MergeTracksHandle {
	destroy(): void;
	open(opts: MergeTracksOptions): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function summarize(p: TrackMergePlan): string[] {
	const out: string[] = [];
	if (p.tagsAdded) out.push(`adds ${p.tagsAdded} tag${p.tagsAdded === 1 ? '' : 's'}`);
	if (p.membershipsMoved) out.push(`joins ${p.membershipsMoved} playlist${p.membershipsMoved === 1 ? '' : 's'}`);
	if (p.membershipsDuplicate) out.push(`${p.membershipsDuplicate} duplicate membership${p.membershipsDuplicate === 1 ? '' : 's'} dropped`);
	if (p.rekordboxAdds) out.push(`${p.rekordboxAdds} rekordbox add${p.rekordboxAdds === 1 ? '' : 's'} on next sync (previewed)`);
	if (p.linksMoved) out.push(`moves ${p.linksMoved} source link${p.linksMoved === 1 ? '' : 's'}`);
	if (p.linksDropped) out.push(`${p.linksDropped} same-provider link${p.linksDropped === 1 ? '' : 's'} discarded`);
	if (p.rekordboxLinkMoved) out.push('takes the rekordbox link');
	if (p.localFilesMoved) out.push(`takes ${p.localFilesMoved} local file${p.localFilesMoved === 1 ? '' : 's'}`);
	if (p.cues === 'take-drop') out.push('takes the other track’s cues');
	if (p.analysis === 'take-drop') out.push('takes the other track’s analysis');
	if (p.analysis === 'graft-rb') out.push('grafts the other track’s rekordbox grid');
	if (p.playsMoved) out.push(`keeps ${p.playsMoved} play${p.playsMoved === 1 ? '' : 's'} of history`);
	return out.length ? out : ['nothing else to carry over'];
}

export function mountMergeTracksDialog(host: HTMLElement): MergeTracksHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [opts, setOpts] = createSignal<MergeTracksOptions | null>(null);
	const [keepId, setKeepId] = createSignal('');
	// Mirrors NamePromptDialog: the active call's callbacks, cleared on
	// resolution so neither fires twice.
	let current: MergeTracksOptions | null = null;

	const open = (o: MergeTracksOptions): void => {
		current = o;
		setOpts(o);
		setKeepId(o.preview.suggestedKeepId);
		setIsOpen(true);
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		const cb = current?.onCancel;
		current = null;
		cb?.();
	};

	const plan = createMemo((): TrackMergePlan | null => {
		const o = opts();
		return o ? (o.preview.plans[keepId()] ?? null) : null;
	});
	const blocked = (): boolean => (plan()?.blockers.length ?? 0) > 0;

	const confirm = (): void => {
		if (!isOpen() || blocked()) return;
		const o = current;
		const keep = keepId();
		if (!o) return;
		const drop = keep === o.preview.a.track.id ? o.preview.b.track.id : o.preview.a.track.id;
		setIsOpen(false);
		current = null;
		o.onConfirm(keep, drop);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirm(); return; }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const card = (side: TrackMergeSide, label: string) => {
		const t = side.track;
		const selected = () => keepId() === t.id;
		return (
			<label class="merge-tracks__card" classList={{ 'is-keep': selected() }}>
				<div class="merge-tracks__card-head">
					<input type="radio" name="merge-keep" checked={selected()} onChange={() => setKeepId(t.id)} />
					<span class="merge-tracks__keep">{selected() ? 'Keep' : 'Fold in'}</span>
					<span class="merge-tracks__which">{label}</span>
				</div>
				<div class="organize__track">
					<span class="organize__cover-lg" style={{ 'background-image': `url(curator-cover://${encodeURIComponent(t.id)})` }} />
					<div class="organize__track-main">
						<div class="organize__title organize__title--track" title={t.title}>{t.title}</div>
						<div class="organize__sub organize__sub--artist">{(t.artists ?? []).map((a) => a.name).join(', ')}</div>
						<div class="organize__trackmeta">
							<Show when={t.label}><span class="organize__meta-item">{t.label}</span></Show>
							<Show when={t.genre}><span class="organize__meta-item">{t.genre}</span></Show>
							<span class="organize__meta-item">{fmtTime(t.duration)}</span>
							<Show when={t.bpm != null}><span class="organize__meta-item">{formatBpmInt(t.bpm)} BPM</span></Show>
							<Show when={t.keyCamelot}><span class="organize__meta-item"><KeyChip keyCamelot={t.keyCamelot} /></span></Show>
						</div>
					</div>
				</div>
				<div class="merge-tracks__facts">
					<span class="src-pips"><For each={side.links}>{(s) => <span class="src-pip" data-src={s} title={s}></span>}</For></span>
					<span>{t.rating ? `${t.rating}★` : 'unrated'}</span>
					<span>{side.tags} tag{side.tags === 1 ? '' : 's'}</span>
					<span>{side.playlists} playlist{side.playlists === 1 ? '' : 's'}</span>
					<Show when={side.cues}><span>{side.cues} cue{side.cues === 1 ? '' : 's'}</span></Show>
					<Show when={side.analyzed}><span>analyzed</span></Show>
					<Show when={side.localFile}><span>local file</span></Show>
					<Show when={side.rekordbox}><span>rekordbox</span></Show>
				</div>
			</label>
		);
	};

	const dispose = render(() => (
		<Show when={isOpen() && opts()}>
			{(o) => (
				<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
					<div class="modal merge-tracks" role="dialog" aria-modal="true" aria-labelledby="merge-tracks-title">
						<header class="modal__head">
							<h3 id="merge-tracks-title">Already linked — merge tracks?</h3>
							<button class="modal__close" type="button" aria-label="Cancel" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
						</header>
						<div class="modal__body merge-tracks__body">
							<p class="merge-tracks__intro">
								That {cap(o().source)} track is already linked to another library track. Merging keeps one row and
								carries over the tags, playlists, links, cues and attributes of both.
							</p>
							<div class="merge-tracks__cards">
								{card(o().preview.a, 'editing')}
								{card(o().preview.b, `owns the ${o().source} link`)}
							</div>
							<Show when={plan()}>
								{(p) => (
									<>
										<Show when={p().blockers.length > 0}>
											<div class="merge-tracks__blocked"><For each={p().blockers}>{(b) => <div>{b}</div>}</For></div>
										</Show>
										<Show when={p().warnings.length > 0}>
											<div class="merge-tracks__warn"><For each={p().warnings}>{(w) => <div>⚠ {w}</div>}</For></div>
										</Show>
										<div class="merge-tracks__summary">Kept track {summarize(p()).join(' · ')}. The other row is removed from the library.</div>
									</>
								)}
							</Show>
						</div>
						<footer class="modal__foot">
							<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Cancel</button>
							<Show when={!blocked()}>
								<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); confirm(); }}>Merge</button>
							</Show>
						</footer>
					</div>
				</div>
			)}
		</Show>
	), host);

	return {
		destroy: () => {
			document.removeEventListener('keydown', onKeyDown, true);
			dispose();
		},
		open,
		close,
		isOpen,
	};
}

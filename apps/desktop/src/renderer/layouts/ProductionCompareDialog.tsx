// Production compare — the pairwise judgment collector behind the learned
// probe. Core draws a pair (same genre when it can, least-judged first,
// loudness gap the volume match can close); the dialog plays each side from
// its first drop at matched loudness and records "A", "B" or "tie".
//
// Loudness matching: the player has one deck and one master volume, so the
// dialog scales the user's volume by the pair's per-side gain while a side
// plays (the louder side is attenuated to the quieter one) and restores the
// user's level on close. Louder sounds better; without this the judgments
// would mostly learn LUFS.
//
// Keys: 1 / 2 play a side, A / B / = answer, Esc closes.

import { createSignal, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { Track } from '@curator/shared';
import type { ProductionPair, ProductionPairSide, ProductionStats, ProductionWinner } from '@curator/core';
import { productionApi } from '../data/api.js';
import * as player from '../player.js';
import { showToast } from '../ui/toast.js';
import { registerModalOpenSignal } from '../modalGate.js';

export interface ProductionCompareDialogProps {
	// The playlist the track list is showing, if any — offered as a scope.
	currentPlaylist: () => { id: string; name: string } | null;
}

export interface ProductionCompareDialogHandle {
	destroy(): void;
	open(opts?: { genre?: string | null }): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

type SideKey = 'a' | 'b';

export function mountProductionCompareDialog(host: HTMLElement, props: ProductionCompareDialogProps): ProductionCompareDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [pair, setPair] = createSignal<ProductionPair | null>(null);
	const [tracks, setTracks] = createSignal<Record<SideKey, Track | null>>({ a: null, b: null });
	const [playing, setPlaying] = createSignal<SideKey | null>(null);
	const [stats, setStats] = createSignal<ProductionStats | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [done, setDone] = createSignal(0); // this session
	const [scope, setScope] = createSignal<{ id: string; name: string } | null>(null);
	const [inScope, setInScope] = createSignal(true);
	let genre: string | null | undefined;
	let userVolume = player.getVolume();
	let session = 0;

	const restoreVolume = (): void => { void player.setVolume(userVolume); };

	const loadPair = async (): Promise<void> => {
		const my = ++session;
		setBusy(true);
		setPlaying(null);
		try {
			const p = await productionApi.nextPair({ genre: genre ?? null, playlistId: inScope() && scope() ? scope()!.id : null });
			if (my !== session) return;
			setPair(p);
			if (!p) { setTracks({ a: null, b: null }); return; }
			const rows = await productionApi.tracksByIds([p.a.trackId, p.b.trackId]);
			if (my !== session) return;
			const byId = new Map(rows.map((t) => [t.id, t]));
			setTracks({ a: byId.get(p.a.trackId) ?? null, b: byId.get(p.b.trackId) ?? null });
		} catch (err) {
			showToast('Could not draw a pair', { sub: String(err), kind: 'error' });
		} finally {
			if (my === session) setBusy(false);
		}
	};

	const playSide = async (k: SideKey): Promise<void> => {
		const p = pair();
		const t = tracks()[k];
		if (!p || !t) return;
		const side: ProductionPairSide = p[k];
		const gain = k === 'a' ? p.gainA : p.gainB;
		try {
			await player.setVolume(userVolume * gain);
			await player.play(t);
			if (side.auditionStartSec > 1) await player.seekWithXfade(side.auditionStartSec);
			setPlaying(k);
		} catch (err) {
			showToast(`Could not play ${side.title}`, { sub: String(err), kind: 'error' });
		}
	};

	const answer = async (w: ProductionWinner): Promise<void> => {
		const p = pair();
		if (!p || busy()) return;
		setBusy(true);
		try {
			const st = await productionApi.judge(p.a.trackId, p.b.trackId, w);
			setStats(st);
			setDone(done() + 1);
			await loadPair();
		} catch (err) {
			showToast('Could not record the judgment', { sub: String(err), kind: 'error' });
			setBusy(false);
		}
	};

	const open = (opts?: { genre?: string | null }): void => {
		genre = opts?.genre;
		setScope(props.currentPlaylist());
		setInScope(true);
		userVolume = player.getVolume();
		setDone(0);
		setIsOpen(true);
		productionApi.stats().then(setStats).catch(() => undefined);
		void loadPair();
	};
	const close = (): void => {
		if (!isOpen()) return;
		session++;
		setIsOpen(false);
		restoreVolume();
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		const k = e.key.toLowerCase();
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (k === '1') { e.preventDefault(); e.stopPropagation(); void playSide('a'); }
		else if (k === '2') { e.preventDefault(); e.stopPropagation(); void playSide('b'); }
		else if (k === 'a') { e.preventDefault(); e.stopPropagation(); void answer('a'); }
		else if (k === 'b') { e.preventDefault(); e.stopPropagation(); void answer('b'); }
		else if (k === '=' || k === 't') { e.preventDefault(); e.stopPropagation(); void answer('tie'); }
		else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); void player.togglePause(); }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const fmtLufs = (v: number): string => `${v.toFixed(1)} LUFS`;
	const sideCard = (k: SideKey, label: string, key: string) => {
		const s = () => pair()?.[k];
		const gain = () => (k === 'a' ? pair()?.gainA : pair()?.gainB) ?? 1;
		return (
			<button type="button" class="production-side" classList={{ 'is-playing': playing() === k }} onClick={() => { void playSide(k); }}>
				<span class="production-side__key">{label} · press {key} to play</span>
				<span class="production-side__title">{s()?.title ?? '…'}</span>
				<span class="production-side__artist">{s()?.artists ?? ''}</span>
				<span class="production-side__meta">
					{s() ? fmtLufs(s()!.lufs) : ''}{gain() < 0.999 ? ` · played at ${(20 * Math.log10(gain())).toFixed(1)} dB` : ''}{s()?.genre ? ` · ${s()!.genre}` : ''}
				</span>
			</button>
		);
	};

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
				<div class="modal production-compare" role="dialog" aria-modal="true" aria-labelledby="production-compare-title">
					<header class="modal__head">
						<h3 id="production-compare-title">Which sounds more professionally produced?</h3>
						<button class="modal__close" type="button" aria-label="Close" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
					</header>
					<div class="modal__body">
						<div class="production-profile__hint">
							Judge the mix and master, not the tune: clarity, low end, punch, balance. Both sides play from their drop at matched loudness.
							{pair()?.cohortGenre ? ` Pair drawn within ${pair()!.cohortGenre}.` : ''}
						</div>
						<Show when={scope()} fallback={
							<div class="production-profile__hint">Drawing from every measured local track. Open a playlist in the track list before Compare to judge inside it.</div>
						}>{(s) => (
							<label class="settings-toggle">
								<input type="checkbox" checked={inScope()} onChange={(e) => { setInScope(e.currentTarget.checked); void loadPair(); }} />
								<span class="settings-toggle__label">Only tracks in “{s().name}”</span>
								<span class="settings-toggle__hint">{inScope() ? 'Pairs are drawn inside this playlist.' : 'Pairs are drawn from every measured local track.'}</span>
							</label>
						)}</Show>
						<Show when={pair()} fallback={
							<div class="production-profile__hint">
								{busy() ? 'Drawing a pair…' : 'No pair available: fewer than two local tracks have production measurements (tick Production quality in the Analyze window), or every pair has been judged.'}
							</div>
						}>
							<div class="production-compare__sides">
								{sideCard('a', 'A', '1')}
								{sideCard('b', 'B', '2')}
							</div>
							<div class="production-compare__verdict">
								<button type="button" class="btn-primary" disabled={busy()} onClick={() => { void answer('a'); }}>A is better (A)</button>
								<button type="button" class="btn-secondary" disabled={busy()} onClick={() => { void answer('tie'); }}>Can't tell (=)</button>
								<button type="button" class="btn-primary" disabled={busy()} onClick={() => { void answer('b'); }}>B is better (B)</button>
							</div>
						</Show>
						<Show when={stats()}>{(s) => (
							<div class="production-compare__stats">
								<span>{s().judgments} judgments so far ({done()} this session)</span>
								<span>{s().judgedTracks} of {s().playableMeasured} tracks seen</span>
								<span>{s().model ? `model fitted on ${s().model!.pairs} pairs · ${s().judgmentsSinceFit} new since` : `${Math.max(0, s().minPairsToFit - s().judgments)} more to fit the first model`}</span>
							</div>
						)}</Show>
					</div>
					<footer class="modal__foot">
						<button type="button" class="btn-secondary" disabled={busy()} onClick={() => { void loadPair(); }}>Skip pair</button>
						<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); close(); }}>Done</button>
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

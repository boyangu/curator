// ArtistMergeReviewDialog — "Suggested merges" for the Artists folder. Lists
// the pairs identity can't decide on its own (a bare name beside the same
// name with a bracketed disambiguator: "Maz" / "Maz (EG)"), one row per
// pair with a Keep radio pre-set to the suggested survivor, and Merge /
// Dismiss per row. Merging goes through the normal artists:merge path (the
// dropped spelling becomes an alias); dismissing remembers the pair so it
// never resurfaces. Callback-based like MergeTracksDialog: one mounted
// instance, open() per use, Esc closes.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { ArtistMergeSuggestion, ArtistSummary } from '@curator/shared';
import { registerModalOpenSignal } from '../modalGate.js';

export interface ArtistMergeReviewProps {
	load: () => Promise<ArtistMergeSuggestion[]>;
	// The tab whose tracks the counts are over ("Spotify", "Rekordbox"…),
	// read on open so the header says what the numbers mean.
	scopeLabel: () => string;
	merge: (keepId: string, dropId: string) => Promise<void>;
	dismiss: (aId: string, bId: string) => Promise<void>;
}

export interface ArtistMergeReviewHandle {
	destroy(): void;
	open(): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

const pairKey = (s: ArtistMergeSuggestion): string => [s.a.id, s.b.id].sort().join('|');

export function mountArtistMergeReviewDialog(host: HTMLElement, props: ArtistMergeReviewProps): ArtistMergeReviewHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [rows, setRows] = createSignal<ArtistMergeSuggestion[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	// Per-pair survivor choice; absent = the suggestion.
	const [keep, setKeep] = createSignal<Map<string, string>>(new Map());
	const [busy, setBusy] = createSignal<string | null>(null);
	const [scopeLabel, setScopeLabel] = createSignal('');
	let seq = 0;

	const keepOf = (s: ArtistMergeSuggestion): string => keep().get(pairKey(s)) ?? s.suggestedKeepId;
	const choose = (s: ArtistMergeSuggestion, id: string): void => {
		const next = new Map(keep());
		next.set(pairKey(s), id);
		setKeep(next);
	};
	const drop = (s: ArtistMergeSuggestion): void => { setRows(rows().filter((r) => pairKey(r) !== pairKey(s))); };

	const open = (): void => {
		setIsOpen(true);
		setScopeLabel(props.scopeLabel());
		setError(null);
		setLoading(true);
		const my = ++seq;
		props.load().then((list) => { if (my === seq) setRows(list); })
			.catch((err) => { if (my === seq) setError(err instanceof Error ? err.message : String(err)); })
			.finally(() => { if (my === seq) setLoading(false); });
	};
	const close = (): void => { if (isOpen()) setIsOpen(false); };

	const merge = async (s: ArtistMergeSuggestion): Promise<void> => {
		const keepId = keepOf(s);
		const dropId = keepId === s.a.id ? s.b.id : s.a.id;
		setBusy(pairKey(s));
		try {
			await props.merge(keepId, dropId);
			// Any other pair naming the dropped artist is moot now — the id no
			// longer resolves to a live row.
			setRows(rows().filter((r) => r.a.id !== dropId && r.b.id !== dropId));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};
	const dismiss = async (s: ArtistMergeSuggestion): Promise<void> => {
		setBusy(pairKey(s));
		try { await props.dismiss(s.a.id, s.b.id); drop(s); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(null); }
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const side = (s: ArtistMergeSuggestion, a: ArtistSummary): ReturnType<typeof Show> => {
		const selected = () => keepOf(s) === a.id;
		return (
			<label class="merge-review__side" classList={{ 'is-keep': selected() }}>
				<input type="radio" name={`keep-${pairKey(s)}`} checked={selected()} onChange={() => choose(s, a.id)} />
				<span class="merge-review__name" title={a.name}>{a.name}</span>
				<span class="merge-review__count">{a.trackCount.toLocaleString()} track{a.trackCount === 1 ? '' : 's'}</span>
				<span class="merge-review__role">{selected() ? 'keep' : 'fold in'}</span>
			</label>
		) as ReturnType<typeof Show>;
	};

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
				<div class="modal merge-review" role="dialog" aria-modal="true" aria-labelledby="merge-review-title">
					<header class="modal__head">
						<h3 id="merge-review-title">Suggested merges <span class="merge-review__scope">· {scopeLabel()}</span></h3>
						<button class="modal__close" type="button" aria-label="Close" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
					</header>
					<div class="modal__body merge-review__body">
						<p class="merge-tracks__intro">
							A bare name next to the same name with a country or city tag. Beatport and Spotify use the tag to tell two
							artists with the same name apart, so this is your call: keep the spelling you want and fold the other in
							(it becomes an alias, so a re-sync spelling it the old way still lands here), or dismiss the pair for good.
							Track counts are the {scopeLabel()} tab's; a merge applies to the whole library.
						</p>
						<Show when={error()}><div class="merge-tracks__warn">{error()}</div></Show>
						<Show when={loading()}><div class="pl-empty-hint">Looking for pairs…</div></Show>
						<Show when={!loading() && rows().length === 0 && !error()}><div class="pl-empty-hint">Nothing left to decide.</div></Show>
						<div class="merge-review__list">
							<For each={rows()}>{(s) => (
								<div class="merge-review__row" classList={{ 'is-busy': busy() === pairKey(s) }}>
									{side(s, s.a)}
									{side(s, s.b)}
									<div class="merge-review__actions">
										<button type="button" class="btn-primary" disabled={busy() != null} onClick={(e) => { e.preventDefault(); void merge(s); }}>Merge</button>
										<button type="button" class="btn-secondary" disabled={busy() != null} onClick={(e) => { e.preventDefault(); void dismiss(s); }}>Dismiss</button>
									</div>
								</div>
							)}</For>
						</div>
					</div>
					<footer class="modal__foot">
						<span class="merge-review__remaining">{rows().length} remaining</span>
						<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Close</button>
					</footer>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => { document.removeEventListener('keydown', onKeyDown, true); dispose(); },
		open,
		close,
		isOpen,
	};
}

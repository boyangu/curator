// RatingDialog — center-screen modal that sets the Rekordbox 0..5 star
// rating on one or more selected tracks.
//
// Keyboard: 1..5 set, 0 clears, Enter applies, Esc cancels.
// Mouse:    hover previews; single-click commits via Enter button.
//
// Component-owned: open/close state, the current star value, key handling,
// hover preview. Submit/cancel are caller callbacks — main.ts owns the
// selection-id list, the IPC write, and the post-write tracklist patching.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import { registerModalOpenSignal } from '../modalGate.js';

export interface RatingDialogProps {
	// Fired when the user confirms (Enter / OK button). `value` is the new
	// 0..5 rating; null means "clear rating" (the 0-key path).
	onSubmit: (value: number | null) => void;
	// Fired on Esc, Cancel button, or backdrop click. No write.
	onCancel: () => void;
}

export interface RatingDialogHandle {
	destroy(): void;
	// Open with the pre-selected star count. Pass round(avg(ratings)) for
	// multi-select; pass the current rating (or 0 when null) for single-select.
	open(initial: number): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

export function mountRatingDialog(host: HTMLElement, props: RatingDialogProps): RatingDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [value, setValue] = createSignal(0);
	// `hover` is the star the cursor is currently over; null when not hovering.
	// Display falls back to `value` when null, so the row reads as the
	// committed selection between mouse moves.
	const [hover, setHover] = createSignal<number | null>(null);

	const open = (initial: number): void => {
		setValue(Math.max(0, Math.min(5, Math.round(initial))));
		setHover(null);
		setIsOpen(true);
	};
	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		props.onCancel();
	};
	const submit = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		// 0 stars from the dialog is the "clear" intent (matches the 0-key
		// shortcut). Other values go through as-is.
		props.onSubmit(value() === 0 ? null : value());
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		// Eat every relevant key here. Without stopPropagation the global
		// keydown handler on document (Enter→play, R→re-open dialog, 1..5
		// could be future shortcuts) runs on the same event — preventDefault
		// alone only suppresses the browser default, not other listeners.
		// Capture-phase registration below guarantees we win on order too.
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); submit(); return; }
		// 1..5 set, 0 clears. Number row + numpad both work — the digit
		// characters are identical between the two on every layout we care
		// about, so a single check covers both.
		if (/^[0-5]$/.test(e.key)) {
			e.preventDefault();
			e.stopPropagation();
			setValue(Number(e.key));
			return;
		}
	};
	// Capture phase so we run before the global tracklist keydown handler,
	// regardless of mount order. Without this, the global "Enter plays the
	// selected track" handler fires first and we'd be reacting to an event
	// that already triggered playback.
	document.addEventListener('keydown', onKeyDown, true);

	const display = () => hover() ?? value();

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				class="modal-overlay"
				onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
			>
				<div class="modal rating-modal" role="dialog" aria-modal="true" aria-labelledby="rating-dialog-title">
					<header class="modal__head">
						<h3 id="rating-dialog-title">Rating</h3>
						<button
							class="modal__close"
							type="button"
							aria-label="Cancel"
							onClick={(e) => { e.preventDefault(); close(); }}
						>×</button>
					</header>
					<div class="modal__body rating-modal__body">
						<div
							class="rating-modal__stars"
							role="radiogroup"
							aria-label="Star rating"
							onMouseLeave={() => setHover(null)}
						>
							<For each={[1, 2, 3, 4, 5]}>
								{(n) => (
									<button
										type="button"
										class="rating-modal__star"
										classList={{ 'is-on': display() >= n }}
										role="radio"
										aria-checked={value() === n}
										aria-label={`${n} star${n === 1 ? '' : 's'}`}
										onMouseEnter={() => setHover(n)}
										onClick={(e) => { e.preventDefault(); setValue(n); }}
									>★</button>
								)}
							</For>
						</div>
						<div class="rating-modal__hint">1–5 to set · 0 to clear · Enter to apply · Esc to cancel</div>
					</div>
					<footer class="modal__foot rating-modal__foot">
						<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Cancel</button>
						<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); submit(); }}>OK</button>
					</footer>
				</div>
			</div>
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

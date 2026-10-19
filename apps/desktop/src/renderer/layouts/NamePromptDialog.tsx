// NamePromptDialog — center-screen single-text-input modal. Generic "name
// this thing" prompt; the first user is the pinned-search "Create Playlist…"
// flow (materialize → name → create).
//
// Keyboard: Enter applies, Esc cancels. On open the input is focused with its
// text pre-selected, so typing replaces the default name in one stroke.
//
// Component-owned: open/close state, the input value, key handling, focus.
// The per-open title/label/initial/confirm and the submit callback arrive via
// open(opts) so one mounted instance serves every caller.

import { createSignal, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import { registerModalOpenSignal } from '../modalGate.js';

export interface NamePromptOptions {
	title: string;
	// Optional field label above the input.
	label?: string;
	// Pre-filled value; selected on open so a keystroke replaces it.
	initial?: string;
	// Confirm-button text (default "OK").
	confirmLabel?: string;
	// Fired with the trimmed, non-empty name on Enter / confirm.
	onSubmit: (name: string) => void;
	// Fired on Esc / Cancel / backdrop click.
	onCancel?: () => void;
}

export interface NamePromptHandle {
	destroy(): void;
	open(opts: NamePromptOptions): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

export function mountNamePromptDialog(host: HTMLElement): NamePromptHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [title, setTitle] = createSignal('');
	const [label, setLabel] = createSignal('');
	const [confirmLabel, setConfirmLabel] = createSignal('OK');
	const [value, setValue] = createSignal('');
	let inputRef: HTMLInputElement | undefined;
	// The active call's options — holds the submit/cancel callbacks so one
	// mounted dialog serves every caller. Cleared on each resolution so a
	// callback never fires twice.
	let current: NamePromptOptions | null = null;

	const open = (opts: NamePromptOptions): void => {
		current = opts;
		setTitle(opts.title);
		setLabel(opts.label ?? '');
		setConfirmLabel(opts.confirmLabel ?? 'OK');
		setValue(opts.initial ?? '');
		setIsOpen(true);
		// Defer to after the Show paints the input, then focus + select.
		queueMicrotask(() => { inputRef?.focus(); inputRef?.select(); });
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		const cb = current?.onCancel;
		current = null;
		cb?.();
	};

	const submit = (): void => {
		if (!isOpen()) return;
		const name = value().trim();
		// Empty name is not a valid submit — keep the dialog open.
		if (!name) { inputRef?.focus(); return; }
		setIsOpen(false);
		const cb = current?.onSubmit;
		current = null;
		cb?.(name);
	};

	// Capture phase so we win over the global tracklist keydown handler
	// (Enter→play, etc.) regardless of mount order — same rationale as
	// RatingDialog.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); return; }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				class="modal-overlay"
				onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
			>
				<div class="modal name-prompt" role="dialog" aria-modal="true" aria-labelledby="name-prompt-title">
					<header class="modal__head">
						<h3 id="name-prompt-title">{title()}</h3>
						<button
							class="modal__close"
							type="button"
							aria-label="Cancel"
							onClick={(e) => { e.preventDefault(); close(); }}
						>×</button>
					</header>
					<div class="modal__body name-prompt__body">
						<Show when={label()}>
							<label class="name-prompt__label" for="name-prompt-input">{label()}</label>
						</Show>
						<input
							id="name-prompt-input"
							ref={(el) => (inputRef = el)}
							class="name-prompt__input"
							type="text"
							value={value()}
							onInput={(e) => setValue(e.currentTarget.value)}
							spellcheck={false}
							autocomplete="off"
						/>
					</div>
					<footer class="modal__foot name-prompt__foot">
						<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Cancel</button>
						<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); submit(); }}>{confirmLabel()}</button>
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

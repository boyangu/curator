// ConfirmDialog — the generic Curator yes/no modal, in place of window.confirm
// (which renders as an unstyled OS box). First user: plain Delete's
// "Remove from playlist" confirmation.
//
// Keyboard: Esc cancels. Enter is swallowed and does NOTHING — a destructive
// action never fires from a key that's also "play" in the tracklist (same
// stance as DeleteTracksDialog / McpConfirmModal). Focus lands on Cancel.

import { createSignal, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import { registerModalOpenSignal } from '../modalGate.js';

export interface ConfirmDialogOptions {
	title: string;
	message: string;
	note?: string;
	confirmLabel: string;
	// Red confirm button + hot headline.
	danger?: boolean;
	onConfirm: () => void;
	onCancel?: () => void;
}

export interface ConfirmDialogHandle {
	destroy(): void;
	open(opts: ConfirmDialogOptions): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

export function mountConfirmDialog(host: HTMLElement): ConfirmDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [opts, setOpts] = createSignal<ConfirmDialogOptions | null>(null);
	let cancelRef: HTMLButtonElement | undefined;
	// The active call's callbacks; cleared on resolution so none fires twice.
	let current: ConfirmDialogOptions | null = null;

	const open = (o: ConfirmDialogOptions): void => {
		// A second open while one is showing cancels the first — its awaiting
		// caller must not hang.
		if (isOpen()) close();
		current = o;
		setOpts(o);
		setIsOpen(true);
		queueMicrotask(() => cancelRef?.focus());
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		const cb = current?.onCancel;
		current = null;
		cb?.();
	};

	const confirm = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		const cb = current?.onConfirm;
		current = null;
		cb?.();
	};

	// Capture phase so we win over the global tracklist keydown handler.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); return; }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const dispose = render(() => (
		<Show when={isOpen() && opts()}>
			{(o) => (
				<div
					class="modal-overlay"
					onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
				>
					<div class="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
						<header class="modal__head">
							<h3 id="confirm-dialog-title">{o().title}</h3>
							<button
								class="modal__close"
								type="button"
								aria-label="Cancel"
								onClick={(e) => { e.preventDefault(); close(); }}
							>×</button>
						</header>
						<div class="modal__body">
							<p class="confirm-dialog__message" classList={{ 'is-danger': !!o().danger }}>{o().message}</p>
							<Show when={o().note}>
								<p class="confirm-dialog__note">{o().note}</p>
							</Show>
						</div>
						<footer class="modal__foot">
							<button
								type="button"
								class="btn-secondary"
								ref={(el) => (cancelRef = el)}
								onClick={(e) => { e.preventDefault(); close(); }}
							>Cancel</button>
							<button
								type="button"
								class={o().danger ? 'btn-danger' : 'btn-primary'}
								onClick={(e) => { e.preventDefault(); confirm(); }}
							>{o().confirmLabel}</button>
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

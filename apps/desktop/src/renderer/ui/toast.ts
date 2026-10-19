// Toast notifications (F3.0 — extracted from main.ts). Small status
// messages anchored bottom-right in the #toast-stack host AppShell renders.
// Toasts announce one-off events (match success/failure, sync errors);
// they don't replace clear in-UI state changes.
//
// `action` renders a button inside the toast (the Organize modal's bulk
// tag/playlist writes use it for Undo). Clicking runs the callback and
// dismisses the toast immediately.

import { escapeHtml } from './format.js';

export interface ToastOptions {
	sub?: string;
	kind?: 'success' | 'error' | 'info';
	durationMs?: number;
	action?: { label: string; onClick: () => void };
}

export function showToast(title: string, opts: ToastOptions = {}): void {
	const stack = document.getElementById('toast-stack');
	if (!stack) return;
	const el = document.createElement('div');
	el.className = `toast toast--${opts.kind ?? 'info'}`;
	el.innerHTML = `<div class="toast__title">${escapeHtml(title)}</div>${opts.sub ? `<div class="toast__sub">${escapeHtml(opts.sub)}</div>` : ''}`;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	const dismiss = (): void => {
		if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
		el.classList.remove('show');
		setTimeout(() => el.remove(), 200);
	};
	if (opts.action) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'toast__action';
		btn.textContent = opts.action.label;
		btn.addEventListener('click', () => {
			dismiss();
			opts.action!.onClick();
		});
		el.appendChild(btn);
	}
	stack.appendChild(el);
	// next frame so the transition runs
	requestAnimationFrame(() => el.classList.add('show'));
	const duration = opts.durationMs ?? 3200;
	hideTimer = setTimeout(dismiss, duration);
}

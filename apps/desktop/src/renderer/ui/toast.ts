// Toast notifications (F3.0 — extracted from main.ts). Small status
// messages anchored bottom-right in the #toast-stack host AppShell renders.
// Toasts announce one-off events (match success/failure, sync errors);
// they don't replace clear in-UI state changes.
//
// `action` renders a button inside the toast (the Organize modal's bulk
// tag/playlist writes use it for Undo). Clicking runs the callback and
// dismisses the toast immediately.
//
// showProgressToast is the one that stays: it follows work in flight and then
// becomes its result.

import { escapeHtml } from './format.js';

export interface ToastOptions {
	sub?: string;
	kind?: 'success' | 'error' | 'info';
	durationMs?: number;
	action?: { label: string; onClick: () => void };
}

const DEFAULT_DURATION_MS = 3200;

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
	const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
	hideTimer = setTimeout(dismiss, duration);
}

// A toast for work that takes a while: shown at once with a breathing square,
// its lines rewritten as the work reports (update), until the work ends and it
// turns into the result — coloured by kind, gone after the usual delay
// (finish). One toast for the whole run, so progress never stacks up.
export interface ProgressToast {
	update(title: string, sub?: string): void;
	finish(title: string, opts?: Pick<ToastOptions, 'sub' | 'kind' | 'durationMs'>): void;
}

export function showProgressToast(title: string, sub?: string): ProgressToast {
	const el = document.createElement('div');
	el.className = 'toast toast--info toast--progress';
	const titleEl = document.createElement('div');
	titleEl.className = 'toast__title';
	const pulse = document.createElement('span');
	pulse.className = 'toast__pulse';
	const titleText = document.createElement('span');
	titleEl.append(pulse, titleText);
	const subEl = document.createElement('div');
	subEl.className = 'toast__sub';
	el.append(titleEl, subEl);
	// Text nodes only: rewriting the markup would restart the pulse.
	const setText = (t: string, s?: string): void => {
		titleText.textContent = t;
		subEl.textContent = s ?? '';
		subEl.hidden = !s;
	};
	setText(title, sub);
	document.getElementById('toast-stack')?.appendChild(el);
	requestAnimationFrame(() => el.classList.add('show'));
	let finished = false;
	return {
		update(t, s) {
			if (!finished) setText(t, s);
		},
		finish(t, opts = {}) {
			if (finished) return;
			finished = true;
			pulse.remove();
			el.classList.replace('toast--info', `toast--${opts.kind ?? 'info'}`);
			setText(t, opts.sub);
			setTimeout(() => {
				el.classList.remove('show');
				setTimeout(() => el.remove(), 200);
			}, opts.durationMs ?? DEFAULT_DURATION_MS);
		},
	};
}

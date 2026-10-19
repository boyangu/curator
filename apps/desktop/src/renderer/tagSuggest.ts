// Reusable `#tag` autocomplete popover. Attaches to any text input that
// uses the shared query grammar (see renderer/query.ts) — currently the
// omnibar and the tracklist filterbox. Behaviour:
//
//   • While the caret sits inside a `#…` partial, a dropdown of matching
//     user tags (prefix-match first, substring fallback) renders below
//     the input.
//   • Up/Down navigates, Enter/Tab inserts the highlighted name (quoted
//     when it contains whitespace, commas, or another `#`), Esc closes
//     the popover without closing the host modal.
//   • Capture-phase keydown intercepts those keys before the host's own
//     handler runs — so the host doesn't need to know the popover exists.
//
// Positioning: the popover is appended into `anchorEl` and uses
// `position: absolute; top: 100%; left: 0; right: 0`. The anchor must be
// `position: relative` so the popover spans its width and lands flush
// below it.

import * as tagsStore from './stores/tagsStore.js';

export interface TagSuggestOptions {
	inputEl: HTMLInputElement;
	anchorEl: HTMLElement;
	// Fired after the user inserts a tag — the caller re-runs whatever
	// query logic depends on the input value (a debounced filter, an IPC,
	// etc.).
	onCommit: () => void;
}

export interface TagSuggestHandle {
	// Tear down DOM + listeners. Idempotent.
	dispose(): void;
}

// Max rows in the popover. 8 fits comfortably above either host without
// pushing into the content below. Tags beyond the 8th are reachable by
// typing more of the prefix.
const MAX = 8;

export function attachTagSuggest(opts: TagSuggestOptions): TagSuggestHandle {
	const { inputEl, anchorEl, onCommit } = opts;

	let popoverEl: HTMLElement | null = null;
	let visible = false;
	let list: { id: string; name: string }[] = [];
	let idx = 0;

	// Walk backward from the caret to find the start of the current `#…`
	// token. Returns null when the caret isn't inside one — the popover
	// stays hidden. `partial` is the text being typed right now (the last
	// comma-separated chunk inside the `#…` run, with any opening quote
	// stripped). (start, end) lets the inserter splice the resolved name.
	const detect = (): { start: number; end: number; partial: string } | null => {
		const value = inputEl.value;
		const caret = inputEl.selectionStart ?? value.length;
		let i = caret - 1;
		while (i >= 0 && value[i] !== '#' && !/\s/.test(value[i] ?? '')) i--;
		if (i < 0 || value[i] !== '#') return null;
		let partialStart = i + 1;
		let inQuote: string | null = null;
		for (let j = i + 1; j < caret; j++) {
			const c = value[j];
			if (inQuote) {
				if (c === inQuote) inQuote = null;
			} else if (c === '"' || c === "'" || c === '`') {
				inQuote = c;
			} else if (c === ',') {
				partialStart = j + 1;
				inQuote = null;
			}
		}
		let raw = value.slice(partialStart, caret);
		if (raw.length > 0 && (raw[0] === '"' || raw[0] === "'" || raw[0] === '`')) {
			raw = raw.slice(1);
		}
		return { start: partialStart, end: caret, partial: raw };
	};

	const ensureEl = (): HTMLElement => {
		if (popoverEl) return popoverEl;
		popoverEl = document.createElement('div');
		popoverEl.className = 'tag-suggest';
		popoverEl.hidden = true;
		// Prevent the input from losing focus when the user mouses over a row.
		popoverEl.addEventListener('mousedown', (e) => e.preventDefault());
		popoverEl.addEventListener('click', (e) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>('[data-tag-idx]');
			if (!row) return;
			const i = Number(row.dataset.tagIdx);
			if (Number.isFinite(i)) insert(i);
		});
		popoverEl.addEventListener('mousemove', (e) => {
			const row = (e.target as HTMLElement).closest<HTMLElement>('[data-tag-idx]');
			if (!row) return;
			const i = Number(row.dataset.tagIdx);
			if (Number.isFinite(i) && i !== idx) {
				idx = i;
				highlight();
			}
		});
		anchorEl.appendChild(popoverEl);
		return popoverEl;
	};

	const render = (): void => {
		if (!popoverEl) return;
		popoverEl.innerHTML = list.map((t, i) => {
			const cls = i === idx ? 'tag-suggest__row is-active' : 'tag-suggest__row';
			return `<div class="${cls}" data-tag-idx="${i}"><span class="tag-suggest__name">${escapeHtml(t.name)}</span></div>`;
		}).join('');
	};

	const highlight = (): void => {
		if (!popoverEl) return;
		const rows = popoverEl.querySelectorAll<HTMLElement>('[data-tag-idx]');
		for (let i = 0; i < rows.length; i++) rows[i]!.classList.toggle('is-active', i === idx);
	};

	const show = (): void => { ensureEl().hidden = false; visible = true; };
	const hide = (): void => { if (popoverEl) popoverEl.hidden = true; visible = false; };

	const insert = (i: number): void => {
		const ctx = detect();
		if (!ctx) return;
		const tag = list[i];
		if (!tag) return;
		// Quote when the name contains a char that would break bareword
		// parsing (whitespace, comma, or another `#`). Double-quote is the
		// canonical form — the parser accepts ' and ` too but we standardise.
		const needsQuote = /[\s,#]/.test(tag.name);
		const inserted = needsQuote ? `"${tag.name}"` : tag.name;
		const before = inputEl.value.slice(0, ctx.start);
		const afterRaw = inputEl.value.slice(ctx.end);
		// Strip a trailing quote that belonged to the partial the user was in
		// the middle of typing — e.g. `#"deep ho|"` — the closing quote lives
		// in `afterRaw[0]`. Without this we'd end up with `"deep house""`.
		const after = afterRaw.length > 0 && (afterRaw[0] === '"' || afterRaw[0] === "'" || afterRaw[0] === '`')
			? afterRaw.slice(1)
			: afterRaw;
		inputEl.value = before + inserted + after;
		const caret = before.length + inserted.length;
		inputEl.setSelectionRange(caret, caret);
		hide();
		onCommit();
	};

	const update = (): void => {
		const ctx = detect();
		if (!ctx) { hide(); return; }
		ensureEl();
		const needle = ctx.partial.toLowerCase();
		const all = tagsStore.getUserTagsSorted();
		const matches: typeof list = [];
		// Prefix match first — most natural when typing the name.
		for (const t of all) {
			if (matches.length >= MAX) break;
			if (!needle || t.name.toLowerCase().startsWith(needle)) {
				matches.push({ id: t.id, name: t.name });
			}
		}
		// Substring fallback so a tag with a noisy prefix is still discoverable.
		if (matches.length === 0 && needle) {
			for (const t of all) {
				if (matches.length >= MAX) break;
				if (t.name.toLowerCase().includes(needle)) {
					matches.push({ id: t.id, name: t.name });
				}
			}
		}
		if (matches.length === 0) { hide(); return; }
		list = matches;
		idx = 0;
		render();
		show();
	};

	const onInput = (): void => update();
	const onKeyup = (e: KeyboardEvent): void => {
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') update();
	};
	const onClick = (): void => update();

	// Capture-phase keydown — when the popover is visible, intercept nav
	// keys before the host input's bubble-phase handler runs so the host
	// doesn't need to coordinate with us.
	const onKeydown = (e: KeyboardEvent): void => {
		if (!visible) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault(); e.stopPropagation();
			if (list.length === 0) return;
			idx = (idx + 1) % list.length;
			highlight();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault(); e.stopPropagation();
			if (list.length === 0) return;
			idx = (idx - 1 + list.length) % list.length;
			highlight();
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault(); e.stopPropagation();
			if (list.length > 0) insert(idx);
		} else if (e.key === 'Escape') {
			e.preventDefault(); e.stopPropagation();
			hide();
		}
	};

	inputEl.addEventListener('input', onInput);
	inputEl.addEventListener('keyup', onKeyup);
	inputEl.addEventListener('click', onClick);
	inputEl.addEventListener('keydown', onKeydown, true);

	return {
		dispose: () => {
			inputEl.removeEventListener('input', onInput);
			inputEl.removeEventListener('keyup', onKeyup);
			inputEl.removeEventListener('click', onClick);
			inputEl.removeEventListener('keydown', onKeydown, true);
			popoverEl?.remove();
			popoverEl = null;
			visible = false;
		},
	};
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => (
		c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
	));
}

// ContextMenu — typed, JSX-driven popup menu. Single-shot: open via
// `openContextMenu(items, handlers, opts)`, dismisses itself on item
// click / outside-mousedown / ESC.
//
// Supports:
//  - leaf items with optional right-docked type chip + underlined mnemonic
//  - nested submenus (hover-driven, opens to the right with viewport-flip
//    when there's not enough room — used by the track menu's Navigate to
//    bucket which combines playlists with artist/album/label/genre drill
//    targets under one parent)
//  - mnemonic activation: pressing a top-level item's mnemonic key while
//    the menu is open triggers that item — mirrors the global tracklist
//    shortcuts so the menu doubles as a discovery surface for them.
//  - radio items (one-of choices with a selected dot) and anchored popups:
//    `anchor` opens the menu under a toolbar chip, ignores mousedowns on
//    the chip itself (so the chip's own click can toggle it closed via
//    dismissContextMenu) and reports every close through `onClose`.
//
// Class names match the existing CSS (ctx-menu, ctx-menu__head,
// ctx-menu__item, ctx-menu__divider, plus the new ctx-menu__sub /
// ctx-menu__chip / ctx-menu__chev / ctx-menu__mnemonic).

import { For, Show, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { log } from '../data/log.js';

const slog = log.for('context-menu');

export type ContextMenuItem =
	| { kind: 'header'; label: string }
	| { kind: 'divider' }
	| {
		kind: 'item';
		id: string;
		label: string;
		// Inline SVG (or other HTML). Rendered via innerHTML so .ts
		// callers can embed icons without needing JSX. Sanitized? No —
		// these strings are app-internal and never touch user input.
		iconHtml?: string;
		danger?: boolean;
		disabled?: boolean;
		// Hover tooltip — chiefly why a disabled item can't run.
		title?: string;
		// Right-docked type chip — e.g. "Playlist", "Artist", "Album".
		// Used by the Navigate to submenu to label the kind of jump
		// each row performs. No truncation here; chip styling caps
		// the visible width.
		chip?: string;
		// Single character that triggers this item when pressed while
		// the menu is open. Display: the first case-insensitive
		// occurrence in `label` gets an underline. Only first-level
		// items participate in keyboard activation — children of
		// submenus are mouse-only for v1 since they're typically
		// data rows (artist/playlist names) without a stable letter.
		mnemonic?: string;
	}
	| {
		kind: 'submenu';
		id: string;
		label: string;
		iconHtml?: string;
		disabled?: boolean;
		items: ContextMenuItem[];
		mnemonic?: string;
	}
	| {
		// One-of choice. `checked` paints the selected state (fill + dot);
		// picking dispatches into the handlers map like a leaf item.
		kind: 'radio';
		id: string;
		label: string;
		checked: boolean;
		disabled?: boolean;
	}
	| {
		// Compact color-swatch matrix (cue color picker). Cells dispatch
		// into the same flat handlers map as leaf items — one handler per
		// cell id. `hex: null` renders the outlined "no color" cell;
		// `selected` rings the current value so the menu doubles as a
		// state display. Cells are mouse-only (no mnemonics) — they're
		// data rows without a stable letter, same rationale as submenu
		// children.
		kind: 'swatch-grid';
		columns: number;
		cells: Array<{ id: string; hex: string | null; label: string; selected?: boolean }>;
	};

export type ContextMenuHandlers = Record<string, () => void | Promise<void>>;

export interface OpenContextMenuOptions {
	// Anchor point — usually the MouseEvent that triggered the menu.
	// `{x, y}` is accepted for cases without a real event. Ignored when
	// `anchor` is given.
	at?: MouseEvent | { x: number; y: number };
	// Open under this element (a toolbar chip): 6px below it, its right
	// edge aligned with the element's when align is 'end'.
	anchor?: HTMLElement;
	align?: 'start' | 'end';
	// 'popup' = the compact toolbar-popup look (fixed width, section label).
	variant?: 'menu' | 'popup';
	// Fires once on any dismissal — item pick, outside click, Esc, or a
	// newer menu replacing this one.
	onClose?: () => void;
}

// The open menu's dismiss, so a newer menu (or a toggling chip) closes it
// properly — listeners and onClose included.
let currentDismiss: (() => void) | null = null;
export function dismissContextMenu(): void {
	currentDismiss?.();
}

// Walk `items` recursively and collect every leaf-item id with its
// handler — used by the keyboard mnemonic path and the click path so
// both can dispatch into the flat handlers map without the caller
// needing to flatten beforehand.
function* walkItems(items: ContextMenuItem[]): Generator<ContextMenuItem & { kind: 'item' | 'submenu' }> {
	for (const item of items) {
		if (item.kind === 'item' || item.kind === 'submenu') yield item;
		if (item.kind === 'submenu') yield* walkItems(item.items);
	}
}

// Split `label` around the first case-insensitive occurrence of `mnemonic`
// and return the JSX with that character wrapped in <u> (bold + underline).
// Returns the plain string when the mnemonic isn't found — defensive against
// label drift (e.g. a localized label that no longer contains the canonical key).
// `**word**` segments render bold ("Open in **Spotify**"); such labels carry no
// mnemonic.
function renderMnemonicLabel(label: string, mnemonic: string | undefined): JSX.Element {
	if (label.includes('**')) {
		return (
			<>
				{label.split('**').map((part, i) => (i % 2 === 1 ? <b class="ctx-menu__em">{part}</b> : part))}
			</>
		);
	}
	if (!mnemonic) return label as unknown as JSX.Element;
	const m = mnemonic.toLowerCase();
	const idx = label.toLowerCase().indexOf(m);
	if (idx < 0) return label as unknown as JSX.Element;
	return (
		<>
			{label.slice(0, idx)}
			<u class="ctx-menu__mnemonic">{label[idx]}</u>
			{label.slice(idx + 1)}
		</>
	);
}

export function openContextMenu(
	items: ContextMenuItem[],
	handlers: ContextMenuHandlers,
	opts: OpenContextMenuOptions,
): void {
	// Tear down any previously-open menu — only one can be visible at a
	// time, and a stale menu from a prior right-click shouldn't survive.
	currentDismiss?.();
	document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());

	const host = document.createElement('div');
	host.className = opts.variant === 'popup' ? 'ctx-menu ctx-menu--popup' : 'ctx-menu';
	host.setAttribute('role', 'menu');
	document.body.appendChild(host);

	let isDismissed = false;
	const dismiss = (): void => {
		if (isDismissed) return;
		isDismissed = true;
		if (currentDismiss === dismiss) currentDismiss = null;
		document.removeEventListener('mousedown', onOutside, true);
		document.removeEventListener('keydown', onKey, true);
		dispose();
		host.remove();
		opts.onClose?.();
	};
	currentDismiss = dismiss;
	const onOutside = (e: MouseEvent): void => {
		const target = e.target as Node;
		if (host.contains(target)) return;
		// The anchoring chip toggles the menu itself (its click handler).
		if (opts.anchor?.contains(target)) return;
		dismiss();
	};

	const handleClick = async (id: string): Promise<void> => {
		dismiss();
		const handler = handlers[id];
		if (!handler) return;
		try {
			await handler();
		} catch (err) {
			slog.error(`ctx action "${id}" failed`, err);
		}
	};

	// Index top-level items by mnemonic char so the keydown listener can
	// fire in O(1) without re-scanning items[]. Submenu CHILDREN are not
	// indexed — see note in the type definition.
	const mnemonicMap = new Map<string, string>();
	for (const item of items) {
		if (item.kind === 'item' && item.mnemonic && !item.disabled) {
			mnemonicMap.set(item.mnemonic.toLowerCase(), item.id);
		}
	}

	const onKey = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
		// Bare single-character key with no modifier → mnemonic activation.
		// Mirrors the global tracklist shortcut shape (R / T / P) so muscle
		// memory carries over once the menu is open.
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const k = e.key;
		if (k.length !== 1) return;
		const id = mnemonicMap.get(k.toLowerCase());
		if (!id) return;
		e.preventDefault();
		void handleClick(id);
	};

	// Submenu positioning — kept as state so a hover that opens a submenu
	// can mark it flipped (open-left) when there's not enough room on the
	// right. Keyed by submenu id; cleared on any other render.
	const [flippedSubs, setFlippedSubs] = createSignal<ReadonlySet<string>>(new Set());

	const renderItem = (item: ContextMenuItem): JSX.Element => {
		if (item.kind === 'header') {
			return <div class="ctx-menu__head">{item.label}</div>;
		}
		if (item.kind === 'divider') {
			return <div class="ctx-menu__divider"></div>;
		}
		if (item.kind === 'radio') {
			return (
				<button
					class="ctx-menu__item ctx-menu__item--radio"
					classList={{ 'is-checked': item.checked }}
					type="button"
					role="menuitemradio"
					aria-checked={item.checked ? 'true' : 'false'}
					disabled={item.disabled}
					onClick={() => { void handleClick(item.id); }}
				>
					<span class="ctx-menu__label">{item.label}</span>
					<Show when={item.checked}><span class="ctx-menu__dot" aria-hidden="true"></span></Show>
				</button>
			);
		}
		if (item.kind === 'swatch-grid') {
			return (
				<div
					class="ctx-menu__swatches"
					style={{ 'grid-template-columns': `repeat(${item.columns}, 1fr)` }}
				>
					<For each={item.cells}>
						{(cell) => (
							<button
								class="ctx-menu__swatch"
								classList={{
									'ctx-menu__swatch--none': cell.hex == null,
									'ctx-menu__swatch--selected': !!cell.selected,
								}}
								type="button"
								title={cell.label}
								aria-label={cell.label}
								onClick={() => { void handleClick(cell.id); }}
							>
								<span
									class="ctx-menu__swatch-dot"
									style={cell.hex ? { background: cell.hex } : undefined}
								></span>
							</button>
						)}
					</For>
				</div>
			);
		}
		if (item.kind === 'submenu') {
			let wrapEl: HTMLDivElement | undefined;
			const onEnter = (): void => {
				// Probe whether the submenu would clip the viewport. The CSS
				// keeps the sub `display: none` until :hover, so we briefly
				// force it visible-but-hidden to take a real measurement,
				// then revert. offsetWidth/Height force a synchronous layout
				// flush so the values reflect the temporary state.
				if (!wrapEl) return;
				const wrapRect = wrapEl.getBoundingClientRect();
				const sub = wrapEl.querySelector<HTMLDivElement>(':scope > .ctx-menu__sub');
				if (!sub) return;
				const prevDisplay = sub.style.display;
				const prevVisibility = sub.style.visibility;
				sub.style.display = 'block';
				sub.style.visibility = 'hidden';
				const subW = sub.offsetWidth || 240;
				const subH = sub.offsetHeight || 0;
				sub.style.display = prevDisplay;
				sub.style.visibility = prevVisibility;

				// Horizontal: flip to right:100% (open left) when the default
				// left:100% would clip the viewport's right edge.
				const shouldFlip = wrapRect.right + subW + 8 > window.innerWidth;
				setFlippedSubs((prev) => {
					const has = prev.has(item.id);
					if (has === shouldFlip) return prev;
					const next = new Set(prev);
					if (shouldFlip) next.add(item.id); else next.delete(item.id);
					return next;
				});

				// Vertical: submenu defaults to top:-5px (5px above trigger
				// top). Shift it up when its bottom would clip the viewport,
				// clamped so we never push past the viewport's top edge.
				// max-height:70vh on .ctx-menu__sub bounds subH so this fits.
				let topPx = -5;
				if (subH > 0) {
					const defaultTop = wrapRect.top + topPx;
					const overflowBottom = defaultTop + subH + 8 - window.innerHeight;
					if (overflowBottom > 0) {
						const maxShift = Math.max(0, wrapRect.top - 8);
						topPx -= Math.min(overflowBottom, maxShift);
					}
				}
				sub.style.top = `${topPx}px`;
			};
			return (
				<div
					class="ctx-menu__sub-wrap"
					ref={(el) => { wrapEl = el; }}
					onMouseEnter={onEnter}
				>
					<button
						class="ctx-menu__item ctx-menu__item--has-sub"
						type="button"
						disabled={item.disabled}
					>
						<Show when={item.iconHtml}>
							{(html) => <span innerHTML={html()}></span>}
						</Show>
						<span class="ctx-menu__label">{renderMnemonicLabel(item.label, item.mnemonic)}</span>
						<span class="ctx-menu__chev">›</span>
					</button>
					<div
						class="ctx-menu__sub"
						classList={{ 'ctx-menu__sub--flip': flippedSubs().has(item.id) }}
					>
						<For each={item.items}>
							{(child) => renderItem(child)}
						</For>
					</div>
				</div>
			);
		}
		return (
			<button
				class="ctx-menu__item"
				classList={{ 'ctx-menu__item--danger': !!item.danger }}
				type="button"
				disabled={item.disabled}
				title={item.title}
				onClick={() => { void handleClick(item.id); }}
			>
				<Show when={item.iconHtml}>
					{(html) => <span innerHTML={html()}></span>}
				</Show>
				<span class="ctx-menu__label">{renderMnemonicLabel(item.label, item.mnemonic)}</span>
				<Show when={item.chip}>
					{(chip) => <span class="ctx-menu__chip">{chip()}</span>}
				</Show>
			</button>
		);
	};

	const dispose = render(() => (
		<For each={items}>
			{(item) => renderItem(item)}
		</For>
	), host);

	// Position once the DOM has its real width/height. Clamp to viewport
	// with an 8px gutter so the menu doesn't sit flush against an edge.
	// The outer Math.max guards against a menu larger than the viewport
	// (oversized would otherwise yield a negative coord and slide off the
	// top/left instead of the bottom/right).
	const rect = host.getBoundingClientRect();
	let ax: number;
	let ay: number;
	if (opts.anchor) {
		const ar = opts.anchor.getBoundingClientRect();
		ax = opts.align === 'end' ? ar.right - rect.width : ar.left;
		ay = ar.bottom + 6;
	} else {
		const at = opts.at ?? { x: 0, y: 0 };
		ax = at instanceof MouseEvent ? at.clientX : at.x;
		ay = at instanceof MouseEvent ? at.clientY : at.y;
	}
	const x = Math.max(8, Math.min(ax, window.innerWidth - rect.width - 8));
	const y = Math.max(8, Math.min(ay, window.innerHeight - rect.height - 8));
	host.style.left = `${x}px`;
	host.style.top = `${y}px`;

	// Defer outside-mousedown wiring by one tick — the click that opened
	// the menu would otherwise dismiss it immediately.
	setTimeout(() => {
		if (isDismissed) return;
		document.addEventListener('mousedown', onOutside, true);
		document.addEventListener('keydown', onKey, true);
	}, 0);

	// Silence unused-import warning when walkItems is dropped from a future
	// refactor; keeping it exported-style for symmetry with mnemonic indexing.
	void walkItems;
}

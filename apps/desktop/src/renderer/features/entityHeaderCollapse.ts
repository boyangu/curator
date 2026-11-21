// An entity page's header collapsing as the list under it scrolls.
//
// At the top of the list the header is full height: picture, name, facts,
// labels, genres, similar artists, what the list is loading. Scrolling takes
// it down to its two top lines — and takes it there with the scroll, pixel
// for pixel: the lower part of the header rides up with the rows, slides in
// behind the name and facts lines and fades as it goes, while the picture and
// the name shrink to their small size. Scrolling back to the top plays it in
// reverse.
//
// How: the header is laid OVER the top of the list's scroll host (its height
// taken back out of the flow with a negative margin), and the list keeps that
// much empty room at the top of its content (track-list.ts setTopInset). So
// the scroll host never moves or resizes — nothing below the header relays
// out — and the first `lead` pixels of scroll (full height minus the two-line
// height) are the header closing: this module shortens the header's box by
// the scroll offset, up to `lead`, and hands the header its progress as two
// CSS variables (`--eh-p`, 0 → 1, and `--eh-more-y`); style.css does the rest
// (.eh rules). Past `lead` the list scrolls under a header that no longer
// changes, and no style is written.
//
// Framework-free on purpose: this runs on every scroll frame while the header
// is closing, and writes straight to the two elements.
//
// The header's natural height changes with what it shows (the catalogue's
// half arriving, a status line coming and going, a narrower window), and it
// cannot be read off the element while it is partly closed. `remeasure` reads
// it by setting the progress to 0 for the length of one layout read — the
// caller runs it whenever the header's content changed.

export interface CollapseGeometry {
	// The header's natural height, and its height at its smallest.
	full: number;
	compact: number;
}

export interface CollapseState {
	// How much of the header is closed (0 … full − compact), and the same as 0 … 1.
	shift: number;
	progress: number;
	// The header's box, as it stands.
	height: number;
	collapsed: boolean;
}

// A header only a few pixels taller than its two lines has nothing to close.
const MIN_LEAD_PX = 8;

export const leadOf = (g: CollapseGeometry): number => {
	const lead = Math.round(g.full - g.compact);
	return lead >= MIN_LEAD_PX ? lead : 0;
};

export function collapseAt(scrollTop: number, g: CollapseGeometry): CollapseState {
	const lead = leadOf(g);
	const shift = Math.min(Math.max(scrollTop, 0), lead);
	return { shift, progress: lead > 0 ? shift / lead : 0, height: g.full - shift, collapsed: lead > 0 && shift >= lead };
}

export interface HeaderCollapseOptions {
	// The header's host (overflow hidden, laid over the list) and the list's scroll host.
	host: HTMLElement;
	scroller: HTMLElement;
	// Whether a page's header is showing at all.
	active(): boolean;
	// The room the list keeps for the header, and how far it scrolls before
	// its rows move (track-list.ts setTopInset). (0, 0): no header.
	onInset(inset: number, lead: number): void;
	// The header reached, or left, its two-line size.
	onCollapsed(collapsed: boolean): void;
}

export interface HeaderCollapse {
	// The header's content (or the window) changed: measure it again.
	remeasure(): void;
	// The room and lead as last measured (a list mounted since needs them).
	inset(): { inset: number; lead: number };
	destroy(): void;
}

const MEASURE_COMPACT = 'eh--measure-compact';
const COLLAPSED = 'eh--collapsed';

export function mountHeaderCollapse(opts: HeaderCollapseOptions): HeaderCollapse {
	const { host, scroller } = opts;
	let geo: CollapseGeometry = { full: 0, compact: 0 };
	// How far the lower part moves up by itself as the top part shrinks.
	let flow = 0;
	let on = false;
	let applied = { shift: -1, height: -1 };
	let collapsed = false;
	let told = { inset: -1, lead: -1 };

	const inner = (): HTMLElement | null => host.firstElementChild as HTMLElement | null;

	function apply(): void {
		const el = inner();
		if (!on || !el) return;
		const s = collapseAt(scroller.scrollTop, geo);
		if (s.shift !== applied.shift || s.height !== applied.height) {
			applied = { shift: s.shift, height: s.height };
			host.style.height = `${s.height}px`;
			host.style.marginBottom = `${-s.height}px`;
			el.style.setProperty('--eh-p', s.progress.toFixed(4));
			// With the rows: `shift` up in all, part of which the shrinking top
			// part already gives it.
			el.style.setProperty('--eh-more-y', `${(flow * s.progress - s.shift).toFixed(2)}px`);
		}
		if (s.collapsed !== collapsed) {
			collapsed = s.collapsed;
			el.classList.toggle(COLLAPSED, collapsed);
			opts.onCollapsed(collapsed);
		}
	}

	function tell(inset: number, lead: number): void {
		if (told.inset === inset && told.lead === lead) return;
		told = { inset, lead };
		opts.onInset(inset, lead);
	}

	function off(): void {
		if (on || applied.height !== -1) {
			on = false;
			applied = { shift: -1, height: -1 };
			host.style.height = '';
			host.style.marginBottom = '';
			host.style.marginRight = '';
		}
		if (collapsed) {
			collapsed = false;
			inner()?.classList.remove(COLLAPSED);
			opts.onCollapsed(false);
		}
		tell(0, 0);
	}

	function remeasure(): void {
		const el = inner();
		if (!el || !opts.active() || host.hidden) {
			off();
			return;
		}
		// Natural size: unclipped, fully open — then fully closed, with and
		// without the lower part in the flow. Three layout reads of the header's
		// own subtree, only when its content changed.
		host.style.height = '';
		host.style.marginBottom = '';
		const more = el.querySelector<HTMLElement>('.eh-more');
		el.classList.remove(COLLAPSED);
		el.style.setProperty('--eh-p', '0');
		el.style.setProperty('--eh-more-y', '0px');
		const border = host.offsetHeight - host.clientHeight;
		const full = el.offsetHeight + border;
		const moreTop = more?.offsetTop ?? 0;
		el.style.setProperty('--eh-p', '1');
		flow = more ? moreTop - more.offsetTop : 0;
		el.classList.add(MEASURE_COMPACT);
		const compact = el.offsetHeight + border;
		el.classList.remove(MEASURE_COMPACT);
		if (collapsed) el.classList.add(COLLAPSED);
		// The header stops short of the list's scrollbar, so the bar runs the
		// pane's whole height beside it instead of starting behind it.
		host.style.marginRight = `${Math.max(0, scroller.offsetWidth - scroller.clientWidth)}px`;
		geo = { full, compact };
		on = full > 0;
		applied = { shift: -1, height: -1 };
		if (!on) {
			off();
			return;
		}
		// The list first: a longer lead moves the scroll offset of rows already
		// scrolled, and the header is then laid out for the offset that results.
		tell(full, leadOf(geo));
		apply();
	}

	const onScroll = (): void => apply();
	// The header covers the top of the list, so a wheel over it would scroll
	// nothing: pass it on. A mouse notch glides like one over the rows does;
	// a trackpad's small steps go straight through.
	const onWheel = (e: WheelEvent): void => {
		if (!on || e.ctrlKey || e.deltaY === 0) return;
		const top = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
		scroller.scrollBy({ top, behavior: Math.abs(top) >= 50 ? 'smooth' : 'auto' });
	};
	let frame = 0;
	const onResize = (): void => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			remeasure();
		});
	};

	scroller.addEventListener('scroll', onScroll, { passive: true });
	host.addEventListener('wheel', onWheel, { passive: true });
	window.addEventListener('resize', onResize);

	return {
		remeasure,
		inset: () => ({ inset: Math.max(0, told.inset), lead: Math.max(0, told.lead) }),
		destroy() {
			scroller.removeEventListener('scroll', onScroll);
			host.removeEventListener('wheel', onWheel);
			window.removeEventListener('resize', onResize);
			if (frame) cancelAnimationFrame(frame);
			off();
		},
	};
}

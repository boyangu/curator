// Side panel:
//   • node-kind toggles (artists / labels / genres / tracks) + live counts
//   • a node search box (focus any node by label)
//   • for labels AND genres (when their kind is on): a filter component —
//     searchable, individually toggleable, sorted by #tracks desc, with a
//     min-#tracks threshold to bulk-drop the long tail.
//
// All state lives here; every change emits an immutable FilterState snapshot
// via onChange. The graph is model-dependent on this whole state (buildGraph
// takes per-entity predicates), so main.ts rebuilds on each snapshot.

import { NODE_KINDS, KIND_LABEL, KIND_COLOR } from '../model/types.js';
import type { NodeKind } from '../model/types.js';
import type { BuildStats, EntityCount } from '../model/buildGraph.js';

// Threshold options for the "min tracks" control. 1 = include everything.
const MIN_TRACK_OPTIONS = [1, 2, 5, 10] as const;

export type EntityFilterState = {
	minTracks: number;
	disabled: Set<string>; // entity names the user explicitly unchecked
};

export type FilterState = {
	visible: Set<NodeKind>;
	artist: EntityFilterState;
	label: EntityFilterState;
	genre: EntityFilterState;
};

export type Entities = { artists: EntityCount[]; labels: EntityCount[]; genres: EntityCount[] };

// The node kinds that get an entity filter pane.
type PaneKind = 'artist' | 'label' | 'genre';
const PANE_KINDS: PaneKind[] = ['artist', 'label', 'genre'];

export type ControlsHandlers = {
	onChange: (state: FilterState) => void;
	onSearch: (query: string) => void;
};

// Internal mutable working state for one entity filter pane.
type PaneState = {
	kind: PaneKind;
	all: EntityCount[];
	minTracks: number;
	disabled: Set<string>;
	query: string;
	section: HTMLElement;
	listEl: HTMLElement;
	summaryEl: HTMLElement;
};

export class Controls {
	private visible: Set<NodeKind>;
	private countEls: Partial<Record<NodeKind, HTMLElement>> = {};
	private totalEl!: HTMLElement;
	private panes: Record<PaneKind, PaneState>;

	constructor(
		root: HTMLElement,
		initial: Set<NodeKind>,
		entities: Entities,
		private handlers: ControlsHandlers
	) {
		this.visible = new Set(initial);
		this.panes = {
			artist: this.makePaneState('artist', entities.artists),
			label: this.makePaneState('label', entities.labels),
			genre: this.makePaneState('genre', entities.genres),
		};
		this.render(root);
		this.syncPaneVisibility();
	}

	get state(): FilterState {
		return this.snapshot();
	}

	private paneFilter(kind: PaneKind): EntityFilterState {
		return { minTracks: this.panes[kind].minTracks, disabled: new Set(this.panes[kind].disabled) };
	}

	private snapshot(): FilterState {
		return {
			visible: new Set(this.visible),
			artist: this.paneFilter('artist'),
			label: this.paneFilter('label'),
			genre: this.paneFilter('genre'),
		};
	}

	private emit(): void {
		this.handlers.onChange(this.snapshot());
	}

	private makePaneState(kind: PaneKind, all: EntityCount[]): PaneState {
		return {
			kind,
			all,
			minTracks: 1,
			disabled: new Set(),
			query: '',
			section: document.createElement('div'),
			listEl: document.createElement('div'),
			summaryEl: document.createElement('div'),
		};
	}

	private render(root: HTMLElement): void {
		root.innerHTML = '';

		const title = document.createElement('h1');
		title.textContent = 'Graph Explorer';
		root.appendChild(title);

		const sub = document.createElement('p');
		sub.className = 'sub';
		sub.textContent = 'curator.db · local files · in-memory graph';
		root.appendChild(sub);

		// ── kind toggles ──
		const group = document.createElement('div');
		group.className = 'toggles';
		for (const kind of NODE_KINDS) {
			const row = document.createElement('label');
			row.className = 'toggle';

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = this.visible.has(kind);
			cb.addEventListener('change', () => {
				if (cb.checked) this.visible.add(kind);
				else this.visible.delete(kind);
				this.syncPaneVisibility();
				this.emit();
			});

			const swatch = document.createElement('span');
			swatch.className = 'swatch';
			swatch.style.background = KIND_COLOR[kind];

			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = KIND_LABEL[kind];

			const count = document.createElement('span');
			count.className = 'count';
			count.textContent = '–';
			this.countEls[kind] = count;

			row.append(cb, swatch, name, count);
			group.appendChild(row);
		}
		root.appendChild(group);

		const total = document.createElement('div');
		total.className = 'total';
		this.totalEl = total;
		root.appendChild(total);

		// ── node search ──
		const search = document.createElement('input');
		search.className = 'search';
		search.type = 'search';
		search.placeholder = 'Find a node…';
		search.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.handlers.onSearch(search.value);
		});
		root.appendChild(search);

		// ── entity filter panes ──
		const HEADINGS: Record<PaneKind, string> = { artist: 'Artists', label: 'Labels', genre: 'Genres' };
		for (const kind of PANE_KINDS) {
			this.buildPane(this.panes[kind], HEADINGS[kind]);
			root.appendChild(this.panes[kind].section);
		}
	}

	private buildPane(pane: PaneState, heading: string): void {
		const section = pane.section;
		section.className = 'filter-section';

		const head = document.createElement('div');
		head.className = 'fs-head';
		const h = document.createElement('span');
		h.className = 'fs-title';
		h.textContent = heading;
		pane.summaryEl.className = 'fs-summary';
		head.append(h, pane.summaryEl);
		section.appendChild(head);

		const controls = document.createElement('div');
		controls.className = 'fs-controls';

		const search = document.createElement('input');
		search.type = 'search';
		search.className = 'fs-search';
		search.placeholder = `Filter ${heading.toLowerCase()}…`;
		search.addEventListener('input', () => {
			pane.query = search.value;
			this.renderList(pane); // search affects the list only, not the graph
		});

		const min = document.createElement('select');
		min.className = 'fs-min';
		min.title = 'Minimum tracks';
		for (const opt of MIN_TRACK_OPTIONS) {
			const o = document.createElement('option');
			o.value = String(opt);
			o.textContent = `≥ ${opt}`;
			min.appendChild(o);
		}
		min.addEventListener('change', () => {
			pane.minTracks = Number(min.value);
			this.renderList(pane);
			this.emit(); // threshold drops entities from the graph
		});

		controls.append(search, min);
		section.appendChild(controls);

		// bulk all / none (respects the current threshold + search filter)
		const actions = document.createElement('div');
		actions.className = 'fs-actions';
		const allBtn = document.createElement('button');
		allBtn.textContent = 'all';
		allBtn.addEventListener('click', () => this.bulkSet(pane, true));
		const noneBtn = document.createElement('button');
		noneBtn.textContent = 'none';
		noneBtn.addEventListener('click', () => this.bulkSet(pane, false));
		actions.append(allBtn, noneBtn);
		section.appendChild(actions);

		pane.listEl.className = 'fs-list';
		section.appendChild(pane.listEl);

		this.renderList(pane);
	}

	// Entities currently passing the threshold (the graph-eligible set).
	private aboveThreshold(pane: PaneState): EntityCount[] {
		return pane.all.filter((e) => e.count >= pane.minTracks);
	}

	private bulkSet(pane: PaneState, enabled: boolean): void {
		// Operate on what's visible in the list (threshold + search), so "none"
		// after searching "anjuna" only disables matches — predictable.
		for (const e of this.visibleRows(pane)) {
			if (enabled) pane.disabled.delete(e.name);
			else pane.disabled.add(e.name);
		}
		this.renderList(pane);
		this.emit();
	}

	private visibleRows(pane: PaneState): EntityCount[] {
		const q = pane.query.trim().toLowerCase();
		return this.aboveThreshold(pane).filter((e) => !q || e.name.toLowerCase().includes(q));
	}

	private renderList(pane: PaneState): void {
		const rows = this.visibleRows(pane);
		const eligible = this.aboveThreshold(pane);
		const enabledCount = eligible.filter((e) => !pane.disabled.has(e.name)).length;
		pane.summaryEl.textContent = `${enabledCount}/${eligible.length} on`;

		pane.listEl.innerHTML = '';
		// Cap the DOM rows — labels can be ~1k; searching narrows it. Show a hint
		// when truncated so the user knows to refine.
		const CAP = 300;
		for (const e of rows.slice(0, CAP)) {
			const row = document.createElement('label');
			row.className = 'fs-item';

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = !pane.disabled.has(e.name);
			cb.addEventListener('change', () => {
				if (cb.checked) pane.disabled.delete(e.name);
				else pane.disabled.add(e.name);
				pane.summaryEl.textContent = `${this.aboveThreshold(pane).filter((x) => !pane.disabled.has(x.name)).length}/${eligible.length} on`;
				this.emit();
			});

			const nm = document.createElement('span');
			nm.className = 'fs-name';
			nm.textContent = e.name;
			nm.title = e.name;

			const ct = document.createElement('span');
			ct.className = 'fs-count';
			ct.textContent = String(e.count);

			row.append(cb, nm, ct);
			pane.listEl.appendChild(row);
		}

		if (rows.length > CAP) {
			const more = document.createElement('div');
			more.className = 'fs-more';
			more.textContent = `+${(rows.length - CAP).toLocaleString()} more — refine search`;
			pane.listEl.appendChild(more);
		}
	}

	private syncPaneVisibility(): void {
		for (const kind of PANE_KINDS) {
			this.panes[kind].section.style.display = this.visible.has(kind) ? '' : 'none';
		}
	}

	updateStats(stats: BuildStats): void {
		for (const kind of NODE_KINDS) {
			const el = this.countEls[kind];
			if (el) el.textContent = stats.nodesByKind[kind].toLocaleString();
		}
		this.totalEl.textContent = `${stats.nodeCount.toLocaleString()} nodes · ${stats.edgeCount.toLocaleString()} edges`;
	}
}

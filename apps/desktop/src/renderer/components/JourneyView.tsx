// JourneyView — the discovery-journey surface (planning/prds/discovery-journeys.md).
//
// Deliberately BARE v1: a journey list (resume / rename / delete), and an
// entity page — breadcrumb path of the current branch, per-aspect expand
// buttons with honest researching/unavailable states, neighbor sections
// grouped by kind, and "via research" markers (confidence + citations) on
// agent claims. Navigation appends to the journey tree via journey:navigate
// (fork-on-navigate from any ancestor); the real tree UI is a later design
// pass. Mounted inside the Discover region next to the feed (mode toggle
// owned by main.ts's mountDiscoverRegion).

import { For, Show, createSignal, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import type {
	JourneyDetail,
	JourneyNode,
	JourneySeed,
	JourneySummary,
	KbAspect,
	KbEdgeOut,
	KbEntity,
	KbEntityDetail,
} from '@curator/core';
import { journeyApi, kbApi, shellApi } from '../data/api.js';

// Where the view is about to land — what a history entry records for it.
// journeyId null ⇔ the journey list.
export interface JourneyNavLocation {
	journeyId: string | null;
	nodeId: string | null;
	label: string;
}

export interface JourneyViewProps {
	onToast: (msg: string, kind: 'info' | 'error' | 'success', sub?: string) => void;
	// A navigation the view applies itself (opening a journey, a neighbor
	// hop, a breadcrumb jump, back to the list), reported BEFORE it applies
	// so main.ts can snapshot the view being left onto its history entry.
	onNavigate?: (loc: JourneyNavLocation) => void;
}

export interface JourneyViewHandle {
	destroy(): void;
	// Refresh the journey list (list mode) — called on re-entry to Discover.
	refresh(): void;
	// Open an existing journey at its current node.
	openJourney(journeyId: string): void;
	// Create a journey from a seed and enter it — the app-wide "Start
	// Journey" context-menu entries land here.
	startFromSeed(seed: JourneySeed): Promise<void>;
	// History traversal: land on a journey node (null ⇔ its current node)
	// WITHOUT reporting a navigation. Jumping moves the journey's pointer —
	// the tree semantics ("jump back + navigate = sibling branch") are
	// exactly a browser's. False when the journey / node is gone.
	openAt(journeyId: string, nodeId: string | null): Promise<boolean>;
	showList(): void;
	// Where the view stands; null in list mode.
	getLocation(): { journeyId: string; nodeId: string } | null;
}

const ASPECT_LABELS: Record<KbAspect, string> = {
	detail: 'Details',
	releases: 'Releases',
	tracks: 'Tracklist',
	'similar-artists': 'Similar artists',
};

const KIND_SECTIONS: { kind: KbEntity['kind']; title: string }[] = [
	{ kind: 'artist', title: 'Artists' },
	{ kind: 'release', title: 'Releases' },
	{ kind: 'track', title: 'Tracks' },
	{ kind: 'label', title: 'Labels' },
	{ kind: 'genre', title: 'Genres' },
];

interface NeighborRow {
	entity: KbEntity;
	edge: KbEdgeOut;
}

// Group the entity's edges into renderable sections: research claims first
// (they're the marquee), then catalog neighbors by kind.
function sectionsOf(detail: KbEntityDetail): { title: string; research: boolean; rows: NeighborRow[] }[] {
	const self = detail.entity.id;
	const research: NeighborRow[] = [];
	const byKind = new Map<KbEntity['kind'], NeighborRow[]>();
	const seen = new Set<string>();
	for (const edge of detail.edges) {
		const otherId = edge.srcId === self ? edge.dstId : edge.srcId;
		const other = detail.neighbors[otherId];
		if (!other) continue;
		const dedupeKey = `${edge.kind}|${other.id}`;
		if (seen.has(dedupeKey)) continue; // same fact from two sources → one row
		seen.add(dedupeKey);
		if (edge.kind === 'similar-artist') {
			research.push({ entity: other, edge });
		} else {
			(byKind.get(other.kind) ?? byKind.set(other.kind, []).get(other.kind)!).push({ entity: other, edge });
		}
	}
	research.sort((a, b) => b.edge.confidence - a.edge.confidence);
	const out: { title: string; research: boolean; rows: NeighborRow[] }[] = [];
	if (research.length > 0) out.push({ title: 'Similar artists', research: true, rows: research });
	for (const { kind, title } of KIND_SECTIONS) {
		const rows = byKind.get(kind);
		if (!rows || rows.length === 0) continue;
		if (kind === 'track') rows.sort((a, b) => (a.edge.position ?? 1e9) - (b.edge.position ?? 1e9));
		if (kind === 'release') rows.sort((a, b) => (b.entity.releaseDate ?? '').localeCompare(a.entity.releaseDate ?? ''));
		out.push({ title, research: false, rows });
	}
	return out;
}

// Root → current chain, from the flat node array.
function pathToCurrent(j: JourneyDetail): JourneyNode[] {
	const byId = new Map(j.nodes.map((n) => [n.id, n]));
	const path: JourneyNode[] = [];
	let cur = byId.get(j.journey.currentNodeId);
	while (cur) {
		path.unshift(cur);
		cur = cur.parentNodeId ? byId.get(cur.parentNodeId) : undefined;
	}
	return path;
}

function fmtWhen(epochMs: number): string {
	return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function mountJourneyView(host: HTMLElement, props: JourneyViewProps): JourneyViewHandle {
	const [mode, setMode] = createSignal<'list' | 'entity'>('list');
	const [journeys, setJourneys] = createSignal<JourneySummary[]>([]);
	const [journey, setJourney] = createSignal<JourneyDetail | null>(null);
	const [detail, setDetail] = createSignal<KbEntityDetail | null>(null);
	const [busyAspect, setBusyAspect] = createSignal<KbAspect | null>(null);
	const [error, setError] = createSignal<string | null>(null);

	const fail = (context: string) => (err: unknown): void => {
		const sub = err instanceof Error ? err.message : String(err);
		setError(`${context}: ${sub}`);
		props.onToast(context, 'error', sub);
	};

	async function loadList(): Promise<void> {
		try { setJourneys(await journeyApi.list()); }
		catch (err) { fail('Loading journeys failed')(err); }
	}

	// Monotonic navigation counter: every move awaits the KB, and a burst
	// (rapid history back/forward, two quick hops) must let the LAST one
	// paint — an older response landing late is dropped.
	let navSeq = 0;

	async function refreshDetail(): Promise<void> {
		const id = detail()?.entity.id;
		if (!id) return;
		const d = await kbApi.entity(id);
		if (d) setDetail(d);
	}

	const nodeTitle = (j: JourneyDetail, nodeId: string): string | null =>
		j.nodes.find((n) => n.id === nodeId)?.titleSnapshot ?? null;

	// Land on a node: jump the journey's pointer there, re-read the tree,
	// show the entity. The shared tail of every entry into entity mode.
	async function applyJump(journeyId: string, nodeId: string): Promise<boolean> {
		const seq = ++navSeq;
		try {
			setError(null);
			const d = await journeyApi.jump(journeyId, nodeId);
			const j = await journeyApi.get(journeyId);
			if (seq !== navSeq) return true;
			if (j) setJourney(j);
			setDetail(d);
			setMode('entity');
			return true;
		} catch (err) {
			fail('Jump failed')(err);
			return false;
		}
	}

	// List row → the journey at its current node (a history navigation).
	async function openJourney(journeyId: string): Promise<void> {
		const seq = ++navSeq;
		try {
			setError(null);
			const j = await journeyApi.get(journeyId);
			if (!j || seq !== navSeq) return;
			props.onNavigate?.({ journeyId, nodeId: j.journey.currentNodeId, label: j.journey.name });
			setJourney(j);
			await applyJump(journeyId, j.journey.currentNodeId);
		} catch (err) { fail('Opening journey failed')(err); }
	}

	async function startFromSeed(seed: JourneySeed): Promise<void> {
		const seq = ++navSeq;
		try {
			setError(null);
			const j = await journeyApi.create(seed);
			if (seq !== navSeq) return;
			const nodeId = j.journey.currentNodeId;
			props.onNavigate?.({ journeyId: j.journey.id, nodeId, label: nodeTitle(j, nodeId) ?? j.journey.name });
			setJourney(j);
			await applyJump(j.journey.id, nodeId);
			void loadList();
		} catch (err) { fail('Starting journey failed')(err); }
	}

	// Neighbor hop: appends a node (forking from an interior node) and moves
	// the pointer. The node id exists only once the KB answers, so the
	// navigation is reported then — still before anything paints.
	async function navigateTo(entityId: string): Promise<void> {
		const j = journey();
		if (!j) return;
		const seq = ++navSeq;
		try {
			setError(null);
			const res = await journeyApi.navigate(j.journey.id, entityId);
			const jj = await journeyApi.get(j.journey.id);
			if (seq !== navSeq) return;
			props.onNavigate?.({ journeyId: j.journey.id, nodeId: res.node.id, label: res.node.titleSnapshot });
			if (jj) setJourney(jj);
			setDetail(res.entity);
		} catch (err) { fail('Navigate failed')(err); }
	}

	// Breadcrumb click — jump back along the branch (no fork).
	async function jumpTo(nodeId: string): Promise<void> {
		const j = journey();
		if (!j) return;
		props.onNavigate?.({ journeyId: j.journey.id, nodeId, label: nodeTitle(j, nodeId) ?? j.journey.name });
		await applyJump(j.journey.id, nodeId);
	}

	function showList(): void {
		setMode('list');
		void loadList();
	}

	// History traversal onto a node — no onNavigate (the entry exists).
	async function openAt(journeyId: string, nodeId: string | null): Promise<boolean> {
		const cur = journey();
		// Already standing there (a mode-bar click back onto the open journey).
		if (mode() === 'entity' && cur?.journey.id === journeyId && (nodeId === null || cur.journey.currentNodeId === nodeId)) return true;
		const seq = ++navSeq;
		let j: JourneyDetail | null;
		try { j = await journeyApi.get(journeyId); } catch { return false; }
		if (seq !== navSeq) return true;
		if (!j) return false;
		const target = nodeId ?? j.journey.currentNodeId;
		if (!j.nodes.some((n) => n.id === target)) return false;
		setJourney(j);
		return applyJump(journeyId, target);
	}

	async function expandAspect(aspect: KbAspect): Promise<void> {
		const d = detail();
		if (!d) return;
		setBusyAspect(aspect);
		try {
			setError(null);
			await kbApi.expand(d.entity.id, aspect);
			// Structured aspects landed their first page synchronously; agent
			// aspects are 'running' and stream via kb:event. Either way the
			// stored state (statuses + any new edges) is what we render.
			await refreshDetail();
		} catch (err) {
			fail('Expand failed')(err);
			await refreshDetail().catch(() => {});
		} finally {
			setBusyAspect(null);
		}
	}

	async function promoteTrack(entityId: string): Promise<void> {
		try {
			await kbApi.promote(entityId);
			props.onToast('Added to library', 'success', 'Pinned as Interested');
			await refreshDetail();
		} catch (err) { fail('Promote failed')(err); }
	}

	// Live updates: background provider pages + research results landing for
	// the entity being viewed. Cheap full-detail refetch — v1 simplicity.
	const unsubscribe = kbApi.onEvent((e) => {
		const d = detail();
		if (!d || mode() !== 'entity') return;
		if (e.kind === 'expansion' && e.entityId === d.entity.id) void refreshDetail();
		if (e.kind === 'entity-updated' && e.entityId === d.entity.id) void refreshDetail();
	});

	function aspectStatus(aspect: KbAspect): { label: string; cls: string } {
		const d = detail();
		if (!d) return { label: '', cls: '' };
		if (busyAspect() === aspect) return { label: 'fetching…', cls: 'is-busy' };
		const states = d.expansions.filter((s) => s.aspect === aspect);
		const tier = d.availableAspects.find((a) => a.aspect === aspect)?.tier;
		if (states.some((s) => s.status === 'running')) {
			return { label: tier === 'agent' ? 'researching…' : 'fetching…', cls: 'is-busy' };
		}
		if (states.some((s) => s.status === 'complete')) return { label: '✓', cls: 'is-done' };
		if (states.some((s) => s.status === 'partial' || s.status === 'pending')) return { label: 'partial — continue', cls: '' };
		if (states.some((s) => s.status === 'error')) return { label: 'failed — retry', cls: 'is-error' };
		return { label: '', cls: '' };
	}

	const Root = () => (
		<div class="journey-root">
			<Show when={mode() === 'list'}>
				<div class="journey-list">
					<div class="journey-list-head">
						<span class="journey-title">Journeys</span>
					</div>
					<Show when={journeys().length === 0}>
						<div class="journey-empty">
							No journeys yet. Right-click any track and choose <b>Start Journey</b> to begin exploring
							from it — artists, releases, labels, and researched similar artists, with a forkable trail
							you can resume any time.
						</div>
					</Show>
					<For each={journeys()}>{(j) => (
						<div class="journey-row" onClick={() => void openJourney(j.id)}>
							<div class="journey-row-main">
								<span class="journey-row-name">{j.name}</span>
								<span class="journey-row-sub">{j.nodeCount} stops · at {j.currentEntityName} · {fmtWhen(j.updatedAt)}</span>
							</div>
							<button
								class="journey-row-btn"
								title="Rename"
								onClick={(e) => {
									e.stopPropagation();
									const name = window.prompt('Journey name', j.name);
									if (name && name.trim()) {
										void journeyApi.rename(j.id, name.trim()).then(loadList);
									}
								}}
							>✎</button>
							<button
								class="journey-row-btn is-danger"
								title="Delete journey"
								onClick={(e) => {
									e.stopPropagation();
									if (window.confirm(`Delete journey "${j.name}"? The knowledge it gathered stays.`)) {
										void journeyApi.remove(j.id).then(loadList);
									}
								}}
							>✕</button>
						</div>
					)}</For>
				</div>
			</Show>
			<Show when={mode() === 'entity' && detail()}>
				<div class="journey-entity">
					<div class="journey-nav">
						<button class="journey-back" onClick={() => { props.onNavigate?.({ journeyId: null, nodeId: null, label: 'Journeys' }); showList(); }}>‹ Journeys</button>
						<span class="journey-name" title={journey()?.journey.name}>{journey()?.journey.name}</span>
					</div>
					<div class="journey-path">
						<For each={journey() ? pathToCurrent(journey()!) : []}>{(node, i) => (
							<>
								<Show when={i() > 0}><span class="journey-path-sep">›</span></Show>
								<button
									class="journey-crumb"
									classList={{ 'is-current': node.id === journey()?.journey.currentNodeId }}
									title={`${node.entityKind} · jump here (navigating on will fork a new branch)`}
									onClick={() => { if (node.id !== journey()?.journey.currentNodeId) void jumpTo(node.id); }}
								>{node.titleSnapshot}</button>
							</>
						)}</For>
					</div>
					<div class="journey-entity-head">
						<span class={`journey-kind kind-${detail()!.entity.kind}`}>{detail()!.entity.kind}</span>
						<span class="journey-entity-name">{detail()!.entity.name}</span>
						<Show when={detail()!.inLibrary[detail()!.entity.id]}>
							<span class="journey-chip in-library">In Library</span>
						</Show>
						<Show when={detail()!.entity.kind === 'track' && !detail()!.inLibrary[detail()!.entity.id]}>
							<button class="journey-interested" onClick={() => void promoteTrack(detail()!.entity.id)}>Interested</button>
						</Show>
					</div>
					<div class="journey-aspects">
						<For each={detail()!.availableAspects}>{(a) => {
							const st = () => aspectStatus(a.aspect);
							return (
								<button
									class={`journey-aspect ${st().cls}`}
									disabled={busyAspect() !== null || st().cls === 'is-busy'}
									onClick={() => void expandAspect(a.aspect)}
								>
									{ASPECT_LABELS[a.aspect]}
									<Show when={a.tier === 'agent'}><span class="journey-research-mark" title="Agent research (web-cited)">✦</span></Show>
									<Show when={st().label}><span class="journey-aspect-status">{st().label}</span></Show>
								</button>
							);
						}}</For>
						<Show when={detail()!.entity.kind === 'artist' && !detail()!.availableAspects.some((a) => a.aspect === 'similar-artists')}>
							<span class="journey-aspect is-unavailable" title="Set ANTHROPIC_API_KEY and build apps/researcher to enable agent research">
								Similar artists — research unavailable
							</span>
						</Show>
					</div>
					<Show when={error()}><div class="journey-error">{error()}</div></Show>
					<div class="journey-sections">
						<Show when={sectionsOf(detail()!).length === 0}>
							<div class="journey-empty">Nothing known yet — expand an aspect above to fetch.</div>
						</Show>
						<For each={sectionsOf(detail()!)}>{(section) => (
							<div class="journey-section">
								<div class="journey-section-title">
									{section.title}
									<Show when={section.research}><span class="journey-research-mark" title="Agent research — cited claims, not catalog facts">✦ via research</span></Show>
								</div>
								<For each={section.rows}>{(row) => (
									<div class="journey-neighbor" onClick={() => void navigateTo(row.entity.id)}>
										<span class={`journey-kind kind-${row.entity.kind}`}>{row.entity.kind}</span>
										<span class="journey-neighbor-name">{row.entity.name}</span>
										<Show when={row.entity.releaseDate}><span class="journey-neighbor-sub">{row.entity.releaseDate}</span></Show>
										<Show when={section.research}>
											<span class="journey-confidence" title="Research confidence">{Math.round(row.edge.confidence * 100)}%</span>
											<Show when={row.edge.hardenedAt}><span class="journey-chip is-hardened" title="You've acted on this claim">confirmed</span></Show>
											<Show when={(row.edge.attrs?.['citations'] as string[] | undefined)?.length}>
												<span class="journey-citations">
													<For each={(row.edge.attrs!['citations'] as string[]).slice(0, 3)}>{(url, i) => (
														<a
															href="#"
															title={url}
															onClick={(e) => { e.preventDefault(); e.stopPropagation(); void shellApi.openExternal(url); }}
														>[{i() + 1}]</a>
													)}</For>
												</span>
											</Show>
										</Show>
										<Show when={detail()!.inLibrary[row.entity.id]}>
											<span class="journey-chip in-library">In Library</span>
										</Show>
										<Show when={row.entity.kind === 'track' && !detail()!.inLibrary[row.entity.id]}>
											<button
												class="journey-interested"
												onClick={(e) => { e.stopPropagation(); void promoteTrack(row.entity.id); }}
											>Interested</button>
										</Show>
									</div>
								)}</For>
							</div>
						)}</For>
					</div>
				</div>
			</Show>
		</div>
	);

	const dispose = render(() => {
		onCleanup(() => unsubscribe());
		return <Root />;
	}, host);
	void loadList();

	return {
		destroy: () => dispose(),
		refresh: () => { if (mode() === 'list') void loadList(); },
		openJourney: (journeyId) => { void openJourney(journeyId); },
		startFromSeed,
		openAt,
		showList,
		getLocation: () => {
			const j = journey();
			return mode() === 'entity' && j ? { journeyId: j.journey.id, nodeId: j.journey.currentNodeId } : null;
		},
	};
}

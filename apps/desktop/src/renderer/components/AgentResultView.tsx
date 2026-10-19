// AgentResultView — renders an agent result set as a compact, playable
// track list in Discover's main area (the third Discover mode next to
// Feed/Journeys). Rows carry source badges (library / feed / kb / web),
// metadata chips, the agent's one-line note, and citation links. Rows with
// a Spotify play ref play through the same path feed cards use.

import { For, Show, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import type { AgentResultItem, AgentResultSet } from '@curator/core';
import { shellApi } from '../data/api.js';

export interface AgentResultViewProps {
	onPlay: (req: { sourceTrackId: string; title: string; artist: string; coverUrl: string | null; durationSec: number | null }) => void;
	onBackToFeed: () => void;
	onToast: (msg: string, kind: 'info' | 'error' | 'success', sub?: string) => void;
}

export interface AgentResultViewHandle {
	destroy(): void;
	show(rs: AgentResultSet): void;
	current(): AgentResultSet | null;
}

const BADGE_LABELS: Record<AgentResultItem['badge'], string> = {
	library: 'LIB',
	feed: 'FEED',
	kb: 'KB',
	web: 'WEB',
};

export function mountAgentResultView(host: HTMLElement, props: AgentResultViewProps): AgentResultViewHandle {
	const [resultSet, setResultSet] = createSignal<AgentResultSet | null>(null);

	const play = (item: AgentResultItem): void => {
		if (!item.playRef) return;
		props.onPlay({
			sourceTrackId: item.playRef.sourceTrackId,
			title: item.title,
			artist: item.artists.join(', '),
			coverUrl: item.meta?.coverUrl ?? null,
			durationSec: item.meta?.durationSec ?? null,
		});
	};

	const Row = (p: { item: AgentResultItem; index: number }) => {
		const it = p.item;
		return (
			<div class="agent-result-row">
				<button
					class="agent-result-row__play"
					disabled={!it.playRef}
					title={it.playRef ? 'Play' : 'Not playable (no streaming link)'}
					onClick={() => play(it)}
				>▶</button>
				<div class="agent-result-row__main">
					<div class="agent-result-row__line1">
						<span class="agent-result-row__title">{it.title}</span>
						<span class="agent-result-row__artists">{it.artists.join(', ')}</span>
					</div>
					<div class="agent-result-row__line2">
						<span class={`agent-result-row__badge agent-result-row__badge--${it.badge}`}>{BADGE_LABELS[it.badge]}</span>
						<Show when={it.meta?.bpm != null}><span class="agent-result-row__chip">{Math.round(it.meta!.bpm!)} BPM</span></Show>
						<Show when={it.meta?.keyCamelot}><span class="agent-result-row__chip">{it.meta!.keyCamelot}</span></Show>
						<Show when={it.meta?.genre}><span class="agent-result-row__chip">{it.meta!.genre}</span></Show>
						<Show when={it.meta?.label}><span class="agent-result-row__chip">{it.meta!.label}</span></Show>
						<Show when={it.meta?.releaseDate}><span class="agent-result-row__chip">{it.meta!.releaseDate}</span></Show>
						<Show when={it.note}><span class="agent-result-row__note" title={it.note}>{it.note}</span></Show>
					</div>
				</div>
				<div class="agent-result-row__links">
					<Show when={it.providerRef?.url}>
						<a class="agent-result-row__cite" title={it.providerRef!.url}
							onClick={(e) => { e.preventDefault(); void shellApi.openExternal(it.providerRef!.url!); }}>↗</a>
					</Show>
					<For each={it.citations ?? []}>{(c) => (
						<a class="agent-result-row__cite" title={c.note ? `${c.note}\n${c.url}` : c.url}
							onClick={(e) => { e.preventDefault(); void shellApi.openExternal(c.url); }}>※</a>
					)}</For>
				</div>
			</div>
		);
	};

	const View = () => (
		<Show when={resultSet()} fallback={<div class="agent-result-empty">No agent result list loaded.</div>}>
			<div class="agent-result-root">
				<div class="agent-result-toolbar">
					<button class="feed-toolbar__refresh" onClick={props.onBackToFeed}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
						Feed
					</button>
					<span class="agent-result-toolbar__title">{resultSet()!.title}</span>
					<span class="agent-result-toolbar__count">{resultSet()!.items.length} items · via agent</span>
				</div>
				<Show when={resultSet()!.summary}>
					<div class="agent-result-summary">{resultSet()!.summary}</div>
				</Show>
				<div class="agent-result-scroll">
					<For each={resultSet()!.items}>{(item, i) => <Row item={item} index={i()} />}</For>
				</div>
			</div>
		</Show>
	);

	const dispose = render(() => <View />, host);
	return {
		destroy: () => dispose(),
		show: (rs) => setResultSet(rs),
		current: () => resultSet(),
	};
}

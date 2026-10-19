// AgentPanel — the docked conversational agent surface inside Discover.
//
// The transcript is a sequence of TYPED BLOCKS, not a text stream: streamed
// markdown-lite text, live tool-activity chips, result-set cards (click →
// the main area jumps to the agent-results list), source links, errors.
// Blocks derive from the 'agent:event' push; text deltas are buffered and
// flushed once per animation frame so token streaming never thrashes the
// DOM. BYOK setup (provider / key / model roles) is embedded as a card —
// shown when unconfigured, toggleable via the gear.

import { For, Show, createSignal, onCleanup } from 'solid-js';
import { render } from 'solid-js/web';
import type { AgentEvent, AgentResultSet, AgentRunUsage, AgentSessionSummary, AgentStatus, AgentProvider, AgentViewCommand, AgentViewContext } from '@curator/core';
import type { AgentConfigRedacted } from '../../ipc.js';
import { shellApi } from '../data/api.js';
import { agentApi } from '../data/agent.js';

export interface AgentPanelProps {
	onToast: (msg: string, kind: 'info' | 'error' | 'success', sub?: string) => void;
	// A result set arrived (live) or was reopened from a card — the main
	// Discover area should switch to the agent-results list.
	onResultSet: (rs: AgentResultSet) => void;
	// The agent asked to change the visible feed filters.
	onViewCommand: (cmd: AgentViewCommand) => void;
	// Snapshot of where the user is standing, captured at send time and
	// attached to the turn so ambiguous asks scope to the current view.
	getViewContext?: () => AgentViewContext | null;
}

export interface AgentPanelHandle {
	destroy(): void;
}

type AgentBlock =
	| { type: 'user'; text: string }
	| { type: 'text'; text: string }
	| { type: 'tool'; callId: string; tool: string; label: string; status: 'running' | 'ok' | 'error'; summary: string }
	| { type: 'sources'; urls: { url: string; title?: string }[] }
	| { type: 'result-set'; id: string; title: string; itemCount: number; rs?: AgentResultSet }
	| { type: 'error'; message: string };

// Human labels for tool chips.
const TOOL_LABELS: Record<string, string> = {
	query_library: 'Searching library',
	get_library_facets: 'Reading library facets',
	get_track_detail: 'Reading track',
	query_feed: 'Searching feed',
	get_feed_item: 'Expanding feed item',
	search_kb: 'Searching knowledge base',
	get_kb_entity: 'Reading knowledge base',
	expand_kb_entity: 'Expanding knowledge',
	search_spotify: 'Searching Spotify',
	lookup_beatport: 'Looking up Beatport',
	web_search: 'Searching the web',
	web_fetch: 'Reading a page',
	present_result_set: 'Building result list',
	update_feed_filters: 'Updating feed filters',
};

const PROVIDER_DEFAULTS: Record<AgentProvider, { routerModel: string; researchModel: string }> = {
	anthropic: { routerModel: 'claude-haiku-4-5', researchModel: 'claude-sonnet-4-6' },
	openai: { routerModel: 'gpt-5-mini', researchModel: 'gpt-5' },
	deepseek: { routerModel: 'deepseek-chat', researchModel: 'deepseek-chat' },
	'openai-compatible': { routerModel: '', researchModel: '' },
};

export function mountAgentPanel(host: HTMLElement, props: AgentPanelProps): AgentPanelHandle {
	const [status, setStatus] = createSignal<AgentStatus | null>(null);
	const [sessions, setSessions] = createSignal<AgentSessionSummary[]>([]);
	const [sessionId, setSessionId] = createSignal<string | null>(null);
	const [blocks, setBlocks] = createSignal<AgentBlock[]>([]);
	const [input, setInput] = createSignal('');
	const [running, setRunning] = createSignal(false);
	const [turnMeta, setTurnMeta] = createSignal<{ mode: string; model: string } | null>(null);
	const [lastUsage, setLastUsage] = createSignal<AgentRunUsage | null>(null);
	const [showSettings, setShowSettings] = createSignal(false);
	// Settings form state.
	const [cfgProvider, setCfgProvider] = createSignal<AgentProvider>('anthropic');
	const [cfgBaseUrl, setCfgBaseUrl] = createSignal('');
	const [cfgKey, setCfgKey] = createSignal('');
	const [cfgHasKey, setCfgHasKey] = createSignal(false);
	const [cfgRouterModel, setCfgRouterModel] = createSignal(PROVIDER_DEFAULTS.anthropic.routerModel);
	const [cfgResearchModel, setCfgResearchModel] = createSignal(PROVIDER_DEFAULTS.anthropic.researchModel);
	const [cfgSaving, setCfgSaving] = createSignal(false);

	let scrollEl: HTMLDivElement | undefined;
	const scrollToBottom = (): void => {
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	};

	// Per-frame text-delta batching: deltas accumulate here; one rAF flush
	// appends them to the trailing text block.
	let pendingText = '';
	let flushScheduled = false;
	const flushText = (): void => {
		flushScheduled = false;
		if (!pendingText) return;
		const text = pendingText;
		pendingText = '';
		setBlocks((prev) => {
			const last = prev[prev.length - 1];
			if (last && last.type === 'text') {
				return [...prev.slice(0, -1), { type: 'text', text: last.text + text }];
			}
			return [...prev, { type: 'text', text }];
		});
		scrollToBottom();
	};
	const queueText = (text: string): void => {
		pendingText += text;
		if (!flushScheduled) {
			flushScheduled = true;
			requestAnimationFrame(flushText);
		}
	};

	const appendBlock = (block: AgentBlock): void => {
		flushText();
		setBlocks((prev) => [...prev, block]);
		scrollToBottom();
	};

	const refreshStatus = async (): Promise<void> => {
		try {
			setStatus(await agentApi.status());
		} catch {
			setStatus({ state: 'disabled' });
		}
	};

	const loadConfigForm = async (): Promise<void> => {
		try {
			const cfg: AgentConfigRedacted | null = await agentApi.getConfig();
			if (!cfg) return;
			setCfgProvider(cfg.provider);
			setCfgBaseUrl(cfg.baseUrl ?? '');
			setCfgRouterModel(cfg.routerModel);
			setCfgResearchModel(cfg.researchModel);
			setCfgHasKey(cfg.hasKey);
		} catch { /* unconfigured */ }
	};

	const loadSessions = async (): Promise<void> => {
		try {
			setSessions(await agentApi.listSessions());
		} catch { /* agent disabled */ }
	};

	const openSession = async (id: string | null): Promise<void> => {
		setSessionId(id);
		setBlocks([]);
		setLastUsage(null);
		if (!id) return;
		try {
			const detail = await agentApi.getSession(id);
			if (!detail) return;
			const rebuilt: AgentBlock[] = [];
			// Interleave turns and result sets chronologically.
			const events: { at: number; block: AgentBlock }[] = [
				...detail.turns.map((t) => ({
					at: t.createdAt,
					block: (t.role === 'user' ? { type: 'user' as const, text: t.text } : { type: 'text' as const, text: t.text }),
				})),
				...detail.resultSets.map((rs) => ({
					at: rs.createdAt,
					block: { type: 'result-set' as const, id: rs.id, title: rs.title, itemCount: rs.itemCount },
				})),
			];
			events.sort((a, b) => a.at - b.at);
			for (const e of events) rebuilt.push(e.block);
			setBlocks(rebuilt);
			requestAnimationFrame(scrollToBottom);
		} catch (err) {
			props.onToast('Failed to load session', 'error', err instanceof Error ? err.message : String(err));
		}
	};

	const send = async (): Promise<void> => {
		const text = input().trim();
		if (text.length === 0 || running()) return;
		setInput('');
		appendBlock({ type: 'user', text });
		setRunning(true);
		try {
			const context = props.getViewContext?.() ?? null;
			const res = await agentApi.send({
				...(sessionId() ? { sessionId: sessionId()! } : {}),
				text,
				...(context ? { context } : {}),
			});
			setSessionId(res.sessionId);
			void loadSessions();
		} catch (err) {
			setRunning(false);
			appendBlock({ type: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	};

	const stop = (): void => {
		const id = sessionId();
		if (id) void agentApi.cancel(id);
	};

	const saveConfig = async (): Promise<void> => {
		setCfgSaving(true);
		try {
			const next = await agentApi.setConfig({
				provider: cfgProvider(),
				...(cfgProvider() === 'openai-compatible' && cfgBaseUrl().trim() ? { baseUrl: cfgBaseUrl().trim() } : {}),
				...(cfgKey().trim() ? { apiKey: cfgKey().trim() } : {}),
				routerModel: cfgRouterModel().trim(),
				researchModel: cfgResearchModel().trim(),
			});
			setStatus(next);
			setCfgKey('');
			if (next.state === 'ready' || next.state === 'running') {
				setCfgHasKey(true);
				setShowSettings(false);
				props.onToast('Agent configured', 'success');
			} else {
				props.onToast('Saved — enter an API key to activate', 'info');
			}
		} catch (err) {
			props.onToast('Failed to save agent config', 'error', err instanceof Error ? err.message : String(err));
		} finally {
			setCfgSaving(false);
		}
	};

	const onEvent = (e: AgentEvent): void => {
		if (e.kind === 'error' && !('turnId' in e && e.turnId)) {
			// Session-independent failure — always surface.
			appendBlock({ type: 'error', message: e.message });
			return;
		}
		if (e.sessionId !== sessionId()) return;
		switch (e.kind) {
			case 'turn-started':
				setTurnMeta({ mode: e.mode, model: e.model });
				break;
			case 'text-delta':
				queueText(e.text);
				break;
			case 'reasoning-delta':
				break; // not rendered in v1 — tool chips carry the "working" signal
			case 'tool-started':
				appendBlock({
					type: 'tool',
					callId: e.callId,
					tool: e.tool,
					label: TOOL_LABELS[e.tool] ?? e.tool,
					status: 'running',
					summary: e.label,
				});
				break;
			case 'tool-finished':
				flushText();
				setBlocks((prev) => prev.map((b) =>
					b.type === 'tool' && b.callId === e.callId
						? { ...b, status: e.ok ? 'ok' : 'error', summary: e.summary }
						: b));
				break;
			case 'source':
				flushText();
				setBlocks((prev) => {
					const last = prev[prev.length - 1];
					if (last && last.type === 'sources') {
						if (last.urls.some((u) => u.url === e.url)) return prev;
						return [...prev.slice(0, -1), { type: 'sources', urls: [...last.urls, { url: e.url, ...(e.title ? { title: e.title } : {}) }] }];
					}
					return [...prev, { type: 'sources', urls: [{ url: e.url, ...(e.title ? { title: e.title } : {}) }] }];
				});
				break;
			case 'result-set':
				appendBlock({ type: 'result-set', id: e.resultSet.id, title: e.resultSet.title, itemCount: e.resultSet.items.length, rs: e.resultSet });
				props.onResultSet(e.resultSet);
				break;
			case 'view-command':
				props.onViewCommand(e.command);
				break;
			case 'turn-finished':
				flushText();
				setRunning(false);
				setLastUsage(e.usage);
				if (e.stopReason === 'max-steps') {
					appendBlock({ type: 'error', message: 'Stopped at the step budget — ask to continue for more.' });
				}
				void refreshStatus();
				break;
			case 'error':
				appendBlock({ type: 'error', message: e.message });
				break;
		}
	};

	const unsubEvents = agentApi.onEvent(onEvent);
	void refreshStatus().then(() => {
		void loadConfigForm();
		void loadSessions();
	});

	const openResultSetCard = async (block: Extract<AgentBlock, { type: 'result-set' }>): Promise<void> => {
		if (block.rs) { props.onResultSet(block.rs); return; }
		try {
			const rs = await agentApi.getResultSet(block.id);
			if (rs) props.onResultSet(rs);
			else props.onToast('Result list no longer exists', 'error');
		} catch (err) {
			props.onToast('Failed to load result list', 'error', err instanceof Error ? err.message : String(err));
		}
	};

	const applyProviderDefaults = (p: AgentProvider): void => {
		setCfgProvider(p);
		const d = PROVIDER_DEFAULTS[p];
		setCfgRouterModel(d.routerModel);
		setCfgResearchModel(d.researchModel);
	};

	const SettingsCard = () => (
		<div class="agent-settings">
			<div class="agent-settings__title">Agent setup (bring your own key)</div>
			<label class="agent-settings__row">
				<span>Provider</span>
				<select value={cfgProvider()} onChange={(e) => applyProviderDefaults(e.currentTarget.value as AgentProvider)}>
					<option value="anthropic">Anthropic</option>
					<option value="openai">OpenAI</option>
					<option value="deepseek">DeepSeek</option>
					<option value="openai-compatible">OpenAI-compatible endpoint</option>
				</select>
			</label>
			<Show when={cfgProvider() === 'openai-compatible'}>
				<label class="agent-settings__row">
					<span>Base URL</span>
					<input type="text" placeholder="https://…/v1" value={cfgBaseUrl()} onInput={(e) => setCfgBaseUrl(e.currentTarget.value)} />
				</label>
			</Show>
			<label class="agent-settings__row">
				<span>API key</span>
				<input type="password" placeholder={cfgHasKey() ? '•••••• (stored — leave blank to keep)' : 'paste key'}
					value={cfgKey()} onInput={(e) => setCfgKey(e.currentTarget.value)} />
			</label>
			<label class="agent-settings__row">
				<span>Quick model</span>
				<input type="text" title="Cheap/fast model: routing + filter-style turns" value={cfgRouterModel()} onInput={(e) => setCfgRouterModel(e.currentTarget.value)} />
			</label>
			<label class="agent-settings__row">
				<span>Research model</span>
				<input type="text" title="Capable model: multi-step research turns" value={cfgResearchModel()} onInput={(e) => setCfgResearchModel(e.currentTarget.value)} />
			</label>
			<div class="agent-settings__actions">
				<button disabled={cfgSaving() || !cfgRouterModel().trim() || !cfgResearchModel().trim() || (!cfgHasKey() && !cfgKey().trim())}
					onClick={() => void saveConfig()}>
					{cfgSaving() ? 'Saving…' : 'Save'}
				</button>
				<Show when={status()?.state === 'ready' || status()?.state === 'running'}>
					<button class="agent-settings__cancel" onClick={() => setShowSettings(false)}>Close</button>
				</Show>
			</div>
			<div class="agent-settings__hint">
				The key is encrypted with your OS account (never leaves this machine, never enters any database).
			</div>
		</div>
	);

	const BlockView = (p: { block: AgentBlock }) => {
		const b = p.block;
		switch (b.type) {
			case 'user':
				return <div class="agent-block agent-block--user">{b.text}</div>;
			case 'text':
				return <div class="agent-block agent-block--text">{b.text}</div>;
			case 'tool':
				return (
					<div class={`agent-chip agent-chip--${b.status}`} title={b.summary}>
						<span class="agent-chip__icon">{b.status === 'running' ? '⟳' : b.status === 'ok' ? '✓' : '✗'}</span>
						{b.label}
						<Show when={b.status !== 'running' && b.summary}><span class="agent-chip__summary"> · {b.summary}</span></Show>
					</div>
				);
			case 'sources':
				return (
					<div class="agent-sources">
						<For each={b.urls}>{(u) => (
							<a class="agent-sources__link" title={u.url} onClick={(e) => { e.preventDefault(); void shellApi.openExternal(u.url); }}>
								{u.title ?? new URL(u.url).hostname}
							</a>
						)}</For>
					</div>
				);
			case 'result-set':
				return (
					<button class="agent-result-card" onClick={() => void openResultSetCard(b)}>
						<span class="agent-result-card__title">{b.title}</span>
						<span class="agent-result-card__count">{b.itemCount} items — click to view</span>
					</button>
				);
			case 'error':
				return <div class="agent-block agent-block--error">{b.message}</div>;
		}
	};

	const View = () => (
		<div class="agent-panel">
			<div class="agent-panel__header">
				<select class="agent-panel__session" value={sessionId() ?? ''}
					onChange={(e) => void openSession(e.currentTarget.value || null)}>
					<option value="">New conversation</option>
					<For each={sessions()}>{(s) => <option value={s.id}>{s.title}</option>}</For>
				</select>
				<Show when={sessionId()}>
					<button class="agent-panel__iconbtn" title="Delete conversation" onClick={() => {
						const id = sessionId();
						if (!id || !window.confirm('Delete this conversation and its result lists?')) return;
						void agentApi.deleteSession(id).then(() => { void loadSessions(); void openSession(null); });
					}}>🗑</button>
				</Show>
				<button class="agent-panel__iconbtn" title="Agent settings" onClick={() => setShowSettings(!showSettings())}>⚙</button>
			</div>
			<Show when={status()?.state === 'disabled'}>
				<div class="agent-panel__disabled">
					Agent unavailable — build the sidecar (<code>pnpm --filter @curator/agent build</code>) and restart.
				</div>
			</Show>
			<Show when={status()?.state === 'unconfigured' || showSettings()}>
				<SettingsCard />
			</Show>
			<div class="agent-panel__scroll" ref={scrollEl}>
				<Show when={blocks().length === 0 && (status()?.state === 'ready' || status()?.state === 'running')}>
					<div class="agent-panel__empty">
						Ask about your library, the feed, or music to discover — e.g.
						<em>“new releases from Berlin labels that worked with Max Cooper, past 14 days”</em>
					</div>
				</Show>
				<For each={blocks()}>{(b) => <BlockView block={b} />}</For>
				<Show when={running()}>
					<div class="agent-panel__working">
						{turnMeta() ? `working — ${turnMeta()!.mode} · ${turnMeta()!.model}` : 'working…'}
					</div>
				</Show>
			</div>
			<div class="agent-panel__inputrow">
				<textarea
					class="agent-panel__input"
					placeholder="Ask the agent…"
					value={input()}
					disabled={status()?.state !== 'ready' && status()?.state !== 'running'}
					onInput={(e) => setInput(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
					}}
				/>
				<Show when={running()} fallback={
					<button class="agent-panel__send" disabled={input().trim().length === 0 || status()?.state !== 'ready'} onClick={() => void send()}>Send</button>
				}>
					<button class="agent-panel__send agent-panel__send--stop" onClick={stop}>Stop</button>
				</Show>
			</div>
			<Show when={lastUsage()}>
				<div class="agent-panel__usage">
					{lastUsage()!.steps} steps · {(lastUsage()!.inputTokens / 1000).toFixed(1)}k in
					{lastUsage()!.cacheReadTokens > 0 ? ` (${(lastUsage()!.cacheReadTokens / 1000).toFixed(1)}k cached)` : ''} · {(lastUsage()!.outputTokens / 1000).toFixed(1)}k out
				</div>
			</Show>
		</div>
	);

	const dispose = render(() => <View />, host);
	onCleanup(() => { /* solid handles component-scope cleanup */ });
	return {
		destroy: () => {
			unsubEvents?.();
			dispose();
		},
	};
}

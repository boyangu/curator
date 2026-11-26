// ConnectDotsDialog — "Help us connect the dots". The Global Catalog knows an
// artist, a label or an album on some stores and not on others; here the user
// says which page is theirs on each store it lacks.
//
// One object at a time: what the catalogue holds of it (its stores, a few of
// its releases), then a section per missing store with the pages on offer —
// the catalogue's own undecided candidates and the search of the store — as
// radio rows: the page's picture, its name, how many follow it there, and
// what it shares with the catalogue. The stores are searched without the user
// asking, the next object's while this one is on screen, so the modal opens
// on pages to pick from. "None of these" and a pasted link are the way out
// when the right page is not among them. Approve sends the picks and moves on; Skip moves on and asks
// again another day. A store left untouched is not answered.
//
// What an approval does is the cloud's call (core catalog-client/connect.ts):
// attached at once when it can back the pick, otherwise sent to the
// catalogue's operator. The toast says which.
//
// One mounted instance, callback-based like ArtistMergeReviewDialog: open()
// for the user's queue, openFor(ids) for one object named from a menu.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { CatalogConnectAnswer, CatalogConnectAnswerResult, CatalogConnectCandidate, CatalogConnectItem, ConnectQueue, ConnectSearch, ConnectSubject } from '@curator/core';
import { brandIcon } from '../features/brandIcons.js';
import { providerLabel } from '../features/feedHandles.js';
import { registerModalOpenSignal } from '../modalGate.js';

export interface ConnectDotsProps {
	queue: (opts?: { limit?: number; objectIds?: string[]; exclude?: string[] }) => Promise<ConnectQueue>;
	search: (subject: ConnectSubject, provider: CatalogConnectCandidate['provider']) => Promise<ConnectSearch>;
	answer: (answers: CatalogConnectAnswer[]) => Promise<CatalogConnectAnswerResult>;
	openExternal: (url: string) => void;
	toast: (title: string, kind: 'success' | 'info' | 'error', sub?: string) => void;
	// The queue's size as last seen (the Discover button's count).
	onRemaining?: (n: number) => void;
}

export interface ConnectDotsHandle {
	destroy(): void;
	// The user's queue.
	open(): void;
	// Exactly these catalogue objects (an artist, a label or an album).
	openFor(objectIds: string[]): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

// A store's pick: one of the offered pages (its provider id), the pasted
// link, or that none of them is.
type Pick = { kind: 'page'; id: string } | { kind: 'paste' } | { kind: 'none' };

const PAGE = 20;
// A pick is pre-selected only on this much evidence: two titles the page
// shares with the catalogue (the cloud's own rule for backing an answer).
const PRESELECT_SHARED = 2;

const KIND_WORD: Record<string, string> = { artist: 'Artist', label: 'Label', release: 'Album' };
const NOTE: Record<NonNullable<ConnectSearch['note']>, string> = {
	no_search: 'Curator cannot search this store for it.',
	not_connected: 'Connect this service in Settings to see its pages here.',
	blocked: 'The store is turning searches away right now.',
	failed: 'The search did not answer.',
};

// 1,234 → "1.2K": the size of a following at a glance.
function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
	return String(n);
}
// Deezer calls them fans; everyone else followers.
const followersText = (c: CatalogConnectCandidate): string | null =>
	c.followers === null || c.followers === undefined ? null : `${compact(c.followers)} ${c.provider === 'deezer' ? (c.followers === 1 ? 'fan' : 'fans') : c.followers === 1 ? 'follower' : 'followers'}`;
const INVALID: Record<string, string> = {
	not_a_page_of_that_store: 'That link is not a page of this store.',
	store_not_asked: 'This store is not asked about here.',
	unknown_object: 'The catalogue no longer holds this one.',
};
const invalidText = (reason: string | undefined): string => {
	const kind = /^that_is_a_(\w+)_page$/.exec(reason ?? '')?.[1];
	if (kind) return `That is ${kind === 'artist' ? 'an artist' : kind === 'release' ? 'an album' : `a ${kind}`} page.`;
	return INVALID[reason ?? ''] ?? 'That link could not be used.';
};

const quoted = (titles: string[], n: number): string => titles.slice(0, n).map((t) => `“${t}”`).join(', ');

// The line under the name: the following and what the store says of the page.
const candidateMeta = (c: CatalogConnectCandidate): string => [followersText(c), c.detail].filter(Boolean).join(' · ') || c.url.replace(/^https?:\/\/(www\.)?/, '');
// The evidence line: what the page shares with the catalogue, else what it lists.
function candidateEvidence(c: CatalogConnectCandidate): string | null {
	if (c.shared?.length) return `Shares ${c.shared.length === 1 ? 'a release' : `${c.shared.length} releases`} with the catalogue: ${quoted(c.shared, 3)}`;
	return c.releases?.length ? `Lists ${quoted(c.releases, 3)}` : null;
}

export function mountConnectDotsDialog(host: HTMLElement, props: ConnectDotsProps): ConnectDotsHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [items, setItems] = createSignal<CatalogConnectItem[]>([]);
	const [total, setTotal] = createSignal(0);
	const [loading, setLoading] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	// For the object on screen, per store.
	const [searches, setSearches] = createSignal<Map<string, ConnectSearch | 'loading'>>(new Map());
	const [picks, setPicks] = createSignal<Map<string, Pick>>(new Map());
	const [pasted, setPasted] = createSignal<Map<string, string>>(new Map());
	const [refused, setRefused] = createSignal<Map<string, string>>(new Map());
	// Stores whose paste field the user opened.
	const [pasting, setPasting] = createSignal<Set<string>>(new Set());
	// Named objects (openFor), or null for the queue.
	let named: string[] | null = null;
	// Skipped this sitting: the queue would hand them straight back.
	const skipped = new Set<string>();
	let seq = 0;

	const current = (): CatalogConnectItem | undefined => items()[0];
	const set = <V,>(get: Accessor<Map<string, V>>, put: (m: Map<string, V>) => void, key: string, value: V | undefined): void => {
		const next = new Map(get());
		if (value === undefined) next.delete(key);
		else next.set(key, value);
		put(next);
	};

	// The pages on offer for a store: this device's search first (it carries
	// the picture and what the page shares), then the catalogue's own that the
	// search did not return.
	const offered = (item: CatalogConnectItem, provider: string): CatalogConnectCandidate[] => {
		const found = searches().get(provider);
		const mine = found && found !== 'loading' ? found.candidates : [];
		const cloud = item.missing.find((m) => m.provider === provider)?.candidates ?? [];
		return [...mine, ...cloud.filter((c) => !mine.some((m) => m.providerId === c.providerId))];
	};

	const subjectOf = (item: CatalogConnectItem): ConnectSubject => ({ kind: item.object.kind as ConnectSubject['kind'], name: item.object.name, titles: item.titles, detail: item.detail });

	const show = (item: CatalogConnectItem | undefined): void => {
		setSearches(new Map());
		setPicks(new Map());
		setPasted(new Map());
		setRefused(new Map());
		setPasting(new Set<string>());
		if (!item) return;
		const my = seq;
		const subject = subjectOf(item);
		// The next object's stores are searched now, so its pages are there
		// when it comes up (core keeps each search's answer).
		const next = items()[items().indexOf(item) + 1];
		if (next) for (const m of next.missing) void props.search(subjectOf(next), m.provider).catch(() => {});
		for (const m of item.missing) {
			set(searches, setSearches, m.provider, 'loading');
			props.search(subject, m.provider)
				.catch((): ConnectSearch => ({ provider: m.provider, candidates: [], searchUrl: null, note: 'failed' }))
				.then((r) => {
					if (my !== seq || current()?.object.id !== item.object.id) return;
					set(searches, setSearches, m.provider, r);
					const sure = r.candidates.filter((c) => (c.shared?.length ?? 0) >= PRESELECT_SHARED);
					if (sure.length === 1 && !picks().has(m.provider)) set(picks, setPicks, m.provider, { kind: 'page', id: sure[0]!.providerId });
				});
		}
	};

	const load = (): void => {
		const my = ++seq;
		setLoading(true);
		setError(null);
		// The queue's next page leaves out what was skipped this sitting, so a
		// page of skipped objects does not end the sitting.
		props.queue(named ? { objectIds: named } : { limit: PAGE, exclude: [...skipped] })
			.then((r) => {
				if (my !== seq) return;
				const list = r.items.filter((i) => !skipped.has(i.object.id));
				setItems(list);
				setTotal(named ? list.length : Math.max(0, r.total - skipped.size));
				if (!named) props.onRemaining?.(r.total);
				show(list[0]);
			})
			.catch((err) => { if (my === seq) setError(err instanceof Error ? err.message : String(err)); })
			.finally(() => { if (my === seq) setLoading(false); });
	};

	const begin = (ids: string[] | null): void => {
		named = ids;
		skipped.clear();
		setItems([]);
		setTotal(0);
		setIsOpen(true);
		load();
	};
	const close = (): void => {
		if (!isOpen()) return;
		seq++;
		setIsOpen(false);
	};

	// The next object; a fresh page of the queue when this one ran out.
	const advance = (): void => {
		const rest = items().slice(1);
		setItems(rest);
		setTotal(Math.max(0, total() - 1));
		if (rest.length) show(rest[0]);
		else if (!named && total() > 0) load();
		else show(undefined);
	};

	const skip = (): void => {
		const item = current();
		if (!item || busy()) return;
		skipped.add(item.object.id);
		advance();
	};

	const approve = async (): Promise<void> => {
		const item = current();
		if (!item || busy()) return;
		const answers: CatalogConnectAnswer[] = [];
		for (const m of item.missing) {
			const pick = picks().get(m.provider);
			if (!pick) continue;
			if (pick.kind === 'none') answers.push({ objectId: item.object.id, provider: m.provider, verdict: 'none' });
			else if (pick.kind === 'paste') {
				const url = pasted().get(m.provider)?.trim();
				if (!url) { set(refused, setRefused, m.provider, 'Paste the page’s link first.'); return; }
				answers.push({ objectId: item.object.id, provider: m.provider, verdict: 'is', url, source: 'pasted' });
			} else {
				const c = offered(item, m.provider).find((x) => x.providerId === pick.id);
				if (c) answers.push({ objectId: item.object.id, provider: m.provider, verdict: 'is', url: c.url, name: c.name, source: c.source, ...(c.releases?.length ? { releases: c.releases } : {}) });
			}
		}
		if (!answers.length) return;
		setBusy(true);
		setError(null);
		try {
			const { results } = await props.answer(answers);
			const bad = new Map<string, string>();
			results.forEach((r, i) => { if (r.outcome === 'invalid') bad.set(answers[i]!.provider, invalidText(r.reason)); });
			const n = (o: string) => results.filter((r) => r.outcome === o).length;
			const said = [
				n('attached') + n('already') ? `${n('attached') + n('already')} connected` : null,
				n('waiting') ? `${n('waiting')} sent for review` : null,
				n('conflict') ? `${n('conflict')} already another’s page (sent for review)` : null,
			].filter(Boolean).join(' · ');
			if (said) props.toast(n('attached') ? 'Connected' : 'Thanks', n('attached') ? 'success' : 'info', `${item.object.name}: ${said}`);
			// A refused link keeps the object on screen, with the reason beside it.
			if (bad.size) { setRefused(bad); return; }
			advance();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
		else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); e.stopPropagation(); void approve(); }
		else if ((e.key === 's' || e.key === 'S') && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); skip(); }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const ExternalIcon = () => (
		<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.5H2.5v7h7V7" /><path d="M7 2h3v3" /><path d="M10 2 5.5 6.5" /></svg>
	);

	const store = (item: CatalogConnectItem, provider: string) => {
		const pick = () => picks().get(provider);
		const found = () => searches().get(provider);
		const result = () => { const f = found(); return f && f !== 'loading' ? f : null; };
		// The paste field is there when asked for, or when there is nothing to pick.
		const showPaste = (): boolean => pasting().has(provider) || pick()?.kind === 'paste' || (!!result() && !offered(item, provider).length);
		const choose = (p: Pick): void => {
			set(picks, setPicks, provider, p);
			set(refused, setRefused, provider, undefined);
		};
		return (
			<section class="connect-dots__store">
				<header class="connect-dots__store-head">
					<span class="connect-dots__brand" innerHTML={brandIcon(provider) ?? ''} />
					<span class="connect-dots__store-name">{providerLabel(provider)}</span>
					<Show when={found() === 'loading'}><span class="connect-dots__hint">Looking…</span></Show>
				</header>
				<For each={offered(item, provider)}>{(c) => (
					<label class="connect-dots__option" classList={{ 'is-picked': pick()?.kind === 'page' && (pick() as { id: string }).id === c.providerId }}>
						<input type="radio" name={`connect-${provider}`} checked={pick()?.kind === 'page' && (pick() as { id: string }).id === c.providerId} onChange={() => choose({ kind: 'page', id: c.providerId })} />
						<Show when={c.imageUrl} fallback={<span class="connect-dots__img" />}>
							<img class="connect-dots__img" src={c.imageUrl!} alt="" loading="lazy" />
						</Show>
						<span class="connect-dots__text">
							<span class="connect-dots__name" title={c.name}>{c.name}</span>
							<span class="connect-dots__meta">{candidateMeta(c)}</span>
							<Show when={candidateEvidence(c)}><span class="connect-dots__sub" classList={{ 'is-shared': !!c.shared?.length }}>{candidateEvidence(c)}</span></Show>
						</span>
						<button type="button" class="following-icon" title="Open the page" aria-label={`Open ${c.name} on ${providerLabel(provider)}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); props.openExternal(c.url); }}><ExternalIcon /></button>
					</label>
				)}</For>
				<Show when={result() && !offered(item, provider).length}>
					<div class="connect-dots__hint">
						{result()!.note ? NOTE[result()!.note!] : `No page found for “${item.object.name}”.`}{' '}
						<Show when={result()!.searchUrl}>
							<button type="button" class="connect-dots__link" onClick={(e) => { e.preventDefault(); props.openExternal(result()!.searchUrl!); }}>Look on {providerLabel(provider)} <ExternalIcon /></button>
						</Show>
					</div>
				</Show>
				<Show when={showPaste()}>
				<label class="connect-dots__option connect-dots__option--paste" classList={{ 'is-picked': pick()?.kind === 'paste' }}>
					<input type="radio" name={`connect-${provider}`} checked={pick()?.kind === 'paste'} onChange={() => choose({ kind: 'paste' })} />
					<input
						type="text"
						class="connect-dots__paste"
						placeholder={`Paste the ${providerLabel(provider)} page’s link`}
						aria-label={`${providerLabel(provider)} page link`}
						value={pasted().get(provider) ?? ''}
						onFocus={() => choose({ kind: 'paste' })}
						onInput={(e) => { set(pasted, setPasted, provider, e.currentTarget.value); set(refused, setRefused, provider, undefined); }}
					/>
				</label>
				</Show>
				<Show when={refused().get(provider)}><div class="connect-dots__refused">{refused().get(provider)}</div></Show>
				<div class="connect-dots__tail">
					<label class="connect-dots__plain">
						<input type="radio" name={`connect-${provider}`} checked={pick()?.kind === 'none'} onChange={() => choose({ kind: 'none' })} />
						None of these
					</label>
					<Show when={!showPaste()}>
						<button type="button" class="connect-dots__link" onClick={(e) => { e.preventDefault(); setPasting(new Set([...pasting(), provider])); }}>Paste a link instead</button>
					</Show>
					<Show when={pick()}>
						<button type="button" class="connect-dots__link" onClick={(e) => { e.preventDefault(); set(picks, setPicks, provider, undefined); set(refused, setRefused, provider, undefined); }}>Clear</button>
					</Show>
				</div>
			</section>
		);
	};

	const picked = (): number => picks().size;

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
				<div class="modal connect-dots" role="dialog" aria-modal="true" aria-labelledby="connect-dots-title">
					<header class="modal__head">
						<h3 id="connect-dots-title">Help us connect the dots</h3>
						<button class="modal__close" type="button" aria-label="Close" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
					</header>
					<div class="modal__body connect-dots__body">
						<p class="merge-tracks__intro">
							Curator knows these on some stores and not on others. Pick the page that is theirs on each store, and everyone’s
							catalogue gets it. Leave a store alone when you are not sure.
						</p>
						<Show when={error()}><div class="merge-tracks__warn">{error()}</div></Show>
						<Show when={loading()}><div class="pl-empty-hint">Looking for what is missing…</div></Show>
						<Show when={!loading() && !current() && !error()}><div class="pl-empty-hint">Nothing left to connect. Thank you.</div></Show>
						<Show when={!loading() && current()} keyed>{(item) => (
							<div class="connect-dots__item" classList={{ 'is-busy': busy() }}>
								<div class="connect-dots__subject">
									<Show when={item.object.coverUrl} fallback={<span class="connect-dots__cover" />}>
										<img class="connect-dots__cover" src={item.object.coverUrl!} alt="" />
									</Show>
									<div class="connect-dots__subject-text">
										<div class="connect-dots__kind">{KIND_WORD[item.object.kind] ?? item.object.kind}</div>
										<div class="connect-dots__title" title={item.object.name}>{item.object.name}</div>
										<Show when={item.detail}><div class="connect-dots__sub">{item.detail}</div></Show>
										<div class="connect-dots__known">
											<For each={item.object.handles.filter((h) => h.url && brandIcon(h.provider))}>{(h) => (
												<button type="button" class="connect-dots__known-store" title={`Open on ${providerLabel(h.provider)}`} aria-label={`Open on ${providerLabel(h.provider)}`} innerHTML={brandIcon(h.provider)!} onClick={(e) => { e.preventDefault(); props.openExternal(h.url!); }} />
											)}</For>
										</div>
									</div>
								</div>
								<Show when={item.titles.length}>
									<div class="connect-dots__titles"><span class="connect-dots__titles-label">{item.object.kind === 'release' ? 'Tracks' : 'Releases'}</span> {item.titles.join(' · ')}</div>
								</Show>
								<div class="connect-dots__stores">
									<For each={item.missing}>{(m) => store(item, m.provider)}</For>
								</div>
							</div>
						)}</Show>
					</div>
					<footer class="modal__foot">
						<span class="merge-review__remaining">{current() ? (named ? `${items().length} to connect` : `${total().toLocaleString()} remaining`) : ''}</span>
						<Show when={current()} fallback={<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Close</button>}>
							<button type="button" class="btn-secondary" disabled={busy()} title="Ask me again another time (S)" onClick={(e) => { e.preventDefault(); skip(); }}>Skip</button>
							<button type="button" class="btn-primary" disabled={busy() || picked() === 0} title="Send the picks (Enter)" onClick={(e) => { e.preventDefault(); void approve(); }}>{busy() ? 'Sending…' : items().length > 1 || (!named && total() > 1) ? 'Approve and next' : 'Approve'}</button>
						</Show>
					</footer>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => { document.removeEventListener('keydown', onKeyDown, true); dispose(); },
		open: () => begin(null),
		openFor: (ids) => begin(ids),
		close,
		isOpen,
	};
}

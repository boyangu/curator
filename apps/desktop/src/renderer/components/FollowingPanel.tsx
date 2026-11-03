// FollowingPanel — the artists and labels the cloud tracks for Discover
// (the Global Catalog's watches; core catalog-client/service.ts).
//
// A drawer over the right edge of Discover: one box takes a pasted Spotify or
// Deezer artist link (followed at once) or a name (searched: the catalogue's
// own artists and labels first, then Spotify/Deezer artists it does not hold
// yet, plus "follow the label by this name"). Below, the follows themselves,
// with which providers know each one and whether the cloud is tracking it.
//
// New releases do not appear here: the cloud's trackers find them and they
// arrive in the feed as items, minutes to a day after a follow.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { CatalogClientStatus, CatalogSearchHit, CatalogWatch } from '@curator/core';
import { catalogApi, shellApi } from '../data/api.js';

export interface FollowingPanelProps {
	onClose: () => void;
	onToast: (msg: string, kind: 'info' | 'error' | 'success', sub?: string) => void;
	// The follow count changed (the toolbar button shows it).
	onCountChange: (n: number) => void;
	// Open Manage following (choose from the library).
	onManage: () => void;
	// Bumped when follows changed elsewhere (the modal): reload the list.
	version: () => number;
}

const PROVIDER_LABEL: Record<string, string> = {
	spotify: 'Spotify',
	deezer: 'Deezer',
	youtube: 'YouTube',
	beatport: 'Beatport',
	musicbrainz: 'MusicBrainz',
	discogs: 'Discogs',
	soundcloud: 'SoundCloud',
	tidal: 'Tidal',
	bandcamp: 'Bandcamp',
	traxsource: 'Traxsource',
	instagram: 'Instagram',
	website: 'Website',
	user: 'by name',
};

const looksLikeLink = (s: string): boolean => /^(https?:\/\/|spotify:)/i.test(s.trim());

function ago(ms: number | null): string {
	if (ms === null) return 'not yet';
	const m = Math.round((Date.now() - ms) / 60000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}

function errorText(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	// IPC wraps the core error: keep the sentence it carries.
	return msg.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '');
}

// How the cloud is following an object, in one line.
function trackingLine(w: CatalogWatch): string {
	if (w.muted) return 'Muted: releases are not shown';
	// A Spotify playlist is read by this computer's Spotify login until the
	// cloud has polled it cleanly (core service.ts deviceTrackedPlaylists).
	if (w.object.kind === 'playlist' && w.object.handles.some((h) => h.provider === 'spotify')
		&& !w.tracking.some((t) => t.provider === 'spotify' && t.lastRunAt !== null && !t.failing)) {
		return 'Spotify · tracked on this computer';
	}
	if (!w.tracking.length) return w.object.kind === 'artist' ? 'Waiting to be tracked' : 'Not tracked yet';
	const failing = w.tracking.filter((t) => t.failing).map((t) => PROVIDER_LABEL[t.provider] ?? t.provider);
	const last = Math.max(...w.tracking.map((t) => t.lastRunAt ?? 0));
	const via = w.tracking.map((t) => PROVIDER_LABEL[t.provider] ?? t.provider).join(' + ');
	return `${via} · checked ${ago(last || null)}${failing.length ? ` · ${failing.join(', ')} failing` : ''}`;
}

export function FollowingPanel(props: FollowingPanelProps) {
	const [status, setStatus] = createSignal<CatalogClientStatus | null>(null);
	const [watches, setWatches] = createSignal<CatalogWatch[]>([]);
	const [query, setQuery] = createSignal('');
	const [hits, setHits] = createSignal<CatalogSearchHit[] | null>(null);
	const [searching, setSearching] = createSignal(false);
	const [busy, setBusy] = createSignal<string | null>(null);
	const [filter, setFilter] = createSignal('');
	const [importing, setImporting] = createSignal(false);

	const loadWatches = async (): Promise<void> => {
		try {
			const ws = await catalogApi.watches();
			setWatches(ws);
			props.onCountChange(ws.length);
		} catch (e) {
			props.onToast('Could not load your follows', 'error', errorText(e));
		}
	};

	onMount(() => {
		void catalogApi.status().then((s) => {
			setStatus(s);
			if (s.available) void loadWatches();
		});
	});
	createEffect(on(props.version, () => {
		if (status()?.available) void loadWatches();
	}, { defer: true }));

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchSeq = 0;
	onCleanup(() => clearTimeout(searchTimer));
	const runSearch = (q: string): void => {
		clearTimeout(searchTimer);
		if (q.trim().length < 2 || looksLikeLink(q)) {
			setHits(null);
			return;
		}
		searchTimer = setTimeout(() => {
			const seq = ++searchSeq;
			setSearching(true);
			void catalogApi
				.search(q)
				.then((r) => {
					if (seq === searchSeq) setHits(r);
				})
				.catch((e) => props.onToast('Search failed', 'error', errorText(e)))
				.finally(() => {
					if (seq === searchSeq) setSearching(false);
				});
		}, 300);
	};

	const followed = async (key: string, run: () => Promise<CatalogWatch>): Promise<void> => {
		setBusy(key);
		try {
			const w = await run();
			props.onToast(`Following ${w.object.name}`, 'success', 'New releases arrive in Discover as the cloud finds them.');
			setHits((h) => h?.map((x) => (x.key === key ? { ...x, watched: true, objectId: w.object.id } : x)) ?? null);
			await loadWatches();
		} catch (e) {
			props.onToast('Could not follow', 'error', errorText(e));
		} finally {
			setBusy(null);
		}
	};

	const submit = (): void => {
		const q = query().trim();
		if (!q) return;
		if (looksLikeLink(q)) {
			void followed(`link:${q}`, () => catalogApi.follow({ url: q })).then(() => setQuery(''));
		} else runSearch(q);
	};

	const followHit = (h: CatalogSearchHit): void => {
		void followed(h.key, () => catalogApi.follow(h.objectId ? { objectId: h.objectId } : { claim: h.claim! }));
	};

	const unfollow = async (w: CatalogWatch): Promise<void> => {
		setBusy(w.object.id);
		try {
			await catalogApi.unfollow(w.object.id);
			await loadWatches();
		} catch (e) {
			props.onToast('Could not unfollow', 'error', errorText(e));
		} finally {
			setBusy(null);
		}
	};

	const toggleMute = async (w: CatalogWatch): Promise<void> => {
		try {
			await catalogApi.mute(w.object.id, !w.muted);
			setWatches((ws) => ws.map((x) => (x.object.id === w.object.id ? { ...x, muted: !w.muted } : x)));
		} catch (e) {
			props.onToast('Could not change mute', 'error', errorText(e));
		}
	};

	const refresh = async (w: CatalogWatch): Promise<void> => {
		try {
			const r = await catalogApi.refresh(w.object.id);
			props.onToast(r.dueAt ? `Checking ${w.object.name}` : `${w.object.name} was checked within the hour`, 'info');
		} catch (e) {
			props.onToast('Could not refresh', 'error', errorText(e));
		}
	};

	const [enriching, setEnriching] = createSignal(false);
	const enrichLabels = async (): Promise<void> => {
		setEnriching(true);
		try {
			const r = await catalogApi.enrichLabels();
			props.onToast(
				`${r.labels} label${r.labels === 1 ? '' : 's'} sent to the catalogue`,
				'success',
				`${r.registered} new to it · ${r.queued} queued for lookup. The catalogue works through them over the next hours; their pages and releases fill in as it goes.`,
			);
		} catch (e) {
			props.onToast('Could not send your labels', 'error', errorText(e));
		} finally {
			setEnriching(false);
		}
	};

	const importSpotify = async (): Promise<void> => {
		setImporting(true);
		try {
			const r = await catalogApi.importSpotify();
			props.onToast(
				r.watched ? `Now following ${r.watched} artist${r.watched === 1 ? '' : 's'} from Spotify` : 'Already following every artist you follow on Spotify',
				'success',
				`${r.found} followed on Spotify · ${r.created} new to the catalogue`,
			);
			await loadWatches();
		} catch (e) {
			props.onToast('Import failed', 'error', errorText(e));
		} finally {
			setImporting(false);
		}
	};

	// Labels first (fewer), then artists; each by name; filtered by the box.
	const grouped = createMemo(() => {
		const f = filter().trim().toLowerCase();
		const list = watches()
			.filter((w) => !f || w.object.name.toLowerCase().includes(f))
			.sort((a, b) => a.object.name.localeCompare(b.object.name));
		return [
			{ title: 'Labels', items: list.filter((w) => w.object.kind === 'label') },
			{ title: 'Artists', items: list.filter((w) => w.object.kind === 'artist') },
			{ title: 'Playlists', items: list.filter((w) => w.object.kind === 'playlist') },
			{ title: 'Genres', items: list.filter((w) => w.object.kind === 'genre') },
		].filter((g) => g.items.length);
	});
	// A library's worth of follows is thousands of rows; each group draws its
	// first PAGE and grows on request. The filter searches all of them.
	const PAGE = 100;
	const [shown, setShown] = createSignal<Record<string, number>>({});
	const shownOf = (title: string): number => shown()[title] ?? PAGE;

	const Providers = (p: { list: string[] }) => (
		<span class="following-providers">
			<For each={p.list}>{(prov) => <span class={`following-chip following-chip--${prov}`}>{PROVIDER_LABEL[prov] ?? prov}</span>}</For>
		</span>
	);

	const Avatar = (p: { url: string | null; name: string }) => (
		<Show when={p.url} fallback={<span class="following-avatar following-avatar--blank">{p.name.slice(0, 1).toUpperCase()}</span>}>
			<img class="following-avatar" src={p.url!} alt="" loading="lazy" />
		</Show>
	);

	return (
		<aside class="following-panel" aria-label="Following">
			<header class="following-head">
				<span class="following-head__title">Following</span>
				<span class="following-head__count">{watches().length}</span>
				<button class="following-close" title="Close" onClick={() => props.onClose()}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
				</button>
			</header>

			<Show when={status()} fallback={<div class="following-note">Checking…</div>}>
				<Show
					when={status()!.available}
					fallback={
						<div class="following-note">
							{status()!.reason === 'signed_out'
								? 'Sign in to Curator Cloud (Settings → Account) to follow artists and labels. The cloud tracks them and brings their new releases to Discover on every device.'
								: 'Your sync server does not offer Following yet.'}
						</div>
					}
				>
					<div class="following-add">
						<input
							class="following-input"
							placeholder="Paste an artist link (Spotify, Deezer) or a label page (Beatport, Bandcamp), or search"
							value={query()}
							onInput={(e) => {
								setQuery(e.currentTarget.value);
								runSearch(e.currentTarget.value);
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter') submit();
								if (e.key === 'Escape') {
									setQuery('');
									setHits(null);
								}
							}}
						/>
						<Show when={looksLikeLink(query())}>
							<button class="following-btn following-btn--primary" disabled={busy() !== null} onClick={submit}>
								Follow
							</button>
						</Show>
					</div>

					<Show when={query().trim().length >= 2 && !looksLikeLink(query())}>
						<div class="following-results">
							<Show when={searching() && !hits()}>
								<div class="following-note">Searching…</div>
							</Show>
							<For each={hits() ?? []}>
								{(h) => (
									<div class="following-row">
										<Avatar url={h.imageUrl} name={h.name} />
										<div class="following-row__main">
											<span class="following-row__name" title={h.name}>{h.name}</span>
											<span class="following-row__sub">
												<span class="following-kind">{h.kind}</span>
												<Providers list={h.providers} />
												<Show when={h.watchCount > 0}><span class="following-row__meta">{h.watchCount} following</span></Show>
											</span>
										</div>
										<Show when={!h.watched} fallback={<span class="following-row__done">Following</span>}>
											<button class="following-btn" disabled={busy() !== null} onClick={() => followHit(h)}>
												{busy() === h.key ? '…' : 'Follow'}
											</button>
										</Show>
									</div>
								)}
							</For>
							<Show when={hits() !== null}>
								<div class="following-row following-row--label">
									<span class="following-avatar following-avatar--blank">L</span>
									<div class="following-row__main">
										<span class="following-row__name">Label “{query().trim()}”</span>
										<span class="following-row__sub">Follow a label by its exact name; releases are matched to it by name.</span>
									</div>
									<button
										class="following-btn"
										disabled={busy() !== null}
										onClick={() => void followed(`label:${query().trim()}`, () => catalogApi.follow({ labelName: query().trim() }))}
									>
										Follow label
									</button>
								</div>
							</Show>
						</div>
					</Show>

					<div class="following-import">
						<button class="following-btn following-btn--primary" onClick={() => props.onManage()}>
							Choose from my library…
						</button>
						<button class="following-btn" disabled={importing()} onClick={() => void importSpotify()}>
							{importing() ? 'Importing…' : 'Import my Spotify follows'}
						</button>
						<button class="following-btn" disabled={enriching()} title="Register every label in your library with the shared catalogue and have it look them up: their pages elsewhere and their releases. Follows nothing." onClick={() => void enrichLabels()}>
							{enriching() ? 'Sending…' : 'Catalogue my labels'}
						</button>
					</div>

					<div class="following-list">
						<Show when={watches().length > 8}>
							<input class="following-input following-input--filter" placeholder="Filter your follows" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
						</Show>
						<Show when={watches().length > 0} fallback={<div class="following-note">You are not following anyone yet. Search above, paste a link, or import your Spotify follows.</div>}>
							<For each={grouped()}>
								{(g) => (
									<section class="following-group">
										<div class="following-group__title">{g.title} <span class="following-group__count">{g.items.length}</span></div>
										<For each={g.items.slice(0, shownOf(g.title))}>
											{(w) => (
												<div class="following-row" classList={{ 'following-row--muted': w.muted }}>
													<Avatar url={w.object.coverUrl} name={w.object.name} />
													<div class="following-row__main">
														<span class="following-row__name" title={w.object.name}>{w.object.name}</span>
														<span class="following-row__sub">
															<Providers list={[...new Set(w.object.handles.map((x) => x.provider))]} />
															<span class="following-row__meta" classList={{ 'following-row__meta--warn': w.tracking.some((t) => t.failing) }}>{trackingLine(w)}</span>
														</span>
													</div>
													<div class="following-row__acts">
														<Show when={w.object.handles.find((x) => x.url)}>
															{(hd) => (
																<button class="following-icon" title={`Open on ${PROVIDER_LABEL[hd().provider] ?? hd().provider}`} onClick={() => void shellApi.openExternal(hd().url!)}>
																	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
																</button>
															)}
														</Show>
														<button class="following-icon" title="Check for new releases now" onClick={() => void refresh(w)}>
															<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3.4-7" /><path d="M21 4v5h-5" /></svg>
														</button>
														<button class="following-icon" title={w.muted ? 'Unmute: show its releases again' : 'Mute: hide its releases without unfollowing'} onClick={() => void toggleMute(w)}>
															<Show
																when={w.muted}
																fallback={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7" /></svg>}
															>
																<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6" /></svg>
															</Show>
														</button>
														<button class="following-icon following-icon--danger" title="Unfollow" disabled={busy() === w.object.id} onClick={() => void unfollow(w)}>
															<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
														</button>
													</div>
												</div>
											)}
										</For>
										<Show when={g.items.length > shownOf(g.title)}>
											<button class="following-more" onClick={() => setShown((s) => ({ ...s, [g.title]: shownOf(g.title) + PAGE * 5 }))}>
												Show more ({g.items.length - shownOf(g.title)} left)
											</button>
										</Show>
									</section>
								)}
							</For>
						</Show>
					</div>
				</Show>
			</Show>
		</aside>
	);
}

// ManageFollowingModal — choose what to follow from your own library.
//
// Four tabs (Artists, Labels, Genres, Playlists), each listing what the LOCAL
// library (tracks with a file here) holds, by how often it appears there
// (core catalog-client/library-candidates.ts): the artists and labels a DJ plays most are the ones
// worth following first. Ticked rows are followed together in one batch.
//
// An artist is followable only with a provider id (a name is never an
// artist's identity); one without says so and points at Following search.
// Genres are tracked through Beatport's weekly charts; playlists through the
// cloud once it reads them (until then this device does), which each tab says.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { FollowCandidate, FollowCandidateKind } from '@curator/core';
import { catalogApi } from '../data/api.js';

export interface ManageFollowingModalProps {
	onClose: () => void;
	onToast: (msg: string, kind: 'info' | 'error' | 'success', sub?: string) => void;
	// Follows changed (the Following drawer and button reload).
	onChanged: () => void;
}

const TABS: { kind: FollowCandidateKind; label: string; note: string | null }[] = [
	{ kind: 'artist', label: 'Artists', note: null },
	{ kind: 'label', label: 'Labels', note: 'Labels are followed by name; Deezer matches releases to them by the label written on each release. A label the catalogue knows on Beatport is read there too, with its tracklists.' },
	{ kind: 'genre', label: 'Genres', note: "Each followed genre brings Beatport's weekly top 100: a track's first appearance on the chart lands in Discover under the genre." },
	{ kind: 'playlist', label: 'Playlists', note: 'Playlists you follow (not your own), by how many of your local tracks are in them. Tracking playlist additions starts in a later update.' },
];

const PAGE = 200;

type Show_ = 'all' | 'unfollowed' | 'followed';

function errorText(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return msg.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '');
}

export function ManageFollowingModal(props: ManageFollowingModalProps) {
	const [tab, setTab] = createSignal<FollowCandidateKind>('artist');
	const [lists, setLists] = createSignal<Partial<Record<FollowCandidateKind, FollowCandidate[]>>>({});
	const [loading, setLoading] = createSignal(false);
	const [filter, setFilter] = createSignal('');
	const [show, setShow] = createSignal<Show_>('unfollowed');
	const [selected, setSelected] = createSignal<Set<string>>(new Set());
	const [limit, setLimit] = createSignal(PAGE);
	const [working, setWorking] = createSignal(false);

	const load = async (kind: FollowCandidateKind, force = false): Promise<void> => {
		if (!force && lists()[kind]) return;
		setLoading(true);
		try {
			const items = await catalogApi.candidates(kind);
			setLists((l) => ({ ...l, [kind]: items }));
		} catch (e) {
			props.onToast('Could not read your library', 'error', errorText(e));
		} finally {
			setLoading(false);
		}
	};
	onMount(() => void load('artist'));

	const switchTab = (kind: FollowCandidateKind): void => {
		setTab(kind);
		setFilter('');
		setLimit(PAGE);
		void load(kind);
	};

	const current = () => lists()[tab()] ?? [];
	const visible = createMemo(() => {
		const f = filter().trim().toLowerCase();
		return current().filter((c) => {
			if (f && !c.name.toLowerCase().includes(f)) return false;
			if (show() === 'followed') return c.followedObjectId !== null;
			if (show() === 'unfollowed') return c.followedObjectId === null;
			return true;
		});
	});
	const followedCount = (kind: FollowCandidateKind) => (lists()[kind] ?? []).filter((c) => c.followedObjectId).length;
	const selectable = (c: FollowCandidate) => c.followedObjectId === null && c.target !== null;
	const toggle = (c: FollowCandidate): void => {
		if (!selectable(c)) return;
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(c.key)) next.delete(c.key);
			else next.add(c.key);
			return next;
		});
	};
	// The most frequent unfollowed ones of the current list, after the filter.
	const selectTop = (n: number): void => {
		setSelected((s) => {
			const next = new Set(s);
			for (const c of visible().filter(selectable).slice(0, n)) next.add(c.key);
			return next;
		});
	};
	// Selections persist across tabs, so one Follow covers artists and labels.
	const selectedItems = createMemo(() => {
		const keys = selected();
		return Object.values(lists())
			.flat()
			.filter((c): c is FollowCandidate => !!c && keys.has(c.key));
	});

	const followSelected = async (): Promise<void> => {
		const items = selectedItems();
		if (!items.length) return;
		setWorking(true);
		try {
			const r = await catalogApi.followMany(items.map((c) => c.target!));
			const failed = r.failed.length ? ` · ${r.failed.length} failed: ${r.failed.slice(0, 3).map((f) => f.name).join(', ')}` : '';
			props.onToast(
				r.followed ? `Now following ${r.followed}` : 'Nothing new to follow',
				r.failed.length ? 'error' : 'success',
				`${r.already ? `${r.already} already followed · ` : ''}New releases arrive in Discover as the cloud finds them${failed}`,
			);
			setSelected(new Set<string>());
			const kinds = [...new Set(items.map((c) => c.kind))];
			await Promise.all(kinds.map((k) => load(k, true)));
			props.onChanged();
		} catch (e) {
			props.onToast('Could not follow', 'error', errorText(e));
		} finally {
			setWorking(false);
		}
	};

	const unfollow = async (c: FollowCandidate): Promise<void> => {
		try {
			await catalogApi.unfollow(c.followedObjectId!);
			setLists((l) => ({ ...l, [c.kind]: (l[c.kind] ?? []).map((x) => (x.key === c.key ? { ...x, followedObjectId: null } : x)) }));
			props.onChanged();
		} catch (e) {
			props.onToast('Could not unfollow', 'error', errorText(e));
		}
	};

	// Capture phase, like the app's other modals: Esc closes this before the
	// views beneath can act on it.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			props.onClose();
		}
	};
	document.addEventListener('keydown', onKeyDown, true);
	onCleanup(() => document.removeEventListener('keydown', onKeyDown, true));

	const note = () => TABS.find((t) => t.kind === tab())!.note;

	return (
		<div class="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
			<div class="modal modal--wide manage-following" role="dialog" aria-modal="true" aria-labelledby="manage-following-title">
				<header class="modal__head">
					<h3 id="manage-following-title">Manage following</h3>
					<button class="modal__close" title="Close" onClick={() => props.onClose()}>
						×
					</button>
				</header>
				<nav class="settings-tabs manage-following__tabs">
					<For each={TABS}>
						{(t) => (
							<button class="settings-tab" classList={{ active: tab() === t.kind }} onClick={() => switchTab(t.kind)}>
								{t.label}
								<Show when={lists()[t.kind]}>
									<span class="manage-following__tabcount">
										{followedCount(t.kind)}/{lists()[t.kind]!.length}
									</span>
								</Show>
							</button>
						)}
					</For>
				</nav>
				<div class="manage-following__bar">
					<input class="following-input" placeholder="Filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
					<select class="feed-toolbar__filter" value={show()} onChange={(e) => setShow(e.currentTarget.value as Show_)}>
						<option value="unfollowed">Not followed</option>
						<option value="followed">Followed</option>
						<option value="all">All</option>
					</select>
					<button class="following-btn" onClick={() => selectTop(25)}>Select top 25</button>
					<button class="following-btn" disabled={!selected().size} onClick={() => setSelected(new Set<string>())}>
						Clear
					</button>
				</div>
				<Show when={note()}>
					<div class="manage-following__note">{note()}</div>
				</Show>
				<div class="modal__body manage-following__body">
					<Show when={!loading() || current().length} fallback={<div class="following-note">Reading your library…</div>}>
						<Show when={visible().length} fallback={<div class="following-note">Nothing to show here.</div>}>
							<div class="manage-following__list">
								<For each={visible().slice(0, limit())}>
									{(c, i) => (
										<label class="manage-following__row" classList={{ 'manage-following__row--off': !selectable(c) }}>
											<input type="checkbox" checked={selected().has(c.key)} disabled={!selectable(c)} onChange={() => toggle(c)} />
											<span class="manage-following__rank">{i() + 1}</span>
											<Show when={c.imageUrl}>
												<img class="manage-following__img" src={c.imageUrl!} alt="" loading="lazy" />
											</Show>
											<span class="manage-following__name" title={c.name}>
												{c.name}
												<Show when={c.detail}>
													<span class="manage-following__detail">{c.detail}</span>
												</Show>
											</span>
											<span class="manage-following__count">
												{c.count} {c.kind === 'playlist' ? 'local' : c.count === 1 ? 'track' : 'tracks'}
											</span>
											<span class="manage-following__state">
												<Show when={c.followedObjectId} fallback={<Show when={c.blocked}><span class="manage-following__blocked">{c.blocked}</span></Show>}>
													<span class="manage-following__followed">Following</span>
													<button
														class="following-icon following-icon--danger"
														title="Unfollow"
														onClick={(e) => {
															e.preventDefault();
															void unfollow(c);
														}}
													>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
													</button>
												</Show>
											</span>
										</label>
									)}
								</For>
								<Show when={visible().length > limit()}>
									<button class="following-btn manage-following__more" onClick={() => setLimit((n) => n + PAGE)}>
										Show {Math.min(PAGE, visible().length - limit())} more of {visible().length - limit()}
									</button>
								</Show>
							</div>
						</Show>
					</Show>
				</div>
				<footer class="modal__foot manage-following__foot">
					<span class="manage-following__summary">
						{selected().size ? `${selected().size} selected` : 'Tick what to follow; selections carry across tabs.'}
					</span>
					<button type="button" class="btn-secondary" onClick={() => props.onClose()}>
						Close
					</button>
					<button type="button" class="btn-primary" disabled={!selected().size || working()} onClick={() => void followSelected()}>
						{working() ? 'Following…' : `Follow ${selected().size || ''}`.trim()}
					</button>
				</footer>
			</div>
		</div>
	);
}

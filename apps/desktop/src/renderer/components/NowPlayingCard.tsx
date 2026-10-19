// NowPlayingCard — the leftmost block of the player footer (cover + title +
// artist + BPM/key/source tags + favorite button).
//
// First real Solid JSX component in the codebase. Pattern to follow for
// every other player surface (TransportView, VolumeControl, BigWaveformView,
// MiniWaveMapView, CueGridView, …):
//
//   1. Component is a pure function that takes the minimum props it needs.
//      No reaching into globals; no `document.getElementById`.
//   2. Reactivity flows from the playerStore (createMutable proxy in
//      player.ts) — reads inside JSX auto-track, so the DOM patches
//      whenever a tracked field changes.
//   3. A small `mountX(host, props)` wrapper calls Solid's `render()` into
//      the supplied host element and returns a destroy() for cleanup.
//      Mounts are caller-driven: today main.ts mounts one; tomorrow a
//      multi-deck layout could mount two with different player contexts.
//
// Single-instance-per-audio-engine. The Curator product invariant is "one
// sound at a time," which means the playerStore is a singleton — but the
// VIEW of it (this component) is composable. Multiple NowPlayingCards
// could mount into different decks of a future "preview-while-playing"
// surface; they'd all observe the same playerStore.

import { For, Show, createMemo, createSignal, createEffect, onCleanup, Index } from 'solid-js';
import { ArtistCredits } from './ArtistCredits.jsx';
import { formatTrackTitle } from '@curator/shared';
import { artistCreditFormat } from '../features/uiSettings.js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { Track } from '@curator/shared';
import * as player from '../player.js';
import * as tagsStore from '../stores/tagsStore.js';

import { KeyChip } from './KeyChip.jsx';
import { formatBpm } from '../music-utils.js';

// Stable per-track gradient used as the cover fallback. Matches the
// row-cover and player-cover gradients elsewhere so a track loading without
// a cover image still reads as "the same thing." Exported for the other
// now-playing surfaces (SmallPlayer, NowPlayingChip) so all covers degrade
// identically.
export function coverGradient(seed: number): string {
	const hues = [25, 65, 105, 145, 195, 230, 280, 320];
	const h1 = hues[seed % hues.length];
	const h2 = hues[(seed * 3 + 2) % hues.length];
	return `linear-gradient(135deg, oklch(0.45 0.16 ${h1}), oklch(0.18 0.08 ${h2}))`;
}

// Resolved cover `background-image` for a now-playing surface — shared by all
// three (SmallPlayer, NowPlayingCard, NowPlayingChip) so feed and library
// tracks degrade identically. A feed/streaming track carries its art as an
// http coverUrl with an EMPTY trackId; a library track has no coverUrl and
// resolves through the curator-cover:// protocol by trackId. Both layer over a
// deterministic gradient (seeded off whichever id is present, so a feed track's
// fallback still varies) — callers pair this with `background-size: cover, cover`.
export function coverImage(cur: { trackId: string; sourceTrackId: string; coverUrl: string | null }): string {
	const seed = (cur.trackId || cur.sourceTrackId || ' ').charCodeAt(0);
	const grad = coverGradient(seed);
	if (cur.coverUrl) return `url("${cur.coverUrl}"), ${grad}`;
	if (cur.trackId) return `url(curator-cover://${encodeURIComponent(cur.trackId)}), ${grad}`;
	return grad;
}

export interface NowPlayingCardProps {
	// Accessor for the in-memory Track cache. Returns undefined when the
	// played track isn't in the cache (e.g. playback from an omnibar pick
	// before the cache loaded). Component degrades gracefully in that case.
	getTrack: (id: string) => Track | undefined;
	// Future favorite-button wiring lives behind this callback. Null disables
	// the button visually; passing a function shows it as enabled.
	onFavoriteToggle?: ((trackId: string) => void) | null;
	// Double-click on the Nth star writes rating=N for the currently playing
	// track. Caller owns the actual IPC + cache patch (so a star click here
	// and the rating dialog share their commit path). Omit / null to hide
	// the stars from the meta row entirely.
	onSetRating?: ((trackId: string, rating: number) => void) | null;
	// Click on the "+" button after the tag chip row — caller opens the tag
	// picker with the currently-playing track as the selection. Null hides
	// the button entirely.
	onAddTag?: ((trackId: string) => void) | null;
	// Right-click on a tag chip — caller shows a context menu (currently a
	// single "Remove" item). Null disables the gesture; the chip still
	// renders normally.
	onTagContextMenu?: ((evt: MouseEvent, trackId: string, tagId: string) => void) | null;
	// Click on one artist name in the credit line — caller resolves the
	// name against the library and opens the artist scope. Null renders
	// the credit as plain text.
	onArtistClick?: ((name: string) => void) | null;
	// Bump-counter the caller increments whenever getTrack() would return
	// fresh data for the currently-played track. Without it, the display
	// memo would never re-run on cache writes — Maps aren't reactive.
	tracksCacheRev?: Accessor<number>;
}

export function NowPlayingCard(props: NowPlayingCardProps) {
	// player.getState() returns the createMutable proxy from player.ts.
	// Reads inside the JSX template auto-track, so each property accessed
	// in the template re-renders only when that property changes.
	const state = player.getState();

	// Reactive bridge to tagsStore. The store is a plain module — not a
	// Solid signal — so we tick `tagsRev` whenever the underlying tag set
	// changes (definitions reload, or membership for the current track
	// resolves after an IPC round-trip). The chip row reads tagsRev() so
	// it re-renders when the bump fires.
	const [tagsRev, setTagsRev] = createSignal(0);
	onCleanup(tagsStore.onTagsChanged(() => setTagsRev((n) => n + 1)));
	// When the current track changes, kick a batch fetch for its tags. We
	// fetch just the single id — the track-list virt loop fetches in pages,
	// so by the time a track becomes "now playing" its row's tags are very
	// often already cached. The one-id call is a no-op when cached.
	createEffect(() => {
		const cur = state.current;
		if (!cur?.trackId) return;
		tagsStore.ensureTracksLoaded([cur.trackId]).then(() => setTagsRev((n) => n + 1));
	});

	const trackTags = createMemo(() => {
		tagsRev();
		const cur = state.current;
		if (!cur?.trackId) return [] as { id: string; name: string; color: string | null }[];
		const ids = tagsStore.getTagsForTrack(cur.trackId);
		const out: { id: string; name: string; color: string | null }[] = [];
		for (const id of ids) {
			const t = tagsStore.getTagById(id);
			if (t && t.kind === 'user') out.push({ id: t.id, name: t.name, color: t.color });
		}
		// Stable display order: alpha by name. Tags carry no intrinsic
		// priority — alpha keeps the chip row from reshuffling between
		// track changes when two tracks share most tags.
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	});

	// Derived display strings. createMemo so the read-graph stays tight —
	// each cell of the template depends on `display()`, which only
	// re-evaluates when state.current changes or the underlying Track
	// data does (the latter via getTrack, which today reads from
	// state.tracksById; the eventual tracksStore exposes a reactive
	// accessor that closes the loop).
	const display = createMemo(() => {
		// Track the rev signal so cache mutations (rating edits, future
		// in-place metadata updates) re-fire this memo. The actual value
		// is unused — only the dependency matters.
		props.tracksCacheRev?.();
		const cur = state.current;
		if (!cur) return null;
		// Prefer the live cache row (reflects in-list rating/re-analysis edits);
		// fall back to the player's own snapshot when the row has left the
		// visible cache (track removed from the current playlist / navigated
		// away) so BPM/key/rating don't blank out under the playing audio.
		const t = props.getTrack(cur.trackId) ?? player.currentTrack() ?? undefined;
		const bpm = t?.bpm ? `${formatBpm(t.bpm)} BPM` : '— BPM';
		const keyCamelot = t?.keyCamelot ?? null;
		const source = cur.source.toUpperCase();
		// "LOCAL" pip surfaces whenever the playing track has a local file
		// attached, even if the active source is Spotify/Tidal — clarifies
		// that playback is coming from disk rather than the streaming SDK.
		const hasLocal = cur.source === 'local'
			|| cur.hasLocal === true
			|| (t?.sources ?? []).includes('local');
		const showLocalPip = hasLocal && cur.source !== 'local';
		const coverUrl = coverImage(cur);
		// Rekordbox 0..5 rating, null when never imported from RB. Clamped
		// defensively in case a future writer overshoots — the star row only
		// renders five glyphs total.
		const rating = t?.rating != null ? Math.max(0, Math.min(5, Math.round(t.rating))) : null;
		// Structured credits: the live cache row first (reflects edits), then
		// the player's own seed (feed plays), then nothing → flat string.
		const artists = t?.artists ?? cur.artists ?? [];
		return { title: formatTrackTitle(cur.title, artists, artistCreditFormat().remixStyle), artist: cur.artist, artists, bpm, keyCamelot, source, showLocalPip, coverUrl, rating };
	});

	return (
		<div class="now-playing">
			<div
				class="np-cover"
				classList={{ 'is-loading': state.loading }}
				style={display()
					? {
						'background-image': display()!.coverUrl,
						'background-size': 'cover, cover',
						'background-position': 'center, center',
					}
					: {}}
			>
				{/* Loading overlay — visible only while the backend is still
				    spinning up audio (decoding the local file, or waiting for
				    Spotify's first state event). A subtle ring rather than a
				    full spinner so the cover art stays legible underneath. */}
				<Show when={state.loading}>
					<div class="np-cover-spinner" />
				</Show>
			</div>
			<div class="np-meta">
				<div class="np-title">{display()?.title ?? 'No track playing'}</div>
				<div class="np-artist">
					<Show when={display() && display()!.artists.length > 0} fallback={display()?.artist ?? 'Select a track to begin auditioning'}>
						<ArtistCredits artists={display()!.artists} onClick={props.onArtistClick ?? null} />
					</Show>
				</div>
				<div class="np-tags">
					<Show
						when={display()}
						fallback={<><span>— BPM</span><span>— · —</span></>}
					>
						{(d) => (
							<>
								<span>{d().bpm}</span>
								<span><KeyChip keyCamelot={d().keyCamelot} /> · {d().source}</span>
								<Show when={props.onSetRating != null}>
									<span
										class="np-rating"
										title={d().rating != null ? `${d().rating}/5 — double-click a star to change` : 'Double-click a star to rate'}
										role="group"
										aria-label="Rating"
									>
										<Index each={[1, 2, 3, 4, 5]}>
											{(n) => (
												<button
													type="button"
													class="np-rating__star"
													classList={{ 'is-on': (d().rating ?? 0) >= n() }}
													aria-label={`Set rating to ${n()}`}
													onDblClick={() => {
														const cur = state.current;
														if (cur && props.onSetRating) props.onSetRating(cur.trackId, n());
													}}
												>★</button>
											)}
										</Index>
									</span>
								</Show>
								<Show when={d().showLocalPip}>
									<span class="np-local">LOCAL</span>
								</Show>
							</>
						)}
					</Show>
				</div>
				<Show when={trackTags().length > 0 || props.onAddTag != null}>
					<div class="np-user-tags">
						<For each={trackTags()}>
							{(t) => (
								<span
									class="np-user-tag"
									title={t.name}
									style={t.color ? { '--tag-color': t.color } : undefined}
									onContextMenu={(e) => {
										const cur = state.current;
										if (cur && props.onTagContextMenu) {
											e.preventDefault();
											props.onTagContextMenu(e, cur.trackId, t.id);
										}
									}}
								>
									{t.name}
								</span>
							)}
						</For>
						<Show when={props.onAddTag != null}>
							<button
								type="button"
								class="np-user-tag-add"
								title="Add tags…"
								aria-label="Add tags"
								onClick={() => {
									const cur = state.current;
									if (cur && props.onAddTag) props.onAddTag(cur.trackId);
								}}
							>+</button>
						</Show>
					</div>
				</Show>
			</div>
			<button
				class="np-fav"
				title="Favorite"
				onClick={() => {
					const cur = state.current;
					if (cur && props.onFavoriteToggle) props.onFavoriteToggle(cur.trackId);
				}}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
					<path d="M12 21s-7-4.5-9.5-9C.8 8.7 2.5 4 6.5 4 9 4 10.7 5.5 12 7.5 13.3 5.5 15 4 17.5 4c4 0 5.7 4.7 4 8C19 16.5 12 21 12 21z" />
				</svg>
			</button>
		</div>
	);
}

export interface NowPlayingCardHandle {
	destroy(): void;
}

// Imperative mount — called once from main.ts/boot() into the host slot
// in index.html. Returns a destroy() that disposes the Solid root (and
// removes the rendered DOM).
export function mountNowPlayingCard(
	host: HTMLElement,
	props: NowPlayingCardProps,
): NowPlayingCardHandle {
	const dispose = render(() => <NowPlayingCard {...props} />, host);
	return { destroy: dispose };
}

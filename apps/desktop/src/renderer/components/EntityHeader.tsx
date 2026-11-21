// EntityHeader — the top of an artist / label / album page: who it is and
// what the catalogue says about it. One component for the three kinds; what
// each row holds differs by kind (an artist's labels, a label's artists, an
// album's artists + label + date).
//
// The name line carries the page's actions: follow, and the stores the
// entity can be opened in. (Owned ↔ World, which decides what the list
// below shows, sits with the list's other controls in the toolbar —
// layouts/MainPane.tsx.)
//
// Two parts: the head (picture, name line, facts line) and the rest (`.eh-more`:
// labels, genres, similar artists, what the list is loading). At the top of
// the list both show. As the list scrolls the header closes with it: the
// rest slides up behind the head and fades, the head shrinks to its small
// size, and two lines remain (features/entityHeaderCollapse.ts drives it
// through CSS variables on `.eh`; `compact` says it is fully closed).
//
// It reads the page's data from features/entityPage.ts and features/
// entitySimilar.ts through accessor props and acts only through callbacks —
// navigation and follow belong to main.ts.

import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { Portal, render } from 'solid-js/web';
import { releaseKind, RELEASE_KIND_LABEL } from '@curator/shared';
import type { ArtistActivity, ArtistBadge, ArtistLink, ArtistReach, EntityChip, EntityHeader as Header, EntityKind, EntityRef, EntityScopeKind, EntityWorkStatus, EntityWorldReason } from '@curator/shared';
import { BRAND_ORDER, brandIcon } from '../features/brandIcons.js';
import type { WorldProgress } from '../features/entityPage.js';
import type { SimilarState } from '../features/entitySimilar.js';

export interface OpenGesture { newTab: boolean }

export interface EntityHeaderProps {
	// Null until the library's half lands (a few ms): the name below fills in.
	header: Accessor<Header | null>;
	// What the page was opened as — shown until the header answers.
	opened: Accessor<{ kind: EntityKind; name: string } | null>;
	// The catalogue's half is still on its way.
	pending: Accessor<boolean>;
	scope: Accessor<EntityScopeKind>;
	world: Accessor<WorldProgress>;
	// What this desktop is doing for the page right now (reading the stores,
	// filling in rows); null when nothing.
	work: Accessor<EntityWorkStatus | null>;
	// The header is closed down to its two lines (the list is scrolled).
	compact: Accessor<boolean>;
	similar: { state: Accessor<SimilarState>; chips: Accessor<EntityChip[]>; canResearch: (ref: EntityRef) => boolean };
	onOpen(ref: EntityRef, gesture: OpenGesture): void;
	onFollow(following: boolean): Promise<void>;
	onLink(link: ArtistLink): void;
	onResearchSimilar(): void;
	onRetryWorld(): void;
}

const KIND_LABEL: Record<EntityKind, string> = { artist: 'Artist', label: 'Label', album: 'Album' };
const STORE_NAMES: Record<string, string> = {
	spotify: 'Spotify', tidal: 'Tidal', beatport: 'Beatport', bandcamp: 'Bandcamp', traxsource: 'Traxsource', soundcloud: 'SoundCloud',
	youtube: 'YouTube', deezer: 'Deezer', apple: 'Apple Music', beatsource: 'Beatsource', discogs: 'Discogs', musicbrainz: 'MusicBrainz', instagram: 'Instagram', website: 'Website',
};
const storeName = (source: string): string => STORE_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);

// How many of an artist's labels the header names before "+n more".
const LABELS_SHOWN = 3;
const COLLABS_SHOWN = 3;

const yearOf = (date: string | null): number | null => (date ? Number(date.slice(0, 4)) || null : null);

// "2006–2025": the years an artist's dated releases span.
function activeYears(a: ArtistActivity | null): string | null {
	const from = yearOf(a?.firstRelease ?? null);
	const to = yearOf(a?.lastRelease ?? null);
	if (!from || !to) return null;
	return from === to ? String(from) : `${from}–${to}`;
}

const METRIC_LABEL: Record<string, string> = {
	monthly_listeners: 'monthly listeners',
	listeners: 'listeners',
	fans: 'fans',
	followers: 'followers',
	subscribers: 'subscribers',
};
const SOURCE_NAME: Record<string, string> = { lastfm: 'Last.fm' };
const fmtChange = (c: number): string => `${c > 0 ? '▲' : c < 0 ? '▼' : ''}${Math.abs(c).toFixed(1)}`;

const REACH_CARD_WIDTH = 360;
const readMonth = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

// The Reach number, and on hover (or focus) a card of what it is made of:
// each store's own count and when it was read. The card is portalled to the
// body: the header clips what overflows it, and it closes up as the list
// scrolls.
function ReachMark(props: { reach: ArtistReach; children: JSX.Element }) {
	const [at, setAt] = createSignal<{ top: number; left: number } | null>(null);
	let anchor: HTMLSpanElement | undefined;
	const show = (): void => {
		if (!anchor) return;
		const r = anchor.getBoundingClientRect();
		setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - REACH_CARD_WIDTH - 8)) });
	};
	const hide = (): void => {
		setAt(null);
	};
	return (
		<span ref={anchor} class="eh-reach" tabIndex={0} aria-label={`Reach ${props.reach.score.toFixed(1)}`} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
			{props.children}
			<Show when={at()}>
				{(pos) => (
					<Portal>
						<div class="reach-card" role="tooltip" style={{ top: `${pos().top}px`, left: `${pos().left}px`, width: `${REACH_CARD_WIDTH}px` }}>
							<div class="reach-card__head">
								<span class="reach-card__title">Reach</span>
								<span class="reach-card__score">{props.reach.score.toFixed(1)}</span>
								<Show when={props.reach.change}>
									{(c) => <span class="reach-card__change" classList={{ 'is-up': c() > 0, 'is-down': c() < 0 }}>{fmtChange(c())} over 3 months</span>}
								</Show>
							</div>
							<div class="reach-card__rows">
								<For each={props.reach.parts}>
									{(p) => (
										<div class="reach-card__row" classList={{ 'is-outlier': !!p.outlier }}>
											<span class="reach-card__icon" innerHTML={brandIcon(p.provider) ?? ''} />
											<span class="reach-card__store">{SOURCE_NAME[p.provider] ?? storeName(p.provider)}</span>
											<span class="reach-card__n">{fmtCount(p.n)}</span>
											<span class="reach-card__metric">{METRIC_LABEL[p.metric] ?? p.metric}</span>
											<span class="reach-card__at">{readMonth(p.at)}</span>
											<Show when={p.outlier}>
												<span class="reach-card__note">Left out: the other stores disagree by over 30×</span>
											</Show>
										</div>
									)}
								</For>
							</div>
							<div class="reach-card__foot">10 × log10 of the audience, counted in Spotify listeners: 1,000 → 30 · 100K → 50 · 1M → 60</div>
						</div>
					</Portal>
				)}
			</Show>
		</span>
	);
}

const BADGE_LABEL: Record<ArtistBadge, string> ={ veteran: 'Veteran', workhorse: 'Workhorse', prolific: 'Prolific' };

// What earned the badge, in the header's numbers (the rules: core entity/badges.ts).
function badgeTitle(b: ArtistBadge, h: Header): string {
	const a = h.activity;
	switch (b) {
		case 'veteran': {
			const from = yearOf(a?.firstRelease ?? null);
			const to = yearOf(a?.lastRelease ?? null);
			return `Veteran: over 15 years of releases${from && to ? ` (${from}–${to})` : ''}`;
		}
		case 'workhorse': {
			const years = a ? Math.round(a.recentDays / 365) : 0;
			return `Workhorse: a release every 6 weeks or 15 tracks a year${a ? ` (${fmtCount(a.recentReleases)} releases, ${fmtCount(a.recentTracks)} new tracks in the last ${years} years)` : ''}`;
		}
		case 'prolific':
			return `Prolific: over 75 releases in the catalogue${h.world.releaseCount ? ` (${fmtCount(h.world.releaseCount)})` : ''}`;
	}
}

// Why World cannot be read, in the page's own words (the toolbar's switch
// says the same in its tooltip).
export function worldOffText(reason: EntityWorldReason, kind: EntityKind): string {
	switch (reason) {
		case 'signed_out': return 'Sign in to Curator Cloud to browse the catalogue';
		case 'server_off': return 'The catalogue is not reachable right now';
		case 'old_server': return 'Curator Cloud needs an update before it can list the catalogue here';
		case 'ambiguous': return 'Several labels share this name. Pick the one you mean:';
		case 'unknown': return `The catalogue does not know this ${kind} yet`;
		case 'pending': return 'Asking the catalogue…';
		default: return '';
	}
}

// What the desktop is doing for the page, in the page's words. A finished
// check that added releases says so (phase null, `added` set).
export function workText(w: EntityWorkStatus, kind: EntityKind): string {
	const at = w.source ? ` at ${storeName(w.source)}` : '';
	const releases = (n: number): string => `${fmtCount(n)} ${n === 1 ? 'release' : 'releases'}`;
	switch (w.phase) {
		case 'discover':
			return w.source
				? `Looking this ${kind} up${at}…${w.found ? ` ${releases(w.found)} found so far` : ''}`
				: `Adding this ${kind} to the catalogue…${w.found ? ` ${releases(w.found)} found` : ''}`;
		case 'updates':
			return w.source ? `Looking for updates${at}…` : w.found ? `Looking for updates… checking ${releases(w.found)} against the catalogue` : 'Looking for updates…';
		case 'tracklists':
			return `Reading tracklists${at}: ${fmtCount(w.done)} of ${fmtCount(w.total)}`;
		case 'details':
			return `Filling in BPM, key, genre and streaming pages: ${fmtCount(w.done)} of ${fmtCount(w.total)}`;
		default:
			return w.added ? `${releases(w.added)} added to the catalogue` : '';
	}
}

const initials = (name: string): string =>
	name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '–';

const fmtCount = (n: number): string => n.toLocaleString('en-US');

// The same word the list's album headers and the feed's cards show.
function albumKindLabel(h: Header): string {
	const kind = releaseKind({ type: h.facts.albumType, title: h.ref.name, trackCount: h.world.trackCount, artists: h.artists.map((a) => a.ref.name) });
	return RELEASE_KIND_LABEL[kind ?? 'album'];
}

// "Anjunadeep (12)": a related entity with how many releases back the tie.
const withCount = (c: EntityChip): string => (c.count !== undefined ? `${c.ref.name} (${fmtCount(c.count)})` : c.ref.name);

// A list of entity links on one line: plain text links, like the artist
// credits in the list below (a row of boxed chips per fact would shout).
// `counted`: each reads "Name (n)". `max`: only the first few are named,
// the rest stand behind "+n more", listed one per line in its tooltip.
function Links(props: { label: string; chips: EntityChip[]; onOpen: EntityHeaderProps['onOpen']; note?: string; counted?: boolean; max?: number }) {
	const shown = (): EntityChip[] => (props.max ? props.chips.slice(0, props.max) : props.chips);
	const rest = (): EntityChip[] => (props.max ? props.chips.slice(props.max) : []);
	return (
		<div class="eh-row">
			<span class="eh-row__label">{props.label}</span>
			<span class="eh-row__links">
				<For each={shown()}>
					{(c) => (
						<button
							type="button"
							class="eh-link"
							title={c.count !== undefined && !props.counted ? `${c.ref.name} — ${fmtCount(c.count)} ${c.count === 1 ? 'release' : 'releases'}` : c.ref.name}
							onClick={(e) => props.onOpen(c.ref, { newTab: e.ctrlKey || e.metaKey })}
							onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); props.onOpen(c.ref, { newTab: true }); } }}
							onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
						>
							{props.counted ? withCount(c) : c.detail ? `${c.ref.name} (${c.detail})` : c.ref.name}
						</button>
					)}
				</For>
				<Show when={rest().length > 0}>
					<span class="eh-row__more" title={rest().map(withCount).join('\n')}>+{rest().length} more</span>
				</Show>
				<Show when={props.note}><span class="eh-row__note">{props.note}</span></Show>
			</span>
		</div>
	);
}

export function EntityHeader(props: EntityHeaderProps) {
	const [imageFailed, setImageFailed] = createSignal<string | null>(null);
	const [followBusy, setFollowBusy] = createSignal(false);
	const [followHover, setFollowHover] = createSignal(false);

	const kind = (): EntityKind => props.header()?.ref.kind ?? props.opened()?.kind ?? 'artist';
	const name = (): string => props.header()?.ref.name || props.opened()?.name || '';
	// An album's own cover from the library when the catalogue brought none.
	const image = createMemo((): string | null => {
		const h = props.header();
		if (!h) return null;
		const url = h.imageUrl ?? (h.coverTrackId ? `curator-cover://${encodeURIComponent(h.coverTrackId)}` : null);
		return url && url !== imageFailed() ? url : null;
	});
	const links = createMemo((): ArtistLink[] => {
		const all = (props.header()?.links ?? []).filter((l) => l.url);
		const rank = (s: string): number => { const i = BRAND_ORDER.indexOf(s); return i < 0 ? BRAND_ORDER.length : i; };
		return [...all].sort((a, b) => rank(a.source) - rank(b.source) || a.source.localeCompare(b.source));
	});
	// One quiet line of facts under the name.
	const facts = createMemo((): string[] => {
		const h = props.header();
		if (!h) return [KIND_LABEL[kind()]];
		if (h.ref.kind === 'album') {
			return [albumKindLabel(h), h.facts.releaseDate ?? '', h.world.trackCount ? `${fmtCount(h.world.trackCount)} tracks` : ''].filter(Boolean);
		}
		const releases = h.world.releaseCount;
		const where = h.world.via ? `on ${storeName(h.world.via)}` : 'in the catalogue';
		return [KIND_LABEL[h.ref.kind], releases ? `${fmtCount(releases)} ${releases === 1 ? 'release' : 'releases'} ${where}` : ''].filter(Boolean);
	});
	const follow = async (): Promise<void> => {
		const h = props.header();
		if (!h?.follow || followBusy()) return;
		setFollowBusy(true);
		try { await props.onFollow(!h.follow.following); } finally { setFollowBusy(false); setFollowHover(false); }
	};
	// What the list under the header is showing, when that needs saying.
	const status = createMemo((): { text: string; retry?: boolean } | null => {
		const h = props.header();
		if (!h) return null;
		if (props.scope() === 'owned') {
			if (h.owned.count > 0) return null;
			return { text: h.ref.kind === 'album' ? 'None of this release is on your disk' : `No local files by this ${h.ref.kind === 'label' ? 'label' : 'artist'} yet` };
		}
		// Being looked up at the stores right now: the work line says so.
		if (h.world.reason === 'unknown' && props.work()?.phase === 'discover') return null;
		// Not reachable: the page keeps asking by itself; the link asks now.
		if (!h.world.available) return { text: worldOffText(h.world.reason, h.ref.kind), retry: h.world.reason === 'server_off' };
		const w = props.world();
		// Read from the streaming service while the catalogue does not know it.
		const from = h.world.via ? storeName(h.world.via) : null;
		if (w.state === 'error') return { text: `${from ?? 'The catalogue'} did not answer: ${w.error ?? 'unknown error'}`, retry: true };
		if (w.state === 'loading' && w.tracks === 0) return { text: from ? `Loading from ${from}…` : 'Loading the catalogue…' };
		if (w.more) return { text: `${fmtCount(w.tracks)} tracks from ${fmtCount(w.releases)}${w.total ? ` of ${fmtCount(w.total)}` : ''} releases${w.state === 'loading' ? ', loading more…' : ' so far — scroll for more'}` };
		return null;
	});
	// The desktop's own work for the page, whichever side the list shows.
	const working = createMemo((): { text: string; busy: boolean } | null => {
		const w = props.work();
		if (!w) return null;
		const text = workText(w, kind());
		return text ? { text, busy: w.phase !== null } : null;
	});

	return (
		<div class="eh" data-kind={kind()}>
			<div class="eh-art" classList={{ 'eh-art--round': kind() === 'artist' }}>
				<Show when={image()} fallback={<span class="eh-art__initials">{initials(name())}</span>}>
					{(src) => <img class="eh-art__img" src={src()} alt="" draggable={false} onError={() => setImageFailed(src())} />}
				</Show>
			</div>

			<div class="eh-head">
				<div class="eh-titleline">
					<h1 class="eh-name" title={name()}>{name()}</h1>
					<Show when={props.header()?.ref.kind === 'artist' && props.header()!.badges.length > 0 ? props.header() : null}>
						{(h) => (
							<span class="eh-badges">
								<For each={h().badges}>{(b) => <span class={`eh-badge eh-badge--${b}`} title={badgeTitle(b, h())}>{BADGE_LABEL[b]}</span>}</For>
							</span>
						)}
					</Show>
					<Show when={props.header()?.ref.kind === 'artist' ? props.header()!.reach : null}>
						{(r) => (
							<ReachMark reach={r()}>
								<span class="eh-reach__label">Reach</span>
								<span class="eh-reach__score">{r().score.toFixed(1)}</span>
								<Show when={r().change !== null && Math.abs(r().change!) >= 0.1}>
									<span class="eh-reach__change" classList={{ 'is-up': r().change! > 0, 'is-down': r().change! < 0 }}>{fmtChange(r().change!)}</span>
								</Show>
							</ReachMark>
						)}
					</Show>
					<Show when={props.header()?.follow}>
						{(f) => (
							// "Following" says where things stand; on hover the same
							// button says what a click does.
							<button
								type="button"
								class="eh-follow"
								classList={{ 'is-following': f().following, 'is-leaving': f().following && followHover() }}
								disabled={followBusy()}
								title={f().following ? 'Stop following: new releases stop arriving in Discover' : 'Follow: new releases arrive in Discover'}
								onMouseEnter={() => setFollowHover(true)}
								onMouseLeave={() => setFollowHover(false)}
								onFocus={() => setFollowHover(true)}
								onBlur={() => setFollowHover(false)}
								onClick={() => void follow()}
							>
								{f().following ? (followHover() ? 'Unfollow' : f().muted ? 'Following (muted)' : 'Following') : 'Follow'}
							</button>
						)}
					</Show>
					<div class="eh-stores">
						<For each={links()}>
							{(l) => (
								<button type="button" class="eh-store" title={`Open in ${storeName(l.source)}`} aria-label={`Open in ${storeName(l.source)}`} onClick={() => props.onLink(l)}>
									<Show when={brandIcon(l.source)} fallback={<span class="eh-store__text">{storeName(l.source)}</span>}>
										{(icon) => <span class="eh-store__icon" innerHTML={icon()} />}
									</Show>
								</button>
							)}
						</For>
					</div>
				</div>
				<div class="eh-facts">
					<For each={facts()}>{(f) => <span>{f}</span>}</For>
					<Show when={props.pending()}><span class="eh-facts__pending">asking the catalogue…</span></Show>
					{/* Closed: the work line is hidden with the rest, so what the
					    desktop is doing for the page rides the facts line. */}
					<Show when={props.compact() ? working() : null}>
						{(w) => (
							<span class="eh-facts__work" classList={{ 'is-busy': w().busy }} role="status">
								<i class="eh-work__dot" aria-hidden="true" />
								{w().text}
							</span>
						)}
					</Show>
				</div>
			</div>

			<div class="eh-more">
				<Show when={props.header()}>
					{(h) => (
						<div class="eh-rows">
							<Show when={h().ref.kind === 'album' && h().artists.length > 0}>
								<Links label="By" chips={h().artists} onOpen={props.onOpen} />
							</Show>
							<Show when={h().labels.length > 0}>
								<Show
									when={h().ref.kind === 'artist'}
									fallback={<Links label={h().labels.length === 1 ? 'Label' : 'Labels'} chips={h().labels} onOpen={props.onOpen} />}
								>
									{/* An artist's labels, most releases first: the first few by name, the rest behind "+n more". */}
									<Links label={h().labels.length === 1 ? 'Label' : 'Labels'} chips={h().labels} onOpen={props.onOpen} counted max={LABELS_SHOWN} />
								</Show>
							</Show>
							<Show when={h().ref.kind === 'label' && h().artists.length > 0}>
								<Links label="Artists" chips={h().artists} onOpen={props.onOpen} />
							</Show>
							<Show when={h().genres.length > 0}>
								<div class="eh-row">
									<span class="eh-row__label">{h().genres.length === 1 ? 'Genre' : 'Genres'}</span>
									<span class="eh-row__text">{h().genres.map((g) => g.name).join(', ')}</span>
								</div>
							</Show>
							{/* Who it makes tracks with, most shared tracks first: the first few by name, the rest behind "+n more". */}
							<Show when={h().ref.kind === 'artist' && h().collabs.length > 0}>
								<Links label="Collabs" chips={h().collabs} onOpen={props.onOpen} counted max={COLLABS_SHOWN} />
							</Show>
							<Show when={h().ref.kind === 'artist' ? activeYears(h().activity) : null}>
								{(years) => (
									<div class="eh-row">
										<span class="eh-row__label">Active</span>
										<span class="eh-row__text">{years()}</span>
									</div>
								)}
							</Show>
							<Show when={h().ref.kind === 'artist'}>
								<Show
									when={h().similar.length > 0 || props.similar.chips().length > 0}
									fallback={
										<Show when={props.similar.canResearch(h().ref)}>
											<div class="eh-row">
												<span class="eh-row__label">Similar</span>
												<span class="eh-row__links">
													<Show when={props.similar.state() === 'idle'}>
														<button type="button" class="eh-link eh-link--action" title="Ask the assistant to research similar artists (uses your model key)" onClick={() => props.onResearchSimilar()}>Find similar artists</button>
													</Show>
													<Show when={props.similar.state() === 'running'}><span class="eh-row__note">researching…</span></Show>
													<Show when={props.similar.state() === 'done'}><span class="eh-row__note">nothing found</span></Show>
													<Show when={props.similar.state() === 'unavailable'}><span class="eh-row__note">set up the assistant in Settings to research similar artists</span></Show>
													<Show when={props.similar.state() === 'error'}>
														<button type="button" class="eh-link eh-link--action" onClick={() => props.onResearchSimilar()}>Research failed — try again</button>
													</Show>
												</span>
											</div>
										</Show>
									}
								>
									<Links
										label="Similar"
										chips={h().similar.length > 0 ? h().similar : props.similar.chips()}
										onOpen={props.onOpen}
										note={h().similar.length > 0 ? undefined : 'via research'}
									/>
								</Show>
							</Show>
							<Show when={h().owned.nameHint}>
								{(hint) => (
									<div class="eh-row">
										<span class="eh-row__label">Library</span>
										<span class="eh-row__links">
											<button type="button" class="eh-link eh-link--action" onClick={(e) => props.onOpen(hint(), { newTab: e.ctrlKey || e.metaKey })}>
												Your library has an artist named {hint().name} — open it
											</button>
										</span>
									</div>
								)}
							</Show>
							<Show when={h().world.reason === 'ambiguous' && (h().world.candidates?.length ?? 0) > 0}>
								<Links label="Which one" chips={h().world.candidates!} onOpen={props.onOpen} />
							</Show>
							{/* Nothing ties the library's artist to one of the streaming
							    service's of that name: offered, never assumed. */}
							<Show when={h().world.reason === 'unknown' && (h().world.candidates?.length ?? 0) > 0}>
								<Links
									label="On Spotify"
									chips={h().world.candidates!}
									onOpen={props.onOpen}
									note={h().world.candidates!.length > 1 ? 'same name — open the one you mean' : 'same name — open it if this is them'}
								/>
							</Show>
						</div>
					)}
				</Show>
				<Show when={status()}>
					{(s) => (
						<div class="eh-status">
							<span>{s().text}</span>
							<Show when={s().retry}><button type="button" class="eh-link eh-link--action" onClick={() => props.onRetryWorld()}>Try again</button></Show>
						</div>
					)}
				</Show>
				<Show when={working()}>
					{(w) => (
						<div class="eh-status eh-work" classList={{ 'is-busy': w().busy }} role="status">
							<span class="eh-work__dot" aria-hidden="true" />
							<span>{w().text}</span>
						</div>
					)}
				</Show>
			</div>
		</div>
	);
}

export interface EntityHeaderHandle { destroy(): void }

export function mountEntityHeader(host: HTMLElement, props: EntityHeaderProps): EntityHeaderHandle {
	const dispose = render(() => <EntityHeader {...props} />, host);
	return { destroy: dispose };
}

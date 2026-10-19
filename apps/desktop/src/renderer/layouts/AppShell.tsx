// AppShell — the entire renderer shell (Phase 3.E).
//
// Renders the full structural skeleton in one mount: the `.app-shell`
// wrapper, the four primary regions as id-based hosts (TopFrame,
// PlayerFooter, Sidebar, MainPane), the toast stack, and the three
// shared overlays (omnibar, settings modal, track-edit modal). After
// this, index.html collapses to a single `<div id="app-root"></div>`.
//
// Why id-based hosts and not nested mounts:
//
// The other four layouts (TopFrame, PlayerFooter, Sidebar, MainPane)
// each take large, state-coupled prop bundles wired through main.ts —
// activeSource signals, click callbacks, snapshot pulls, persistent-
// scroll restore, etc. Threading those through AppShell would be pure
// prop drilling. Instead the shell renders empty hosts and main.ts/
// boot() continues to call mountTopFrame / mountPlayerFooter /
// mountSidebar / mountMainPane against them by id. Same convention
// every host in the codebase already uses.
//
// Future multi-deck shell would be `mountTwoDeckLayout(root)` rendering
// two `<div id="player-footer-host-{a,b}"></div>` hosts; main.ts would
// call mountPlayerFooter twice with different deck contexts.

import { render } from 'solid-js/web';

export interface AppShellHandle {
	destroy(): void;
}

export function AppShell() {
	return (
		<div class="app-shell">
			{/* TopFrame host — filled by mountTopFrame() in main.ts/boot()
			    (layouts/TopFrame.tsx). The layout renders the entire bar
			    (logo, source tabs, state tabs, volume control, analyzer
			    chip, player-mode toggle, omnibar trigger, settings,
			    avatar, window controls) into this slot. */}
			<div id="topframe-host"></div>

			{/* PlayerFooter host — filled by mountPlayerFooter() in main.ts/boot()
			    (layouts/PlayerFooter.tsx). The layout composes every player
			    surface (now-playing card, main waveform, mini wavemap,
			    transport, cue grid, plus the loop placeholder) into a single
			    Solid render tree sharing one reactive root. */}
			<footer class="player" id="player-footer-host"></footer>

			<div class="app">
				{/* Sidebar host — filled by mountSidebar() (layouts/Sidebar.tsx).
				    The host IS the styled <aside class="sidebar"> so that
				    grid-area + flex column + overflow:hidden land on the
				    direct grid child of .app; otherwise the row defaults to
				    content-height and the inner .playlists never scrolls.
				    Mirrors the #main-pane-host pattern below. */}
				<aside class="sidebar" id="sidebar-host"></aside>

				{/* MainPane host — filled by mountMainPane() (layouts/MainPane.tsx).
				    Inner ids (#playlist-title, #sync-list, #dl-list,
				    #tracks-view, …) are preserved by
				    the layout, so existing renderEmptyState / renderSyncView /
				    renderDownloadsView / mountMainTrackList target
				    them unchanged. */}
				<main class="main" id="main-pane-host"></main>

				{/* Agent dock host — filled by mountAgentDock() in main.ts/boot()
				    (components/AgentPanel.tsx). A third grid column so the agent
				    panel is available on EVERY tab (Library/Rekordbox/Spotify/
				    Discover) and can capture the current view as context.
				    Hidden ⇒ the auto column collapses to zero. Toggled by the
				    fixed right-edge ✦ handle (also mounted by mountAgentDock). */}
				<aside class="agent-dock" id="agent-dock-host" hidden></aside>

				{/* Toast stack — small status messages anchored bottom-right. */}
				<div class="toast-stack" id="toast-stack" aria-live="polite"></div>

				{/* Now-playing chip host — filled by mountNowPlayingChip() in
				    main.ts/boot() (components/NowPlayingChip.tsx). Floating
				    pill shown when the playing track's source doesn't match
				    the active tab's context; clicking it jumps to the owning
				    tab. The docked player collapses while it's visible. */}
				<div id="np-chip-host"></div>

				{/* Omnibar — global quick-open popup. Top-anchored over the whole
				    shell, driven by renderer/omnibar.ts. Source pills live in the
				    head row, the query input below, and a scrollable result list
				    under that. Footer holds keyboard hints + the "keep query
				    between sessions" toggle. */}
				<div class="omnibar-overlay" id="omnibar-overlay" hidden>
					<div class="omnibar" role="dialog" aria-modal="true" aria-label="Quick open">
						{/* Header row: source scope pills + Syntax toggle. The pills
						    are populated dynamically from omnibar.ts; the Syntax
						    button swaps the body to the grammar cheatsheet view. */}
						<div class="omnibar__head">
							<div class="omnibar__pills" id="omnibar-pills" role="tablist"></div>
							<button class="omnibar__syntax-btn" id="omnibar-syntax-btn" type="button" title="Search syntax">Syntax</button>
						</div>
						{/* Search view — the default. Holds input row, result list,
						    and footer hints + Keep-query toggle. */}
						<div class="omnibar__view" id="omnibar-view-search">
							<div class="omnibar__search">
								<svg class="omnibar__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
								<input id="omnibar-input" type="text" spellcheck={false} autocomplete="off" placeholder="Search tracks, playlists, folders…  Try s/, l/, r/, zen/uplifting/, artist:foo bpm<124" />
								<span class="omnibar__scope-chip" id="omnibar-scope-chip" hidden></span>
							</div>
							<div class="omnibar__results" id="omnibar-results" role="listbox"></div>
							<div class="omnibar__foot">
								<div class="omnibar__hints">
									<span><kbd>↑</kbd><kbd>↓</kbd> nav</span>
									<span><kbd>⇥</kbd> source</span>
									<span><kbd>⏎</kbd> open</span>
									<span><kbd>esc</kbd> clear / close</span>
								</div>
								<label class="omnibar__keep" title="Keep search term between sessions">
									<input type="checkbox" id="omnibar-keep" />
									<span>Keep query</span>
								</label>
							</div>
						</div>
						{/* Syntax view — grammar cheatsheet. Static content with a
						    Back button that returns to the search view. */}
						<div class="omnibar__view omnibar__view--syntax" id="omnibar-view-syntax" hidden>
							<div class="omnibar__syntax-head">
								<button class="omnibar__syntax-back" id="omnibar-syntax-back" type="button" title="Back to search">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
									<span>Back</span>
								</button>
								<span class="omnibar__syntax-title">Search syntax</span>
							</div>
							<div class="omnibar__syntax-body">
								<section>
									<h4>Basic terms</h4>
									<dl>
										<dt><code>ben böhmer</code></dt>
										<dd>two bare terms — AND across all attributes</dd>
										<dt><code>"ben böhmer"</code></dt>
										<dd>quoted phrase as a single term</dd>
									</dl>
								</section>
								<section>
									<h4>Attributes</h4>
									<dl>
										<dt><code>artist:foo</code></dt>
										<dd>substring of <em>foo</em> in artist</dd>
										<dt><code>artist=&#123;Ben Böhmer&#125;</code></dt>
										<dd>exact match (curly braces hold the value, spaces OK)</dd>
									</dl>
									<p class="omnibar__syntax-meta">
										<strong>String:</strong> title, artist, album, label, genre, key &nbsp;·&nbsp;
										<strong>Number:</strong> bpm, time, rating, plays, drops, breakdowns, lra, diss, dens, bright, punch, intro, outro, drop
									</p>
								</section>
								<section>
									<h4>Tags</h4>
									<dl>
										<dt><code>#deep</code></dt>
										<dd>tracks with that tag</dd>
										<dt><code>#deep,balkan</code></dt>
										<dd>two tags (AND)</dd>
										<dt><code>#"deep house"</code></dt>
										<dd>quoted name with spaces</dd>
									</dl>
								</section>
								<section>
									<h4>Sources</h4>
									<dl>
										<dt><code>source:rekordbox</code> &nbsp; <code>src:rb</code></dt>
										<dd>only tracks in the Rekordbox collection</dd>
										<dt><code>source:spotify</code></dt>
										<dd>spotify, tidal, local, beatport — by source link</dd>
									</dl>
								</section>
								<section>
									<h4>Comparisons</h4>
									<dl>
										<dt><code>bpm=122</code> &nbsp; <code>rating=5</code></dt>
										<dd>equals — works for any number field</dd>
										<dt><code>bpm&lt;120</code></dt>
										<dd>less-than</dd>
										<dt><code>rating&gt;=4</code> &nbsp; <code>bpm&lt;=120</code></dt>
										<dd>inclusive bounds</dd>
										<dt><code>120&lt;=bpm&lt;=122</code></dt>
										<dd>range (between)</dd>
										<dt><code>120</code></dt>
										<dd>a bare number also matches exact BPM</dd>
									</dl>
								</section>
								<section>
									<h4>Boolean operators</h4>
									<dl>
										<dt><code>a &amp; b</code> &nbsp; <code>a AND b</code></dt>
										<dd>both — same as plain space</dd>
										<dt><code>a | b</code> &nbsp; <code>a OR b</code></dt>
										<dd>either</dd>
										<dt><code>(#b1 | #b2) &amp; #p3</code></dt>
										<dd>group with parens; AND binds tighter than OR</dd>
									</dl>
								</section>
								<section>
									<h4>Omnibar only</h4>
									<dl>
										<dt><code>s/</code> &nbsp; <code>t/</code> &nbsp; <code>r/</code></dt>
										<dd>scope to Spotify / Tidal / Rekordbox (collection + local files)</dd>
										<dt><code>zen/uplifting/</code></dt>
										<dd>narrow to a Rekordbox folder subtree</dd>
									</dl>
								</section>
							</div>
						</div>
					</div>
				</div>

				{/* Settings modal host — filled by mountSettingsModal() in
				    main.ts/boot() (layouts/SettingsModal.tsx). The component
				    paints the tabbed shell + three panel hosts; main.ts still
				    paints each panel body imperatively via renderSettings*. */}
				<div id="settings-modal-host"></div>

				{/* Track-edit modal host — filled by mountTrackEditModal() in
				    main.ts/boot() (layouts/TrackEditModal.tsx). The component
				    paints the form structure with the same field names
				    (title, artists, …, spotifyUrl, tidalUrl, beatportUrl) so
				    main.ts's openTrackEditor() / saveTrackEditor() can read
				    + write the form fields by name. */}
				<div id="track-edit-modal-host"></div>

				{/* Analyze modal host — filled by mountAnalyzeModal() in
				    main.ts/boot() (layouts/AnalyzeModal.tsx). Opened from the
				    "Analyze…" context-menu item on the track list to pick
				    which advanced features (brightness, power, loudness range,
				    dissonance, density, punch) to compute on the selected
				    track(s). MusicExtractor is skipped by default; this modal
				    is the opt-in surface. */}
				<div id="analyze-modal-host"></div>

				{/* Sync-to-Rekordbox modal host — filled by mountSyncToRekordboxModal()
				    in main.ts/boot() (layouts/SyncToRekordboxModal.tsx). Opened from
				    the per-track or per-playlist context-menu "Sync to Rekordbox…"
				    item. Drives the explicit backup → write → verify flow with a
				    restore-or-leave choice on verification failure. */}
				<div id="sync-to-rekordbox-modal-host"></div>

				{/* Sync-FROM-Rekordbox modal host (pull direction) — filled by
				    mountSyncFromRekordboxModal() in main.ts/boot(). Opened from the
				    "Sync from Rekordbox…" context-menu item on rb-linked tracks,
				    rb playlists, and rb folders. idle / in-flight / conflicts;
				    no verify surface (a pull never writes master.db). */}
				<div id="sync-from-rekordbox-modal-host"></div>

				{/* Backup progress + restore dialogs — filled by
				    mountBackupProgressDialog() / mountBackupRestoreDialog() in
				    main.ts/boot(). Opened from Settings → Backup. */}
				<div id="backup-progress-host"></div>
				<div id="backup-restore-host"></div>

				{/* Rating dialog host — filled by mountRatingDialog() in main.ts/boot()
				    (layouts/RatingDialog.tsx). Opened by the "Rate…" track context-
				    menu item or the R keyboard shortcut. Sets the Rekordbox 0..5
				    star rating on every track in the current selection. */}
				<div id="rating-dialog-host"></div>

				{/* Name-prompt host — filled by mountNamePromptDialog() in
				    main.ts/boot() (layouts/NamePromptDialog.tsx). Generic
				    single-input "name this" modal; used by the pinned-search
				    "Create Playlist…" flow. */}
				<div id="name-prompt-host"></div>
				<div id="delete-tracks-host"></div>
				<div id="confirm-dialog-host"></div>
				{/* Convert to WAV run status (layouts/WavConvertDialog.tsx). */}
				<div id="wav-convert-host"></div>

				{/* Merge-tracks host — filled by mountMergeTracksDialog() in
				    main.ts/boot() (layouts/MergeTracksDialog.tsx). Offered by the
				    Edit Track save flow when a provider URL already belongs to
				    another library track. */}
				<div id="merge-tracks-host"></div>

				{/* Artist merge review host — filled by mountArtistMergeReviewDialog()
				    in main.ts/boot() (layouts/ArtistMergeReviewDialog.tsx). The
				    Artists folder's "Suggested merges…" list: bare name vs the
				    same name with a country/city tag, merge or dismiss per pair. */}
				<div id="artist-merge-host"></div>

				{/* MCP confirm host — filled by mountMcpConfirmModal() in
				    main.ts/boot() (layouts/McpConfirmModal.tsx). Approval gate
				    for Claude-initiated writes arriving over the MCP bridge
				    (streaming playlist mutations, removals). */}
				<div id="mcp-confirm-host"></div>

				{/* Organize modal host — filled by mountOrganizeDialog() in
				    main.ts/boot() (layouts/TagPlaylistPickerDialog.tsx). The
				    unified tag + playlist picker: opened by the O keyboard
				    shortcut, the "Organize…" context-menu item, or the player
				    "+" button. Three-column grid (Tags / Local·Rekordbox /
				    Streaming·Spotify) with three-state chips across a multi-
				    track selection; smart + hidden playlists filtered server-
				    side. */}
				<div id="organize-host"></div>

				{/* (Player relocated above .app — it now sits as a horizontal strip
				    directly below the topframe, sharing its bg color with active
				    tabs so the two read as one continuous panel.) */}
			</div>
		</div>
	);
}

export function mountAppShell(root: HTMLElement): AppShellHandle {
	const dispose = render(() => <AppShell />, root);
	return { destroy: dispose };
}

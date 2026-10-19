// Settings feature — the per-panel body painters for the Settings modal
// (Connections / Rekordbox / Player / UI) plus their persistence helpers.
// Extracted verbatim from main.ts (F3.1). Cross-feature calls that still
// live in main.ts (Spotify sync flow, library folders panel, the
// SettingsModalHandle lifecycle, deck access, reorder gate) are injected
// once from boot() via initSettingsFeature — this module never imports
// main.ts. IPC goes through the data/api.ts facades, never the raw
// preload bridge (boundary-checked at build time).

import { escapeHtml, formatBytes } from '../ui/format.js';
import { showToast } from '../ui/toast.js';
import { syncState } from '../data/sync.js';
import { authApi, sourcesApi, rekordboxApi, dialogApi, creditsApi } from '../data/api.js';
import { getSourceCapabilities, SYNC_INTERVAL_OPTIONS, STREAMING_SOURCES, DEFAULT_SOURCE_SYNC_SETTINGS, type StreamingSource, type SourceSyncSettings } from '@curator/shared';
import { getConnectedControllers } from '../controllers.js';
import type { SettingsTab } from '../layouts/SettingsModal.jsx';
import type { SourceTabId } from '../layouts/TopFrame.jsx';
import type { DeckController } from '../deck/controller.js';
import type { PlayerMode } from '../player.js';
import { uiSettingsSignal, updateUiSettings, type StateTabKey, type StateTabMode } from './uiSettings.js';
import { similaritySettingsSignal, updateSimilaritySettings, type KeyRelatedLevel, type MetricRange } from './similarity.js';
import { mountMirSettings } from './mirSettings.js';
import { mountBackupSettings } from './backupSettings.js';
import { mountAccountSettings } from './accountSettings.js';
import { log } from '../data/log.js';

const slog = log.for('settings');

export interface SettingsFeatureDeps {
	// Modal handle lifecycle stays in main.ts (boot() owns mountSettingsModal
	// + the open/close entry points); the connections panel closes the modal
	// before kicking off a manual sync.
	closeSettingsModal(): void;
	// Spotify plan-and-confirm sync flow (with its retry loop) — main.ts.
	runSpotifySync(opts?: { force?: boolean }): Promise<void>;
	// Tidal background sync (toast + tab indicator, no Sync view) — main.ts.
	runTidalSync(opts?: { force?: boolean }): Promise<void>;
	// Full data refresh after connect/disconnect.
	refreshAll(): Promise<void>;
	// Reorder gate re-evaluation after a writeSyncAuto change.
	updateReorderableState(): void;
	// Library tab body — the folder-list panel painters live in
	// features/libraryPanel.ts (F3.2); boot() forwards its exports here.
	refreshLibraryFolders(): Promise<void>;
	renderLibraryFoldersModalIfOpen(): void;
	// Player panel reads/writes the deck's quantize signal; the deck handle
	// is created in boot() after the audio sidecar is up.
	getDeck(): DeckController | null;
	// Per-mode "auto-play next track in list" preference. Owned by player.ts
	// (the runtime consumer at end-of-track); injected here so the Settings
	// panel can read/write it without settings → player coupling.
	getAutoplayNext(mode: PlayerMode): boolean;
	setAutoplayNext(mode: PlayerMode, on: boolean): void;
}

let deps: SettingsFeatureDeps;

export function initSettingsFeature(d: SettingsFeatureDeps): void {
	deps = d;
}

export function handleSettingsTabActivate(tab: SettingsTab): void {
	if (tab === 'connections') {
		renderSettingsConnections().catch((err) => slog.error('render failed', err));
	} else if (tab === 'library') {
		// Library panel uses the existing folder-list renderer. Population
		// of library.libraryFolders() happens via refreshLibraryFolders ahead of
		// open; the render below is a paint over the up-to-date data.
		deps.refreshLibraryFolders().then(() => deps.renderLibraryFoldersModalIfOpen());
	} else if (tab === 'rekordbox') {
		renderSettingsRekordbox().catch((err) => slog.error('rekordbox render failed', err));
	} else if (tab === 'player') {
		renderSettingsPlayer();
	} else if (tab === 'similarity') {
		renderSettingsSimilarity();
	} else if (tab === 'ui') {
		renderSettingsUI().catch((err) => slog.error('ui render failed', err));
	} else if (tab === 'backup') {
		const host = document.getElementById('settings-backup');
		if (host) mountBackupSettings(host);
	} else if (tab === 'account') {
		const host = document.getElementById('settings-account');
		if (host) mountAccountSettings(host);
	}
}

// Drop the rekordbox event subscription so the renderer stops receiving
// frames it doesn't have a UI surface for. Re-subscribed on next open.
export function handleSettingsClose(): void {
	rekordboxImportUnsub?.();
	rekordboxImportUnsub = null;
}

export async function renderSettingsConnections(): Promise<void> {
	const wrap = document.getElementById('settings-connections');
	if (!wrap) return;
	const auth = await authApi.status();
	await ensureSourceSyncSettingsLoaded();

	// Sync sub-panel — rendered beneath the connection row when the source
	// is connected. Toggles for auto read-sync (+ interval) and auto
	// write-sync. When ALL sync capabilities are off (Tidal today), we
	// short-circuit to a single "Coming soon" line rather than render two
	// disabled controls that look broken.
	const syncPanel = (src: StreamingSource): string => {
		const caps = getSourceCapabilities(src);
		const cfg = getSourceSyncSettings(src);
		if (!caps.canReadSync && !caps.canWriteSync) {
			return `<div class="settings-sync settings-sync--placeholder" data-src="${src}">
				<span class="settings-sync__hint">Auto-sync — coming soon</span>
			</div>`;
		}
		const intervalOptions = SYNC_INTERVAL_OPTIONS.map((m) =>
			`<option value="${m}"${m === cfg.readIntervalMin ? ' selected' : ''}>${m === 60 ? '1 hour' : m + ' min'}</option>`
		).join('');
		const readSection = caps.canReadSync
			? `<label class="settings-sync__row">
				<input type="checkbox" data-sync-field="readSyncAuto"${cfg.readSyncAuto ? ' checked' : ''} />
				<span>Pull remote changes</span>
				<span class="settings-sync__every">every</span>
				<select data-sync-field="readIntervalMin"${cfg.readSyncAuto ? '' : ' disabled'}>${intervalOptions}</select>
			</label>`
			: `<div class="settings-sync__row settings-sync__row--disabled">
				<span>Pull remote changes</span>
				<span class="settings-sync__hint">coming soon</span>
			</div>`;
		const writeSection = caps.canWriteSync
			? `<label class="settings-sync__row">
				<input type="checkbox" data-sync-field="writeSyncAuto"${cfg.writeSyncAuto ? ' checked' : ''} />
				<span>Push local edits immediately</span>
			</label>`
			: `<div class="settings-sync__row settings-sync__row--disabled">
				<span>Push local edits immediately</span>
				<span class="settings-sync__hint">coming soon</span>
			</div>`;
		return `<div class="settings-sync" data-src="${src}">${readSection}${writeSection}</div>`;
	};

	const block = (src: StreamingSource): string => {
		const a = auth[src];
		const label = src === 'spotify' ? 'Spotify' : 'Tidal';
		const name = a.displayName ?? label;
		// No app credentials in this build: the same row shape as the sidecar
		// "unavailable" states — a state label, no Connect button to fail on.
		// (A connected token from a restored DB still shows below as
		// connected; it just never refreshes.)
		if (!a.configured && !a.connected) {
			const vars = src === 'spotify' ? 'CURATOR_SPOTIFY_CLIENT_ID' : 'CURATOR_TIDAL_CLIENT_ID and CURATOR_TIDAL_CLIENT_SECRET';
			return `
				<div class="settings-connection" data-src="${src}">
					<div class="settings-row">
						<span class="settings-row__label">${escapeHtml(label)}</span>
						<span class="settings-row__state settings-row__state--off">Not configured</span>
						<span class="settings-toggle__hint">This build has no ${escapeHtml(label)} app credentials (${vars}). See .env.example.</span>
					</div>
				</div>
			`;
		}
		if (!a.connected) {
			return `
				<div class="settings-connection" data-src="${src}">
					<div class="settings-row">
						<span class="settings-row__label">${escapeHtml(label)}</span>
						<span class="settings-row__state settings-row__state--off">Disconnected</span>
						<button class="btn-primary" data-action="connect" data-src="${src}">Connect</button>
					</div>
				</div>
			`;
		}
		// Swap "Sync now" → "Stop" while a manual sync is mid-flight or
		// stuck in the connection-lost retry loop. Stop is the ONLY way
		// the user can break out of an infinite retry — the source-tab
		// breathing rectangle is read-only. (Spotify only: Tidal's sync has
		// no retry loop, so there's nothing to stop mid-flight.)
		const isActive = src === 'spotify' && (syncState.running() || syncState.retrying());
		const resyncTitle = src === 'spotify'
			? 'Re-fetch every playlist from scratch — use when local data has drifted from Spotify (positions, removed tracks, addedAt)'
			: 'Re-fetch every playlist from scratch — bypasses the lastModifiedAt change check';
		const syncBtns = isActive
			? '<button class="btn-secondary" data-action="stop-sync" data-src="' + src + '">Stop</button>'
			: '<button class="btn-secondary" data-action="sync" data-src="' + src + '">Sync now</button>'
			+ '<button class="btn-secondary" data-action="resync-full" data-src="' + src + '" title="' + resyncTitle + '">Resync entirely</button>';
		return `
			<div class="settings-connection" data-src="${src}">
				<div class="settings-row">
					<span class="settings-row__label">${escapeHtml(label)}</span>
					<span class="settings-row__state settings-row__state--on">Connected · ${escapeHtml(name)}</span>
					${syncBtns}
					<button class="btn-secondary" data-action="disconnect" data-src="${src}">Disconnect</button>
				</div>
				${syncPanel(src)}
			</div>
		`;
	};

	wrap.innerHTML = block('spotify') + block('tidal');

	// Connection-row buttons (connect / sync / disconnect).
	wrap.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const action = btn.dataset.action;
			const src = btn.dataset.src as 'spotify' | 'tidal';
			try {
				if (action === 'connect') {
					await (src === 'spotify' ? authApi.spotifyStart() : authApi.tidalStart());
				} else if (action === 'disconnect') {
					const label = src === 'spotify' ? 'Spotify' : 'Tidal';
					if (!window.confirm(`Disconnect ${label}?\n\nYour synced tracks stay; you'll need to reconnect to sync again or play tracks in-app.`)) return;
					await (src === 'spotify' ? authApi.spotifyDisconnect() : authApi.tidalDisconnect());
					showToast(`${label} disconnected`, { kind: 'info' });
				} else if (action === 'sync') {
					if (src === 'spotify') {
						// Trigger the plan-and-confirm Sync flow directly.
						// Used to dispatch a click to the SyncView's hidden
						// button, but the view is no longer auto-opened so
						// relying on it being painted is fragile.
						deps.closeSettingsModal();
						void deps.runSpotifySync();
						return;
					}
					if (src === 'tidal') {
						deps.closeSettingsModal();
						void deps.runTidalSync();
						return;
					}
				} else if (action === 'resync-full') {
					if (src === 'spotify') {
						// Confirm before doing the expensive full re-fetch.
						// User said yes → run with force=true, bypassing the
						// snapshot_id short-circuit on every playlist.
						if (!window.confirm('Resync every Spotify playlist from scratch?\n\nThis re-fetches every playlist\'s tracks regardless of whether Spotify says they changed. Useful when local data has drifted (positions, missing/extra tracks).\n\nThis can take a while for large libraries.')) return;
						deps.closeSettingsModal();
						void deps.runSpotifySync({ force: true });
						return;
					}
					if (src === 'tidal') {
						if (!window.confirm('Resync every Tidal playlist from scratch?\n\nThis re-fetches every playlist\'s tracks regardless of whether Tidal says they changed.')) return;
						deps.closeSettingsModal();
						void deps.runTidalSync({ force: true });
						return;
					}
				} else if (action === 'stop-sync') {
					if (src === 'spotify') {
						// Flip the flag — the retry loop's sleep gate breaks
						// out immediately, the next attempt boundary exits
						// cleanly with a "Sync stopped" toast. No await: the
						// loop owns its own state transitions.
						syncState.setStopRequested(true);
						// Re-render right away so the button reads as
						// pressed; the loop's own re-render fires once it
						// observes the stop.
						void renderSettingsConnections();
						return;
					}
				}
				await deps.refreshAll();
				await renderSettingsConnections();
			} catch (err) {
				slog.error('action failed', err, { action });
			}
		});
	});

	// Sync sub-panel inputs — write-through to ui-settings on every change.
	// Toggling auto-read flips the interval dropdown's disabled state; that
	// requires a re-render of just the sub-panel, easiest done via a full
	// re-render of the connections wrap (cheap — two rows).
	wrap.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-sync-field]').forEach((el) => {
		el.addEventListener('change', () => {
			const panel = el.closest<HTMLElement>('.settings-sync');
			const src = panel?.dataset.src as StreamingSource | undefined;
			if (!src) return;
			const field = el.dataset.syncField as 'readSyncAuto' | 'readIntervalMin' | 'writeSyncAuto';
			const patch: Partial<SourceSyncSettings> = field === 'readIntervalMin'
				? { readIntervalMin: Number((el as HTMLSelectElement).value) }
				: { [field]: (el as HTMLInputElement).checked };
			const next = setSourceSyncSettingsLocal(src, patch);
			// Persist in core (app_setting) — core is the canonical store —
			// and let the scheduler restart its timer + the write router see
			// the new writeSyncAuto value. A failed push is surfaced, not
			// swallowed: the user just flipped a switch that decides whether
			// their edits reach Spotify, so a stale core must not look "on".
			void sourcesApi.setSyncSettings(src, next).catch((err) => {
				log.for('sync-settings').warn('push to core failed', { src }, err);
				showToast('Sync setting not saved', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
				loaded = false;
				void renderSettingsConnections();
			});
			// Re-render so the interval select reflects readSyncAuto's new
			// disabled state, and the reorder gate gets re-evaluated.
			void renderSettingsConnections();
			deps.updateReorderableState();
		});
	});
}

// ─── Per-source sync settings (renderer-side mirror) ────────────────────
// Core's app_setting table is the canonical store — one value shared by the
// dev (http://localhost) and packaged (file://) renderers. This module keeps
// a read cache so synchronous callers (the settings panel painter, the
// drag-reorder gate) don't round-trip; `ensureSourceSyncSettingsLoaded`
// fills it once per boot and every toggle writes through.
let cache: Record<StreamingSource, SourceSyncSettings> = {
	spotify: { ...DEFAULT_SOURCE_SYNC_SETTINGS },
	tidal: { ...DEFAULT_SOURCE_SYNC_SETTINGS },
};
let loaded = false;
let loading: Promise<void> | null = null;

export function getSourceSyncSettings(source: StreamingSource): SourceSyncSettings {
	return { ...cache[source] };
}

function setSourceSyncSettingsLocal(source: StreamingSource, patch: Partial<SourceSyncSettings>): SourceSyncSettings {
	const next: SourceSyncSettings = { ...cache[source], ...patch };
	cache = { ...cache, [source]: next };
	return next;
}

export function ensureSourceSyncSettingsLoaded(): Promise<void> {
	if (loaded) return Promise.resolve();
	if (loading) return loading;
	loading = sourcesApi.getSyncSettings()
		.then((all) => {
			cache = {
				spotify: { ...DEFAULT_SOURCE_SYNC_SETTINGS, ...(all.spotify ?? {}) },
				tidal: { ...DEFAULT_SOURCE_SYNC_SETTINGS, ...(all.tidal ?? {}) },
			};
			loaded = true;
		})
		.catch((err) => {
			log.for('sync-settings').warn('load from core failed — using defaults until retried', undefined, err);
		})
		.finally(() => { loading = null; });
	return loading;
}

// Boot: load the persisted settings, then re-push each syncable source so
// core starts its per-source poll timers only once the window is up (the
// same ordering the old localStorage push had — timers never start inside
// createCoreService). Also re-evaluates the reorder gate, which read the
// defaults before the cache was filled.
// Credit format: core's app_setting is the source of truth (the rekordbox
// push reads it); the UI-settings store mirrors it for instant display.
// Boot pulls core's value into the mirror — unless core has never been
// given one, in which case the renderer's own setting seeds core (a user
// who picked a style before core owned it must not be reset to defaults).
// The Settings radios push every change.
export async function hydrateCreditFormatFromCore(): Promise<void> {
	try {
		const res = await creditsApi.getFormat();
		if (!res.stored) { pushCreditFormatToCore(); return; }
		updateUiSettings((d) => { d.artistSeparator = res.format.separator; d.remixStyle = res.format.remixStyle; });
	} catch (err) {
		log.for('ui-settings').warn('credit format hydrate failed', undefined, err);
	}
}
function pushCreditFormatToCore(): void {
	const s = uiSettingsSignal();
	void creditsApi.setFormat({ separator: s.artistSeparator, remixStyle: s.remixStyle }).catch((err) => {
		log.for('ui-settings').warn('credit format push failed', undefined, err);
	});
}

export async function pushAllSourceSyncSettingsToCore(): Promise<void> {
	await ensureSourceSyncSettingsLoaded();
	for (const src of STREAMING_SOURCES) {
		const caps = getSourceCapabilities(src);
		if (!caps.canReadSync && !caps.canWriteSync) continue;
		void sourcesApi.setSyncSettings(src, getSourceSyncSettings(src)).catch((err) => {
			log.for('sync-settings').warn('initial push to core failed', { src }, err);
		});
	}
	deps.updateReorderableState();
}

// ─── Rekordbox settings panel ────────────────────────────────────────────────
// localStorage-backed flag set + auto-detect probe + read-now button. The
// import progress strip subscribes to onRekordboxEvent while the panel is
// open (subscription is torn down when the modal closes).

// Per-data-class scope flags. Each maps 1:1 to a scope string the Python
// sidecar's scan() dispatches on. Order = display order in the Settings
// panel checkbox list. Default all true (matches the v2 "read metadata
// + read analysis" both-on behaviour).
export interface RekordboxSettings {
	syncTracks: boolean;
	syncPlaylists: boolean;
	syncMyTags: boolean;
	syncCuesGridsPhrases: boolean;
	syncWaveformPeaks: boolean;
	dbPathOverride: string | null;
	key: string | null;
}

// v2 → v3 bump because the flag shape changed from two coarse buckets
// (readMetadata + readAnalysis) to five per-data-class flags. The v2
// migration in loadRekordboxSettings expands each boolean: readMetadata
// → tracks + playlists + mytags; readAnalysis → cues+grids+phrases +
// waveform peaks.
const REKORDBOX_SETTINGS_KEY = 'curator.rekordbox-settings.v3';
const REKORDBOX_SETTINGS_KEY_V2 = 'curator.rekordbox-settings.v2';

const DEFAULT_REKORDBOX_SETTINGS: RekordboxSettings = {
	syncTracks: true,
	syncPlaylists: true,
	syncMyTags: true,
	syncCuesGridsPhrases: true,
	syncWaveformPeaks: true,
	dbPathOverride: null,
	key: null,
};

// Old v2 shape — preserved here for the one-time migration. Don't extend.
interface RekordboxSettingsV2 {
	readMetadata?: boolean;
	readAnalysis?: boolean;
	dbPathOverride?: string | null;
	key?: string | null;
}

export function loadRekordboxSettings(): RekordboxSettings {
	try {
		const raw = localStorage.getItem(REKORDBOX_SETTINGS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<RekordboxSettings>;
			return { ...DEFAULT_REKORDBOX_SETTINGS, ...parsed };
		}
		// First load on v3 — try to migrate from v2 before falling back to
		// defaults. readMetadata maps to all three metadata scopes; readAnalysis
		// to both analysis scopes. Preserve dbPathOverride + key verbatim.
		const v2Raw = localStorage.getItem(REKORDBOX_SETTINGS_KEY_V2);
		if (v2Raw) {
			const v2 = JSON.parse(v2Raw) as RekordboxSettingsV2;
			const meta = v2.readMetadata !== false;
			const anal = v2.readAnalysis !== false;
			const migrated: RekordboxSettings = {
				syncTracks: meta,
				syncPlaylists: meta,
				syncMyTags: meta,
				syncCuesGridsPhrases: anal,
				syncWaveformPeaks: anal,
				dbPathOverride: v2.dbPathOverride ?? null,
				key: v2.key ?? null,
			};
			// Persist the migrated shape under the v3 key so the next load
			// short-circuits straight to the new format.
			saveRekordboxSettings(migrated);
			return migrated;
		}
		return { ...DEFAULT_REKORDBOX_SETTINGS };
	} catch {
		return { ...DEFAULT_REKORDBOX_SETTINGS };
	}
}

function saveRekordboxSettings(s: RekordboxSettings): void {
	try { localStorage.setItem(REKORDBOX_SETTINGS_KEY, JSON.stringify(s)); }
	catch (err) { log.for('rekordbox-settings').warn('persist failed', undefined, err); }
}

let rekordboxImportUnsub: (() => void) | null = null;
// Mirrors RekordboxImportEvent shape (started | progress | completed | failed).
// Stored verbatim for the status-strip painter; reset on each new import.
type AnyRekordboxEvent =
	| { kind: 'started';   mode: 'incremental' | 'full' }
	| { kind: 'progress';  phase: string; done: number; total: number }
	| { kind: 'completed'; totals: Record<string, number>; cancelled: boolean }
	| { kind: 'failed';    errorKind: string; message: string };
let rekordboxLastEvent: AnyRekordboxEvent | null = null;

async function renderSettingsRekordbox(): Promise<void> {
	const wrap = document.getElementById('settings-rekordbox');
	if (!wrap) return;
	const settings = loadRekordboxSettings();

	// Auto-detect path + running state. Best-effort; if the sidecar isn't
	// running yet, fall back to "unknown" and let the user paste manually.
	let detected: { dbPath: string | null; running: boolean } = { dbPath: null, running: false };
	try { detected = await rekordboxApi.detect(); }
	catch (err) { log.for('rekordbox-settings').warn('detect failed', undefined, err); }
	const effectivePath = settings.dbPathOverride ?? detected.dbPath ?? '';

	const checkbox = (id: keyof RekordboxSettings, label: string, hint: string, indent = false): string => `
		<label class="settings-toggle ${indent ? 'settings-toggle--indent' : ''}">
			<input type="checkbox" data-rekordbox-flag="${id}" ${settings[id] ? 'checked' : ''} />
			<span class="settings-toggle__label">${escapeHtml(label)}</span>
			<span class="settings-toggle__hint">${escapeHtml(hint)}</span>
		</label>
	`;

	wrap.innerHTML = `
		<div class="settings-rekordbox__db">
			<div class="settings-rekordbox__path-row">
				<label class="settings-rekordbox__path-label">master.db</label>
				<input class="settings-rekordbox__path-input" id="rekordbox-path" value="${escapeHtml(effectivePath)}" placeholder="Auto-detected path (override here if needed)" />
				<button class="btn-secondary" id="rekordbox-path-browse" type="button">Browse…</button>
			</div>
			${detected.running ? '<div class="settings-rekordbox__warning">Rekordbox is running. Close it before reading to avoid SQLite lock errors.</div>' : ''}
		</div>

		<div class="settings-rekordbox__group">
			<div class="settings-rekordbox__group-title">What to sync</div>
			${checkbox('syncTracks', 'Tracks', 'Title, artist, album, BPM, key, comment, rating, color, play count, last-played, added-at.')}
			${checkbox('syncPlaylists', 'Playlists & folders', 'Rekordbox playlist hierarchy + track membership + smart-playlist definitions.')}
			${checkbox('syncMyTags', 'MyTags', "Rekordbox's MyTag user tags + their track membership.")}
			${checkbox('syncCuesGridsPhrases', 'Cues, beatgrid + downbeats, song phrases', 'Hot cues, memory cues, loops, beatgrid, downbeats, and PSSI song-structure phrases (Intro/Verse/Chorus/etc.).')}
			${checkbox('syncWaveformPeaks', 'Waveform peaks (.cpk files)', "Pre-decoded 3-band waveform bands from Rekordbox's ANLZ files. Skip this if you only care about Curator's own analyzer-produced peaks.")}
		</div>

		<div class="settings-rekordbox__actions">
			<button class="btn-primary"   id="rekordbox-sync-newer"      type="button" title="Reads only rows changed since the last sync (USN watermarked). Conflicts: Curator's edits win over Rekordbox's — your manual changes are preserved.">Sync Newer</button>
			<button class="btn-secondary" id="rekordbox-sync-everything" type="button" title="Reads every row in Rekordbox (ignores the change watermark) and overwrites Curator's edits where Rekordbox has values. Empty Rekordbox values won't clear Curator data — fields like Genre or Label populated from Beatport/MusicBrainz are preserved when Rekordbox has them blank.">Resync Everything</button>
		</div>

		<div class="settings-rekordbox__status" id="rekordbox-status" aria-live="polite"></div>

		<div class="settings-rekordbox__backups">
			<div class="settings-rekordbox__backups-row">
				<span class="settings-rekordbox__backups-text" id="rekordbox-backups-text">Loading backup info…</span>
				<button class="btn-secondary" id="rekordbox-backups-clear" type="button" disabled>Clear</button>
			</div>
			<div class="settings-rekordbox__backups-hint">
				Curator creates a timestamped copy of master.db before every Sync to Rekordbox. Backups are never deleted automatically — clear them here when you're confident the corresponding syncs succeeded.
			</div>
		</div>
	`;

	// Wire checkbox changes — persist on every flip.
	wrap.querySelectorAll<HTMLInputElement>('[data-rekordbox-flag]').forEach((input) => {
		input.addEventListener('change', () => {
			const key = input.dataset.rekordboxFlag as keyof RekordboxSettings;
			if (typeof settings[key] !== 'boolean') return;
			(settings as unknown as Record<string, boolean>)[key] = input.checked;
			saveRekordboxSettings(settings);
		});
	});

	// Path input — persist on blur (saves typing every keystroke).
	const pathInput = wrap.querySelector<HTMLInputElement>('#rekordbox-path');
	pathInput?.addEventListener('blur', () => {
		const v = pathInput.value.trim();
		settings.dbPathOverride = v.length ? v : null;
		saveRekordboxSettings(settings);
	});
	wrap.querySelector<HTMLButtonElement>('#rekordbox-path-browse')?.addEventListener('click', async () => {
		const picked = await dialogApi.pickFolder();
		if (picked && pathInput) {
			// dialog returns a folder; user is expected to point at the
			// master.db file inside. We keep the input free-form so they can
			// edit further.
			pathInput.value = picked;
			settings.dbPathOverride = picked;
			saveRekordboxSettings(settings);
		}
	});

	wrap.querySelector<HTMLButtonElement>('#rekordbox-sync-newer')?.addEventListener('click', () => {
		startRekordboxImport('incremental', settings);
	});
	wrap.querySelector<HTMLButtonElement>('#rekordbox-sync-everything')?.addEventListener('click', () => {
		// "Resync Everything": full re-read AND bypass LMW so Rekordbox values
		// overwrite Curator. The per-field null-preservation rule in the
		// importer still keeps Curator's non-null values when rb has null.
		startRekordboxImport('full', settings, { overwriteCurator: true });
	});

	// Subscribe to events for the lifetime of the panel render. We tear down
	// on the next render or when the modal closes (handled in wireSettingsModal).
	rekordboxImportUnsub?.();
	rekordboxImportUnsub = rekordboxApi.onEvent((evt) => {
		rekordboxLastEvent = evt as AnyRekordboxEvent;
		paintRekordboxStatus();
	});
	paintRekordboxStatus();

	// ─── Backups row — paint + wire Clear ──────────────────────────────────
	const backupsText = wrap.querySelector<HTMLSpanElement>('#rekordbox-backups-text');
	const clearBtn = wrap.querySelector<HTMLButtonElement>('#rekordbox-backups-clear');
	const refreshBackups = async (): Promise<void> => {
		if (!backupsText) return;
		try {
			const list = await rekordboxApi.listBackups(settings.dbPathOverride ?? undefined);
			const totalBytes = list.reduce((acc, b) => acc + b.sizeBytes, 0);
			if (list.length === 0) {
				backupsText.textContent = 'No database backup files.';
				if (clearBtn) clearBtn.disabled = true;
			} else {
				backupsText.textContent = `${list.length} database backup ${list.length === 1 ? 'file' : 'files'}, ${formatBytes(totalBytes)} total`;
				if (clearBtn) clearBtn.disabled = false;
			}
		} catch (err) {
			log.for('rekordbox-backups').warn('list failed', undefined, err);
			backupsText.textContent = 'Unable to read backup info.';
			if (clearBtn) clearBtn.disabled = true;
		}
	};
	clearBtn?.addEventListener('click', async () => {
		// Destructive — confirm before deleting. The PRD spec is "never
		// auto-delete + manual Clear"; we ask once per click.
		if (!window.confirm('Delete every Curator-created master.db backup?\n\nRekordbox\'s own .bak files are not touched.')) return;
		try {
			const res = await rekordboxApi.clearBackups(settings.dbPathOverride ?? undefined);
			showToast(`Cleared ${res.deleted} backup${res.deleted === 1 ? '' : 's'}`, {
				sub: res.freedBytes > 0 ? `${formatBytes(res.freedBytes)} freed` : undefined,
				kind: 'success',
			});
		} catch (err) {
			showToast('Clear backups failed', {
				sub: err instanceof Error ? err.message : String(err),
				kind: 'error',
			});
		}
		await refreshBackups();
	});
	void refreshBackups();
}

export function startRekordboxImport(
	mode: 'incremental' | 'full',
	settings: RekordboxSettings,
	extra: { overwriteCurator?: boolean } = {},
): void {
	const flags = {
		syncTracks: settings.syncTracks,
		syncPlaylists: settings.syncPlaylists,
		syncMyTags: settings.syncMyTags,
		syncCuesGridsPhrases: settings.syncCuesGridsPhrases,
		syncWaveformPeaks: settings.syncWaveformPeaks,
		// Play history is always pulled on library-wide imports (v1 has no
		// settings toggle for it; the pass is read-only and cheap).
		syncHistory: true,
	};
	rekordboxLastEvent = { kind: 'started', mode };
	paintRekordboxStatus();

	rekordboxApi.read({
		mode,
		flags,
		key: settings.key ?? undefined,
		dbPathOverride: settings.dbPathOverride ?? undefined,
		overwriteCurator: extra.overwriteCurator,
	}).then((totals) => {
		const title = extra.overwriteCurator ? 'Rekordbox full sync complete (overwriting Curator)' : 'Rekordbox sync complete';
		// Build a concise per-scope summary from the totals — only mention
		// counts > 0 so disabled scopes don't clutter the line.
		const parts: string[] = [];
		if (totals.tracksMatched) parts.push(`${totals.tracksMatched} tracks`);
		if (totals.playlistsUpserted) parts.push(`${totals.playlistsUpserted} playlists`);
		if (totals.playlistsDeleted) parts.push(`${totals.playlistsDeleted} removed`);
		if (totals.playlistsPruneHeld) parts.push(`${totals.playlistsPruneHeld} removals held — run Sync Everything to apply`);
		if (totals.myTagsUpserted) parts.push(`${totals.myTagsUpserted} mytags`);
		if (totals.myTagsMerged) parts.push(`${totals.myTagsMerged} dead mytags merged`);
		if (totals.myTagsPruned) parts.push(`${totals.myTagsPruned} dead mytags pruned`);
		if (totals.cuesUpserted) parts.push(`${totals.cuesUpserted} cues`);
		if (totals.beatgridsUpserted) parts.push(`${totals.beatgridsUpserted} beatgrids`);
		if (totals.phrasesUpserted) parts.push(`${totals.phrasesUpserted} phrases`);
		if (totals.waveformsUpserted) parts.push(`${totals.waveformsUpserted} waveforms`);
		if (totals.historySessionsUpserted) parts.push(`${totals.historySessionsUpserted} play sessions`);
		showToast(title, {
			sub: parts.length ? parts.join(', ') : 'nothing to sync',
			kind: 'success',
		});
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		showToast('Rekordbox sync failed', { sub: msg, kind: 'error', durationMs: 6000 });
	});
}

function paintRekordboxStatus(): void {
	const el = document.getElementById('rekordbox-status');
	if (!el) return;
	const evt = rekordboxLastEvent;
	if (!evt) { el.textContent = ''; return; }
	if (evt.kind === 'started')   { el.textContent = 'Reading…'; return; }
	if (evt.kind === 'progress')  { el.textContent = `${evt.phase}: ${evt.done}/${evt.total}`; return; }
	if (evt.kind === 'completed') {
		const t = evt.totals;
		el.textContent = `Done. tracks ${t.tracksMatched} · cues ${t.cuesUpserted} · playlists ${t.playlistsUpserted}${evt.cancelled ? ' (cancelled)' : ''}`;
		return;
	}
	if (evt.kind === 'failed')    { el.textContent = `Failed: ${evt.message ?? 'unknown error'}`; return; }
	el.textContent = '';
}

// Player settings — currently just the quantize toggle (formerly the "Q"
// chip in the transport row). Reads the deck's signal directly so the
// modal stays in sync if quantize is toggled elsewhere (none today, but
// the wire-up is cheap). Repainted each time the panel becomes active so
// the checkbox reflects the latest signal value without a subscription.
export function renderSettingsPlayer(): void {
	const wrap = document.getElementById('settings-player');
	if (!wrap) return;
	const on = !!deps.getDeck()?.quantizeOn();
	const connected = getConnectedControllers();
	const controllersBlock = connected.length === 0
		? `<div class="settings-toggle__hint" style="padding: 8px 0;">No controller connected. Plug in a supported Pioneer DDJ/FLX/XDJ controller (FLX10 first in v1) — it'll appear here automatically.</div>`
		: `<ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px;">${connected.map((m) => `
			<li style="display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: rgba(255,255,255,0.02); border: 1px solid var(--line); border-radius: 4px;">
				<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: oklch(0.7 0.15 145);"></span>
				<span style="font-size: 13px; color: var(--fg);">${escapeHtml(m)}</span>
				<span style="font-size: 11px; color: var(--fg-3); margin-left: auto;">connected</span>
			</li>`).join('')}</ul>`;
	const autoplayRow = (mode: PlayerMode, label: string, hint: string): string => `
		<div class="settings-ui__section-label">${escapeHtml(label)}</div>
		<label class="settings-toggle">
			<input type="checkbox" data-player-autoplay="${mode}" ${deps.getAutoplayNext(mode) ? 'checked' : ''} />
			<span class="settings-toggle__label">Auto-play next track in list</span>
			<span class="settings-toggle__hint">${escapeHtml(hint)}</span>
		</label>
	`;
	wrap.innerHTML = `
		<div class="settings-ui__section">
			${autoplayRow('streaming', 'Streaming Source', 'When a Spotify/Tidal track finishes on its own, continue to the next track in the list. Off — playback stops at the end of the track.')}
		</div>
		<div class="settings-ui__section">
			${autoplayRow('local', 'Local', 'When a local file finishes on its own, continue to the next track in the list. Off — playback stops at the end of the track.')}
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Beatgrid</div>
			<label class="settings-toggle">
				<input type="checkbox" data-player-quantize ${on ? 'checked' : ''} />
				<span class="settings-toggle__label">Quantize</span>
				<span class="settings-toggle__hint">Snap cue and loop triggers to the next beat. When off, triggers fire instantly at sub-beat precision.</span>
			</label>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Controllers</div>
			${controllersBlock}
		</div>
	`;
	const cb = wrap.querySelector<HTMLInputElement>('[data-player-quantize]');
	cb?.addEventListener('change', () => {
		deps.getDeck()?.setQuantize(cb.checked);
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-player-autoplay]').forEach((input) => {
		input.addEventListener('change', () => {
			deps.setAutoplayNext(input.dataset.playerAutoplay as PlayerMode, input.checked);
		});
	});
}

// ─── Track Similarity panel ──────────────────────────────────────────────────
// Master toggle + five dimension rows. Checkbox changes re-render the panel
// (they flip sub-control disabled states); value changes (BPM range, key
// level, brightness/power range) persist without a repaint so focus stays put.
// The tracklist repaints reactively off similaritySettingsSignal (see the
// effect in main.ts boot()).

export function renderSettingsSimilarity(): void {
	const wrap = document.getElementById('settings-similarity');
	if (!wrap) return;
	const s = similaritySettingsSignal();
	const dimDis = s.enabled ? '' : ' disabled';
	// Sub-inputs live when the master AND their own dimension are on.
	const subDis = (dimOn: boolean): string => (s.enabled && dimOn ? '' : ' disabled');

	const keyRadio = (level: KeyRelatedLevel, label: string, hint: string): string => `
		<label class="settings-radio" title="${escapeHtml(hint)}">
			<input type="radio" name="sim-key-level" data-sim-key-level value="${level}" ${s.key.level === level ? 'checked' : ''}${subDis(s.key.enabled)} />
			<span class="settings-radio__label">${escapeHtml(label)}</span>
		</label>
	`;
	const metricRadio = (dim: 'brightness' | 'power', range: MetricRange, label: string): string => `
		<label class="settings-radio">
			<input type="radio" name="sim-${dim}-range" data-sim-metric-range="${dim}" value="${range}" ${s[dim].range === range ? 'checked' : ''}${subDis(s[dim].enabled)} />
			<span class="settings-radio__label">${escapeHtml(label)}</span>
		</label>
	`;
	const dimToggle = (dim: 'bpm' | 'key' | 'brightness' | 'power' | 'label', label: string, hint: string): string => `
		<label class="settings-toggle">
			<input type="checkbox" data-sim-dim="${dim}" ${s[dim].enabled ? 'checked' : ''}${dimDis} />
			<span class="settings-toggle__label">${escapeHtml(label)}</span>
			<span class="settings-toggle__hint">${escapeHtml(hint)}</span>
		</label>
	`;

	wrap.innerHTML = `
		<div class="settings-ui__section">
			<label class="settings-toggle">
				<input type="checkbox" data-sim-enabled ${s.enabled ? 'checked' : ''} />
				<span class="settings-toggle__label">Highlight similar tracks</span>
				<span class="settings-toggle__hint">While a track is loaded (playing or paused), tracklist cells whose value neighbours it light up.</span>
			</label>
		</div>
		<div class="settings-ui__section settings-sim__dims" ${s.enabled ? '' : 'data-disabled="1"'}>
			<div class="settings-sim__dim" ${s.bpm.enabled ? '' : 'data-disabled="1"'}>
				${dimToggle('bpm', 'BPM', 'Tempo within the range below.')}
				<label class="settings-ui__field settings-toggle--indent">
					<span class="settings-ui__field-label">Within ±</span>
					<input type="number" class="settings-ui__number" data-sim-bpm-range min="1" max="10" step="1" value="${s.bpm.range}"${subDis(s.bpm.enabled)} />
					<span class="settings-ui__field-suffix">BPM</span>
				</label>
			</div>
			<div class="settings-sim__dim" ${s.key.enabled ? '' : 'data-disabled="1"'}>
				${dimToggle('key', 'Key', "Camelot-wheel neighbours, graded like rekordbox's Traffic Light.")}
				<div class="settings-ui__radios settings-toggle--indent">
					${keyRadio(0, 'Same key',      'Only the exact key — 8A matches 8A.')}
					${keyRadio(1, 'Related key 1', 'Adds the relative major/minor — 8A also matches 8B.')}
					${keyRadio(2, 'Related key 2', 'Adds ±1 on the wheel, same letter — 8A also matches 7A and 9A.')}
					${keyRadio(3, 'Related key 3', 'Adds ±1 on the wheel, other letter — 8A also matches 7B and 9B.')}
				</div>
			</div>
			<div class="settings-sim__dim" ${s.brightness.enabled ? '' : 'data-disabled="1"'}>
				${dimToggle('brightness', 'Brightness', 'Learned brightness score (0–3) within the tolerance below.')}
				<div class="settings-ui__radios settings-toggle--indent">
					${metricRadio('brightness', 0.25, 'Tight (±0.25)')}
					${metricRadio('brightness', 0.5,  'Medium (±0.5)')}
					${metricRadio('brightness', 1,    'Wide (±1)')}
				</div>
			</div>
			<div class="settings-sim__dim" ${s.power.enabled ? '' : 'data-disabled="1"'}>
				${dimToggle('power', 'Power', 'Learned energy/density score (0–3) within the tolerance below.')}
				<div class="settings-ui__radios settings-toggle--indent">
					${metricRadio('power', 0.25, 'Tight (±0.25)')}
					${metricRadio('power', 0.5,  'Medium (±0.5)')}
					${metricRadio('power', 1,    'Wide (±1)')}
				</div>
			</div>
			<div class="settings-sim__dim">
				${dimToggle('label', 'Label', 'Same record label (case-insensitive).')}
			</div>
		</div>
		<div data-mir-settings></div>
	`;
	const mirHost = wrap.querySelector<HTMLElement>('[data-mir-settings]');
	if (mirHost) mountMirSettings(mirHost);

	wrap.querySelector<HTMLInputElement>('[data-sim-enabled]')?.addEventListener('change', function () {
		updateSimilaritySettings((d) => { d.enabled = this.checked; });
		renderSettingsSimilarity();
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-sim-dim]').forEach((input) => {
		input.addEventListener('change', () => {
			const dim = input.dataset.simDim as 'bpm' | 'key' | 'brightness' | 'power' | 'label';
			updateSimilaritySettings((d) => { d[dim].enabled = input.checked; });
			renderSettingsSimilarity();
		});
	});
	const bpmInput = wrap.querySelector<HTMLInputElement>('[data-sim-bpm-range]');
	bpmInput?.addEventListener('change', () => {
		// Clamp to the input's own 1–10 bounds and reflect the corrected value
		// back so the field never shows an out-of-range number.
		const n = Math.min(10, Math.max(1, Math.round(Number(bpmInput.value) || 3)));
		bpmInput.value = String(n);
		updateSimilaritySettings((d) => { d.bpm.range = n; });
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-sim-key-level]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			const level = Number(input.value) as KeyRelatedLevel;
			updateSimilaritySettings((d) => { d.key.level = level; });
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-sim-metric-range]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			const dim = input.dataset.simMetricRange as 'brightness' | 'power';
			const range = Number(input.value) as MetricRange;
			updateSimilaritySettings((d) => { d[dim].range = range; });
		});
	});
}

async function renderSettingsUI(): Promise<void> {
	const wrap = document.getElementById('settings-ui');
	if (!wrap) return;
	const s = uiSettingsSignal();

	const sourceRow = (id: SourceTabId, label: string): string => `
		<label class="settings-toggle">
			<input type="checkbox" data-ui-source="${id}" ${s.sourceTabs[id] ? 'checked' : ''} />
			<span class="settings-toggle__label">${escapeHtml(label)}</span>
		</label>
	`;

	const stateGroup = (key: StateTabKey, label: string): string => {
		const pref = s[key];
		const disabledAttr = pref.visible ? '' : 'disabled';
		const radio = (mode: StateTabMode, text: string): string => `
			<label class="settings-radio">
				<input type="radio" name="ui-${key}" data-ui-mode="${key}" value="${mode}" ${pref.mode === mode ? 'checked' : ''} ${disabledAttr} />
				<span class="settings-radio__label">${escapeHtml(text)}</span>
			</label>
		`;
		return `
			<div class="settings-ui__group" data-ui-group="${key}" ${pref.visible ? '' : 'data-disabled="1"'}>
				<label class="settings-toggle">
					<input type="checkbox" data-ui-state-visible="${key}" ${pref.visible ? 'checked' : ''} />
					<span class="settings-toggle__label">${escapeHtml(label)}</span>
				</label>
				<div class="settings-ui__radios">
					${radio('always',   'Always')}
					${radio('when-has', 'Only when has tracks')}
				</div>
			</div>
		`;
	};

	wrap.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Main tabs</div>
			<div class="settings-ui__sources">
				${sourceRow('spotify',    'Spotify')}
				${sourceRow('tidal',      'Tidal')}
				${sourceRow('soundcloud', 'Soundcloud')}
				${sourceRow('rekordbox',  'Rekordbox')}
			</div>
		</div>
		<div class="settings-ui__section">
			${stateGroup('pinned',    'Pinned Tracks')}
			${stateGroup('downloads', 'Downloads')}
			${stateGroup('basket',    'Basket')}
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Analysis source</div>
			<div class="settings-ui__hint">Which beatgrid, segments &amp; key the waveform shows for tracks that have both. Rekordbox-imported and Curator analyses are always kept; this only chooses what's displayed.</div>
			<div class="settings-ui__radios">
				<label class="settings-radio">
					<input type="radio" name="ui-analysis-source" data-ui-analysis-source value="rekordbox" ${s.analysisSource === 'rekordbox' ? 'checked' : ''} />
					<span class="settings-radio__label">Rekordbox</span>
				</label>
				<label class="settings-radio">
					<input type="radio" name="ui-analysis-source" data-ui-analysis-source value="curator" ${s.analysisSource === 'curator' ? 'checked' : ''} />
					<span class="settings-radio__label">Curator</span>
				</label>
			</div>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Key notation</div>
			<div class="settings-ui__hint">How musical keys are labelled everywhere — tracklist, player, discover. The colour stays the same; only the text changes.</div>
			<div class="settings-ui__radios">
				<label class="settings-radio">
					<input type="radio" name="ui-key-format" data-ui-key-format value="camelot" ${s.keyDisplayFormat === 'camelot' ? 'checked' : ''} />
					<span class="settings-radio__label">Camelot (8A)</span>
				</label>
				<label class="settings-radio">
					<input type="radio" name="ui-key-format" data-ui-key-format value="musical" ${s.keyDisplayFormat === 'musical' ? 'checked' : ''} />
					<span class="settings-radio__label">Musical (Am)</span>
				</label>
			</div>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Artist credits</div>
			<div class="settings-ui__hint">First: the separator between the names on the artist line (remixers are listed there as names). Second: how the title shows the remix — "Feel Me (JAMIEE Remix)" or "Feel Me - JAMIEE Remix". Sync to Rekordbox writes Title and Artist in this same format; changing it re-pushes every linked track whose strings change on the next sync.</div>
			<div class="settings-ui__radios">
				<label class="settings-radio">
					<input type="radio" name="ui-artist-sep" data-ui-artist-sep value="," ${s.artistSeparator === ',' ? 'checked' : ''} />
					<span class="settings-radio__label">A, B</span>
				</label>
				<label class="settings-radio">
					<input type="radio" name="ui-artist-sep" data-ui-artist-sep value="/" ${s.artistSeparator === '/' ? 'checked' : ''} />
					<span class="settings-radio__label">A / B</span>
				</label>
				<label class="settings-radio">
					<input type="radio" name="ui-artist-sep" data-ui-artist-sep value=";" ${s.artistSeparator === ';' ? 'checked' : ''} />
					<span class="settings-radio__label">A; B</span>
				</label>
			</div>
			<div class="settings-ui__radios">
				<label class="settings-radio">
					<input type="radio" name="ui-remix-style" data-ui-remix-style value="parenthesis" ${s.remixStyle === 'parenthesis' ? 'checked' : ''} />
					<span class="settings-radio__label">Title (X Remix)</span>
				</label>
				<label class="settings-radio">
					<input type="radio" name="ui-remix-style" data-ui-remix-style value="dash" ${s.remixStyle === 'dash' ? 'checked' : ''} />
					<span class="settings-radio__label">Title - X Remix</span>
				</label>
			</div>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Discover</div>
			<div class="settings-ui__hint">How many seconds a track must play — without skipping or seeking — before Discover counts it as listened and marks it played.</div>
			<label class="settings-ui__field">
				<span class="settings-ui__field-label">Listened after</span>
				<input type="number" class="settings-ui__number" data-ui-listen-threshold min="5" max="120" step="5" value="${s.discoverListenThresholdSec}" />
				<span class="settings-ui__field-suffix">seconds</span>
			</label>
		</div>
	`;

	wrap.querySelectorAll<HTMLInputElement>('[data-ui-source]').forEach((input) => {
		input.addEventListener('change', () => {
			const id = input.dataset.uiSource as SourceTabId;
			updateUiSettings((d) => { d.sourceTabs[id] = input.checked; });
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-ui-state-visible]').forEach((input) => {
		input.addEventListener('change', () => {
			const key = input.dataset.uiStateVisible as StateTabKey;
			updateUiSettings((d) => { d[key].visible = input.checked; });
			// Sync local radio enabled-state without a full repaint — keeps the
			// user's current focus + scroll position in the panel.
			const group = wrap.querySelector<HTMLElement>(`[data-ui-group="${key}"]`);
			if (group) {
				if (input.checked) group.removeAttribute('data-disabled');
				else group.setAttribute('data-disabled', '1');
				group.querySelectorAll<HTMLInputElement>('[data-ui-mode]').forEach((r) => { r.disabled = !input.checked; });
			}
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-ui-mode]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			const key = input.dataset.uiMode as StateTabKey;
			const mode: StateTabMode = input.value === 'when-has' ? 'when-has' : 'always';
			updateUiSettings((d) => { d[key].mode = mode; });
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-ui-analysis-source]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			const src = input.value === 'curator' ? 'curator' : 'rekordbox';
			updateUiSettings((d) => { d.analysisSource = src; });
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-ui-key-format]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			const fmt = input.value === 'musical' ? 'musical' : 'camelot';
			updateUiSettings((d) => { d.keyDisplayFormat = fmt; });
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-ui-artist-sep]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			const sep = input.value === '/' || input.value === ';' ? input.value : ',';
			updateUiSettings((d) => { d.artistSeparator = sep; });
			pushCreditFormatToCore();
		});
	});
	wrap.querySelectorAll<HTMLInputElement>('[data-ui-remix-style]').forEach((input) => {
		input.addEventListener('change', () => {
			if (!input.checked) return;
			updateUiSettings((d) => { d.remixStyle = input.value === 'dash' ? 'dash' : 'parenthesis'; });
			pushCreditFormatToCore();
		});
	});
	const listenInput = wrap.querySelector<HTMLInputElement>('[data-ui-listen-threshold]');
	listenInput?.addEventListener('change', () => {
		// Clamp + snap to the input's own bounds; reflect the corrected value
		// back so the field never shows an out-of-range number.
		const n = Math.min(120, Math.max(5, Math.round(Number(listenInput.value) || 25)));
		listenInput.value = String(n);
		updateUiSettings((d) => { d.discoverListenThresholdSec = n; });
	});
}

// wireSettingsModal retired — backdrop/ESC/close handlers moved into
// SettingsModal component. Tab activation flows through props.onTabActivate.

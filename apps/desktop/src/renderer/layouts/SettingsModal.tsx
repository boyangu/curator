// SettingsModal — the tabbed settings dialog (Connections / Library /
// Rekordbox). Owns the modal-overlay shell, the tab strip, open/close
// lifecycle (backdrop click, ESC, close button), and the three empty
// panel hosts.
//
// Conservative scope: the panel BODIES stay imperative — main.ts still
// owns renderSettingsConnections / renderLibraryFoldersModalIfOpen /
// renderSettingsRekordbox, which paint into `#settings-connections`,
// `#lib-folders-body`, and `#settings-rekordbox` respectively. The
// component fires onTabActivate when a tab becomes active so main.ts
// can repaint that panel.
//
// What this extraction gains:
//   • The 30 lines of static modal markup leave AppShell.tsx
//   • Open/close + tab activation become a single handle method (no
//     more openSettingsModal() / closeSettingsModal() / activateTab()
//     fan-out chasing the same overlay element through getElementById)
//   • ESC + backdrop-click handlers are scoped to the component (no
//     more document-level keydown sniffer that runs even when the
//     modal is closed)

import { createSignal, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import { registerModalOpenSignal } from '../modalGate.js';

export type SettingsTab = 'connections' | 'library' | 'rekordbox' | 'player' | 'similarity' | 'ui' | 'backup' | 'account';

export interface SettingsModalProps {
	// Fired when a tab becomes active (initial open + subsequent tab
	// clicks). Caller paints the panel body for the new tab.
	onTabActivate: (tab: SettingsTab) => void;
	// Fired when the modal closes (backdrop click / ESC / close button).
	// Caller does any teardown (e.g. unsubscribe from event streams).
	onClose: () => void;
}

export interface SettingsModalHandle {
	destroy(): void;
	open(tab?: SettingsTab): void;
	close(): void;
	isOpen: Accessor<boolean>;
	activeTab: Accessor<SettingsTab>;
}

const TABS: { id: SettingsTab; label: string }[] = [
	{ id: 'connections', label: 'Connections' },
	{ id: 'library',     label: 'Library' },
	{ id: 'rekordbox',   label: 'Rekordbox' },
	{ id: 'player',      label: 'Player' },
	{ id: 'similarity',  label: 'Track Similarity' },
	{ id: 'ui',          label: 'User Interface' },
	{ id: 'backup',      label: 'Backup' },
	{ id: 'account',     label: 'Account' },
];

export function mountSettingsModal(host: HTMLElement, props: SettingsModalProps): SettingsModalHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [activeTab, setActiveTab] = createSignal<SettingsTab>('connections');

	const activate = (tab: SettingsTab): void => {
		setActiveTab(tab);
		props.onTabActivate(tab);
	};

	const open = (tab: SettingsTab = 'connections'): void => {
		setIsOpen(true);
		activate(tab);
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		props.onClose();
	};

	// ESC closes — but only while open, so a global listener doesn't fight
	// other ESC consumers (track-edit modal, omnibar) when this modal is
	// hidden.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape') return;
		if (!isOpen()) return;
		e.preventDefault();
		close();
	};
	document.addEventListener('keydown', onKeyDown);

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				id="settings-overlay"
				class="modal-overlay"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) close();
				}}
			>
				<div class="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="settings-title">
					<header class="modal__head">
						<h3 id="settings-title">Settings</h3>
						<button
							class="modal__close"
							type="button"
							aria-label="Close"
							onClick={(e) => { e.preventDefault(); close(); }}
						>×</button>
					</header>
					<nav class="settings-tabs" role="tablist">
						{TABS.map((t) => (
							<button
								class="settings-tab"
								classList={{ active: activeTab() === t.id }}
								role="tab"
								type="button"
								onClick={() => activate(t.id)}
							>
								{t.label}
							</button>
						))}
					</nav>
					{/* `data-settings-panel` is the hook main.ts:
					    renderLibraryFoldersModalIfOpen (and similar) use to find
					    the right panel container without depending on tab order
					    or class structure. Don't drop it without also updating
					    those imperative painters. */}
					<div class="modal__body settings-body">
						<div class="settings-panel" data-settings-panel="connections" role="tabpanel" hidden={activeTab() !== 'connections'}>
							<div id="settings-connections"></div>
						</div>
						<div class="settings-panel" data-settings-panel="library" role="tabpanel" hidden={activeTab() !== 'library'}>
							{/* Keep id stable so existing renderLibraryFoldersModalIfOpen /
							    wireLibraryFoldersPanel logic finds the same container. */}
							<div id="lib-folders-body"></div>
						</div>
						<div class="settings-panel" data-settings-panel="rekordbox" role="tabpanel" hidden={activeTab() !== 'rekordbox'}>
							{/* Rendered by main.ts:renderSettingsRekordbox(). Flags live in
							    localStorage under curator.rekordbox-settings.v2; the
							    "Read library now" button drives ipc.rekordbox:read. */}
							<div id="settings-rekordbox"></div>
						</div>
						<div class="settings-panel" data-settings-panel="player" role="tabpanel" hidden={activeTab() !== 'player'}>
							{/* Rendered by main.ts:renderSettingsPlayer(). Reads the
							    deck's quantizeOn signal directly; the toggle writes
							    back via deck.toggleQuantize. */}
							<div id="settings-player"></div>
						</div>
						<div class="settings-panel" data-settings-panel="similarity" role="tabpanel" hidden={activeTab() !== 'similarity'}>
							{/* Rendered by features/settings.ts:renderSettingsSimilarity().
							    Drives the similaritySettingsSignal that the tracklist's
							    similarity highlight reads. */}
							<div id="settings-similarity"></div>
						</div>
						<div class="settings-panel" data-settings-panel="ui" role="tabpanel" hidden={activeTab() !== 'ui'}>
							{/* Rendered by main.ts:renderSettingsUI(). Drives the
							    uiSettingsSignal which TopFrame reads to filter the
							    source + state tab strips. */}
							<div id="settings-ui"></div>
						</div>
						<div class="settings-panel" data-settings-panel="backup" role="tabpanel" hidden={activeTab() !== 'backup'}>
							{/* Rendered by features/backupSettings.ts:mountBackupSettings().
							    Thin view over backup:status; re-renders on backup:event. */}
							<div id="settings-backup"></div>
						</div>
						<div class="settings-panel" data-settings-panel="account" role="tabpanel" hidden={activeTab() !== 'account'}>
							{/* Rendered by features/accountSettings.ts:mountAccountSettings().
							    Sign-in form or account + cloud sync status; re-renders on
							    cloud-sync:status. */}
							<div id="settings-account"></div>
						</div>
					</div>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => {
			document.removeEventListener('keydown', onKeyDown);
			dispose();
		},
		open,
		close,
		isOpen,
		activeTab,
	};
}

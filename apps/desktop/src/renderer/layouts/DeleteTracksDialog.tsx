// DeleteTracksDialog — the library Delete confirmation (Shift+Delete / the
// "Delete from library…" track command). Replaces a window.confirm that
// deleted from every source at once: the user now ticks which sources go.
//
// Rows are the removable sources the selection actually has (local file,
// Spotify, Tidal, Rekordbox — metadata links like Beatport travel with the
// row), with "k of n" when only part of a multi-selection has one. Nothing is
// pre-checked and DELETE stays disabled until something is, so a stray
// Shift+Delete + click can't wipe a track. Core tombstones a row only when
// every source it has was checked (CoreService.removeTrackSources).
//
// Keyboard: Esc cancels. Enter is swallowed and does NOTHING — a destructive
// action never fires from a key that's also "play" in the tracklist (same
// stance as McpConfirmModal). Focus lands on Cancel.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { Track } from '@curator/shared';
import type { RemovableTrackSource } from '@curator/core';
import { registerModalOpenSignal } from '../modalGate.js';

export interface DeleteTracksDialogOptions {
	tracks: Track[];
	onConfirm: (sources: RemovableTrackSource[]) => void;
	onCancel?: () => void;
}

export interface DeleteTracksDialogHandle {
	destroy(): void;
	open(opts: DeleteTracksDialogOptions): void;
	close(): void;
	isOpen: Accessor<boolean>;
}

interface SourceRow {
	source: RemovableTrackSource;
	label: string;
	hint: string;
	count: number;
}

const ORDER: readonly RemovableTrackSource[] = ['local', 'spotify', 'tidal', 'rekordbox'];
const LABEL: Record<RemovableTrackSource, string> = { local: 'Local file', spotify: 'Spotify', tidal: 'Tidal', rekordbox: 'Rekordbox' };
const HINT: Record<RemovableTrackSource, string> = {
	local: 'Moves the file to the OS trash — recoverable from there',
	spotify: 'Removes it from every Spotify playlist you own — changes your live Spotify account',
	tidal: 'Removes it from every Tidal playlist you own — changes your live Tidal account',
	rekordbox: 'Removes it from the rekordbox collection and its playlists on the next Sync to Rekordbox',
};

export function mountDeleteTracksDialog(host: HTMLElement): DeleteTracksDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [rows, setRows] = createSignal<SourceRow[]>([]);
	const [headline, setHeadline] = createSignal('');
	const [total, setTotal] = createSignal(0);
	const [checked, setChecked] = createSignal<Set<RemovableTrackSource>>(new Set());
	let cancelRef: HTMLButtonElement | undefined;
	// The active call's callbacks; cleared on resolution so none fires twice.
	let current: DeleteTracksDialogOptions | null = null;

	const open = (opts: DeleteTracksDialogOptions): void => {
		current = opts;
		const n = opts.tracks.length;
		setTotal(n);
		setHeadline(n === 1 ? `Delete “${opts.tracks[0]!.title}” from your library?` : `Delete ${n} tracks from your library?`);
		setRows(ORDER
			.map((source) => ({
				source,
				label: LABEL[source],
				hint: HINT[source],
				count: opts.tracks.filter((t) => (t.sources ?? []).includes(source)).length,
			}))
			.filter((r) => r.count > 0));
		setChecked(new Set<RemovableTrackSource>());
		setIsOpen(true);
		queueMicrotask(() => cancelRef?.focus());
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		const cb = current?.onCancel;
		current = null;
		cb?.();
	};

	const confirm = (): void => {
		if (!isOpen() || checked().size === 0) return;
		const sources = ORDER.filter((s) => checked().has(s));
		setIsOpen(false);
		const cb = current?.onConfirm;
		current = null;
		cb?.(sources);
	};

	const toggle = (source: RemovableTrackSource, on: boolean): void => {
		const next = new Set(checked());
		if (on) next.add(source); else next.delete(source);
		setChecked(next);
	};

	// Capture phase so we win over the global tracklist keydown handler.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); return; }
	};
	document.addEventListener('keydown', onKeyDown, true);

	const countSuffix = (r: SourceRow): string => (total() > 1 && r.count < total() ? ` (${r.count} of ${total()} tracks)` : '');

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				class="modal-overlay"
				onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
			>
				<div class="modal delete-tracks" role="dialog" aria-modal="true" aria-labelledby="delete-tracks-title">
					<header class="modal__head">
						<h3 id="delete-tracks-title">Delete from library</h3>
						<button
							class="modal__close"
							type="button"
							aria-label="Cancel"
							onClick={(e) => { e.preventDefault(); close(); }}
						>×</button>
					</header>
					<div class="modal__body">
						<p class="delete-tracks__warning">{headline()}</p>
						<p class="delete-tracks__note">
							Choose which sources to remove it from. A track leaves your library only when every source it has is checked.
						</p>
						<div class="delete-tracks__sources">
							<For each={rows()}>
								{(r) => (
									<label class="settings-toggle">
										<input
											type="checkbox"
											checked={checked().has(r.source)}
											onChange={(e) => toggle(r.source, e.currentTarget.checked)}
										/>
										<span class="settings-toggle__label">{r.label}{countSuffix(r)}</span>
										<span class="settings-toggle__hint">{r.hint}</span>
									</label>
								)}
							</For>
						</div>
					</div>
					<footer class="modal__foot">
						<button
							type="button"
							class="btn-secondary"
							ref={(el) => (cancelRef = el)}
							onClick={(e) => { e.preventDefault(); close(); }}
						>Cancel</button>
						<button
							type="button"
							class="btn-danger"
							disabled={checked().size === 0}
							onClick={(e) => { e.preventDefault(); confirm(); }}
						>DELETE</button>
					</footer>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => {
			document.removeEventListener('keydown', onKeyDown, true);
			dispose();
		},
		open,
		close,
		isOpen,
	};
}

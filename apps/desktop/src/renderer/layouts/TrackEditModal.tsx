// TrackEditModal — single-track metadata edit dialog (title, artists,
// album, label, genre, bpm, key + Spotify/Tidal/Beatport URLs).
//
// Conservative scope: the component owns the modal shell, form markup,
// open/close lifecycle (backdrop, ESC, close button), backdrop-click
// dismiss, and Enter-to-next-field navigation. main.ts still owns the
// load / save logic — its openTrackEditor() fills the form fields by
// name after the component is open, and its saveTrackEditor() reads
// them on submit.
//
// Form-field names are preserved exactly (title, artists, album, …)
// so the legacy form.elements.namedItem() lookups keep working. The
// `data-edit-field` attribute is preserved too — main.ts greps it for
// the Enter-to-next traversal (kept here for parity, harmless to leave).

import { createSignal, For, Show } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { render } from 'solid-js/web';
import type { TrackArtist } from '@curator/shared';
import { registerModalOpenSignal } from '../modalGate.js';
import { KEY_MAP } from '../music-utils.js';
import { ArtistTokenField, type ArtistSuggestion } from '../components/ArtistTokenField.jsx';

export interface TrackEditModalProps {
	// Submit handler. Component does NOT serialize the form — main.ts
	// reads form fields directly. Callback fires after submit / Save click.
	onSubmit: () => void;
	// Fired on backdrop, ESC, or close-button. Caller does any state
	// cleanup (editor.trackId = null, etc.).
	onClose: () => void;
	// Per-field reset. Fires when the user clicks the × next to an input.
	// `field` is the input's `name` attribute (title, artists, … or
	// spotifyUrl/tidalUrl/beatportUrl). Main.ts dispatches: metadata fields
	// clear the override via tracks:set-overrides; URL fields delete the
	// source_link row. Component awaits so it can refill the field with the
	// post-reset value the caller writes back into the form element.
	onResetField: (field: string) => Promise<void> | void;
	// Library artist lookup for the Artists field's suggestion list. Optional
	// — without it the field is a plain token editor.
	searchArtists?: (q: string) => Promise<ArtistSuggestion[]>;
}

export interface TrackEditModalHandle {
	destroy(): void;
	open(): void;
	close(): void;
	isOpen: Accessor<boolean>;
	// Convenience for callers that need the underlying <form> to write
	// field values into. Stable across opens.
	form(): HTMLFormElement | null;
	// Feed the genre/label autocomplete pools. The Key field's suggestions are
	// static (the 24 Camelot slots) and owned here; genre/label are library
	// data, so editTrack.ts fetches them and pushes them in through this.
	setFieldOptions(opts: { genres: string[]; labels: string[] }): void;
	// The Artists field is a token editor, not an <input> — it has no form
	// element to read/write, so the caller goes through these.
	setArtists(list: TrackArtist[]): void;
	getArtists(): TrackArtist[];
	// URL fields (spotifyUrl / tidalUrl / beatportUrl) whose value is a
	// claim-derived id — known from the account, not linked on this device
	// (core sync-log/claim-links.ts). They render muted with a note; typing
	// in one makes it an ordinary field again.
	setDerivedUrls(names: readonly string[]): void;
	// Further ids of a URL field's provider (field name → URLs): a merged
	// track can hold several Spotify or Tidal ids. The field shows the
	// primary; these are listed under it, read-only.
	setOtherUrls(urls: Readonly<Record<string, readonly string[]>>): void;
}

interface FieldDef {
	name: string;
	label: string;
	placeholder?: string;
	type?: 'text' | 'password' | 'number';
	min?: string;
	step?: string;
}

const META_FIELDS: FieldDef[] = [
	{ name: 'title',   label: 'Title' },
	{ name: 'artists', label: 'Artists' },
	{ name: 'album',   label: 'Album' },
	{ name: 'label',   label: 'Label' },
	{ name: 'genre',   label: 'Genre' },
	{ name: 'bpm',     label: 'BPM', type: 'number', min: '0', step: '1' },
	{ name: 'key',     label: 'Key', placeholder: 'e.g. Am or 8A' },
];

const DERIVED_TITLE = 'Known from your account: another of your devices linked this track. Edit it to set this device’s own link; × hides it here.';

const URL_FIELDS: FieldDef[] = [
	{ name: 'spotifyUrl',  label: 'Spotify',  placeholder: 'https://open.spotify.com/track/…' },
	{ name: 'tidalUrl',    label: 'Tidal',    placeholder: 'https://tidal.com/browse/track/…' },
	{ name: 'beatportUrl', label: 'Beatport', placeholder: 'https://www.beatport.com/track/…/…' },
];

// Fields wired to a <datalist> for autocomplete → the input's `list` attribute
// points at the matching datalist id below. The field stays free-text; the list
// only suggests. genre/label draw from the library vocabulary (fed in via
// setFieldOptions); key draws from the static Camelot slots.
const DATALIST_ID: Record<string, string> = {
	genre: 'edit-genre-options',
	label: 'edit-label-options',
	key:   'edit-key-options',
};

// The 24 Camelot slots, wheel-ordered (1A,1B,…12B). `value` is the musical
// spelling the Key field echoes on prefill (so picking one matches what a
// reopen would show); the Camelot code rides along as the option's text so
// Chromium also filters the list when the user types Camelot ("8A").
const KEY_OPTIONS: { camelot: string; name: string }[] = (() => {
	const out: { camelot: string; name: string }[] = [];
	for (let n = 1; n <= 12; n++) {
		for (const mode of ['A', 'B'] as const) {
			const camelot = `${n}${mode}`;
			const km = KEY_MAP[camelot];
			if (km) out.push({ camelot, name: km.name });
		}
	}
	return out;
})();

export function mountTrackEditModal(host: HTMLElement, props: TrackEditModalProps): TrackEditModalHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [fieldOptions, setFieldOptions] = createSignal<{ genres: string[]; labels: string[] }>({ genres: [], labels: [] });
	const [artists, setArtists] = createSignal<TrackArtist[]>([]);
	const [derivedUrls, setDerivedUrls] = createSignal<ReadonlySet<string>>(new Set());
	const [otherUrls, setOtherUrls] = createSignal<Readonly<Record<string, readonly string[]>>>({});
	const undoDerived = (name: string): void => {
		if (!derivedUrls().has(name)) return;
		const next = new Set(derivedUrls());
		next.delete(name);
		setDerivedUrls(next);
	};
	let formRef: HTMLFormElement | null = null;

	const open = (): void => { setIsOpen(true); };
	// Two intents on close. `close()` (Cancel button) discards in-progress
	// edits — the modal hides without firing the submit path. `closeWithSave()`
	// (× header button, ESC, backdrop click) commits the form first; matches
	// the user expectation that closing a modal you've been editing keeps
	// the work. main.ts dispatches both: onSubmit runs save + hides the
	// modal itself; onClose just hides.
	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		props.onClose();
	};
	const closeWithSave = (): void => {
		if (!isOpen()) return;
		props.onSubmit();
	};

	// Enter-to-next-field traversal. Browser default would submit on Enter
	// from any input; we walk to the next data-edit-field input and focus
	// it. From the last field, focus the Save button so a final Enter
	// confirms.
	const onFieldKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Enter') return;
		if (!formRef) return;
		e.preventDefault();
		const inputs = Array.from(formRef.querySelectorAll<HTMLInputElement>('input[data-edit-field]'));
		const target = e.currentTarget as HTMLInputElement;
		const idx = inputs.indexOf(target);
		if (idx < 0) return;
		const next = inputs[idx + 1];
		const saveBtn = formRef.querySelector<HTMLButtonElement>('button[type="submit"]');
		(next ?? saveBtn)?.focus();
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape') return;
		if (!isOpen()) return;
		e.preventDefault();
		closeWithSave();
	};
	document.addEventListener('keydown', onKeyDown);

	const fieldRow = (f: FieldDef): JSX.Element => (
		<label class="field">
			<span>{f.label}</span>
			{f.name === 'artists'
				? <ArtistTokenField value={artists} onChange={setArtists} search={props.searchArtists} onAdvance={onFieldKeyDown} />
				: <input
					name={f.name}
					data-edit-field
					type={f.type ?? 'text'}
					min={f.min}
					step={f.step}
					list={DATALIST_ID[f.name]}
					placeholder={f.placeholder}
					onKeyDown={onFieldKeyDown}
					classList={{ 'field__input--derived': derivedUrls().has(f.name) }}
					title={derivedUrls().has(f.name) ? DERIVED_TITLE : undefined}
					onInput={() => undoDerived(f.name)}
				/>}
			<button
				type="button"
				class="field__reset"
				title="Reset to canonical / remove link"
				aria-label={`Reset ${f.label}`}
				onClick={(e) => { e.preventDefault(); undoDerived(f.name); void props.onResetField(f.name); }}
			>×</button>
			<Show when={derivedUrls().has(f.name)}>
				<small class="field__note">From your account — linked on another device</small>
			</Show>
			<Show when={(otherUrls()[f.name]?.length ?? 0) > 0}>
				<small class="field__note field__note--others" title={otherUrls()[f.name]!.join('\n')}>
					Also linked: {otherUrls()[f.name]!.map((u) => u.split('/').pop()).join(', ')}
				</small>
			</Show>
		</label>
	);

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				class="modal-overlay"
				onMouseDown={(e) => { if (e.target === e.currentTarget) closeWithSave(); }}
			>
				<div class="modal" role="dialog" aria-modal="true" aria-labelledby="track-edit-title">
					<header class="modal__head">
						<h3 id="track-edit-title">Edit Track</h3>
						<button
							class="modal__close"
							type="button"
							aria-label="Close and save"
							onClick={(e) => { e.preventDefault(); closeWithSave(); }}
						>×</button>
					</header>
					<form
						class="modal__body"
						id="track-edit-form"
						ref={(el) => { formRef = el; }}
						onSubmit={(e) => { e.preventDefault(); props.onSubmit(); }}
					>
						<For each={META_FIELDS}>{fieldRow}</For>
						{/* Autocomplete pools. Native <datalist> — suggestions only,
						    the fields stay free-text. */}
						<datalist id={DATALIST_ID.genre}>
							<For each={fieldOptions().genres}>{(g) => <option value={g} />}</For>
						</datalist>
						<datalist id={DATALIST_ID.label}>
							<For each={fieldOptions().labels}>{(l) => <option value={l} />}</For>
						</datalist>
						<datalist id={DATALIST_ID.key}>
							<For each={KEY_OPTIONS}>{(k) => <option value={k.name}>{k.camelot}</option>}</For>
						</datalist>
						<div class="field-sep"></div>
						<For each={URL_FIELDS}>{fieldRow}</For>
						<footer class="modal__foot">
							<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Cancel</button>
							<button type="submit" class="btn-primary">Save</button>
						</footer>
					</form>
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
		form: () => formRef,
		setFieldOptions,
		setArtists: (list) => setArtists(list.map((a) => (a.role ? { name: a.name, role: a.role } : { name: a.name }))),
		getArtists: () => artists(),
		setDerivedUrls: (names) => setDerivedUrls(new Set(names)),
		setOtherUrls: (urls) => setOtherUrls({ ...urls }),
	};
}

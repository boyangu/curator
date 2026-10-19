// ArtistTokenField — the Edit Track modal's artists input. One chip per
// credited artist (name + role badge that cycles main → feat. → remix, ×
// to remove), a text input that adds credits on Enter, and a suggestion
// list fed by the library's artist table.
//
// Splitting on commit uses the SHARED credit splitter, so "A, B feat. C"
// pasted here lands the same way it would from a rekordbox pull. The one
// thing the client can't know is the protect set (names the library holds
// whole despite a separator — "Tyler, The Creator"): for those, pick the
// suggestion, which commits the exact name without splitting. Roles are
// explicit per chip — never inferred from position.

import { createSignal, For, Show, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { TrackArtist } from '@curator/shared';
import { searchFold, splitArtistCredit } from '@curator/shared';

export interface ArtistSuggestion { id: string; name: string; trackCount: number }

export interface ArtistTokenFieldProps {
	value: Accessor<TrackArtist[]>;
	onChange: (next: TrackArtist[]) => void;
	// Library lookup for the suggestion list (debounced here). Optional so
	// the field still works as a plain token editor without one.
	search?: (q: string) => Promise<ArtistSuggestion[]>;
	// Enter on an EMPTY input — the modal's field-to-field traversal.
	onAdvance?: (e: KeyboardEvent) => void;
}

const ROLE_CYCLE: Array<TrackArtist['role']> = [undefined, 'featured', 'remixer'];
const ROLE_LABEL: Record<NonNullable<TrackArtist['role']>, string> = { main: '', featured: 'feat.', remixer: 'remix' };

export function ArtistTokenField(props: ArtistTokenFieldProps) {
	const [text, setText] = createSignal('');
	const [sugg, setSugg] = createSignal<ArtistSuggestion[]>([]);
	const [hi, setHi] = createSignal(-1);
	let inputRef: HTMLInputElement | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;
	onCleanup(() => clearTimeout(timer));

	const folds = (): Set<string> => new Set(props.value().map((a) => searchFold(a.name)));

	// Append credits, deduped by fold against what's already there.
	const append = (parts: TrackArtist[]): void => {
		if (parts.length === 0) return;
		const seen = folds();
		const next = [...props.value()];
		for (const p of parts) {
			const k = searchFold(p.name);
			if (!k || seen.has(k)) continue;
			seen.add(k);
			next.push(p.role ? { name: p.name, role: p.role } : { name: p.name });
		}
		props.onChange(next);
		setText('');
		setSugg([]);
		setHi(-1);
	};
	const commitText = (raw: string): void => append(splitArtistCredit(raw));
	// A picked suggestion is a known library name — keep it whole.
	const pick = (s: ArtistSuggestion): void => append([{ name: s.name }]);
	const remove = (i: number): void => props.onChange(props.value().filter((_, j) => j !== i));
	const cycleRole = (i: number): void => props.onChange(props.value().map((a, j) => {
		if (j !== i) return a;
		const role = ROLE_CYCLE[(ROLE_CYCLE.indexOf(a.role) + 1) % ROLE_CYCLE.length];
		return role ? { name: a.name, role } : { name: a.name };
	}));

	const schedule = (q: string): void => {
		clearTimeout(timer);
		const needle = q.trim();
		if (!props.search || !needle) { setSugg([]); setHi(-1); return; }
		const my = ++seq;
		timer = setTimeout(() => {
			props.search!(needle).then((rows) => {
				if (my !== seq) return;
				const have = folds();
				setSugg(rows.filter((r) => !have.has(searchFold(r.name))).slice(0, 8));
				setHi(-1);
			}).catch(() => { /* suggestions are best-effort */ });
		}, 150);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		const list = sugg();
		switch (e.key) {
			case 'ArrowDown':
				if (list.length) { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
				return;
			case 'ArrowUp':
				if (list.length) { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
				return;
			case 'Enter': {
				const h = hi();
				if (h >= 0 && list[h]) { e.preventDefault(); pick(list[h]!); return; }
				if (text().trim()) { e.preventDefault(); commitText(text()); return; }
				props.onAdvance?.(e);
				return;
			}
			case 'Backspace':
				if (!text() && props.value().length) { e.preventDefault(); remove(props.value().length - 1); }
				return;
			case 'Escape':
				if (list.length) { e.stopPropagation(); setSugg([]); setHi(-1); }
				return;
			default:
				return;
		}
	};
	// Blur commits typed text. Deferred so a mousedown on a suggestion
	// (which preventDefaults to keep focus) still wins the race.
	const onBlur = (): void => {
		setTimeout(() => {
			if (text().trim()) commitText(text());
			setSugg([]);
			setHi(-1);
		}, 120);
	};

	return (
		<div class="artist-field" onClick={() => inputRef?.focus()}>
			<For each={props.value()}>{(a, i) => (
				<span class="artist-chip" data-role={a.role ?? ''}>
					<span class="artist-chip__name">{a.name}</span>
					<button
						type="button"
						class="artist-chip__role"
						title="Role — click to cycle: main → feat. → remix"
						onClick={(e) => { e.stopPropagation(); cycleRole(i()); }}
					>{a.role ? ROLE_LABEL[a.role] : '·'}</button>
					<button
						type="button"
						class="artist-chip__x"
						aria-label={`Remove ${a.name}`}
						onClick={(e) => { e.stopPropagation(); remove(i()); }}
					>×</button>
				</span>
			)}</For>
			<input
				ref={(el) => { inputRef = el; }}
				class="artist-field__input"
				data-edit-field
				autocomplete="off"
				placeholder={props.value().length ? '' : 'Add artist — Enter adds, "A, B feat. C" splits'}
				value={text()}
				onInput={(e) => { setText(e.currentTarget.value); schedule(e.currentTarget.value); }}
				onKeyDown={onKeyDown}
				onBlur={onBlur}
			/>
			<Show when={sugg().length > 0}>
				<ul class="artist-field__sugg" role="listbox">
					<For each={sugg()}>{(s, i) => (
						<li
							role="option"
							classList={{ 'is-hi': hi() === i() }}
							onMouseDown={(e) => { e.preventDefault(); pick(s); }}
							onMouseEnter={() => setHi(i())}
						>
							<span>{s.name}</span>
							<span class="artist-field__count">{s.trackCount}</span>
						</li>
					)}</For>
				</ul>
			</Show>
		</div>
	);
}

// Edit-Track modal feature — form pre-fill, save, and per-field reset for
// the TrackEditModal component. Extracted verbatim from main.ts (F3.2).
// The TrackEditModalHandle is mounted in boot() (main.ts owns the modal
// lifecycle and wires onSubmit/onClose/onResetField back to this module's
// exports); it reaches this module's state only through those exports and
// hands the handle in via initEditTrackFeature — this module never imports
// main.ts. IPC goes through the data/api.ts tracksApi facade, never the
// raw preload bridge (boundary-checked at build time).

import type { ClearableTrackField, SourceLinkError } from '@curator/core';
import type { Track } from '@curator/shared';
import type { TrackEditModalHandle } from '../layouts/TrackEditModal.jsx';
import type { MergeTracksHandle } from '../layouts/MergeTracksDialog.jsx';
import { tracksApi } from '../data/api.js';
import { tracksData } from '../data/tracks.js';
import { showToast } from '../ui/toast.js';
import { KEY_MAP } from '../music-utils.js';
import { log } from '../data/log.js';

const slog = log.for('edit-track');

export interface EditTrackFeatureDeps {
	// The modal handle lives in main.ts — boot() owns mountTrackEditModal;
	// null until that mount lands, so openTrackEditor guards.
	getModal(): TrackEditModalHandle | null;
	// The "already linked — merge?" dialog; same lifetime rules as the modal.
	getMergeDialog(): MergeTracksHandle | null;
	// Visible-tracklist repaint after a save / dirty close — main.ts.
	renderTracks(): Promise<void>;
	// Sidebar/playlist refetch after a merge moved memberships — main.ts.
	refreshAll(): Promise<void>;
	// Patch one visible tracklist row in place (decorated Track) — main.ts.
	patchTrackRow(t: Track): void;
	// Drop per-track tag/analysis caches so the next paint refetches.
	invalidateTrackCaches(trackId: string): void;
}

let deps: EditTrackFeatureDeps;

export function initEditTrackFeature(d: EditTrackFeatureDeps): void {
	deps = d;
}

// ─── Edit Track modal ──────────────────────────────────────────────────────
// Pre-fills the form with the merged (override-applied) values, computes a
// patch on save where empty inputs translate to `null` (revert the override
// back to the canonical source value).

// Musical → Camelot for PARSING user input. Mirrors apps/core/src/enrich/
// keys.ts keyToCamelot so the user can type either notation (and either
// enharmonic spelling) in the Key field. For DISPLAY (prefill) we use the
// shared KEY_MAP so the field echoes exactly what the chip shows — one
// canonical spelling per slot, no chip-vs-field enharmonic drift.
const MUSICAL_TO_CAMELOT: Record<string, string> = {
	Cm: '5A', C: '8B', 'C#': '3B', 'C#m': '12A', Db: '3B', 'Dbm': '12A',
	D: '10B', Dm: '7A', 'D#': '5B', 'D#m': '2A', Eb: '5B', Ebm: '2A',
	E: '12B', Em: '9A', F: '7B', Fm: '4A', 'F#': '2B', 'F#m': '11A',
	Gb: '2B', Gbm: '11A', G: '9B', Gm: '6A', 'G#': '4B', 'G#m': '1A',
	Ab: '4B', Abm: '1A', A: '11B', Am: '8A', 'A#': '6B', 'A#m': '3A',
	Bb: '6B', Bbm: '3A', B: '1B', Bm: '10A',
};
// Camelot → musical label for prefill display (the chip's spelling).
const camelotToMusical = (c: string): string => KEY_MAP[c]?.name ?? c;

// Parse whatever the user typed (Camelot "8A" OR musical "Am"/"Bb major")
// down to the ONE canonical form we store: Camelot. Musical is a display
// projection, never persisted — so unrecognized input resolves to null
// rather than being kept as a raw string (which would store junk and, since
// the whole key display is Camelot-driven, render blank anyway).
function parseKeyInput(s: string): string | null {
	const v = s.trim().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, '');
	if (!v) return null;
	if (/^([0-9]|1[0-2])[AB]$/i.test(v)) return v.toUpperCase();
	// Musical notation. Normalize first letter upper, accidental as typed,
	// quality collapsed to bare ''/'m'. Accept spelled-out qualities
	// (maj/major/min/minor) so "Bb major" resolves instead of dropping.
	const m = v.match(/^([A-Ga-g])([#b]?)(maj|major|min|minor|m)?$/i);
	if (m) {
		// 'major'/'maj' must NOT be read as minor — only an explicit minor
		// word or a bare trailing 'm' means minor.
		const q = (m[3] ?? '').toLowerCase();
		const minor = q === 'm' || q === 'min' || q === 'minor';
		const norm = `${m[1]!.toUpperCase()}${m[2] ?? ''}${minor ? 'm' : ''}`;
		return MUSICAL_TO_CAMELOT[norm] ?? null;
	}
	return null;
}

// Open-editor state. The component owns visible-ness via its own
// signal; this only tracks which track is currently being edited so
// the async source-link fetch can early-out when the user closes the
// modal mid-load. `modalDirty` records whether any per-field reset
// fired — if so we resync the tracklist on close so the row reflects
// the new canonical values immediately. `initialUrls` snapshots the
// URL inputs as filled by the async source-link load so saveTrackEditor
// can refetch ONLY the URLs the user actually changed (otherwise opening
// + saving without any edit would re-pull Tidal/Beatport).
let editingTrackId: string | null = null;
let modalDirty = false;
let initialUrls = { spotify: '', tidal: '', beatport: '', traxsource: '' };
// Genre/label autocomplete vocabulary. Cached across opens so reopening the
// editor shows suggestions instantly; refreshed in the background on each open
// so genres/labels added since (e.g. via a Beatport refetch) surface too.
let fieldOptionsCache: { genres: string[]; labels: string[] } = { genres: [], labels: [] };
// Tracks the per-field reset IPCs that are still in flight. If the user
// clicks × on multiple fields and then closes the modal fast, those writes
// may not be committed yet when onClose fires — running renderTracks
// immediately would read pre-reset rows from the DB. We await this set
// before rendering on close.
const pendingResets = new Set<Promise<unknown>>();

export async function openTrackEditor(trackId: string): Promise<void> {
	const t = tracksData.get(trackId);
	if (!t) { slog.warn('no track in tracksById', { trackId }); return; }
	const trackEditModal = deps.getModal();
	if (!trackEditModal) { slog.warn('modal not mounted (boot likely threw before mountTrackEditModal)'); return; }

	// open() must precede form() — the <form> lives inside <Show when={isOpen()}>,
	// so the ref isn't populated until the signal flips. Solid renders synchronously
	// here so formRef is set by the time open() returns.
	editingTrackId = trackId;
	modalDirty = false;
	initialUrls = { spotify: '', tidal: '', beatport: '', traxsource: '' };
	pendingResets.clear();
	trackEditModal.open();
	const form = trackEditModal.form();
	if (!form) { slog.warn('form() returned null after open()'); trackEditModal.close(); return; }

	// Feed the genre/label autocomplete from cache immediately, then refresh in
	// the background. The Key field's suggestions are static and owned by the
	// component. The setter just writes a signal, so a late resolve after a
	// close/reopen is harmless.
	trackEditModal.setFieldOptions(fieldOptionsCache);
	void tracksApi.fieldOptions()
		.then((opts) => { fieldOptionsCache = opts; trackEditModal.setFieldOptions(opts); })
		.catch((err) => slog.warn('failed to load field options', undefined, err));

	const set = (name: string, v: string | number | null | undefined) => {
		const el = form.elements.namedItem(name) as HTMLInputElement | null;
		if (el) el.value = v == null ? '' : String(v);
	};
	set('title', t.title);
	trackEditModal.setArtists(t.artists ?? []);
	set('album', t.albumTitle);
	set('label', t.label);
	set('genre', t.genre);
	set('bpm', t.bpm);
	// Key is stored as Camelot only; show its musical spelling in the field
	// (the input accepts either notation back). Falls back to raw Camelot.
	set('key', t.keyCamelot ? camelotToMusical(t.keyCamelot) : '');

	// Source URLs come from source_link rows; clear placeholders first then
	// fill async — modal can already show while we fetch.
	set('spotifyUrl', '');
	set('tidalUrl', '');
	set('beatportUrl', '');
	set('traxsourceUrl', '');
	deps.getModal()?.setDerivedUrls([]);
	deps.getModal()?.setOtherUrls({});
	(form.elements.namedItem('title') as HTMLInputElement | null)?.focus();
	(form.elements.namedItem('title') as HTMLInputElement | null)?.select();

	try {
		const links = await tracksApi.sourceLinks(trackId);
		// Only fill if the modal is still open for this track (user may have
		// closed/reopened by the time the fetch resolves).
		if (trackEditModal.isOpen() && editingTrackId === trackId) {
			// Same fallback as the context menu — derive a canonical URL from
			// sourceTrackId when the stored url is null on legacy rows.
			const derive = (source: string, id: string): string => {
				switch (source) {
					case 'spotify':  return `https://open.spotify.com/track/${id}`;
					case 'tidal':    return `https://tidal.com/browse/track/${id}`;
					case 'beatport': return `https://www.beatport.com/track/-/${id}`;
					case 'traxsource': return `https://www.traxsource.com/track/${id}`;
					default:         return '';
				}
			};
			// Core lists a provider's primary first (own links, then the
			// claim-derived ones by rank): the field shows it, the rest are
			// listed under the field.
			const byS = new Map<string, string>();
			const firstOf = new Map<string, (typeof links)[number]>();
			const others: Record<string, string[]> = {};
			for (const l of links) {
				const url = l.url ?? derive(l.source, l.sourceTrackId);
				if (!firstOf.has(l.source)) { firstOf.set(l.source, l); byS.set(l.source, url); }
				else if (url && url !== byS.get(l.source)) (others[`${l.source}Url`] ??= []).push(url);
			}
			initialUrls = {
				spotify:  byS.get('spotify')  ?? '',
				tidal:    byS.get('tidal')    ?? '',
				beatport: byS.get('beatport') ?? '',
				traxsource: byS.get('traxsource') ?? '',
			};
			set('spotifyUrl',  initialUrls.spotify);
			set('tidalUrl',    initialUrls.tidal);
			set('beatportUrl', initialUrls.beatport);
			set('traxsourceUrl', initialUrls.traxsource);
			// Ids another device linked (core claim-links.ts) fill the field
			// too, marked "from your account". They sit in initialUrls like an
			// own link, so leaving one alone saves nothing; editing it sets this
			// device's own link, and clearing it hides it on this device (core
			// deleteTrackSourceLink dismisses a derived link).
			deps.getModal()?.setDerivedUrls([...firstOf.values()].filter((l) => l.derived).map((l) => `${l.source}Url`));
			deps.getModal()?.setOtherUrls(others);
		}
	} catch (err) {
		slog.warn('failed to load source links', undefined, err);
	}
}

function closeTrackEditor(): void {
	deps.getModal()?.close();
	editingTrackId = null;
}

export async function saveTrackEditor(): Promise<void> {
	const trackId = editingTrackId;
	const form = deps.getModal()?.form();
	if (!trackId || !form) return;
	// Drain any per-field × resets that are still in flight so we don't
	// read a stale (pre-clear) form value and write it back as an override.
	if (pendingResets.size > 0) await Promise.all(pendingResets);

	const read = (name: string): string => {
		const el = form.elements.namedItem(name) as HTMLInputElement | null;
		return (el?.value ?? '').trim();
	};

	const title = read('title');
	const artistList = deps.getModal()?.getArtists() ?? [];
	const album = read('album');
	const label = read('label');
	const genre = read('genre');
	const bpmRaw = read('bpm');
	const keyRaw = read('key');

	// Two patches: setPatch holds non-empty values (apply as overrides),
	// clearList holds fields the user emptied (hard-clear: drops override
	// AND nulls canonical for nullable fields). This matches the natural
	// expectation that erasing a value in the modal erases it in the DB —
	// not just the override layer over a canonical that keeps showing.
	const setPatch: Record<string, unknown> = {};
	const clearList: ClearableTrackField[] = [];
	if (title) setPatch.title = title; else clearList.push('title');
	// Chips are already TrackArtist[] with explicit roles — core normalizes
	// (curated spellings, aliases) on the way in.
	if (artistList.length > 0) setPatch.artists = artistList;
	else clearList.push('artists');
	if (album) setPatch.albumTitle = album; else clearList.push('albumTitle');
	if (label) setPatch.label = label; else clearList.push('label');
	if (genre) setPatch.genre = genre; else clearList.push('genre');
	const bpm = bpmRaw ? Math.max(0, Math.round(Number(bpmRaw))) : null;
	if (Number.isFinite(bpm) && bpm !== null && bpm > 0) setPatch.bpm = bpm;
	else clearList.push('bpm');
	if (keyRaw) {
		const camelot = parseKeyInput(keyRaw);
		if (camelot) setPatch.keyCamelot = camelot;
		else clearList.push('keyCamelot');
	} else {
		clearList.push('keyCamelot');
	}

	const spotifyUrl = read('spotifyUrl');
	const tidalUrl = read('tidalUrl');
	const beatportUrl = read('beatportUrl');
	const traxsourceUrl = read('traxsourceUrl');

	try {
		if (Object.keys(setPatch).length > 0) {
			await tracksApi.setOverrides(trackId, setPatch as Parameters<typeof tracksApi.setOverrides>[1]);
		}
		if (clearList.length > 0) {
			await tracksApi.clearFields(trackId, clearList);
		}
	} catch (err) {
		slog.error('save overrides failed', err);
		showToast('Save failed', { sub: 'Could not save edits', kind: 'error' });
		return;
	}

	// Source URLs go in a separate call so a Beatport refetch can run server-side
	// without blocking the overrides write. We diff against the snapshot taken
	// when the modal opened: changed-and-non-empty URLs upsert (and refetch);
	// emptied URLs that previously had a link delete that link.
	const urlDeletes: ('spotify' | 'tidal' | 'beatport' | 'traxsource')[] = [];
	if (!spotifyUrl  && initialUrls.spotify)  urlDeletes.push('spotify');
	if (!tidalUrl    && initialUrls.tidal)    urlDeletes.push('tidal');
	if (!beatportUrl && initialUrls.beatport) urlDeletes.push('beatport');
	if (!traxsourceUrl && initialUrls.traxsource) urlDeletes.push('traxsource');
	for (const src of urlDeletes) {
		try {
			await tracksApi.deleteSourceLink(trackId, src);
		} catch (err) {
			showToast(`${src}: link delete failed`, { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		}
	}
	const urlPayload: { spotify?: string | null; tidal?: string | null; beatport?: string | null; traxsource?: string | null } = {};
	if (spotifyUrl  && spotifyUrl  !== initialUrls.spotify)  urlPayload.spotify  = spotifyUrl;
	if (tidalUrl    && tidalUrl    !== initialUrls.tidal)    urlPayload.tidal    = tidalUrl;
	if (beatportUrl && beatportUrl !== initialUrls.beatport) urlPayload.beatport = beatportUrl;
	if (traxsourceUrl && traxsourceUrl !== initialUrls.traxsource) urlPayload.traxsource = traxsourceUrl;
	// Provider ids already owned by another live track — offered as merges
	// after the modal closes (one dialog at a time).
	const conflicts: SourceLinkError[] = [];
	if (Object.keys(urlPayload).length > 0) {
		try {
			const res = await tracksApi.setSourceLinks(trackId, urlPayload);
			// Surface every error individually so the user sees which provider
			// failed and why (parse failure, not connected, track-not-found,
			// network etc.). Stays open at 6s — long enough to read.
			for (const e of res.errors) {
				if (e.code === 'already-linked' && e.conflictTrackId) { conflicts.push(e); continue; }
				showToast(`${e.source}: error`, { sub: e.message, kind: 'error', durationMs: 6000 });
			}
			if (res.refetched.length) {
				const list = res.refetched.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
				showToast(`${list} refetched`, { sub: 'Updated fields where not overridden', kind: 'success' });
			}
		} catch (err) {
			slog.error('save source links failed', err);
			showToast('Source link save failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		}
	}

	// closeTrackEditor() fires the modal's onClose, which would also call
	// renderTracks() if modalDirty is true. Clear the flag first so we
	// only render once (the await below).
	modalDirty = false;
	closeTrackEditor();
	await deps.renderTracks();

	for (const c of conflicts) {
		// Stop after the first merge that removes the edited row — any later
		// conflict would be against a track that no longer exists.
		const merged = await offerMerge(trackId, c);
		if (merged && merged.dropId === trackId) break;
	}
}

// ─── Merge offer ───────────────────────────────────────────────────────────
// The provider id the user typed belongs to another live track. Instead of
// just discarding the URL, preview a merge of the two rows and let the user
// pick the survivor. The conflicting link is never re-applied here: when
// the merge runs it moves with the row (drop's links fold into keep's), so
// the survivor owns it either way.
async function offerMerge(editingId: string, e: SourceLinkError): Promise<{ keepId: string; dropId: string } | null> {
	const dialog = deps.getMergeDialog();
	const otherId = e.conflictTrackId!;
	if (!dialog) {
		showToast(`${e.source}: error`, { sub: e.message, kind: 'error', durationMs: 6000 });
		return null;
	}
	let preview;
	try {
		preview = await tracksApi.mergePreview(editingId, otherId);
	} catch (err) {
		slog.error('merge preview failed', err);
		showToast(`${e.source}: error`, { sub: e.message, kind: 'error', durationMs: 6000 });
		return null;
	}
	const choice = await new Promise<{ keepId: string; dropId: string } | null>((resolve) => {
		dialog.open({
			source: e.source,
			preview,
			onConfirm: (keepId, dropId) => resolve({ keepId, dropId }),
			onCancel: () => resolve(null),
		});
	});
	if (!choice) {
		showToast(`${e.source} link not saved`, { sub: 'Already linked to another track — tracks were not merged', kind: 'info', durationMs: 4000 });
		return null;
	}
	try {
		const res = await tracksApi.merge(choice.keepId, choice.dropId);
		// Mirror the merge into the renderer caches before the refetch so the
		// list drops the loser and the survivor's row repaints immediately.
		tracksData.removeMany(new Set([choice.dropId]));
		tracksData.upsert(res.survivor);
		deps.invalidateTrackCaches(choice.keepId);
		deps.invalidateTrackCaches(choice.dropId);
		deps.patchTrackRow(res.survivor);
		const bits: string[] = [];
		if (res.tagsAdded) bits.push(`${res.tagsAdded} tag${res.tagsAdded === 1 ? '' : 's'}`);
		if (res.membershipsMoved) bits.push(`${res.membershipsMoved} playlist${res.membershipsMoved === 1 ? '' : 's'}`);
		if (res.linksMoved) bits.push(`${res.linksMoved} link${res.linksMoved === 1 ? '' : 's'}`);
		showToast(`Merged into “${res.survivor.title}”`, {
			sub: bits.length ? `Carried over ${bits.join(', ')}` : undefined,
			kind: 'success',
			durationMs: 4000,
		});
		for (const msg of res.errors) slog.warn('merge post-step failed', { msg });
		if (res.playlistsTouched.length > 0) await deps.refreshAll();
		else await deps.renderTracks();
		return choice;
	} catch (err) {
		slog.error('merge failed', err);
		showToast('Merge failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
		return null;
	}
}

// onClose callback for the mounted modal — wired in boot() alongside
// onSubmit/onResetField.
export function handleTrackEditorClose(): void {
	editingTrackId = null;
	// If the user reset any field while the modal was open,
	// resync the visible tracklist on close. saveTrackEditor()
	// always renders itself; it sets modalDirty = false first
	// to avoid a double render via this path.
	if (modalDirty) {
		modalDirty = false;
		// Await any in-flight reset IPCs first — without this,
		// renderTracks() can fire before the clear-fields /
		// delete-source-link writes have committed and read
		// pre-reset rows from the DB. The modal hides synchronously
		// regardless (close() doesn't await this callback).
		void (async () => {
			if (pendingResets.size > 0) await Promise.all(pendingResets);
			await deps.renderTracks();
		})();
	}
}

// Per-field reset for the Edit Track modal. Metadata fields hard-clear:
// the override key is removed AND the canonical column is nulled (for
// nullable columns — title/artists are NOT NULL, so for those only the
// override is dropped). This matches user intent of "make this empty in
// the DB", which is what they want when a value originally came from a
// Beatport refetch (written to canonical, not overrides) and clicking ×
// previously did nothing. URL fields delete the corresponding source_link
// row outright. After each reset we refill the input with the post-reset
// value and mark the modal dirty so onClose resyncs the tracklist.
export function resetTrackEditorField(field: string): Promise<void> {
	const trackId = editingTrackId;
	const form = deps.getModal()?.form();
	if (!trackId || !form) return Promise.resolve();
	const setInput = (name: string, value: string): void => {
		const el = form.elements.namedItem(name) as HTMLInputElement | null;
		if (el) el.value = value;
	};

	// Mark the modal dirty SYNCHRONOUSLY — before any await — so that if the
	// user clicks the modal's close × immediately after a field ×, the close
	// handler reliably sees `modalDirty = true` and schedules a tracklist
	// resync. (Setting it after the await means a fast close races the IPC
	// and the resync is skipped.)
	modalDirty = true;

	const urlMap: Record<string, 'spotify' | 'tidal' | 'beatport' | 'traxsource'> = {
		spotifyUrl: 'spotify', tidalUrl: 'tidal', beatportUrl: 'beatport', traxsourceUrl: 'traxsource',
	};
	const fieldMap: Record<string, ClearableTrackField[]> = {
		title:   ['title'],
		artists: ['artists'],
		album:   ['albumTitle'],
		label:   ['label'],
		genre:   ['genre'],
		bpm:     ['bpm'],
		key:     ['keyCamelot'],
	};

	const promise = (async () => {
		// URL fields → delete source_link row, clear the input. Also clear
		// the snapshot so a subsequent save with the same URL retyped counts
		// as a new link (and refetches), instead of being diffed away.
		if (field in urlMap) {
			try {
				const source = urlMap[field]!;
				await tracksApi.deleteSourceLink(trackId, source);
				setInput(field, '');
				initialUrls[source] = '';
			} catch (err) {
				showToast('Reset failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			}
			return;
		}

		// Metadata fields → hard-clear via tracks:clear-fields.
		const fields = fieldMap[field];
		if (!fields) return;
		try {
			const updated = await tracksApi.clearFields(trackId, fields);
			if (!updated) return;
			tracksData.upsert(updated);
			switch (field) {
				case 'title':   setInput('title', updated.title ?? ''); break;
				case 'artists': deps.getModal()?.setArtists(updated.artists ?? []); break;
				case 'album':   setInput('album', updated.albumTitle ?? ''); break;
				case 'label':   setInput('label', updated.label ?? ''); break;
				case 'genre':   setInput('genre', updated.genre ?? ''); break;
				case 'bpm':     setInput('bpm', updated.bpm != null ? String(updated.bpm) : ''); break;
				case 'key':     setInput('key', updated.keyCamelot ? camelotToMusical(updated.keyCamelot) : ''); break;
			}
		} catch (err) {
			showToast('Reset failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		}
	})();
	pendingResets.add(promise);
	void promise.finally(() => pendingResets.delete(promise));
	return promise;
}

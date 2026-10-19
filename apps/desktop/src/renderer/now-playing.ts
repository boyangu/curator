// Shared "which track is currently playing" state. Read at row-construction
// time by createTrackRow (the tracks table) so a freshly-painted row already
// shows the meter, and swept onto already-painted rows by the setter so
// live transitions (next track, pause/resume) flip without a re-render.
//
// The row factory renders BOTH the `#` number and the meter in every index
// cell (two-line rows with a cover also carry a meter over the cover); CSS
// picks what shows from `tr.row-playing` (+ `has-cover-meter`). A transition
// therefore only toggles one class. The old approach swapped the cell's
// innerHTML and had to rebuild the number on the way out — from the array
// index, which showed the wrong number in a sorted or filtered playlist.
//
// Lives in its own module to avoid a circular dep between main.ts (player
// subscription) and track-list.ts (the row factory).

let currentTrackId: string | null = null;

function cssEscape(s: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
	return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// The meter markup — four CSS bars (live heights from eq-driver.ts via
// --np-eq-*, keyframe fallback otherwise). Inherits currentColor-free VU
// colours from `.now-playing-eq i` in style.css.
export const NOW_PLAYING_EQ_HTML = '<span class="now-playing-eq" aria-label="now playing"><i></i><i></i><i></i><i></i></span>';

export function getNowPlayingTrackId(): string | null {
	return currentTrackId;
}

export function setNowPlayingTrackId(id: string | null): void {
	if (id === currentTrackId) return;
	const prev = currentTrackId;
	currentTrackId = id;
	// Multiple matches per id are valid — the same track can appear more
	// than once in the table, and all should light up.
	if (prev) {
		document.querySelectorAll<HTMLTableRowElement>(`.trk[data-id="${cssEscape(prev)}"]`).forEach((r) => r.classList.remove('row-playing'));
	}
	if (id) {
		document.querySelectorAll<HTMLTableRowElement>(`.trk[data-id="${cssEscape(id)}"]`).forEach((r) => r.classList.add('row-playing'));
	}
}

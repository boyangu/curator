// Drag-payload contract between track-row drag sources (track-list.ts) and
// external drop targets (the sidebar's playlist rows). HTML5 DnD only exposes
// payload TYPES during dragover — the data itself is readable at drop time
// only — so targets gate hover feedback on the custom MIME type and decode
// the id list in their drop handler.

export const TRACK_DRAG_MIME = 'application/x-curator-track-ids';

export function setTrackDragPayload(dt: DataTransfer, trackIds: readonly string[]): void {
	dt.setData(TRACK_DRAG_MIME, JSON.stringify(trackIds));
}

export function hasTrackDragPayload(dt: DataTransfer | null): boolean {
	return !!dt && dt.types.includes(TRACK_DRAG_MIME);
}

export function readTrackDragPayload(dt: DataTransfer | null): string[] | null {
	if (!dt) return null;
	try {
		const parsed: unknown = JSON.parse(dt.getData(TRACK_DRAG_MIME));
		if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) return null;
		return parsed as string[];
	} catch {
		return null;
	}
}

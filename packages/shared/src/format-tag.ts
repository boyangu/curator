// Format tag Curator appends to the title of a track it minted as a format
// copy of another ("Convert to WAV": "Song (X Remix)" → "Song (X Remix) [WAV]").
// The tag is part of the stored title — it has to reach rekordbox and every
// list a DJ scans on an old deck — so the display/push formatters must keep it
// LAST rather than treating it as an ordinary bracket segment.

export const FORMAT_TAG_RE = /\s+\[(?:WAV|AIFF)\]$/;

export function stripFormatTag(title: string): { base: string; tag: string } {
	const m = title.match(FORMAT_TAG_RE);
	if (!m || m.index == null) return { base: title, tag: '' };
	return { base: title.slice(0, m.index), tag: m[0] };
}

// Idempotent: re-tagging an already-tagged title leaves it unchanged.
export function withFormatTag(title: string, format: 'WAV' | 'AIFF'): string {
	return `${stripFormatTag(title).base} [${format}]`;
}

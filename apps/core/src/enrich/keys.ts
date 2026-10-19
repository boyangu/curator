// Best-effort: convert "Am" / "F#m" → Camelot ("8A" / "11A"). Returns null
// if input isn't a recognized musical key. Lives here (not in sync/spotify.ts)
// so the enrich/ module stays self-contained — no dependency back into the
// Spotify sync code. The renderer mirrors this map in editTrack.ts.
export function keyToCamelot(key: string | null): string | null {
	if (!key) return null;
	// Collapse spelled-out qualities to the bare ''/'m' the map uses, so
	// "Bb major" / "D minor" resolve instead of falling through to null.
	// Mirrors parseKeyInput() in the renderer's editTrack.ts.
	key = key.trim().replace(/\s+/g, '').replace(/(maj|major)$/i, '').replace(/(min|minor)$/i, 'm');
	const map: Record<string, string> = {
		Cm: '5A', C: '8B', 'C#': '3B', 'C#m': '12A', Db: '3B', 'Dbm': '12A',
		D: '10B', Dm: '7A', 'D#': '5B', 'D#m': '2A', Eb: '5B', Ebm: '2A',
		E: '12B', Em: '9A', F: '7B', Fm: '4A', 'F#': '2B', 'F#m': '11A',
		Gb: '2B', Gbm: '11A', G: '9B', Gm: '6A', 'G#': '4B', 'G#m': '1A',
		Ab: '4B', Abm: '1A', A: '11B', Am: '8A', 'A#': '6B', 'A#m': '3A',
		Bb: '6B', Bbm: '3A', B: '1B', Bm: '10A',
	};
	return map[key] ?? null;
}

// ISRC (ISO 3901) in canonical form: 12 characters, uppercase, no separators.
// Presentation varies by who wrote it — Spotify and Tidal send
// `GBSMU1676261`, rippers tag files `gbsmu1676261`, and the printed form is
// `GB-SMU-16-76261` — but every lookup that keys on the value (the
// track.isrc index, provider ISRC search, the startup dedup, catalogue
// claims) needs exactly one spelling.
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

// Canonical form, or null when the value is not an ISRC once presentation
// is stripped. Returning null rather than the cleaned-up junk keeps a stray
// tag value out of an indexed column where it would pass for identity.
export function normalizeIsrc(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const s = raw.trim().toUpperCase().replace(/[\s-]/g, '');
	return ISRC_RE.test(s) ? s : null;
}

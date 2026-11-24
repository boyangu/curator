// Result of parsing one audio file. Flat shape — anything that was buried in
// music-metadata's nested `common`/`format` is hoisted up so downstream code
// (scanner, source_link writer) doesn't depend on the music-metadata types.

export interface ParseResult {
	title: string | null;
	artists: string[];
	albumTitle: string | null;
	// Rounded seconds. null if the decoder couldn't determine length.
	duration: number | null;
	isrc: string | null;
	// BPM tag from the file. The analyzer's beatgrid BPM supersedes this
	// later; we persist this so a freshly-imported track has *something* in
	// the BPM column before analysis runs.
	bpm: number | null;
	genre: string | null;
	label: string | null;
	// Container as music-metadata reports it (flac, mp4, mpeg, …), lowercased.
	// Used by the curator-local:// protocol handler to pick a MIME type.
	container: string | null;
	// Scheme-prefixed identity of the audio stream (ingest/audio-hash.ts) —
	// survives tag rewrites, so the scanner can re-bind a moved or re-tagged
	// file to its row. null for unsupported containers or a parse failure.
	// Filled by the parser (parseInline), not by extract(): it comes from the
	// file's bytes, not from music-metadata.
	audioHash: string | null;
}

// Function signature used to inject a parser implementation into the scanner.
// In Electron the desktop main process injects a utility-process-backed
// implementation; in tests / headless CLI we fall back to parseInline.
export type ParseFn = (path: string) => Promise<ParseResult>;

// A file's embedded album art, bytes as stored in the tag. Uint8Array (not
// Buffer) so it crosses structured-clone boundaries as-is.
export interface CoverArt {
	data: Uint8Array;
	format: string;
}

// Embedded-art reader, injected the same way as ParseFn: the desktop main
// process hands in the utility-process pool, because reading the art means a
// full music-metadata parse — the cover protocol must not run that on the
// main loop. null = the file has no picture.
export type CoverFn = (path: string) => Promise<CoverArt | null>;

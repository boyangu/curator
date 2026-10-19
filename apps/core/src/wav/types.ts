// Convert to WAV — shared shapes for the core run, the IPC contract and the
// renderer. See convert-run.ts for the flow and materialize.ts for what a
// WAV copy carries over from its FLAC original.

export interface WavSettings {
	// Normalized (forward slashes, lowercase drive letter) absolute folder the
	// converter writes into. Defaults to <OS Music folder>/WAV.
	outputDir: string;
	// True when the value came from app_setting rather than the default.
	stored: boolean;
}

// What happens to one playlist member. 'convert' = a FLAC with no live WAV
// copy yet; 'reuse' = an existing live copy whose file is on disk; 'kept' =
// a member already playable on older decks (WAV/AIFF/MP3/AAC, or a copy
// itself) — it goes into the [WAV] playlist unchanged; 'skipped' = nothing
// local to play (streaming-only, or the file is missing on disk).
export type WavMemberPlan = 'convert' | 'reuse' | 'kept' | 'skipped';

export interface WavPreview {
	playlistId: string;
	playlistName: string;
	// Name the derived playlist has (existing) or will get (new).
	targetPlaylistName: string;
	targetPlaylistExists: boolean;
	outputDir: string;
	available: boolean;           // false = converter binary not configured
	convert: number;
	reuse: number;
	kept: number;
	skipped: number;
	// Sources above 48 kHz that will be resampled (to 44.1 or 48 kHz).
	resample: number;
	estimatedBytes: number;
	// Free space on the output volume, or null when it couldn't be read.
	freeBytes: number | null;
	// Display names of skipped members (capped) so the confirm can say why.
	skippedTitles: string[];
}

export interface WavConvertResult {
	playlistId: string;           // the derived "[WAV]" playlist
	converted: number;
	reused: number;
	kept: number;
	skipped: number;
	failed: number;
	cancelled: boolean;
	outputDir: string;
	failures: Array<{ trackId: string; title: string; message: string }>;
}

export type WavConvertEvent =
	| { kind: 'started'; runId: string; playlistId: string; total: number }
	| { kind: 'progress'; runId: string; playlistId: string; done: number; total: number; currentTitle: string | null }
	| { kind: 'trackFailed'; runId: string; playlistId: string; trackId: string; title: string; message: string }
	| { kind: 'completed'; runId: string; playlistId: string; result: WavConvertResult }
	| { kind: 'failed'; runId: string; playlistId: string; message: string };

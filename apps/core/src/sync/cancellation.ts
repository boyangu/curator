// Shared cancellation flag for long-running enrichment / hybrid-sync loops.
// One instance is created per CoreService and passed to both SpotifySync (for
// Beatport enrichment) and TidalHybrid (for the per-track Tidal matcher), so
// a single IPC cancel hits whichever is running.
//
// The loops `reset()` at the start of a session and check `cancelled`
// between iterations. After a cancelled run, callers report it via the
// existing progress channel (`stage: 'done'` with `cancelled: true`) so
// the renderer can clear the inline indicator + sidebar pulse.

export class CancelToken {
	private _cancelled = false;
	request(): void { this._cancelled = true; }
	reset(): void { this._cancelled = false; }
	get cancelled(): boolean { return this._cancelled; }
}

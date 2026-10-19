// One progress bar for a whole rekordbox sync instead of one per phase.
//
// The core reports every sub-step with its own done/total (the pull's reader
// passes, then resolve / backup / write / verify), and the modals used to draw
// each as a fresh 0–100% bar, so the bar refilled five-plus times per sync and
// said nothing about how far along the sync was. Here the bar is split equally
// across the root steps, each root's slice equally across its sub-steps, and a
// sub-step's done/total fills its own slice.
//
// Steps that don't run (the WAV create phase on a normal playlist, the pull on
// a resume-with-resolutions) are jumped over, and the tracker never moves the
// bar backwards: an unknown or out-of-order phase holds the current position.

export type ProgressPlan = ReadonlyArray<{ id: string; steps: readonly string[] }>;

// Reader passes in the order the rekordbox sidecar runs them, then the
// importer's own cue merge. `open` is the placeholder the renderer shows before
// the first wire event.
const PULL_STEPS = ['open', 'tracks', 'cues', 'waveforms', 'grids', 'playlists', 'mytags', 'history', 'cue-merge'] as const;

// Sync to rekordbox: the pre-push pull arrives prefixed `pull:`, then the
// exporter's phases. The WAV create phase runs before resolve, so the two share
// a root: on a normal playlist resolve simply starts past the create slices.
//
// `commit` (pyrekordbox's commit: SQLCipher flush + masterPlaylists6.xml
// rewrite) is the second half of the write root, not a root of its own: it's
// the tail of the same write session, and its cost scales with the batch just
// staged, so write and commit split one slice. As its own root a binary 0/1
// step would own a sixth of the bar and the bar would sit still across it.
export const SYNC_TO_REKORDBOX_PLAN: ProgressPlan = [
	{ id: 'pull', steps: PULL_STEPS.map((p) => `pull:${p}`) },
	{ id: 'prepare', steps: ['create:backup', 'create:write', 'create:verify', 'resolve'] },
	{ id: 'backup', steps: ['backup'] },
	{ id: 'write', steps: ['write', 'commit'] },
	{ id: 'verify', steps: ['verify'] },
];

// Sync from rekordbox: the reader passes unprefixed, nothing after them.
export const SYNC_FROM_REKORDBOX_PLAN: ProgressPlan = [{ id: 'pull', steps: PULL_STEPS }];

// Overall fraction (0..1) for a phase event, or null when the plan does not
// know the phase.
export function overallFraction(plan: ProgressPlan, phase: string, done: number, total: number): number | null {
	const rootShare = 1 / plan.length;
	for (let r = 0; r < plan.length; r++) {
		const steps = plan[r]!.steps;
		const s = steps.indexOf(phase);
		if (s === -1) continue;
		const stepShare = rootShare / steps.length;
		const within = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
		return r * rootShare + s * stepShare + within * stepShare;
	}
	return null;
}

export interface ProgressTracker {
	// Percent 0..100 after this event; never lower than the previous value.
	update(phase: string, done: number, total: number): number;
	reset(): void;
}

export function createProgressTracker(plan: ProgressPlan): ProgressTracker {
	let max = 0;
	return {
		update(phase, done, total) {
			const f = overallFraction(plan, phase, done, total);
			if (f !== null) max = Math.max(max, f);
			return Math.round(max * 100);
		},
		reset() {
			max = 0;
		},
	};
}

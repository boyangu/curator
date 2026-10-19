// BackupHost — the async seam between the backup service (settings,
// scheduler, IPC — in main) and wherever the engine runs. Two
// implementations:
//   - createInlineBackupHost (here): the engine in-process. Tests, the
//     headless CLI, the core-sidecar.
//   - UtilityBackupHost (apps/desktop/src/main/backup/host.ts): the engine
//     in an Electron utilityProcess, so VACUUM INTO, hashing 190 GB and
//     zstd never touch the main loop. Same injection pattern as
//     workspaceHost / parseAudio.

import { BackupEngine } from './engine.js';
import type { TargetDeps } from './targets/index.js';
import type { BackupEngineConfig, BackupHost } from './types.js';

export function createInlineBackupHost(cfg: BackupEngineConfig, deps: TargetDeps = {}): BackupHost {
	const engine = new BackupEngine(cfg, deps);
	return {
		run: (plan) => engine.run(plan),
		async cancel(runId) { engine.cancel(runId); },
		listSnapshots: (target, opts) => engine.listSnapshots(target, opts),
		pin: (target, id, label) => engine.pin(target, id, label),
		deleteSnapshot: (target, id) => engine.deleteSnapshot(target, id),
		targetStat: (target) => engine.targetStat(target),
		restorePreview: (target, id) => engine.restorePreview(target, id),
		restoreStage: (runId, target, req) => engine.restoreStage(runId, target, req),
		restoreTracks: (runId, target, req) => engine.restoreTracks(runId, target, req),
		restoreRekordbox: (runId, target, req) => engine.restoreRekordbox(runId, target, req),
		onEvent: (cb) => engine.subscribe(cb),
		async stop() { engine.cancelActive(); engine.close(); },
	};
}

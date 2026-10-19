// Push-event ingestion — IPC events update DATA, never DOM or views
// (planning/tech/frontend-architecture.md F2). One boot-time wire-up per
// domain; whoever renders the affected rows reacts through store
// subscriptions. Domains migrate here one at a time from main.ts's
// wireX() functions — each migration deletes its wireX.

import { downloadsApi } from './api.js';
import { downloads } from './downloads.js';

export function wireDataEvents(): void {
	// Downloads: live queue transitions patch single rows; the snapshot
	// seed covers jobs that predate this window.
	downloadsApi.onQueueEvent((evt) => downloads.ingestEvent(evt));
	void downloads.seedMissing().catch(() => { /* download subsystem disabled / boot ordering — ignore */ });
}

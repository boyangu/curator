// node:fs/promises as the sync client uses it: only the master's snapshot
// publish reads and removes its part files. A phone is never the master.

export async function readFile(): Promise<never> {
	throw new Error('readFile is not in the phone host (the master publishes snapshots, not the phone)');
}

export async function rm(): Promise<void> {}

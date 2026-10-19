// OS defaults + user-override resolution for Rekordbox master.db.
//
// The sidecar exposes a `detect` RPC that returns the same defaults; this
// module is for the Node side's pre-launch lookups (e.g. showing the
// auto-detected path in the settings modal even before the sidecar is
// fully alive).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// rekordbox's preferences folder (rekordbox3.settings, My Settings, key /
// MIDI mappings…) — a sibling of the library folder, not inside it. Backed
// up alongside master.db so a restored rekordbox opens identically.
export function defaultRekordboxSettingsDir(): string | null {
	let candidate: string;
	if (process.platform === 'darwin') {
		candidate = join(homedir(), 'Library', 'Application Support', 'Pioneer', 'rekordbox6');
	} else if (process.platform === 'win32') {
		const appdata = process.env.APPDATA;
		if (!appdata) return null;
		candidate = join(appdata, 'Pioneer', 'rekordbox6');
	} else {
		candidate = join(homedir(), '.config', 'Pioneer', 'rekordbox6');
	}
	return existsSync(candidate) ? candidate : null;
}

export function defaultRekordboxDbPath(): string | null {
	let candidate: string;
	if (process.platform === 'darwin') {
		candidate = join(homedir(), 'Library', 'Pioneer', 'rekordbox', 'master.db');
	} else if (process.platform === 'win32') {
		const appdata = process.env.APPDATA;
		if (!appdata) return null;
		candidate = join(appdata, 'Pioneer', 'rekordbox', 'master.db');
	} else {
		candidate = join(homedir(), '.config', 'Pioneer', 'rekordbox', 'master.db');
	}
	return existsSync(candidate) ? candidate : null;
}

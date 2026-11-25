// node:fs as the core uses it on the phone: what installing a ready-made
// library needs (sync-log/replica.ts installReplica) — whether a path exists,
// a file read or written whole, bytes appended, a rename, a remove — and the
// waveform cache's folders. The master's half (buildReplica) reads its file in
// slices and never runs here; those calls refuse, so a use nobody expected
// shows up as an error.

import { host } from './host.js';
import { Buffer } from './globals.js';

const unsupported = (name: string) => (): never => { throw new Error(`fs.${name} is not in the phone's node:fs`); };

export function existsSync(path: string): boolean {
	return host.fileSize(path) >= 0;
}

export function statSync(path: string): { size: number } {
	const size = host.fileSize(path);
	if (size < 0) throw new Error(`ENOENT: no such file, stat '${path}'`);
	return { size };
}

export function readFileSync(path: string, enc?: string): Uint8Array | string {
	if (enc === 'utf8' || enc === 'utf-8') return host.readText(path);
	if (enc !== undefined) throw new Error(`fs.readFileSync(${enc}) is not in the phone's node:fs`);
	return Buffer.from(host.readBytes(path));
}

export function writeFileSync(path: string, data: string | Uint8Array): void {
	if (typeof data === 'string') host.writeText(path, data);
	else host.writeBytes(path, data, false);
}

export function appendFileSync(path: string, data: Uint8Array): void {
	host.writeBytes(path, data, true);
}

export function renameSync(from: string, to: string): void {
	host.renameFile(from, to);
}

// The core passes { force: true } and plain files only.
export function rmSync(path: string, opts?: { force?: boolean; recursive?: boolean }): void {
	if (opts?.recursive) throw new Error(`fs.rmSync({ recursive }) is not in the phone's node:fs`);
	if (!opts?.force && host.fileSize(path) < 0) throw new Error(`ENOENT: no such file, rm '${path}'`);
	host.removeFile(path);
}

export function mkdirSync(path: string): void {
	host.makeDirs(path);
}

export const openSync = unsupported('openSync');
export const readSync = unsupported('readSync');
export const closeSync = unsupported('closeSync');
// migrate.ts's backups, which a phone's library never takes (entry.ts setMigrationBackups).
export const readdirSync = unsupported('readdirSync');
export const unlinkSync = unsupported('unlinkSync');

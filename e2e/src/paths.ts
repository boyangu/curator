import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

// Git-ignored (planning/): the only place the CLI writes.
export const CLI_WORK_ROOT = join(REPO_ROOT, 'planning', 'private', 'e2e');

// `2026-10-24T09-15-02`, local time — sortable, and valid in a Windows path.
export function runStamp(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// node:path as the core uses it on a phone: joining and splitting the
// library's own paths (replica.ts, migrate.ts's backup naming). POSIX only:
// the hosts run on Android.

export function join(...parts: string[]): string {
	const joined = parts.filter((p) => p.length > 0).join('/').replace(/\/+/g, '/');
	return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined || '.';
}

export function dirname(path: string): string {
	const i = path.replace(/\/+$/, '').lastIndexOf('/');
	return i < 0 ? '.' : i === 0 ? '/' : path.slice(0, i);
}

export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function resolve(...parts: string[]): string {
	return join(...parts);
}

export default { join, dirname, basename, resolve };

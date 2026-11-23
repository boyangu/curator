// node:url as the core touches it on a phone: only migrate.ts's check for
// being run as a command (`pnpm db:migrate`), which never holds here (the
// globals shim gives `process.argv` no script).

export function fileURLToPath(url: string | URL): string {
	const s = String(url);
	return s.startsWith('file://') ? decodeURIComponent(s.slice('file://'.length)) : s;
}

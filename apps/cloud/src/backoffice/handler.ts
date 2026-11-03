// The catalogue back office in a browser: one page (index.html, no build) and
// a read-only JSON API under /backoffice. No auth, so it is only ever mounted
// on loopback: by the local catalogue (cli/local.ts, beside /admin) and by
// cli/backoffice.ts against DATABASE_URL. Never by server.ts.
//
// Every call runs in a READ ONLY transaction, so a query here cannot write to
// the catalogue even when the connection's role could. The one thing the page
// writes — resolving an inbox item — goes to the host's /admin endpoint (the
// CLI's, loopback), never through here.

import { readFileSync } from 'node:fs';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { browseList, browseObject, type BrowseKind, type BrowseSort } from '../catalog/browse.js';
import { getInbox, inboxCounts, listInbox, type InboxFilter } from '../catalog/inbox.js';
import type { Severity } from '../catalog/inbox-policy.js';
import type { LocalLibrary } from '../catalog/local-library.js';

const KINDS: readonly BrowseKind[] = ['label', 'artist', 'recording'];
const SORTS: readonly BrowseSort[] = ['name', 'recent', 'watched', 'scanned', 'stale', 'tracks', 'fewest_tracks'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = new URL('./index.html', import.meta.url);

export type BackofficeHandler = (req: Request) => Promise<Response | null>;

// Answers requests under /backoffice; null for anything else, so a host can
// chain it in front of its own handler. `library`: the owner's local library
// when the host loaded one (the local catalogue), for the lists' filter.
export function createBackofficeHandler(db: Db, opts: { library?: () => LocalLibrary | null } = {}): BackofficeHandler {
	const read = <T>(fn: (tx: Queryable) => Promise<T>) =>
		db.begin(async (tx) => {
			await tx.query('set transaction read only');
			return fn(tx);
		});
	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, '');
		if (path !== '/backoffice' && !path.startsWith('/backoffice/')) return null;
		if (req.method !== 'GET') return Response.json({ error: 'read-only' }, { status: 405 });
		try {
			if (path === '/backoffice') {
				// Read per request: an edit to the page shows on reload.
				return new Response(readFileSync(PAGE), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
			}
			if (path === '/backoffice/api/stats') {
				const rows = await read((tx) =>
					tx.query<{ kind: string; n: unknown }>(`select kind, count(*) as n from curator.catalog_object where merged_into is null and kind in ('label', 'artist', 'recording', 'release') group by kind`),
				);
				return Response.json({ ...Object.fromEntries(rows.map((r) => [r.kind, num(r.n)])), library: opts.library?.() ?? null });
			}
			if (path === '/backoffice/api/list') {
				const kind = url.searchParams.get('kind') as BrowseKind;
				if (!KINDS.includes(kind)) return Response.json({ error: 'kind must be label, artist or recording' }, { status: 400 });
				const sort = (url.searchParams.get('sort') ?? 'name') as BrowseSort;
				const page = await read((tx) =>
					browseList(tx, {
						kind,
						q: url.searchParams.get('q') ?? '',
						sort: SORTS.includes(sort) ? sort : 'name',
						offset: Number(url.searchParams.get('offset') ?? 0) || 0,
						limit: Number(url.searchParams.get('limit') ?? 50) || 50,
						library: url.searchParams.get('library') === '1' && !!opts.library?.(),
					}),
				);
				return Response.json(page);
			}
			if (path === '/backoffice/api/inbox/counts') return Response.json(await read((tx) => inboxCounts(tx)));
			if (path === '/backoffice/api/inbox') {
				const status = url.searchParams.get('status') ?? 'open';
				const severity = url.searchParams.get('severity');
				const f: InboxFilter = {
					status: status === 'all' || status === 'snoozed' ? status : 'open',
					...(severity && ['audit', 'notice', 'approval'].includes(severity) ? { severity: severity as Severity } : {}),
					...(url.searchParams.get('kind') ? { kind: url.searchParams.get('kind')! } : {}),
					...(UUID_RE.test(url.searchParams.get('subject') ?? '') ? { subject: url.searchParams.get('subject')! } : {}),
					offset: Number(url.searchParams.get('offset') ?? 0) || 0,
					limit: Number(url.searchParams.get('limit') ?? 50) || 50,
				};
				return Response.json(await read((tx) => listInbox(tx, f)));
			}
			const inbox = /^\/backoffice\/api\/inbox\/(\d+)$/.exec(path);
			if (inbox) {
				const item = await read((tx) => getInbox(tx, Number(inbox[1])));
				return item ? Response.json(item) : Response.json({ error: 'not found' }, { status: 404 });
			}
			const m = /^\/backoffice\/api\/object\/([^/]+)$/.exec(path);
			if (m) {
				if (!UUID_RE.test(m[1]!)) return Response.json({ error: 'not an id' }, { status: 400 });
				const view = await read((tx) => browseObject(tx, m[1]!, { library: url.searchParams.get('library') === '1' && !!opts.library?.() }));
				return view ? Response.json(view) : Response.json({ error: 'not found' }, { status: 404 });
			}
			return Response.json({ error: 'not found' }, { status: 404 });
		} catch (e) {
			return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
		}
	};
}

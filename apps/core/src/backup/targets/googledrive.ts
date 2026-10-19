// Google Drive backup target — the BackupTarget contract over DriveClient.
// Folder tree under My Drive:
//   <folderName>/curator-backup/<libraryId>/{library.json, snapshots/, pins/, objects/<aa>/}
// Folder ids are resolved once per init and cached; the 256 object shards
// are resolved lazily (created on first put) because Drive has no "mkdir -p"
// and every lookup is a request. Runs inside the backup worker: no Electron,
// no engine — the access token arrives through the injected callback.

import { readFile } from 'node:fs/promises';
import { DriveClient, SMALL_UPLOAD_MAX, type DriveFile } from '@curator/google-drive';
import { log } from '../../log.js';
import { LIBRARY_ROOT, type BackupTarget, type GetObjectOptions, type ObjectSource, type PutObjectOptions, type RemoteFileInfo, type RemoteObjectInfo } from './types.js';

const tlog = log.for('backup-gdrive');

const SHA_RE = /^[0-9a-f]{64}$/;
const SHARD_RE = /^[0-9a-f]{2}$/;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LIST_FIELDS = 'id,name,size,createdTime,modifiedTime,mimeType';

export interface GoogleDriveTargetDeps {
	accessToken(): Promise<string>;
	fetch?: typeof fetch;
}

interface Tree {
	libraryId: string;
	library: string;   // curator-backup/<libraryId>
	snapshots: string;
	pins: string;
	objects: string;
}

export function createGoogleDriveTarget(id: string, cfg: { folderName: string }, deps: GoogleDriveTargetDeps): BackupTarget {
	const client = new DriveClient({
		accessToken: deps.accessToken,
		...(deps.fetch ? { fetch: deps.fetch } : {}),
		log: { info: (m, d) => tlog.info(m, d), warn: (m, d) => tlog.warn(m, d) },
	});

	let tree: Tree | null = null;
	let initPending: Promise<Tree> | null = null;
	// Shard folder id cache + in-flight dedupe: four uploads in flight that
	// share a prefix must not each create an `aa` folder.
	const shards = new Map<string, string>();
	const shardPending = new Map<string, Promise<string | null>>();

	function ready(): Tree {
		if (!tree) throw new Error('GoogleDriveTarget: init() has not run');
		return tree;
	}

	async function resolveTree(libraryId: string): Promise<Tree> {
		const app = await client.ensureFolder('root', cfg.folderName);
		const root = await client.ensureFolder(app.id, LIBRARY_ROOT);
		const library = await client.ensureFolder(root.id, libraryId);
		const [snapshots, pins, objects] = await Promise.all([
			client.ensureFolder(library.id, 'snapshots'),
			client.ensureFolder(library.id, 'pins'),
			client.ensureFolder(library.id, 'objects'),
		]);
		return { libraryId, library: library.id, snapshots: snapshots.id, pins: pins.id, objects: objects.id };
	}

	async function shard(aa: string, create: boolean): Promise<string | null> {
		const hit = shards.get(aa);
		if (hit) return hit;
		const { objects } = ready();
		let pending = shardPending.get(aa);
		if (!pending) {
			pending = (create ? client.ensureFolder(objects, aa) : client.findChild(objects, aa, { folder: true }))
				.then((r) => {
					if (r) shards.set(aa, r.id);
					return r?.id ?? null;
				})
				.finally(() => shardPending.delete(aa));
			shardPending.set(aa, pending);
			return pending;
		}
		const found = await pending;
		// The in-flight lookup was a non-creating miss; a creating caller
		// goes again (the cache is still empty, so this issues the create).
		return found !== null || !create ? found : shard(aa, true);
	}

	async function findObject(sha256: string, createShard: boolean): Promise<{ id: string } | null> {
		const shardId = await shard(sha256.slice(0, 2), createShard);
		if (!shardId) return null;
		return client.findChild(shardId, sha256);
	}

	// `rel` is relative to the library folder: 'library.json', 'snapshots/x',
	// 'pins/x'. Anything deeper is outside the contract.
	function locate(rel: string): { parentId: string; name: string } {
		const t = ready();
		const parts = rel.split('/').filter((p) => p.length > 0);
		if (parts.length === 1) return { parentId: t.library, name: parts[0]! };
		if (parts.length === 2 && parts[0] === 'snapshots') return { parentId: t.snapshots, name: parts[1]! };
		if (parts.length === 2 && parts[0] === 'pins') return { parentId: t.pins, name: parts[1]! };
		throw new Error(`GoogleDriveTarget: unsupported file path '${rel}'`);
	}

	function dirId(relDir: string): string {
		const t = ready();
		const clean = relDir.replace(/^\/+|\/+$/g, '');
		if (clean === '' || clean === '.') return t.library;
		if (clean === 'snapshots') return t.snapshots;
		if (clean === 'pins') return t.pins;
		throw new Error(`GoogleDriveTarget: unsupported directory '${relDir}'`);
	}

	function mimeFor(name: string): string {
		return name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
	}

	function toFileInfo(f: DriveFile): RemoteFileInfo {
		return { name: f.name, size: f.size ?? 0, modifiedAt: Date.parse(f.modifiedTime) || 0, remoteId: f.id };
	}

	return {
		id,
		kind: 'googledrive',

		async init(libraryId) {
			if (tree?.libraryId === libraryId) return;
			if (!initPending) {
				initPending = resolveTree(libraryId).finally(() => {
					initPending = null;
				});
			}
			const t = await initPending;
			tree = t;
			shards.clear();
			shardPending.clear();
			tlog.info('Drive target ready', { folderName: cfg.folderName, libraryId });
		},

		async stat() {
			const a = await client.about();
			const freeBytes = a.quotaBytes !== null && a.usedBytes !== null ? Math.max(0, a.quotaBytes - a.usedBytes) : null;
			return { quotaBytes: a.quotaBytes, usedBytes: a.usedBytes, freeBytes, account: a.email };
		},

		async putObject(sha256: string, src: ObjectSource, o: PutObjectOptions) {
			const shardId = await shard(sha256.slice(0, 2), true);
			if (!shardId) throw new Error('GoogleDriveTarget: shard folder could not be created');
			// A crashed run may have finished this object after the journal
			// was written; Drive would happily store a duplicate name. Only
			// resumed items pay for the lookup — ~45k extra requests on the
			// initial run otherwise, and a stray duplicate is harmless (reads
			// resolve to the oldest copy, GC sees both as live).
			const existing = o.resume ? await client.findChild(shardId, sha256, { signal: o.signal }) : null;
			if (existing) {
				o.onProgress(src.size);
				return { remoteId: existing.id };
			}
			if (src.size <= SMALL_UPLOAD_MAX) {
				const bytes = await readFile(src.path);
				const r = await client.uploadSmall(shardId, sha256, bytes, { appProperties: { sha256 } });
				o.onProgress(src.size);
				return { remoteId: r.id };
			}
			const r = await client.uploadResumable(shardId, sha256, src, {
				appProperties: { sha256 },
				signal: o.signal,
				onProgress: o.onProgress,
				...(o.onSession ? { onSession: (sessionUri: string) => o.onSession?.({ sessionUri, bytesSent: 0 }) } : {}),
				...(o.resume ? { resume: o.resume } : {}),
			});
			return { remoteId: r.id };
		},

		async getObject(sha256: string, destPath: string, o: GetObjectOptions) {
			const found = await findObject(sha256, false);
			if (!found) throw new Error(`GoogleDriveTarget: object ${sha256} is not on Google Drive`);
			await client.download(found.id, destPath, o);
		},

		async hasObject(sha256: string) {
			return (await findObject(sha256, false)) !== null;
		},

		async *listObjects(): AsyncIterable<RemoteObjectInfo> {
			const { objects } = ready();
			const shardFolders: DriveFile[] = [];
			for await (const f of client.list(objects, { fields: LIST_FIELDS })) {
				if (f.mimeType === FOLDER_MIME && SHARD_RE.test(f.name)) {
					shardFolders.push(f);
					if (!shards.has(f.name)) shards.set(f.name, f.id);
				}
			}
			for (const folder of shardFolders) {
				for await (const f of client.list(folder.id, { fields: LIST_FIELDS })) {
					if (f.mimeType === FOLDER_MIME || !SHA_RE.test(f.name)) continue;
					yield { sha256: f.name, storedSize: f.size ?? 0, remoteId: f.id, createdAt: Date.parse(f.createdTime) || 0 };
				}
			}
		},

		async deleteObject(sha256: string, remoteId: string | null) {
			const target = remoteId ? { id: remoteId } : await findObject(sha256, false);
			if (!target) return;
			await client.delete(target.id);
		},

		async putFile(rel: string, bytes: Buffer) {
			const { parentId, name } = locate(rel);
			const existing = await client.findChild(parentId, name);
			await client.uploadSmall(parentId, name, bytes, { mimeType: mimeFor(name), ...(existing ? { replaceId: existing.id } : {}) });
		},

		async getFile(rel: string) {
			const { parentId, name } = locate(rel);
			const existing = await client.findChild(parentId, name);
			if (!existing) return null;
			return client.downloadBuffer(existing.id);
		},

		async listFiles(relDir: string) {
			const parentId = dirId(relDir);
			const out: RemoteFileInfo[] = [];
			for await (const f of client.list(parentId, { fields: LIST_FIELDS })) {
				if (f.mimeType === FOLDER_MIME) continue;
				out.push(toFileInfo(f));
			}
			return out;
		},

		async deleteFile(rel: string) {
			const { parentId, name } = locate(rel);
			const existing = await client.findChild(parentId, name);
			if (existing) await client.delete(existing.id);
		},
	};
}

// FolderTarget — a BackupTarget over any local directory: an external drive,
// a NAS mount, or a folder a cloud client (Google Drive for desktop, Dropbox,
// OneDrive) syncs for us. Also the engine's test double.
//
// A cloud-sync folder is a legitimate TARGET even though the library watcher
// refuses to watch inside one (local/scanner.ts isCloudSyncPath): that rule
// exists because the sync client rewrites mtimes under the scanner's feet,
// which breaks file identity. Nothing here depends on mtimes — objects are
// immutable and content-addressed — so the backup settings deliberately do
// not apply that check.

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LIBRARY_ROOT, objectRel, type BackupTarget, type GetObjectOptions, type ObjectSource, type PutObjectOptions, type RemoteFileInfo, type RemoteObjectInfo } from './types.js';

const SHA_RE = /^[0-9a-f]{64}$/;

export function createFolderTarget(id: string, rootPath: string): BackupTarget {
	let lib = '';
	const abs = (rel: string): string => join(lib, rel);

	return {
		id,
		kind: 'folder',

		async init(libraryId) {
			lib = join(rootPath, LIBRARY_ROOT, libraryId);
			for (const d of ['snapshots', 'pins', 'objects']) await mkdir(abs(d), { recursive: true });
		},

		async stat() {
			try {
				const s = await statfs(rootPath);
				const total = Number(s.blocks) * Number(s.bsize);
				const free = Number(s.bavail) * Number(s.bsize);
				return { quotaBytes: total, usedBytes: total - free, freeBytes: free, account: null };
			} catch {
				return { quotaBytes: null, usedBytes: null, freeBytes: null, account: null };
			}
		},

		async putObject(sha256, src: ObjectSource, o: PutObjectOptions) {
			const dest = abs(objectRel(sha256));
			if (existsSync(dest)) {
				// A previous run finished this object before dying; adopt it.
				const s = await stat(dest);
				if (s.size === src.size) { o.onProgress(src.size); return { remoteId: null }; }
				await rm(dest, { force: true });
			}
			await mkdir(dirname(dest), { recursive: true });
			const part = `${dest}.part`;
			let sent = 0;
			const rs = createReadStream(src.path, { signal: o.signal });
			rs.on('data', (chunk: string | Buffer) => { sent += chunk.length; o.onProgress(sent); });
			await pipeline(rs, createWriteStream(part));
			await rename(part, dest);
			return { remoteId: null };
		},

		async getObject(sha256, destPath, o: GetObjectOptions) {
			const srcPath = abs(objectRel(sha256));
			if (!existsSync(srcPath)) throw new Error(`object ${sha256.slice(0, 12)}… is missing from the backup folder`);
			await mkdir(dirname(destPath), { recursive: true });
			const part = `${destPath}.part`;
			let got = 0;
			const rs = createReadStream(srcPath, { signal: o.signal });
			rs.on('data', (chunk: string | Buffer) => { got += chunk.length; o.onProgress(got); });
			await pipeline(rs, createWriteStream(part));
			if (got !== o.expectedSize) throw new Error(`object ${sha256.slice(0, 12)}… is ${got} bytes, expected ${o.expectedSize}`);
			await rename(part, destPath);
		},

		async hasObject(sha256) {
			return existsSync(abs(objectRel(sha256)));
		},

		async *listObjects(): AsyncIterable<RemoteObjectInfo> {
			const root = abs('objects');
			let shards: string[];
			try { shards = await readdir(root); } catch { return; }
			for (const shard of shards) {
				let names: string[];
				try { names = await readdir(join(root, shard)); } catch { continue; }
				for (const name of names) {
					if (!SHA_RE.test(name)) continue;
					const s = await stat(join(root, shard, name));
					yield { sha256: name, storedSize: s.size, remoteId: null, createdAt: s.mtimeMs };
				}
			}
		},

		async deleteObject(sha256) {
			await rm(abs(objectRel(sha256)), { force: true });
		},

		async putFile(rel, bytes) {
			const dest = abs(rel);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(`${dest}.part`, bytes);
			await rename(`${dest}.part`, dest);
		},

		async getFile(rel) {
			try { return await readFile(abs(rel)); }
			catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
		},

		async listFiles(relDir): Promise<RemoteFileInfo[]> {
			let names: string[];
			try { names = await readdir(abs(relDir)); } catch { return []; }
			const out: RemoteFileInfo[] = [];
			for (const name of names) {
				if (name.endsWith('.part')) continue;
				const s = await stat(join(abs(relDir), name));
				if (s.isFile()) out.push({ name, size: s.size, modifiedAt: s.mtimeMs, remoteId: null });
			}
			return out;
		},

		async deleteFile(rel) {
			await rm(abs(rel), { force: true });
		},
	};
}

// Settings-time validation: the folder must be absolute, creatable and
// writable. Returns the normalized path the settings store keeps.
export async function probeFolderTarget(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
	const probe = join(path, `.curator-backup-probe-${process.pid}`);
	await writeFile(probe, 'ok');
	await rm(probe, { force: true });
}

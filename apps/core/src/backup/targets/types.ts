// BackupTarget — where objects, manifests and pins live. Two implementations:
// FolderTarget (any local path, also the test double) and GoogleDriveTarget
// (Drive REST v3). The engine owns concurrency, hashing, compression and the
// resume journal; a target only moves bytes and lists what it holds.
//
// Layout is identical on every target (relative to the target root):
//   curator-backup/<libraryId>/library.json
//   curator-backup/<libraryId>/snapshots/<snapshotId>.json.zst
//   curator-backup/<libraryId>/pins/<snapshotId>.json
//   curator-backup/<libraryId>/objects/<aa>/<sha256>
// `putFile`/`getFile`/`listFiles`/`deleteFile` take paths relative to the
// library folder; objects go through the sha-keyed methods.

export interface ObjectSource {
	// Local file to upload (the staged zstd output, or the raw source file).
	path: string;
	size: number;
}

export interface ResumeToken {
	// Target-specific upload session (Drive resumable session URI). Absent
	// for targets that don't support resumption — they restart the object.
	sessionUri?: string;
	bytesSent: number;
}

export interface PutObjectOptions {
	signal: AbortSignal;
	onProgress(bytesSent: number): void;
	// Called when the target opens a resumable session, so the engine can
	// journal it before any byte goes out.
	onSession?(token: ResumeToken): void;
	resume?: ResumeToken;
}

export interface GetObjectOptions {
	signal: AbortSignal;
	expectedSize: number;
	onProgress(bytesGot: number): void;
}

export interface RemoteObjectInfo {
	sha256: string;
	storedSize: number;
	remoteId: string | null;
	createdAt: number;
}

export interface RemoteFileInfo {
	name: string;
	size: number;
	modifiedAt: number;
	remoteId: string | null;
}

export interface BackupTarget {
	readonly id: string;
	readonly kind: 'folder' | 'googledrive';
	// Resolve/create the library folder tree. Idempotent.
	init(libraryId: string): Promise<void>;
	stat(): Promise<{ quotaBytes: number | null; usedBytes: number | null; freeBytes: number | null; account: string | null }>;
	// Upload one object. Returns the target's own id for it (null for
	// filesystem targets). Must be atomic from a reader's point of view: a
	// partially written object is never listed.
	putObject(sha256: string, src: ObjectSource, o: PutObjectOptions): Promise<{ remoteId: string | null }>;
	getObject(sha256: string, destPath: string, o: GetObjectOptions): Promise<void>;
	hasObject(sha256: string): Promise<boolean>;
	listObjects(): AsyncIterable<RemoteObjectInfo>;
	deleteObject(sha256: string, remoteId: string | null): Promise<void>;
	putFile(rel: string, bytes: Buffer): Promise<void>;
	getFile(rel: string): Promise<Buffer | null>;
	listFiles(relDir: string): Promise<RemoteFileInfo[]>;
	deleteFile(rel: string): Promise<void>;
}

export const LIBRARY_ROOT = 'curator-backup';

export function objectRel(sha256: string): string {
	return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

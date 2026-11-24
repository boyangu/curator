// In-process audio metadata parser. Calls music-metadata directly on the
// caller's thread. Used as a fallback when no out-of-process parser has been
// injected (tests, headless CLI usage, prod-without-bundle).
//
// The desktop main process normally injects a utility-process-backed parser
// that runs `parseFile` off the main thread — see apps/desktop/src/main/ingest/.

import { parseFile } from 'music-metadata';
import { audioHash } from './audio-hash.js';
import { extract } from './extract.js';
import type { CoverFn, ParseFn, ParseResult } from './types.js';

export const parseInline: ParseFn = async (path: string): Promise<ParseResult> => {
	const meta = await parseFile(path, { skipCovers: true, duration: true });
	// Both parse paths (this one and the utility-process worker) end here, so
	// the hash is computed wherever the metadata read runs — off the main
	// loop in the desktop app — with no further wiring.
	return { ...extract(meta, path), audioHash: await audioHash(path) };
};

// The first embedded picture. Same in-process / utility-process split as
// parseInline: the worker calls this, and core falls back to it directly.
export const readCoverInline: CoverFn = async (path: string) => {
	const meta = await parseFile(path, { duration: false });
	const pic = meta.common.picture?.[0];
	if (!pic?.data || pic.data.length === 0) return null;
	// `pic.data` is a Uint8Array in current music-metadata; coerce in case
	// an older build hands back a Buffer-like.
	const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data as ArrayLike<number>);
	return { data, format: pic.format || 'image/jpeg' };
};

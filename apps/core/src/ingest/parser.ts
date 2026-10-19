// In-process audio metadata parser. Calls music-metadata directly on the
// caller's thread. Used as a fallback when no out-of-process parser has been
// injected (tests, headless CLI usage, prod-without-bundle).
//
// The desktop main process normally injects a utility-process-backed parser
// that runs `parseFile` off the main thread — see apps/desktop/src/main/ingest/.

import { parseFile } from 'music-metadata';
import { audioHash } from './audio-hash.js';
import { extract } from './extract.js';
import type { ParseFn, ParseResult } from './types.js';

export const parseInline: ParseFn = async (path: string): Promise<ParseResult> => {
	const meta = await parseFile(path, { skipCovers: true, duration: true });
	// Both parse paths (this one and the utility-process worker) end here, so
	// the hash is computed wherever the metadata read runs — off the main
	// loop in the desktop app — with no further wiring.
	return { ...extract(meta, path), audioHash: await audioHash(path) };
};

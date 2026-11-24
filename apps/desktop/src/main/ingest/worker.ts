// Utility process entry. Runs in a Node sub-process spawned by the main
// process via `app.utilityProcess.fork`. No Electron APIs are touched here —
// this is plain Node. Its job: read one audio file when the parent asks —
// its metadata ('parse') or its embedded album art ('cover') — and post the
// result back.
//
// One utility process == one worker slot in the IngestPool (apps/desktop/src/
// main/ingest/pool.ts). The pool sizes the number of these processes; each
// process serves requests serially.
//
// Communication is via process.parentPort (Electron's structured-clone
// channel — no JSON parsing on either side):
//
//   parent → worker:  { type: 'parse' | 'cover', id: <n>, path: <abs path> }
//   worker → parent:  { id: <n>, ok: true,  result: ParseResult | CoverArt | null }
//                  |  { id: <n>, ok: false, message: string }
//
// `id` correlates request ↔ response; the pool's dispatcher uses it to
// resolve the right pending promise even if multiple jobs are in flight on
// the same worker (we currently serialize, but the protocol stays open
// for future overlap).

// parseInline = music-metadata's parseFile + extract, bundled together. We
// import from `@curator/core/ingest` (the sub-path export) rather than the
// package root so rollup only pulls the metadata-parsing module — not the
// whole service + drizzle + sqlite surface — into this worker's bundle.
import { parseInline, readCoverInline, type CoverArt, type ParseResult } from '@curator/core/ingest';

interface WorkerRequest {
	type: 'parse' | 'cover';
	id: number;
	path: string;
}

type WorkerResponse =
	| { id: number; ok: true; result: ParseResult | CoverArt | null }
	| { id: number; ok: false; message: string };

if (!process.parentPort) {
	// Defensive — would only fire if someone tried to run this file with
	// plain `node` instead of utilityProcess.fork. Crash loudly so the bug
	// can't masquerade as a silent hang.
	throw new Error('ingest worker must be launched via app.utilityProcess.fork');
}

process.parentPort.on('message', async (evt) => {
	const req = evt.data as WorkerRequest | undefined;
	if (!req || (req.type !== 'parse' && req.type !== 'cover')) return;

	let response: WorkerResponse;
	try {
		const result = req.type === 'cover' ? await readCoverInline(req.path) : await parseInline(req.path);
		response = { id: req.id, ok: true, result };
	} catch (err) {
		response = {
			id: req.id,
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	process.parentPort.postMessage(response);
});

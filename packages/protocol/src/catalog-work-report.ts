// What a device sends back for the work it was handed (catalog-work.ts):
// `catalog.workReport` ('catalog_device_work').
//
// A report is evidence, never an instruction. A find says what a page lists;
// a release result says which store page the device holds to be the same
// release and by what it matched it, WITH that page's tracklist, so the cloud
// repeats the comparison itself before it links anything (and keeps two
// releases apart when it cannot confirm them); a check says a page no longer
// looks like the release, which the cloud verifies and puts to the operator —
// a device removes nothing. Facts carry the store page they were read from.
// "Not found" is an answer the cloud remembers, so no device is asked the
// same thing again until its retry age passes.

import { z } from 'zod';
import { CATALOG_PROVIDERS, ZCatalogClaim, ZCatalogHints, ZCatalogTrackerPoll, type CatalogClaim, type CatalogHandle, type CatalogRef, type CatalogTrackerPoll } from './catalog-service.js';
import { CATALOG_WORK_STORES, ZCatalogDeviceProfile, type CatalogDeviceProfile, type CatalogWork, type CatalogWorkStore } from './catalog-work.js';
import { ZDeviceId } from './sync-input.js';

// How a device matched a release at another store, strongest first: the page
// the catalogue already named, a track's ISRC, the release's UPC, or title
// and artist confirmed by the tracklist.
export const CATALOG_MATCH_HOWS = ['id', 'isrc', 'upc', 'tracklist'] as const;
export type CatalogMatchHow = (typeof CATALOG_MATCH_HOWS)[number];

export const CATALOG_CHECK_VERDICTS = ['same', 'differs', 'gone'] as const;
export type CatalogCheckVerdict = (typeof CATALOG_CHECK_VERDICTS)[number];

// A page a store search offered for a name-only label, with the titles it
// lists: the cloud compares them with the label's own.
export type CatalogWorkCandidate = { provider: CatalogWorkStore; providerId: string; name: string; url: string | null; releases: string[] };

export type CatalogWorkResult =
	// The page's listing as a reader's poll; a search's candidates.
	| { jobId: string; kind: 'find'; poll?: CatalogTrackerPoll; candidates?: CatalogWorkCandidate[] }
	| {
			jobId: string;
			kind: 'release';
			// Each a release claim with its tracklist: the release's own pages it
			// was told to read, and the pages it found at other stores. A page it
			// read that lists no tracks is sent too, without recordings — the
			// cloud remembers it has none.
			found: { how: CatalogMatchHow; claim: CatalogClaim }[];
			notFound: CatalogWorkStore[];
			// A page of the release (one it was told to read or to check) and what
			// reading it said. `gone`: the store no longer has it — the answer for
			// a page it was told to read and could not.
			checks: { handle: CatalogHandle; verdict: CatalogCheckVerdict; claim?: CatalogClaim }[];
	  }
	// Each row a recording claim at the store that stated the facts.
	| { jobId: string; kind: 'facts'; rows: { recordingId: string; claim: CatalogClaim }[]; notFound: { recordingId: string; store: CatalogWorkStore }[] }
	// The store did not answer: nothing is learned, and nothing remembered.
	| { jobId: string; kind: 'error'; store: CatalogWorkStore; message: string; rateLimitedSec: number | null };

export const CATALOG_WORK_MAX_RESULTS = 50;
const WORK_MAX_ROWS = 200;

// `calls`: the store calls this report's work made, against the day's count
// per store — counted up to what the report's results could have taken, no
// further. `idempotencyKey`: a resend after a timeout gets the first answer.
// `hints`: the ones the read that handed the work carried, so the follow-up
// work is planned as that read was.
export type CatalogWorkReportInput = {
	deviceId: string;
	idempotencyKey: string;
	profile: CatalogDeviceProfile;
	hints?: CatalogRef[];
	results: CatalogWorkResult[];
	calls?: Partial<Record<CatalogWorkStore, number>>;
};

// saved        kept as the device found it.
// unconfirmed  the cloud's own comparison did not confirm the match: what
//              was found is kept as its own release, apart.
// kept         a check the cloud agrees with (the link stands) or disagrees
//              with (the link stands and the operator is asked).
// refused      not work the catalogue would hand out, or not a valid result.
// failed       the device's own error, noted — or the cloud's, saving this
//              one result: the rest of the report stands.
export const CATALOG_WORK_OUTCOMES = ['saved', 'unconfirmed', 'kept', 'refused', 'failed'] as const;
export type CatalogWorkOutcome = (typeof CATALOG_WORK_OUTCOMES)[number];
export type CatalogWorkReportResult = {
	results: { jobId: string; outcome: CatalogWorkOutcome; note?: string }[];
	// Catalogue objects the report changed: a device reads them again.
	changed: string[];
	// Follow-up work, while the visit's rounds last.
	work?: CatalogWork;
};

const ZWorkStore = z.enum(CATALOG_WORK_STORES);
const ZJobId = z.string().min(3).max(400);
const ZHandle: z.ZodType<CatalogHandle> = z.object({ provider: z.enum(CATALOG_PROVIDERS), id: z.string().min(1).max(200), url: z.string().max(1000).nullable() }).strict();

const ZCandidate = z
	.object({ provider: ZWorkStore, providerId: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(500), url: z.string().url().max(1000).nullable(), releases: z.array(z.string().max(500)).max(200) })
	.strict();

const ZResult = z.union([
	z.object({ jobId: ZJobId, kind: z.literal('find'), poll: ZCatalogTrackerPoll.optional(), candidates: z.array(ZCandidate).max(25).optional() }).strict(),
	z
		.object({
			jobId: ZJobId,
			kind: z.literal('release'),
			found: z.array(z.object({ how: z.enum(CATALOG_MATCH_HOWS), claim: ZCatalogClaim }).strict()).max(20),
			notFound: z.array(ZWorkStore).max(CATALOG_WORK_STORES.length),
			checks: z.array(z.object({ handle: ZHandle, verdict: z.enum(CATALOG_CHECK_VERDICTS), claim: ZCatalogClaim.optional() }).strict()).max(20),
		})
		.strict(),
	z
		.object({
			jobId: ZJobId,
			kind: z.literal('facts'),
			rows: z.array(z.object({ recordingId: z.string().uuid(), claim: ZCatalogClaim }).strict()).max(WORK_MAX_ROWS),
			notFound: z.array(z.object({ recordingId: z.string().uuid(), store: ZWorkStore }).strict()).max(WORK_MAX_ROWS * CATALOG_WORK_STORES.length),
		})
		.strict(),
	z.object({ jobId: ZJobId, kind: z.literal('error'), store: ZWorkStore, message: z.string().max(1000), rateLimitedSec: z.number().int().positive().nullable() }).strict(),
]);

const ZCalls = z.record(ZWorkStore, z.number().int().nonnegative().max(100_000));

// The report as the server takes it: each result is judged on its own
// (parseWorkResult), so one it must refuse costs that job alone — the lesson
// of the worker report, where one over-long roster sank the whole batch.
export const ZCatalogWorkReportWire = z
	.object({
		deviceId: ZDeviceId,
		idempotencyKey: z.string().trim().min(8).max(128),
		profile: ZCatalogDeviceProfile,
		hints: ZCatalogHints.optional(),
		results: z.array(z.unknown()).max(CATALOG_WORK_MAX_RESULTS),
		calls: ZCalls.optional(),
	})
	.strict();

// A result the schema refuses comes back as its job id (when it has one) and
// where it went wrong.
export function parseWorkResult(result: unknown): { ok: true; result: CatalogWorkResult } | { ok: false; jobId: string | null; note: string } {
	const r = ZResult.safeParse(result);
	if (r.success) return { ok: true, result: r.data as CatalogWorkResult };
	const jobId = typeof result === 'object' && result !== null && typeof (result as { jobId?: unknown }).jobId === 'string' ? (result as { jobId: string }).jobId.slice(0, 400) : null;
	const issue = r.error.issues[0];
	return { ok: false, jobId, note: `${issue?.path.join('.') || 'result'}: ${issue?.message ?? 'not a result'}`.slice(0, 300) };
}

// The run: library → cloud → a fresh desktop → rekordbox, compared with the
// real rekordbox (plan: "End-to-end: library → cloud → fresh desktop →
// rekordbox", Design 1–7).
//
//   1. Copies, read-only on the sources: curator.db (VACUUM INTO, tokens
//      stripped) as the founder; master.db (+ wal/shm) twice, rb/ to push
//      into and rb-reference/ to compare against.
//   2. The local cloud: the real server on PGlite, in this process.
//   3. Founder = the copy with its sync bookkeeping reset (core
//      sync-log/refound.ts), signed in as the library's bound user: the
//      fold, the master setting op, the publish, the backfills.
//   4. Joiner = a fresh database, same user, new device: bootstrap from the
//      snapshot, then the master's local files attached by audio hash, the
//      join bind run again as the confirmation.
//   5. The joiner's Sync to Rekordbox ('updates') into rb/ with the real
//      sidecar, its write guard on: the pre-push pull links by path, the
//      exporter pushes.
//   6. Compare (cloud round trip before and after linking; rekordbox pushed
//      vs reference), report.
//
// Every write goes under the work dir; the rails (rails.ts) are checked
// before the first copy and again before the push. Nothing here injects a
// remoteWritePolicy, and no streaming adapter can reach a provider.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { createDb, migrate, type RekordboxExportResult } from '@curator/core';
import { joinBindAsync, readCursor, resetSyncForFounding, type LibraryDump } from '@curator/core/e2e';
import { MASTER_DEVICE_SETTING } from '@curator/protocol';
import { createLogger, type LogRecord } from '@curator/shared/log';
import { fileSink } from '@curator/shared/log-node';
import { startLocalCloud, type LocalCloud } from './cloud.js';
import { afterLinkClassifier, rekordboxClassifier, type DiffClass } from './classify.js';
import { diffDumps, dumpOf } from './compare.js';
import { diffRekordbox, type RbDump } from './compare-rb.js';
import { copyCuratorDb, copyRekordbox } from './copies.js';
import { founderPending, joinerPending, openDevice, settle, type Device } from './devices.js';
import { attachLocalSources } from './joiner.js';
import { assertSafeTargets, defaultLiveRoots, RailError, type LiveRoots } from './rails.js';
import { rekordboxProcesses, rekordboxSidecarSpec, runPythonScript } from './rekordbox.js';
import { writeReport, type Check, type Report } from './report.js';
import { runStamp } from './paths.js';

type Raw = Database.Database;

export type HookContext = { workDir: string; founder: Raw; joiner: Raw; rbDb: string; refDb: string };

export type RunOptions = {
	sources: { curatorDb: string; rbDb: string };
	workRoot: string;
	workDir?: string;
	// Copies, cloud, founder and joiner (local files attached, bind run);
	// no rekordbox sidecar, no push, no rekordbox comparison.
	dryRun?: boolean;
	// Keep the copies and databases. Without it only the report and the logs
	// stay (the copies are the user's whole library).
	keep?: boolean;
	// Default: %APPDATA%/Curator*, %APPDATA%/Pioneer, ~/Music, plus the
	// source library's folders and the folders its files live in.
	live?: LiveRoots;
	phaseTimeoutMs?: number;
	log?: (line: string) => void;
	// Test seams (e2e tests inject a difference).
	hooks?: {
		beforeRoundTrip?(ctx: HookContext): void | Promise<void>;
		beforeRekordboxCompare?(ctx: HookContext): void | Promise<void>;
	};
};

const DEFAULT_PHASE_TIMEOUT_MS = 45 * 60_000;

const KEY_ORDER_NOTE = 'JSON key order of rekordbox phrases and object-valued account settings is ignored: the snapshot load stores them key-sorted (compare.ts canonicalDump)';
const CLASS_NOTE = 'expected = the fresh desktop did what the master\'s Curator would (rekordbox behind Curator, or an edit Curator never pulled); artefact = the run\'s setup (another recording for the file); failure = anything else. Only failures fail the check (classify.ts).';

const count = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);
function sumClasses(xs: ReadonlyArray<Record<DiffClass, number> | undefined>): Record<DiffClass, number> {
	const out: Record<DiffClass, number> = { expected: 0, artefact: 0, failure: 0 };
	for (const x of xs) if (x) for (const k of Object.keys(out) as DiffClass[]) out[k] += x[k];
	return out;
}
const classSummary = (c: Record<DiffClass, number>): string => `${c.expected} expected, ${c.artefact} artefacts, ${c.failure} failures`;

// The folders the source library's music lives in: its watched folders and
// the folder of every local file row. Read through a read-only handle.
export function musicRootsOf(curatorDb: string): string[] {
	const ro = new Database(curatorDb, { readonly: true, fileMustExist: true });
	try {
		const roots = new Set<string>(ro.prepare(`SELECT path FROM library_folder`).pluck().all() as string[]);
		for (const p of ro.prepare(`SELECT DISTINCT file_path FROM source_link WHERE source = 'local' AND file_path IS NOT NULL`).pluck().all() as string[]) roots.add(dirname(p));
		return [...roots];
	} finally {
		ro.close();
	}
}

export async function runRekordboxE2E(opts: RunOptions): Promise<Report> {
	const startedAt = new Date();
	const workDir = opts.workDir ?? join(opts.workRoot, runStamp(startedAt));
	const dryRun = !!opts.dryRun;
	const timeoutMs = opts.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
	const say = opts.log ?? ((l: string) => { process.stdout.write(`${l}\n`); });
	const timings: Record<string, number> = {};
	const facts: Record<string, unknown> = {};
	const checks: Check[] = [];
	const logs = { warnings: 0, errors: 0, samples: [] as Report['log']['samples'] };
	let error: string | null = null;
	let crashed = false;

	const paths = {
		founderDir: join(workDir, 'founder'),
		joinerDir: join(workDir, 'joiner'),
		rbDir: join(workDir, 'rb'),
		refDir: join(workDir, 'rb-reference'),
		tmp: join(workDir, 'tmp'),
	};
	const founderDb = join(paths.founderDir, 'curator.db');
	const joinerDb = join(paths.joinerDir, 'curator.db');
	const rbDb = join(paths.rbDir, 'master.db');
	const refDb = join(paths.refDir, 'master.db');
	const targets = [workDir, ...Object.values(paths), founderDb, joinerDb, rbDb, refDb];
	const sources = [opts.sources.curatorDb, opts.sources.rbDb];

	let cloud: LocalCloud | null = null;
	const devices: Device[] = [];
	const phase = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
		say(`… ${name}`);
		const t0 = Date.now();
		try { return await fn(); } finally { timings[name] = Date.now() - t0; }
	};

	try {
		for (const s of sources) if (!existsSync(s)) throw new RailError(`source not found: ${s}`);
		const live = opts.live ?? defaultLiveRoots({ music: musicRootsOf(opts.sources.curatorDb) });
		// The sources' own folders are live too, whatever they are called.
		const rails = { workRoot: opts.workRoot, workDir, targets, sources, live: { ...live, curator: [...live.curator, dirname(opts.sources.curatorDb)], pioneer: [...live.pioneer, dirname(opts.sources.rbDb)] } };
		assertSafeTargets(rails);
		if (existsSync(workDir) && readdirSync(workDir).length > 0) throw new RailError(`the work dir is not empty: ${workDir}`);
		if (!dryRun) {
			const running = await rekordboxProcesses();
			if (running.length > 0) throw new RailError(`rekordbox is running (${running.join(', ')}). Close it and run again: pyrekordbox refuses to write while it runs, and the copy would not be a consistent point in time.`);
		}
		for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });

		// Core's records go to a file in the work dir; warnings and errors are
		// also counted for the report.
		const logger = createLogger({ proc: 'core', level: 'info', sinks: [
			fileSink({ dir: workDir, name: 'core', maxBytes: 64 * 1024 * 1024, keep: 2 }),
			{ write(rec: LogRecord) {
				if (rec.level === 'warn') logs.warnings++;
				else if (rec.level === 'error') logs.errors++;
				else return;
				if (logs.samples.length < 50) logs.samples.push({ level: rec.level, area: rec.area, msg: rec.msg + (rec.err ? `: ${rec.err.message}` : '') });
			} },
		] });
		process.env['CURATOR_DISABLE_ALBUM_ENRICH'] = '1';

		// ── 1. copies ───────────────────────────────────────────────────────
		facts['copies'] = await phase('copy', () => {
			const curator = copyCuratorDb(opts.sources.curatorDb, founderDb);
			const rb = copyRekordbox(opts.sources.rbDb, paths.rbDir);
			const ref = copyRekordbox(opts.sources.rbDb, paths.refDir);
			return { curator, rb: { bytes: rb.bytes, files: rb.files.length, warning: rb.warning }, reference: { bytes: ref.bytes, files: ref.files.length, warning: ref.warning } };
		});

		// ── 2–3. cloud + founder ────────────────────────────────────────────
		const reset = await phase('founder reset', () => {
			migrate(founderDb, { logger });
			const { sqlite } = createDb(founderDb);
			try { return resetSyncForFounding(sqlite); } finally { sqlite.close(); }
		});
		const userId = reset.userId ?? randomUUID();
		facts['founderReset'] = { ...reset, userId, boundBefore: reset.userId !== null };
		const masterCopy = await phase('dump master copy', () => {
			const { sqlite } = createDb(founderDb);
			try { return dumpOf(sqlite); } finally { sqlite.close(); }
		});
		cloud = await phase('start local cloud', () => startLocalCloud());
		const lc = cloud;
		const founderSession = await lc.session(userId);
		const founder = openDevice({ name: 'founder', dir: paths.founderDir, dbPath: founderDb, transport: founderSession.transport, logger });
		devices.push(founder);
		const founderRounds = await phase('found the account', () => settle(lc, userId, [founder], 'founder', {
			timeoutMs, pending: founderPending(lc, userId), onRound: (n, b) => { if (b.length) say(`  founder round ${n}: ${b.slice(0, 4).join('; ')}`); },
		}));
		const founderStatus = await founder.svc.getCloudSyncStatus();
		const founded = dumpOf(founder.raw);
		facts['founder'] = {
			rounds: founderRounds, deviceId: founderStatus.deviceId, head: await lc.head(userId), snapshot: await lc.latestSnapshot(userId),
			ops: await lc.opCounts(userId), cursor: readCursor(founder.raw),
		};
		{
			// Stating itself master is the founder's job (the reset cleared the
			// mirror so it would): the setting is checked on its own.
			const master = founded.settings[MASTER_DEVICE_SETTING];
			const d = diffDumps(withoutSetting(masterCopy, MASTER_DEVICE_SETTING), withoutSetting(founded, MASTER_DEVICE_SETTING));
			const ok = d.equal && master === founderStatus.deviceId;
			checks.push({
				name: 'founder.unchanged', title: 'Founding left the library as it was',
				status: ok ? 'pass' : 'fail',
				summary: ok ? 'the fold, master op, publish and backfills changed no Curator-owned state; the founder is the master'
					: d.equal ? `the master setting names ${JSON.stringify(master)}, not the founder ${founderStatus.deviceId}`
					: `${d.tables.filter((t) => !t.equal).map((t) => t.table).join(', ')} changed while founding`,
				details: d.tables.filter((t) => !t.equal), rows: d.rows,
			});
		}

		// ── 4. joiner ───────────────────────────────────────────────────────
		migrate(joinerDb, { logger });
		const joinerSession = await lc.session(userId);
		const joiner = openDevice({
			name: 'joiner', dir: paths.joinerDir, dbPath: joinerDb, transport: joinerSession.transport, logger,
			...(dryRun ? {} : { rekordbox: rekordboxSidecarSpec(paths.rbDir, paths.tmp) }),
		});
		devices.push(joiner);
		const joinRounds = await phase('join from the snapshot', () => settle(lc, userId, [joiner], 'joiner', {
			timeoutMs, pending: joinerPending, onRound: (n, b) => { if (b.length) say(`  joiner round ${n}: ${b.slice(0, 4).join('; ')}`); },
		}));
		facts['joiner'] = { rounds: joinRounds, deviceId: (await joiner.svc.getCloudSyncStatus()).deviceId, cursor: readCursor(joiner.raw), ops: await lc.opCounts(userId) };

		const hookCtx = (): HookContext => ({ workDir, founder: founder.raw, joiner: joiner.raw, rbDb, refDb });
		await opts.hooks?.beforeRoundTrip?.(hookCtx());
		{
			const d = await phase('compare round trip', () => diffDumps(founded, dumpOf(joiner.raw)));
			checks.push({
				name: 'cloud.roundTrip', title: 'Cloud round trip (master vs fresh desktop)',
				status: d.equal ? 'pass' : 'fail',
				summary: d.equal ? `all ${d.tables.length} tables equal` : `differs in ${d.tables.filter((t) => !t.equal).map((t) => `${t.table} (−${t.onlyLeft} +${t.onlyRight} ~${t.changed})`).join(', ')}`,
				details: { tables: d.tables, normalised: KEY_ORDER_NOTE }, rows: d.rows,
			});
		}

		const attach = await phase('attach local files', () => attachLocalSources(founder.raw, joiner.raw));
		facts['attach'] = attach;
		const bind = await phase('join bind', () => joinBindAsync(joiner.raw));
		facts['joinBind'] = { ...bind, tracksTouched: bind.tracksTouched.length, playlistsTouched: bind.playlistsTouched.length };
		checks.push({
			name: 'joiner.attach', title: 'Local files bound to the account\'s recordings',
			status: attach.recordingMismatch > 0 || bind.bound > 0 || bind.unbound > 0 ? 'warn' : attach.noClaim + attach.noRow > 0 ? 'warn' : 'pass',
			summary: `${attach.attached} of ${attach.masterLinks} files attached (${attach.noHash} without a hash, ${attach.noClaim} unclaimed, ${attach.noRow} without a row, ${attach.recordingMismatch} on another recording); bind: ${bind.known} known, ${bind.bound} re-bound, ${bind.unbound} unbound`,
			details: { attach, bind: facts['joinBind'] },
		});
		await phase('settle after attaching', () => settle(lc, userId, [joiner], 'joiner after attach', { timeoutMs, pending: joinerPending }));
		const outboxMark = (joiner.raw.prepare(`SELECT coalesce(max(seq_local), 0) FROM sync_outbox`).pluck().get() as number);
		facts['outboxAfterAttach'] = outboxSummary(joiner.raw, 0);

		// ── 5. link + push ──────────────────────────────────────────────────
		let push: RekordboxExportResult | null = null;
		if (dryRun) {
			checks.push({ name: 'rekordbox.push', title: 'Sync to Rekordbox', status: 'skipped', summary: 'dry run' });
		} else {
			assertSafeTargets(rails);
			const running = await rekordboxProcesses();
			if (running.length > 0) throw new RailError(`rekordbox started during the run (${running.join(', ')}); stopping before the push.`);
			const progress: string[] = [];
			const unsub = joiner.svc.subscribeRekordboxExportEvents((e) => {
				if (e.kind === 'progress' && progress.at(-1) !== e.phase) { progress.push(e.phase); say(`  rekordbox: ${e.phase}`); }
			});
			try {
				const outcome = await phase('sync to rekordbox', () => joiner.svc.syncToRekordbox({
					targetKind: 'updates', targetIds: [],
					flags: { syncMetadata: true, syncCues: true, syncTags: true, syncPlaylist: true },
					dbPathOverride: rbDb,
				}));
				if (outcome.status === 'conflicts') {
					checks.push({
						name: 'rekordbox.push', title: 'Sync to Rekordbox', status: 'fail',
						summary: `paused on ${outcome.conflicts.length} conflicts after linking; nothing was pushed`, details: outcome.conflicts.slice(0, 50),
					});
				} else {
					push = outcome.result;
					const bad = !push.verifyOk || push.writeFailures.length > 0;
					checks.push({
						name: 'rekordbox.push', title: 'Sync to Rekordbox', status: bad ? 'fail' : push.removalsHeld.length > 0 ? 'warn' : 'pass',
						summary: `${push.tracksWritten} tracks, ${push.cuesWritten} cue sets, ${push.tagsWritten} tag sets, ${push.playlistsWritten} playlists written; ${push.tracksSkippedNotLinked} not linked; ${push.removalsHeld.length} removal holds; verify ${push.verifyOk ? 'ok' : 'FAILED'}; ${push.writeFailures.length} write failures`,
						details: { ...push, verifyFailures: push.verifyFailures.slice(0, 50), writeFailures: push.writeFailures.slice(0, 50) },
					});
				}
			} finally {
				unsub();
			}
			facts['push'] = { phases: progress };
		}
		const links = joiner.raw.prepare(`SELECT rb_content_id FROM rekordbox_link`).pluck().all() as string[];
		const masterLinks = founder.raw.prepare(`SELECT count(*) FROM rekordbox_link`).pluck().get() as number;
		facts['links'] = { joiner: links.length, master: masterLinks };
		if (!dryRun) {
			checks.push({
				name: 'rekordbox.coverage', title: 'rekordbox rows linked by the fresh desktop',
				status: links.length < masterLinks ? 'warn' : 'pass',
				summary: `${links.length} linked (the master links ${masterLinks}); only linked rows are compared`,
			});
		}

		// The joiner's outbox after linking and the push: what the link stated.
		const outbox = outboxSummary(joiner.raw, outboxMark);
		checks.push({
			name: 'joiner.outbox', title: 'What linking stated (joiner outbox after the push)', status: 'info',
			summary: outbox.total === 0 ? 'nothing' : Object.entries(outbox.byKind).map(([k, n]) => `${k} ${n}`).join(', '),
			details: outbox,
		});

		await opts.hooks?.beforeRekordboxCompare?.(hookCtx());
		// Both rekordbox copies, read once: the rekordbox check compares them,
		// and the after-link check reads what rekordbox really holds from the
		// untouched one (classify.ts).
		let rb: { pushed: RbDump; reference: RbDump } | null = null;
		if (!dryRun) {
			const ids = join(paths.tmp, 'linked-ids.json');
			writeFileSync(ids, JSON.stringify(links), 'utf8');
			const outA = join(paths.tmp, 'rb-pushed.json');
			const outB = join(paths.tmp, 'rb-reference.json');
			await phase('read rekordbox copies', async () => {
				await runPythonScript('rb_dump.py', [rbDb, ids, outA], { tmpDir: paths.tmp });
				await runPythonScript('rb_dump.py', [refDb, ids, outB], { tmpDir: paths.tmp });
			});
			rb = { pushed: JSON.parse(readFileSync(outA, 'utf8')) as RbDump, reference: JSON.parse(readFileSync(outB, 'utf8')) as RbDump };
		}

		{
			// Linking takes what rekordbox holds and Curator never pulled; only
			// a change rekordbox does not explain fails (classify.ts).
			const classify = rb ? afterLinkClassifier(joiner.raw, rb.reference) : undefined;
			const d = await phase('compare after linking', () => diffDumps(founded, dumpOf(joiner.raw), undefined, undefined, classify));
			const differing = d.tables.filter((t) => !t.equal);
			const classes = sumClasses(differing.map((t) => t.byClass));
			checks.push({
				name: 'cloud.afterLink', title: 'Fresh desktop after linking rekordbox vs master',
				status: d.equal ? 'pass' : d.failures > 0 ? 'fail' : 'warn',
				summary: d.equal ? 'linking changed no Curator-owned state'
					: `linking changed ${differing.map((t) => `${t.table} (−${t.onlyLeft} +${t.onlyRight} ~${t.changed})`).join(', ')}${classify ? `; ${classSummary(classes)}` : ''}`,
				details: { tables: d.tables, normalised: KEY_ORDER_NOTE, ...(classify ? { classes, classified: CLASS_NOTE } : {}) }, rows: d.rows,
			});
		}

		// ── 6. rekordbox compare ────────────────────────────────────────────
		if (rb) {
			const d = diffRekordbox(rb.pushed, rb.reference, links, undefined, rekordboxClassifier(founder.raw, joiner.raw, rb.reference));
			const failing = Object.entries(d.byClass.failure);
			const classes = { expected: count(d.byClass.expected), artefact: count(d.byClass.artefact), failure: count(d.byClass.failure) };
			checks.push({
				name: 'rekordbox.compare', title: 'rekordbox after the push vs the real rekordbox',
				status: d.equal ? 'pass' : failing.length > 0 ? 'fail' : 'warn',
				summary: d.equal ? `${d.compared} linked rows and their playlists equal`
					: `differs: ${Object.entries(d.fields).map(([f, n]) => `${f} ${n}`).join(', ')}; ${classSummary(classes)}${failing.length > 0 ? ` (failing: ${failing.map(([f, n]) => `${f} ${n}`).join(', ')})` : ''}`,
				details: { linked: d.linked, compared: d.compared, missing: d.missing, fields: d.fields, byClass: d.byClass, classified: CLASS_NOTE }, rows: d.rows,
			});
		}

		const upstream = devices.flatMap((d) => d.upstream.map((c) => `${d.name}: ${c}`));
		if (upstream.length > 0) {
			checks.push({ name: 'streaming.untouched', title: 'No streaming provider was called', status: 'fail', summary: `${upstream.length} adapter calls`, details: upstream });
		}
		facts['writeAudit'] = devices.map((d) => ({ device: d.name, entries: d.audit.length, sample: d.audit.slice(0, 20) }));
	} catch (err) {
		crashed = true;
		error = err instanceof Error ? (err instanceof RailError ? err.message : `${err.message}\n${err.stack ?? ''}`) : String(err);
	} finally {
		for (const d of devices.splice(0).reverse()) await d.close();
		if (cloud) await cloud.close().catch(() => { /* PGlite already gone */ });
	}

	const failed = checks.some((c) => c.status === 'fail');
	const report: Report = {
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		ok: !crashed && !failed,
		exitCode: crashed ? 2 : failed ? 1 : 0,
		error,
		dryRun,
		workDir,
		sources: opts.sources,
		timings,
		facts,
		checks,
		log: logs,
	};
	if (existsSync(workDir)) {
		writeReport(workDir, report);
		if (!opts.keep) {
			const left = await prune(workDir);
			if (left.length > 0) {
				// The report is already on disk; what could not be removed is
				// added to it rather than thrown.
				say(`! could not remove from the work dir (still in use?): ${left.join('; ')}`);
				report.facts['pruneLeftovers'] = left;
				writeReport(workDir, report);
			}
		}
	}
	return report;
}

function withoutSetting(d: LibraryDump, key: string): LibraryDump {
	const settings = { ...d.settings };
	delete settings[key];
	return { ...d, settings };
}

type OutboxSummary = { total: number; byKind: Record<string, number>; byState: Record<string, number>; sample: Array<{ entity: string; entityId: string; kind: string; state: string; payload: string }> };

function outboxSummary(raw: Raw, afterSeqLocal: number): OutboxSummary {
	const rows = raw.prepare(`SELECT entity, entity_id, kind, state, payload FROM sync_outbox WHERE seq_local > ? ORDER BY seq_local`).all(afterSeqLocal) as Array<{ entity: string; entity_id: string; kind: string; state: string; payload: string }>;
	const byKind: Record<string, number> = {};
	const byState: Record<string, number> = {};
	for (const r of rows) {
		byKind[`${r.entity}.${r.kind}`] = (byKind[`${r.entity}.${r.kind}`] ?? 0) + 1;
		byState[r.state] = (byState[r.state] ?? 0) + 1;
	}
	return {
		total: rows.length, byKind, byState,
		sample: rows.slice(0, 50).map((r) => ({ entity: r.entity, entityId: r.entity_id, kind: r.kind, state: r.state, payload: r.payload.length > 300 ? `${r.payload.slice(0, 300)}…` : r.payload })),
	};
}

// Without --keep: the report and the logs stay, the copies go. A child
// process can hold a file a moment past the services' close — the rekordbox
// sidecar's read snapshot under tmp/ (its shutdown has a 2 s grace), which
// Windows then refuses to delete (EBUSY) — so each pass is retried for a
// while, and whatever is still held comes back as a list, never a throw.
async function prune(workDir: string, deadlineMs = 15_000): Promise<string[]> {
	const keep = (name: string): boolean => name === 'report.json' || name === 'report.html' || name.endsWith('.jsonl');
	const until = Date.now() + deadlineMs;
	for (;;) {
		const failed: string[] = [];
		for (const name of readdirSync(workDir)) {
			if (keep(name)) continue;
			try {
				rmSync(join(workDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			} catch (err) {
				failed.push(`${name}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
			}
		}
		if (failed.length === 0 || Date.now() > until) return failed;
		await new Promise((r) => setTimeout(r, 500));
	}
}

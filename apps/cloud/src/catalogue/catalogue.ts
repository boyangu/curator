// catalogue.lookup / put / inventory (workstream D, phase 1). The server
// stores what a device computed and hands it to the same user's other
// devices; it never analyses, and it judges an item only by its shape, the
// server's unit policy, the blob it names and the account's quota.
//
// Everything runs as the user under RLS (withUserTx), like sync: a query
// that forgot its user filter would see nothing of anyone else's. Blob
// checks read storage.objects the same way, so an item can only ever name an
// object the caller's own Storage policies let it see.
//
// Order of work in a put, all before the first write: whole-call size caps,
// per-item shape (zod), policy, blob path; then one transaction: device
// check, entitlement, per-user advisory lock, blob existence and size,
// versions kept and quota, one upsert for the batch, retention.

import { createHash } from 'node:crypto';
import {
	CATALOGUE_VERSIONS_KEPT,
	catalogueAllows,
	catalogueBlobPath,
	compareVersions,
	MAX_CATALOGUE_INVENTORY,
	MAX_CATALOGUE_PUT_BYTES,
	MAX_CATALOGUE_PUT_ITEMS,
	safeParseCatalogueItem,
	utf8ByteLength,
	type CatalogueAccount,
	type CatalogueInventoryInput,
	type CatalogueInventoryResult,
	type CatalogueItem,
	type CatalogueLookupInput,
	type CatalogueLookupResult,
	type CataloguePolicy,
	type CataloguePutResult,
	type CatalogueRejectReason,
	type CatalogueUnit,
	type StoredCatalogueItem,
} from '@curator/protocol';
import type { AuditEmit } from '../audit.js';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { hasUnstorableText } from '../sync/push.js';

// ── shared ──────────────────────────────────────────────────────────────────

// Lookups and inventories only read, so the device check is a select: no
// `last_seen_at` write on a read path that a hydrating device calls every
// few seconds. Push keeps the device list's "last seen" current.
async function assertDevice(tx: Queryable, deviceId: string): Promise<void> {
	const [d] = await tx.query<{ revoked: boolean }>(
		`select revoked_at is not null as revoked from curator.device where user_id = (select auth.uid()) and device_id = $1`,
		[deviceId],
	);
	if (!d) throw new CloudError('PRECONDITION_FAILED', 'device_not_registered');
	if (d.revoked) throw new CloudError('FORBIDDEN', 'device_revoked');
}

async function readAccount(tx: Queryable): Promise<CatalogueAccount> {
	const [a] = await tx.query<{ entitled: boolean; quota: unknown }>(
		`select entitled, quota_bytes::float8 as quota from curator.catalogue_account where user_id = (select auth.uid())`,
	);
	const [u] = await tx.query<{ used: unknown }>(
		`select coalesce(sum(data_bytes + blob_bytes), 0)::float8 as used from curator.catalogue_item where user_id = (select auth.uid())`,
	);
	return { entitled: a?.entitled ?? false, quotaBytes: a ? num(a.quota) : 0, usedBytes: num(u!.used) };
}

// A revoked device is told so per call; the audit row is what an incident
// review greps for.
async function withDevice<T>(
	db: Db,
	audit: AuditEmit,
	userId: string,
	procedure: 'lookup' | 'put' | 'inventory',
	deviceId: string,
	fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
	try {
		return await withUserTx(db, userId, async (tx) => {
			await assertDevice(tx, deviceId);
			return fn(tx);
		});
	} catch (e) {
		if (e instanceof CloudError && (e.reason === 'device_revoked' || e.reason === 'catalogue_not_entitled')) {
			audit('catalogue_rejected', { procedure, reason: e.reason });
		}
		throw e;
	}
}

// Sorted keys at every level, so equal items hash equal whatever order the
// device built them in.
function canonicalJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
	if (v !== null && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
	}
	return JSON.stringify(v);
}

export function itemDigest(item: CatalogueItem): string {
	const { unit, variant, version, unitSchema, data } = item;
	return createHash('sha256').update(canonicalJson({ unit, variant, version, unitSchema, data })).digest('hex');
}

const versionKey = (v: readonly number[]) => v.join('.');
const groupKey = (hash: string, unit: string, variant: string) => `${hash}|${unit}|${variant}`;

// ── lookup ──────────────────────────────────────────────────────────────────

type ItemRow = {
	audio_hash: string;
	unit: CatalogueUnit;
	variant: string;
	version: string;
	unit_schema: number;
	duration_sec: number;
	data: string;
	licence: string | null;
	device_id: string;
	rev: unknown;
	updated_at: unknown;
};

export async function lookup(db: Db, audit: AuditEmit, userId: string, input: CatalogueLookupInput): Promise<CatalogueLookupResult> {
	return withDevice(db, audit, userId, 'lookup', input.deviceId, async (tx) => {
		const want = input.want.map((w) => ({
			unit: w.unit,
			variant: w.variant ?? null,
			min_version: w.minVersion ?? null,
			max_schema: w.maxSchema ?? null,
		}));
		// Newest acceptable version per (hash, unit, variant): Postgres orders
		// int[] element-wise, the protocol's compareVersions. Overlapping wants
		// join a row twice; DISTINCT ON keeps one.
		const rows = await tx.query<ItemRow>(
			`select distinct on (i.audio_hash, i.unit, i.variant)
				i.audio_hash, i.unit, i.variant, array_to_json(i.version)::text as version, i.unit_schema, i.duration_sec,
				i.data::text as data, i.licence, i.device_id, i.rev::float8 as rev,
				floor(extract(epoch from i.updated_at) * 1000)::float8 as updated_at
			from curator.catalogue_item i
			join jsonb_to_recordset($2::text::jsonb) as w(unit text, variant text, min_version int[], max_schema int)
				on i.unit = w.unit
				and (w.variant is null or i.variant = w.variant)
				and (w.min_version is null or i.version >= w.min_version)
				and (w.max_schema is null or i.unit_schema <= w.max_schema)
			where i.user_id = (select auth.uid())
				and i.audio_hash in (select jsonb_array_elements_text($1::text::jsonb))
			order by i.audio_hash, i.unit, i.variant, i.version desc`,
			[JSON.stringify(input.audioHashes), JSON.stringify(want)],
		);
		const items = rows.map(
			(r): StoredCatalogueItem =>
				({
					audioHash: r.audio_hash,
					unit: r.unit,
					variant: r.variant,
					version: JSON.parse(r.version) as number[],
					unitSchema: num(r.unit_schema),
					durationSec: num(r.duration_sec),
					licence: r.licence,
					data: JSON.parse(r.data) as unknown,
					rev: num(r.rev),
					deviceId: r.device_id,
					updatedAt: num(r.updated_at),
				}) as StoredCatalogueItem,
		);
		return { items };
	});
}

// ── put ─────────────────────────────────────────────────────────────────────

export type PutCall = { deviceId: string; items: readonly unknown[] };

export function assertPutSize(items: readonly unknown[]): void {
	if (items.length > MAX_CATALOGUE_PUT_ITEMS || utf8ByteLength(JSON.stringify(items)) > MAX_CATALOGUE_PUT_BYTES) {
		throw new CloudError('PAYLOAD_TOO_LARGE', 'batch_too_large');
	}
}

type Candidate = {
	index: number;
	item: CatalogueItem;
	group: string;
	key: string;
	blobPath: string | null;
	blobBytes: number;
	dataBytes: number;
};

type Rejected = CataloguePutResult['rejected'][number];

// Pure: everything that needs no database.
export function validatePut(userId: string, policy: CataloguePolicy, items: readonly unknown[]): { candidates: Candidate[]; rejected: Rejected[] } {
	assertPutSize(items);
	const rejected: Rejected[] = [];
	const candidates: Candidate[] = [];
	items.forEach((raw, index) => {
		const reject = (reason: CatalogueRejectReason) => rejected.push({ index, reason });
		const parsed = safeParseCatalogueItem(raw);
		// U+0000 or a lone surrogate inside `features` would fail the batch's
		// single INSERT, and with it every valid item beside it.
		if (!parsed.ok || hasUnstorableText(raw)) return reject('invalid_item');
		const item = parsed.item;
		if (!catalogueAllows(policy, item.unit, item.variant)) return reject('unit_disabled');
		let blobPath: string | null = null;
		let blobBytes = 0;
		if (item.unit === 'peaks' || item.unit === 'vectors') {
			const blob = item.data.blob;
			if (blob.path !== catalogueBlobPath(userId, item.unit, blob.sha256)) return reject('blob_path_invalid');
			blobPath = blob.path;
			blobBytes = blob.bytes;
		}
		const group = groupKey(item.audioHash, item.unit, item.variant);
		candidates.push({
			index,
			item,
			group,
			key: `${group}|${versionKey(item.version)}`,
			blobPath,
			blobBytes,
			dataBytes: utf8ByteLength(JSON.stringify(item.data)),
		});
	});
	// One statement upserts the batch, and Postgres refuses to touch a row
	// twice in one ON CONFLICT: the last copy of a key wins, as it would
	// have in two calls.
	const last = new Map<string, number>();
	for (const c of candidates) last.set(c.key, c.index);
	const kept = candidates.filter((c) => {
		if (last.get(c.key) === c.index) return true;
		rejected.push({ index: c.index, reason: 'duplicate_in_batch' });
		return false;
	});
	return { candidates: kept, rejected };
}

// Arrays leave Postgres as JSON text (`array_to_json(...)::text`): the two
// drivers parse array columns differently, JSON they parse the same.
type ExistingRow = { audio_hash: string; unit: string; variant: string; version: string; bytes: unknown; blob_paths: string };
const asPaths = (v: string): string[] => JSON.parse(v) as string[];

export async function put(db: Db, audit: AuditEmit, userId: string, policy: CataloguePolicy, call: PutCall): Promise<CataloguePutResult> {
	// Caps (validatePut checks them first) and shapes, before a connection
	// is even taken.
	const uid = userId.toLowerCase();
	const { candidates, rejected } = validatePut(uid, policy, call.items);

	const result = await withDevice(db, audit, userId, 'put', call.deviceId, async (tx): Promise<CataloguePutResult> => {
		// Serialise one user's puts: rev order then equals commit order, so an
		// inventory cursor never passes a rev a slower put has yet to commit,
		// and the usage, versions and retention read below stay true until
		// commit.
		await tx.query(`select pg_advisory_xact_lock(hashtextextended('catalogue:' || (select auth.uid())::text, 0))`);
		const account = await readAccount(tx);
		if (!account.entitled) throw new CloudError('FORBIDDEN', 'catalogue_not_entitled');

		const reject = (c: Candidate, reason: CatalogueRejectReason): false => {
			rejected.push({ index: c.index, reason });
			return false;
		};
		let live = candidates;

		// The blobs, as the caller's RLS shows them: an object in another
		// user's prefix is invisible here, so it reads as missing.
		const paths = [...new Set(live.flatMap((c) => (c.blobPath ? [c.blobPath] : [])))];
		if (paths.length > 0) {
			const objects = await tx.query<{ name: string; size: unknown }>(
				`select o.name, (o.metadata ->> 'size')::float8 as size from storage.objects o
				where o.bucket_id = 'catalogue' and o.name in (select jsonb_array_elements_text($1::text::jsonb))`,
				[JSON.stringify(paths)],
			);
			const sizes = new Map(objects.map((o) => [o.name, o.size === null ? null : num(o.size)]));
			live = live.filter((c) => {
				if (!c.blobPath) return true;
				if (!sizes.has(c.blobPath)) return reject(c, 'blob_missing');
				if (sizes.get(c.blobPath) !== c.blobBytes) return reject(c, 'blob_size_mismatch');
				return true;
			});
		}

		// What the account holds for every touched (hash, unit, variant).
		const groups = [...new Map(live.map((c) => [c.group, { h: c.item.audioHash, u: c.item.unit, v: c.item.variant }])).values()];
		const existing =
			groups.length === 0
				? []
				: await tx.query<ExistingRow>(
						`select i.audio_hash, i.unit, i.variant, array_to_json(i.version)::text as version,
							(i.data_bytes + i.blob_bytes)::float8 as bytes, array_to_json(i.blob_paths)::text as blob_paths
						from curator.catalogue_item i
						join jsonb_to_recordset($1::text::jsonb) as g(h text, u text, v text)
							on i.audio_hash = g.h and i.unit = g.u and i.variant = g.v
						where i.user_id = (select auth.uid())`,
						[JSON.stringify(groups)],
					);
		const held = new Map<string, { version: number[]; bytes: number; paths: string[] }[]>();
		for (const r of existing) {
			const g = groupKey(r.audio_hash, r.unit, r.variant);
			held.set(g, [...(held.get(g) ?? []), { version: JSON.parse(r.version) as number[], bytes: num(r.bytes), paths: asPaths(r.blob_paths) }]);
		}

		// Versions kept, then quota, in batch order. The quota counts an
		// overwrite as its difference; versions retention is about to drop are
		// still counted, so the check errs towards refusing.
		let used = account.usedBytes;
		const replacedPaths: string[] = [];
		live = live.filter((c) => {
			const versions = held.get(c.group) ?? [];
			const same = versions.find((v) => compareVersions(v.version, c.item.version) === 0);
			if (!same && versions.filter((v) => compareVersions(v.version, c.item.version) > 0).length >= CATALOGUE_VERSIONS_KEPT) {
				return reject(c, 'version_outdated');
			}
			const bytes = c.dataBytes + c.blobBytes;
			const delta = bytes - (same?.bytes ?? 0);
			if (delta > 0 && used + delta > account.quotaBytes) return reject(c, 'quota_exceeded');
			used += delta;
			const paths = c.blobPath ? [c.blobPath] : [];
			if (same) {
				replacedPaths.push(...same.paths.filter((p) => !paths.includes(p)));
				same.bytes = bytes;
				same.paths = paths;
			} else {
				held.set(c.group, [...versions, { version: c.item.version, bytes, paths }]);
			}
			return true;
		});

		const accepted: CataloguePutResult['accepted'] = [];
		let superseded: string[] = [];
		if (live.length > 0) {
			const rows = live.map((c) => ({
				audio_hash: c.item.audioHash,
				unit: c.item.unit,
				variant: c.item.variant,
				version: c.item.version,
				unit_schema: c.item.unitSchema,
				duration_sec: c.item.durationSec,
				data: c.item.data,
				data_bytes: c.dataBytes,
				blob_paths: c.blobPath ? [c.blobPath] : [],
				blob_bytes: c.blobBytes,
				digest: itemDigest(c.item),
				licence: c.item.licence,
				device_id: call.deviceId,
			}));
			// One statement for the batch; `user_id` comes from the default
			// (`auth.uid()`), `rev` from the sequence on insert and again on
			// overwrite, so an inventory cursor sees the change.
			const stored = await tx.query<{ k: string; rev: unknown }>(
				`insert into curator.catalogue_item
					(audio_hash, unit, variant, version, unit_schema, duration_sec, data, data_bytes, blob_paths, blob_bytes, digest, licence, device_id)
				select r.audio_hash, r.unit, r.variant, r.version, r.unit_schema, r.duration_sec, r.data, r.data_bytes,
					r.blob_paths, r.blob_bytes, r.digest, r.licence, r.device_id
				from jsonb_array_elements($1::text::jsonb) with ordinality as e(x, ord)
				cross join lateral jsonb_to_record(e.x) as r(audio_hash text, unit text, variant text, version int[], unit_schema int,
					duration_sec float8, data jsonb, data_bytes int, blob_paths text[], blob_bytes bigint, digest text, licence text, device_id text)
				order by e.ord
				on conflict (user_id, audio_hash, unit, variant, version) do update set
					unit_schema = excluded.unit_schema,
					duration_sec = excluded.duration_sec,
					data = excluded.data,
					data_bytes = excluded.data_bytes,
					blob_paths = excluded.blob_paths,
					blob_bytes = excluded.blob_bytes,
					digest = excluded.digest,
					licence = excluded.licence,
					device_id = excluded.device_id,
					rev = nextval('curator.catalogue_rev'),
					updated_at = now()
				returning audio_hash || '|' || unit || '|' || variant || '|' || array_to_string(version, '.') as k, rev::float8 as rev`,
				[JSON.stringify(rows)],
			);
			const revByKey = new Map(stored.map((s) => [s.k, num(s.rev)]));
			for (const c of live) accepted.push({ index: c.index, rev: revByKey.get(c.key)! });

			// Retention: the newest CATALOGUE_VERSIONS_KEPT versions per key.
			const touched = [...new Map(live.map((c) => [c.group, { h: c.item.audioHash, u: c.item.unit, v: c.item.variant }])).values()];
			const dropped = await tx.query<{ blob_paths: string }>(
				`delete from curator.catalogue_item i
				using (
					select x.audio_hash, x.unit, x.variant, x.version,
						row_number() over (partition by x.audio_hash, x.unit, x.variant order by x.version desc) as rn
					from curator.catalogue_item x
					join jsonb_to_recordset($1::text::jsonb) as g(h text, u text, v text)
						on x.audio_hash = g.h and x.unit = g.u and x.variant = g.v
					where x.user_id = (select auth.uid())
				) r
				where i.user_id = (select auth.uid())
					and i.audio_hash = r.audio_hash and i.unit = r.unit and i.variant = r.variant and i.version = r.version
					and r.rn > $2::int
				returning array_to_json(i.blob_paths)::text as blob_paths`,
				[JSON.stringify(touched), String(CATALOGUE_VERSIONS_KEPT)],
			);

			// A path is superseded only once no item of the account names it:
			// content-addressed, so two versions (or two hashes) can share one.
			const candidatesGone = [...new Set([...replacedPaths, ...dropped.flatMap((d) => asPaths(d.blob_paths))])];
			if (candidatesGone.length > 0) {
				const still = await tx.query<{ p: string }>(
					`select distinct p from curator.catalogue_item i, unnest(i.blob_paths) as p
					where i.user_id = (select auth.uid()) and p in (select jsonb_array_elements_text($1::text::jsonb))`,
					[JSON.stringify(candidatesGone)],
				);
				const stillNamed = new Set(still.map((s) => s.p));
				superseded = candidatesGone.filter((p) => !stillNamed.has(p)).sort();
			}
		}

		const after = await readAccount(tx);
		rejected.sort((a, b) => a.index - b.index);
		return { accepted, rejected, superseded, usage: { usedBytes: after.usedBytes, quotaBytes: after.quotaBytes } };
	});

	if (result.rejected.length > 0) {
		const byReason: Record<string, number> = {};
		for (const r of result.rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
		audit('catalogue_rejected', { procedure: 'put', byReason });
	}
	return result;
}

// ── inventory ───────────────────────────────────────────────────────────────

export async function inventory(
	db: Db,
	audit: AuditEmit,
	userId: string,
	policy: CataloguePolicy,
	input: CatalogueInventoryInput,
): Promise<CatalogueInventoryResult> {
	const limit = Math.min(input.limit ?? MAX_CATALOGUE_INVENTORY, MAX_CATALOGUE_INVENTORY);
	return withDevice(db, audit, userId, 'inventory', input.deviceId, async (tx) => {
		const rows = await tx.query<{
			audio_hash: string;
			unit: CatalogueUnit;
			variant: string;
			version: string;
			unit_schema: number;
			rev: unknown;
			bytes: unknown;
			device_id: string;
		}>(
			`select audio_hash, unit, variant, array_to_json(version)::text as version, unit_schema, rev::float8 as rev,
				(data_bytes + blob_bytes)::float8 as bytes, device_id
			from curator.catalogue_item
			where user_id = (select auth.uid()) and rev > $1::bigint
			order by rev
			limit $2::int`,
			[String(input.afterRev), String(limit + 1)],
		);
		const more = rows.length > limit;
		const entries = rows.slice(0, limit).map((r) => ({
			audioHash: r.audio_hash,
			unit: r.unit,
			variant: r.variant,
			version: JSON.parse(r.version) as number[],
			unitSchema: num(r.unit_schema),
			rev: num(r.rev),
			bytes: num(r.bytes),
			deviceId: r.device_id,
		}));
		return {
			entries,
			nextRev: entries.length > 0 ? entries[entries.length - 1]!.rev : input.afterRev,
			more,
			account: await readAccount(tx),
			policy,
		};
	});
}

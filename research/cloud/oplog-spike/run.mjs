// Op-log round-trip spike against a Supabase project (see README.md).
//
// One process plays two "devices" signed in as the same user. Device B appends synthetic ops
// through push_ops(). Device A learns about them either from the trigger-driven broadcast on
// the private channel user:<uid> (default) or by polling once a second (--no-realtime), then
// pulls by seq until drained. Latency is wall clock at apply on A minus the client_ts that B
// stamped at enqueue; both halves share one clock, so the headline number has no skew in it.

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const args = parseArgs(process.argv.slice(2));
const REALTIME = !args['no-realtime'];
const OPS = intArg('ops', 1000);
const BATCH = intArg('batch', 50);
const DELAY_MS = intArg('delay', 100);
const PAGE = 500;
const POLL_MS = 1000;
const GRACE_MS = 30_000;
const SETTLE_MS = 3000;
const DEVICE_B = 'spike-device-b';

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');
const SPIKE_EMAIL = env('SPIKE_EMAIL');
const SPIKE_PASSWORD = env('SPIKE_PASSWORD');

main().catch(fail);

async function main() {
	const t0 = performance.now();
	log(`mode=${REALTIME ? 'realtime' : 'poll'} ops=${OPS} batch=${BATCH} delay=${DELAY_MS}ms page=${PAGE}`);

	const a = await signIn('A');
	const b = await signIn('B');
	log(`signed in twice as ${a.uid}`);

	const batches = chunk(makeOps(OPS), BATCH);
	const sentIds = new Set(batches.flat().map((o) => o.op_id));
	const rx = makeReceiver(a.client, sentIds);

	let timer = null;
	if (REALTIME) await subscribe(a.client, a.uid, rx.onWake);
	// Baseline after subscribing: rows from earlier runs are skipped, and nothing can slip into
	// the gap because B has not started pushing yet.
	rx.state.lastSeq = await headSeq(a.client);
	log(`[A] head seq ${rx.state.lastSeq}, ${REALTIME ? `subscribed to user:${a.uid}` : `polling every ${POLL_MS} ms`}`);
	if (!REALTIME) timer = setInterval(() => rx.pull().catch(fail), POLL_MS);

	const pushStart = performance.now();
	const sent = [];
	const rpcMs = [];
	let head = 0;
	for (let i = 0; i < batches.length; i++) {
		// client_ts is stamped here, at enqueue: t=0 of the measured round trip.
		const ops = stamp(batches[i]);
		const r = await push(b.client, ops);
		sent.push(ops);
		rpcMs.push(r.ms);
		head = r.head;
		if (i < batches.length - 1) await sleep(DELAY_MS);
	}
	const pushEnd = performance.now();
	log(`[B] pushed ${OPS} ops in ${batches.length} calls over ${sec(pushEnd - pushStart)}, head seq ${head}`);

	const drained = await waitFor(() => rx.state.received >= OPS, GRACE_MS);
	const drainEnd = performance.now();
	// A forced pull separates "rows never landed" from "rows landed but the wake-up was lost".
	let recovered = 0;
	if (!drained) {
		const before = rx.state.received;
		await rx.pull();
		recovered = rx.state.received - before;
		log(`[A] grace period expired: ${OPS - before} missing, ${recovered} recovered by a forced pull`);
	}

	// Idempotency: resend one accepted batch verbatim, as a client retrying a lost response
	// would. Expect the same head seq back, no wake-up (the statement trigger sees an empty
	// transition table) and no new rows on A, even after an explicit pull.
	const wakeBefore = rx.state.wakeups;
	const seenBefore = rx.state.received + rx.state.duplicates;
	const re = await push(b.client, sent[Math.floor(sent.length / 2)]);
	await sleep(SETTLE_MS);
	await rx.pull();
	const leaked = rx.state.received + rx.state.duplicates - seenBefore;
	const reWakeups = rx.state.wakeups - wakeBefore;

	if (timer) clearInterval(timer);
	await a.client.removeAllChannels();

	const s = rx.state;
	const missing = OPS - s.received;
	const idempotent = re.head === head && leaked === 0;
	console.log('');
	console.log(`=== results (${REALTIME ? 'realtime wake-up' : `poll every ${POLL_MS} ms`}) ===`);
	console.log(`sent ${OPS}  received ${s.received}  missing ${missing}  duplicates ${s.duplicates}  foreign ${s.foreign}`);
	console.log(`wake-ups ${s.wakeups}  pulls ${s.pulls}  pages ${s.pages}`);
	console.log(`latency enqueue -> applied   ${dist(s.latency)}`);
	console.log(`  push leg   client_ts -> received_at   ${dist(s.pushLeg)}   (server clock, includes skew)`);
	console.log(`  fan-out    received_at -> applied     ${dist(s.fanoutLeg)}   (server clock, includes skew)`);
	console.log(`push_ops rpc                 ${dist(rpcMs)}`);
	console.log(`elapsed: push ${sec(pushEnd - pushStart)}, drain after last push ${sec(drainEnd - pushEnd)}, total ${sec(performance.now() - t0)}`);
	console.log(`re-push of one batch: head seq ${head} -> ${re.head}, wake-ups +${reWakeups}, new rows ${leaked}  ${idempotent ? 'ok' : 'FAIL'}`);
	if (recovered) console.log(`note: ${recovered} ops were in the table but only arrived on a forced pull; wake-ups were lost`);

	process.exit(missing > 0 ? 1 : (s.duplicates > 0 || !idempotent) ? 2 : 0);
}

// Each client gets its own in-memory session. autoRefreshToken off so no refresh timer keeps
// the process alive past the report; a run is far shorter than the one-hour token lifetime.
async function signIn(label) {
	const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const { data, error } = await client.auth.signInWithPassword({ email: SPIKE_EMAIL, password: SPIKE_PASSWORD });
	if (error) throw new Error(`device ${label}: sign-in failed: ${error.message}`);
	// Private channels are authorized with the user's JWT. supabase-js forwards it on the auth
	// event, but setting it explicitly makes the subscribe below independent of that timing.
	await client.realtime.setAuth(data.session.access_token);
	return { client, uid: data.user.id };
}

function subscribe(client, uid, onWake) {
	return new Promise((resolve, reject) => {
		client
			.channel(`user:${uid}`, { config: { private: true } })
			.on('broadcast', { event: 'wake' }, (msg) => onWake(msg.payload?.seq))
			.subscribe((status, err) => {
				if (status === 'SUBSCRIBED') resolve();
				else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`subscribe ${status}: ${err?.message ?? 'no detail'}`));
				else log(`[A] channel ${status}`);
			});
	});
}

function makeReceiver(client, sentIds) {
	const state = {
		lastSeq: 0, received: 0, duplicates: 0, foreign: 0, wakeups: 0, pulls: 0, pages: 0,
		latency: [], pushLeg: [], fanoutLeg: [], seen: new Set(),
	};
	let pulling = false;
	let dirty = false;

	async function pullOnce() {
		for (;;) {
			const { data, error } = await client.rpc('pull_ops', { after_seq: state.lastSeq, lim: PAGE });
			if (error) throw new Error(`pull_ops: ${error.message}`);
			state.pages++;
			const now = Date.now();
			for (const row of data) {
				state.lastSeq = row.seq;
				if (state.seen.has(row.op_id)) { state.duplicates++; continue; }
				state.seen.add(row.op_id);
				// Rows from a concurrent run (or another device) are counted, not measured.
				if (!sentIds.has(row.op_id)) { state.foreign++; continue; }
				state.received++;
				const clientTs = Date.parse(row.client_ts);
				const receivedAt = Date.parse(row.received_at);
				state.latency.push(now - clientTs);
				state.pushLeg.push(receivedAt - clientTs);
				state.fanoutLeg.push(now - receivedAt);
			}
			if (data.length < PAGE) return;
		}
	}

	// Coalesce: a wake-up that lands mid-pull only marks dirty, and the loop runs once more, so
	// N wake-ups cost at most N+1 pulls and never overlap (overlap would reorder lastSeq).
	async function pull() {
		if (pulling) { dirty = true; return; }
		pulling = true;
		try {
			do { dirty = false; state.pulls++; await pullOnce(); } while (dirty);
		} finally {
			pulling = false;
		}
	}

	function onWake(seq) {
		state.wakeups++;
		// The doorbell says how far the log goes; skip the trip when we already hold that seq.
		if (typeof seq === 'number' && seq <= state.lastSeq) return;
		pull().catch(fail);
	}

	return { state, pull, onWake };
}

async function headSeq(client) {
	const { data, error } = await client.from('library_op').select('seq').order('seq', { ascending: false }).limit(1).maybeSingle();
	if (error) throw new Error(`head seq: ${error.message}`);
	return data?.seq ?? 0;
}

async function push(client, ops) {
	const t0 = performance.now();
	const { data, error } = await client.rpc('push_ops', { ops });
	if (error) throw new Error(`push_ops: ${error.message}`);
	return { head: Number(data), ms: performance.now() - t0 };
}

function makeOps(n) {
	const ops = [];
	for (let i = 0; i < n; i++) {
		ops.push({
			device_id: DEVICE_B,
			op_id: randomUUID(),
			schema_version: 1,
			entity: 'track_tag',
			entity_id: randomUUID(),
			kind: 'add',
			payload: { tag: 'spike' },
		});
	}
	return ops;
}

function stamp(ops) {
	const client_ts = new Date().toISOString();
	return ops.map((o) => ({ ...o, client_ts }));
}

function chunk(arr, size) {
	const out = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

async function waitFor(pred, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

function pct(arr, p) {
	const s = [...arr].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function dist(arr) {
	if (!arr.length) return 'n/a';
	return `p50 ${pct(arr, 50).toFixed(0)}  p95 ${pct(arr, 95).toFixed(0)}  max ${Math.max(...arr).toFixed(0)} ms`;
}

function sec(ms) {
	return `${(ms / 1000).toFixed(1)} s`;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function log(line) {
	console.log(`${new Date().toISOString().slice(11, 23)} ${line}`);
}

function env(key) {
	const v = process.env[key];
	if (!v) {
		console.error(`missing env ${key} (see README.md)`);
		process.exit(64);
	}
	return v;
}

function parseArgs(argv) {
	const out = {};
	for (const a of argv) {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
		if (!m) {
			console.error(`unknown argument ${a}; usage: node run.mjs [--no-realtime] [--ops=N] [--batch=N] [--delay=MS]`);
			process.exit(64);
		}
		out[m[1]] = m[2] ?? true;
	}
	return out;
}

function intArg(name, fallback) {
	if (args[name] === undefined) return fallback;
	const n = Number.parseInt(args[name], 10);
	if (!Number.isInteger(n) || n <= 0) {
		console.error(`--${name} must be a positive integer`);
		process.exit(64);
	}
	return n;
}

function fail(err) {
	console.error(err instanceof Error ? err.stack ?? err.message : err);
	process.exit(70);
}

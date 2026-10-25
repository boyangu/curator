import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineWorkspace } from 'vitest/config';

// Files whose tests bound a main-loop slice or a wall-clock wait tightly
// (tens to a few hundred ms). In the parallel run they share the cores with
// ~110 other files — sync-slices-perf alone generates a 40k-track library —
// and a hydrate slice that takes 11-17 ms at rest was measured at 465 ms
// there: the machine, not the code.
//
// So each runs as its own single-fork project. vitest 2.1's forks pool runs
// every parallel file first and the single-fork projects after, one project
// at a time, recycling the worker between projects (pool-forks runTests):
// each of these files gets a quiet machine and a fresh process. Fresh
// matters — sharing one fork, the hydrate slice read 72 ms after
// sync-slices-perf's heap. (vitest 3 names this ordering `sequence.groupOrder`;
// if an upgrade drops the implicit order these merely run in parallel again.)
// Their budgets still scale with whatever load is left
// (src/test-support/timing.ts).
//
// The two-desktops rigs and the 2,000 ms-bounded identity / fold drains stay
// in the parallel project: their bounds catch a regression in kind, not a
// few ms, and scale with load the same way.
const PERF = [
	'src/sync-log/sync-slices-perf.test.ts',
	'src/sync-log/remote-rows-perf.test.ts',
	'src/sync-log/membership-perf.test.ts',
	'src/rekordbox/history-import-perf.test.ts',
	'src/catalogue/hydrator.test.ts',
	'src/catalogue/two-device.test.ts',
	'src/catalogue/fileless.test.ts',
	'src/catalogue/queue.test.ts',
	'src/library/artist-alias.test.ts',
];

// The default 5 s is a hang detector, and a two-desktops rig test that runs
// in ~1 s alone (two migrated DBs, a fake cloud, several sync cycles) has
// taken over 5 s under the parallel suite. These are correctness tests;
// 30 s still fails a hang, and the slow ones set their own.
//
// Every project shares the run's temp root (scripts/test/tmp-root.mjs): the
// tests' mkdtemp dirs land under one directory this run owns and removes.
const common = {
	testTimeout: 30_000,
	hookTimeout: 30_000,
	globalSetup: [fileURLToPath(new URL('../../scripts/test/tmp-root.mjs', import.meta.url))],
};

export default defineWorkspace([
	{
		test: {
			name: 'core',
			include: ['src/**/*.test.ts'],
			exclude: [...configDefaults.exclude, ...PERF],
			...common,
		},
	},
	...PERF.map((file) => ({
		test: {
			name: `perf:${basename(file, '.test.ts')}`,
			include: [file],
			poolOptions: { forks: { singleFork: true } },
			...common,
		},
	})),
]);

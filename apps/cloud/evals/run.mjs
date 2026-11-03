// `pnpm --filter @curator/cloud eval`: bundle the provider, replay the set
// with promptfoo (it exits non-zero on any failing case, which is not the
// gate), then judge the run by pair agreement (summary.mjs). A plain node
// script, not a `&&` chain: the same on Windows' cmd and a CI shell.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const node = (args, opts = {}) => spawnSync(process.execPath, args, { stdio: 'inherit', cwd: here, ...opts }).status ?? 1;

if (!existsSync(new URL('./catalog/twins.jsonl', import.meta.url))) {
	console.error('no evals/catalog/twins.jsonl: run `pnpm --filter @curator/cloud catalog agent evals export` first');
	process.exit(1);
}
if (node(['build.mjs'])) process.exit(1);
const promptfoo = fileURLToPath(new URL('../node_modules/promptfoo/dist/src/entrypoint.js', import.meta.url));
const env = new URL('../../../.env', import.meta.url);
node([promptfoo, 'eval', '-c', 'promptfooconfig.yaml', '--no-progress-bar', ...(existsSync(env) ? ['--env-file', fileURLToPath(env)] : []), ...process.argv.slice(2)], { env: { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' } });
process.exit(node(['summary.mjs']));

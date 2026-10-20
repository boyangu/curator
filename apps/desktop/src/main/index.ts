import { app, BrowserWindow, ipcMain, Menu, net, powerMonitor, protocol, shell } from 'electron';
// `components` is castlabs/electron-releases' Widevine CDM loader. The fork
// adds it to the Electron API; upstream Electron also exposes it on recent
// versions but castlabs is the one that ships a signed VMP keyset usable by
// services like Spotify. Imported separately because the type signatures
// aren't part of the default 'electron' export.
import { components } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize as normalizePath } from 'node:path';
import { createHash } from 'node:crypto';
import { appendFile, existsSync, promises as fsp, statSync } from 'node:fs';
import { applyPendingRestore, buildMcpWriteTools, createCoreService, migrate, remapLocalPathsAt, type CoreService, type MirProvisionSpec, type MirSidecarSpec } from '@curator/core';
import { cpus, hostname } from 'node:os';
import { mainLog, attachFileSink } from './log.js';
import { isLogLevel } from '@curator/shared/log';
import { TOOL_CATALOG, LOG_BATCH_CHANNEL, type IpcChannels } from '../ipc.js';
import { broadcastEvent, sendEvent } from './events.js';
import { buildHandlers } from './handlers.js';
import { buildAppRouter } from './trpc.js';
import { IngestPool, defaultPoolSize } from './ingest/pool.js';
import { loadAgentConfig } from './agent-config.js';
import { McpBridgeHost } from './mcp/host.js';
import { McpConfirmBroker } from './mcp/confirm.js';
import { UtilityWorkspaceHost } from './workspace/host.js';
import { UtilityBackupHost } from './backup/host.js';
import { importRestoredTokens, writeHostArtifacts } from './backup/host-artifacts.js';
import { getGoogleAuthStatus, googleNeedsReconnect, getGoogleAccessToken } from './backup/google-auth.js';
import { CoreSidecarHost } from './core-sidecar/host.js';
import { AudioSidecarHost } from './audio-sidecar.js';
import { SpotifySidecarHost } from './spotify-sidecar.js';
import { LoadRecovery } from './load-recovery.js';
import { CloudAccount } from './cloud/account.js';
import { watchAppActivity } from './cloud/activity.js';
import { createHttpCloudTransport } from './cloud/transport.js';
import { createCatalogueBlobStore } from './cloud/blobs.js';
import { cloudAccountConfigured, cloudApiUrl } from './cloud-config.js';
import type { CloudTransport } from '@curator/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const bootLog = mainLog.for('boot');
const shutdownLog = mainLog.for('shutdown');

// DB lives in the user's app-data folder so it persists across reinstalls.
// dev override: CURATOR_DB_URL env var.
function getDbPath(): string {
	if (process.env.CURATOR_DB_URL) return process.env.CURATOR_DB_URL;
	return join(app.getPath('userData'), 'curator.db');
}

function getCoversDir(): string {
	return join(app.getPath('userData'), 'covers');
}

function getPeaksDir(): string {
	return join(app.getPath('userData'), 'peaks');
}

// Windows path → WSL path: 'C:\\foo\\bar' → '/mnt/c/foo/bar'.
function toWslPath(p: string): string {
	return p
		.replace(/^([A-Za-z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
		.replace(/\\/g, '/');
}

type SidecarSpec = { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; translatePathsToWsl?: boolean };

// Run the analyzer source tree inside WSL Ubuntu's venv (.venv-wsl under
// analyzerDir), translating paths across the JSON-RPC boundary. Shared by dev
// (source tree next to __dirname) and the packaged repo-local fallback below.
function wslVenvAnalyzerSpec(analyzerDir: string): SidecarSpec {
	return {
		executable: 'wsl',
		args: [
			'bash', '-c',
			// cd into the analyzer dir under /mnt/<drive>/; PYTHONPATH
			// points at src/ so `curator_analyzer.main` resolves. We
			// don't pass cwd to spawn — `wsl` cd's via the bash command.
			`cd '${toWslPath(analyzerDir)}' && PYTHONUNBUFFERED=1 PYTHONPATH=src .venv-wsl/bin/python -m curator_analyzer.main`,
		],
		translatePathsToWsl: true,
	};
}

// Resolve the analyzer sidecar spawn spec. In dev (ELECTRON_RENDERER_URL set)
// we run the source tree directly via `python -m curator_analyzer.main`,
// expecting the dev to have set up the venv (see apps/analyzer/README.md).
// In production we point at the PyInstaller `--onedir` artifact bundled under
// `resources/analyzer/`. Every path is gated behind existsSync so a missing
// bundle just disables the analyzer instead of crashing the whole app.
//
// Windows never has a native analyzer: Essentia has no Windows wheel, so the
// analyzer always runs inside WSL — dev uses the source tree + .venv-wsl;
// packaged builds prefer the Linux PyInstaller bundle staged by
// scripts/build-sidecars.mjs (built inside WSL), falling back to the repo's
// .venv-wsl when the packaged app runs out of the source tree (win-unpacked).
function getAnalyzerSpec(): SidecarSpec | null {
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	if (isDev) {
		const analyzerDir = join(__dirname, '..', '..', '..', 'analyzer');
		// WSL path activated by the presence of apps/analyzer/.venv-wsl OR
		// explicitly via env flag.
		const useWsl = process.platform === 'win32'
			&& (process.env.CURATOR_ANALYZER_WSL === '1' || existsSync(join(analyzerDir, '.venv-wsl')));
		if (useWsl) return wslVenvAnalyzerSpec(analyzerDir);

		// CURATOR_PY overrides — point at the user's venv'd python if not on PATH.
		const exe = process.env.CURATOR_PY ?? (process.platform === 'win32' ? 'python' : 'python3');
		return {
			executable: exe,
			args: ['-m', 'curator_analyzer.main'],
			cwd: analyzerDir,
			env: { PYTHONPATH: join(analyzerDir, 'src') },
		};
	}
	// Production. Native bundle first — mac/linux today, and a hypothetical
	// future Windows build the moment Essentia ships a wheel.
	const bundleDir = join(process.resourcesPath ?? __dirname, 'analyzer');
	const nativeExe = join(bundleDir, process.platform === 'win32' ? 'curator-analyzer.exe' : 'curator-analyzer');
	if (existsSync(nativeExe)) {
		return { executable: nativeExe, cwd: bundleDir };
	}
	if (process.platform === 'win32') {
		// WSL-hosted Linux bundle: build-sidecars builds the PyInstaller
		// onedir *inside WSL* and stages it at resources/analyzer/ — same
		// dir as the native path, but the entry binary is an ELF with no
		// .exe suffix. `exec` so the analyzer replaces the bash shim and
		// process kill reaches it directly.
		const linuxExe = join(bundleDir, 'curator-analyzer');
		if (existsSync(linuxExe)) {
			return {
				executable: 'wsl',
				args: ['bash', '-c', `cd '${toWslPath(bundleDir)}' && exec ./curator-analyzer`],
				translatePathsToWsl: true,
			};
		}
		// Repo-local fallback: a packaged build launched from inside the
		// source tree (dist/win-unpacked) can still reach the dev WSL venv.
		// resourcesPath = apps/desktop/dist/win-unpacked/resources → 4 up +
		// 'analyzer' = apps/analyzer. CURATOR_ANALYZER_DIR overrides for a
		// packaged app installed elsewhere on a dev machine.
		const repoAnalyzerDir = process.env.CURATOR_ANALYZER_DIR
			?? join(process.resourcesPath ?? __dirname, '..', '..', '..', '..', 'analyzer');
		if (existsSync(join(repoAnalyzerDir, '.venv-wsl'))) {
			mainLog.for('analyzer').info('no staged bundle — running repo WSL venv', { analyzerDir: repoAnalyzerDir });
			return wslVenvAnalyzerSpec(repoAnalyzerDir);
		}
	}
	mainLog.for('analyzer').warn('sidecar bundle not found; analyzer disabled', { exe: nativeExe });
	return null;
}

// AI audio analysis engine (apps/mir): Windows-native Python + torch, no WSL.
// Dev runs the source tree's uv venv — .venv-xpu (Intel GPU torch build)
// when present, else .venv (CPU build). Packaged builds run an env that is
// provisioned on demand into userData/mir from the staged project + bundled
// uv (multi-GB, so never bundled; see apps/core/src/mir/provision.ts); until
// then the engine reports "not set up". Weights download lazily into
// userData/mir/hf in packaged builds (dev keeps the default HF cache).
function getMirSpec(): { spec: MirSidecarSpec; provision?: MirProvisionSpec } | null {
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	const venvPy = (venv: string): string => join(venv, process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'));
	if (isDev) {
		const mirDir = join(__dirname, '..', '..', '..', 'mir');
		const venv = [join(mirDir, '.venv-xpu'), join(mirDir, '.venv')].find((v) => existsSync(venvPy(v)));
		if (!venv) {
			mainLog.for('mir').warn('apps/mir venv not found; AI engine disabled (uv sync --extra cpu in apps/mir)');
			return null;
		}
		return { spec: { executable: venvPy(venv), args: ['-m', 'curator_mir.main'], cwd: mirDir, env: { PYTHONPATH: join(mirDir, 'src') } } };
	}
	const projectDir = join(process.resourcesPath ?? __dirname, 'mir');
	const uv = join(projectDir, process.platform === 'win32' ? 'uv.exe' : 'uv');
	if (!existsSync(join(projectDir, 'uv.lock')) || !existsSync(uv)) {
		mainLog.for('mir').warn('engine project not staged; AI engine disabled', { projectDir });
		return null;
	}
	const home = join(app.getPath('userData'), 'mir');
	const envDir = join(home, 'venv');
	// Core Ultra (Meteor/Lunar/Arrow Lake) iGPUs run the Intel XPU torch
	// build ~20-30x faster than CPU; elsewhere the CPU build is smaller.
	const cpuModel = cpus()[0]?.model ?? '';
	const extra = /Intel/i.test(cpuModel) && /Ultra/i.test(cpuModel) ? 'xpu' : 'cpu';
	return {
		spec: { executable: venvPy(envDir), args: ['-m', 'curator_mir.main'], cwd: projectDir,
			env: { PYTHONPATH: join(projectDir, 'src'), HF_HOME: join(home, 'hf') } },
		provision: { uv, projectDir, envDir, pythonDir: join(home, 'python'), cacheDir: join(home, 'uv-cache'), extra },
	};
}

// Same shape as getAnalyzerSpec() but for the rekordbox reader sidecar
// (apps/rekordbox/). Dev: python -m curator_rekordbox.main; prod: bundled
// PyInstaller binary at resources/rekordbox/.
function getRekordboxSpec(): { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null {
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	if (isDev) {
		const cwd = join(__dirname, '..', '..', '..', 'rekordbox');
		// Prefer the dedicated venv at apps/rekordbox/.venv if it exists —
		// pyrekordbox + sqlcipher3-wheels need a specific Python interpreter
		// and pinning to the venv avoids the "you have Python 3.13 on PATH"
		// trap. CURATOR_PY env var still wins if set.
		const venvPy = join(cwd, '.venv',
			process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'),
		);
		const exe = process.env.CURATOR_PY
			?? (existsSync(venvPy) ? venvPy : (process.platform === 'win32' ? 'python' : 'python3'));
		return {
			executable: exe,
			args: ['-m', 'curator_rekordbox.main'],
			cwd,
			env: { PYTHONPATH: join(cwd, 'src') },
		};
	}
	const bundleDir = join(process.resourcesPath ?? __dirname, 'rekordbox');
	const exeName = process.platform === 'win32' ? 'curator-rekordbox.exe' : 'curator-rekordbox';
	const exe = join(bundleDir, exeName);
	if (!existsSync(exe)) {
		mainLog.for('rekordbox').warn('sidecar bundle not found; rekordbox adapter disabled', { exe });
		return null;
	}
	return { executable: exe, cwd: bundleDir };
}

// Same shape as getAnalyzerSpec() but for the Node research sidecar
// (apps/researcher/ — agent research over the Claude Agent SDK, powering the
// KB's similar-artists aspect). Requires an ANTHROPIC_API_KEY in the
// environment — absent key ⇒ null ⇒ the KB's agent tier is off (disabled is
// a supported state). Runs on our own Electron binary with
// ELECTRON_RUN_AS_NODE=1 (no separate Node install needed). Dev: the tsc
// output at apps/researcher/dist; prod: the bundled copy at
// resources/researcher/.
function getResearcherSpec(): { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null {
	const apiKey = process.env['ANTHROPIC_API_KEY'];
	if (!apiKey) {
		mainLog.for('researcher').info('no ANTHROPIC_API_KEY — research sidecar disabled');
		return null;
	}
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	const entry = isDev
		? join(__dirname, '..', '..', '..', 'researcher', 'dist', 'main.js')
		: join(process.resourcesPath ?? __dirname, 'researcher', 'dist', 'main.js');
	if (!existsSync(entry)) {
		mainLog.for('researcher').warn('sidecar build not found; research disabled (run: pnpm --filter @curator/researcher build)', { entry });
		return null;
	}
	return {
		executable: process.execPath,
		args: [entry],
		cwd: dirname(entry),
		env: { ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_API_KEY: apiKey },
	};
}

// Same shape for the Node agent sidecar (apps/agent — the in-app agent's
// provider-generic harness). Unlike the researcher, no API key gates the
// spawn: the sidecar boots unconfigured and is armed via the configure RPC
// with the safeStorage-held BYOK key (agent-config.ts) — so key entry and
// rotation never respawn the process. CURATOR_DISABLE_AGENT=1 disables.
function getAgentSpec(): { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null {
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	const entry = isDev
		? join(__dirname, '..', '..', '..', 'agent', 'dist', 'main.js')
		: join(process.resourcesPath ?? __dirname, 'agent', 'dist', 'main.js');
	if (!existsSync(entry)) {
		mainLog.for('agent').warn('sidecar build not found; agent disabled (run: pnpm --filter @curator/agent build)', { entry });
		return null;
	}
	return {
		executable: process.execPath,
		args: [entry],
		cwd: dirname(entry),
		env: { ELECTRON_RUN_AS_NODE: '1' },
	};
}

// Same shape as getAnalyzerSpec() but for the Rust audio engine sidecar
// (apps/audio/). Dev: `cargo run --release` from the workspace; prod: the
// bundled native binary at resources/audio/. Single self-contained binary
// (no Python runtime, no ffmpeg) — bundle is the cargo build output.
//
// Why --release in dev: symphonia's debug-build decode is several×
// slower than release; running --release iterates fast enough on the
// audio path and avoids misleading latency numbers during development.
// CURATOR_AUDIO_DEBUG=1 overrides this when stepping through with a
// debugger is needed (e.g. broken WASAPI device init).
function getAudioSpec(): { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null {
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	if (isDev) {
		const audioDir = join(__dirname, '..', '..', '..', 'audio');
		const debugMode = process.env.CURATOR_AUDIO_DEBUG === '1';
		// Prefer a pre-built binary in target/{release,debug} to avoid
		// `cargo`'s startup cost (a few hundred ms) on every Electron
		// launch. Fall back to invoking `cargo run` when no binary exists
		// yet (first run after a fresh clone).
		const profile = debugMode ? 'debug' : 'release';
		const exeName = process.platform === 'win32' ? 'curator-audio.exe' : 'curator-audio';
		const prebuilt = join(audioDir, 'target', profile, exeName);
		if (existsSync(prebuilt)) {
			// Sanity check — warn loudly if the OTHER profile's binary is
			// newer than the one we're about to launch. This catches the
			// silent-failure mode where someone iterates with `cargo build`
			// (debug) but dev runs the stale release binary, and every
			// audio:rpc method the new code added gets rejected as
			// "unknown method" without obvious surface.
			const otherProfile = debugMode ? 'release' : 'debug';
			const otherPath = join(audioDir, 'target', otherProfile, exeName);
			if (existsSync(otherPath)) {
				try {
					const myMtime = statSync(prebuilt).mtimeMs;
					const otherMtime = statSync(otherPath).mtimeMs;
					if (otherMtime > myMtime + 1000) {
						const age = ((otherMtime - myMtime) / 1000 / 60).toFixed(1);
						mainLog.for('audio').warn(
							`⚠ stale sidecar: target/${profile}/${exeName} is ${age} min older than target/${otherProfile}/. ` +
							`If you've been iterating on apps/audio recently, run \`cargo build${debugMode ? '' : ' --release'}\` ` +
							`from apps/audio to rebuild ${profile}, or set CURATOR_AUDIO_DEBUG=${debugMode ? '0' : '1'} to launch the other profile.`,
						);
					}
				} catch { /* mtime read failure — not worth crashing over */ }
			}
			return { executable: prebuilt, cwd: audioDir };
		}
		// Fallback — `cargo run --release` (or `cargo run` for debug).
		// First run rebuilds the binary; subsequent runs pick the prebuilt
		// path above. Streams cargo's compile output through stderr until
		// the binary actually launches — long compile = long startup lag,
		// but only on first run.
		mainLog.for('audio').warn(`no prebuilt sidecar at ${prebuilt} — falling back to \`cargo run\`. Build with \`cargo build --release\` from apps/audio for faster startup.`);
		const args = ['run', '--quiet'];
		if (!debugMode) args.push('--release');
		return { executable: 'cargo', args, cwd: audioDir };
	}
	// Production path — bundle lives in resources/audio/curator-audio(.exe)
	const bundleDir = join(process.resourcesPath ?? __dirname, 'audio');
	const exeName = process.platform === 'win32' ? 'curator-audio.exe' : 'curator-audio';
	const exe = join(bundleDir, exeName);
	if (!existsSync(exe)) {
		mainLog.for('audio').warn('sidecar bundle not found; audio sidecar disabled', { exe });
		return null;
	}
	return { executable: exe, cwd: bundleDir };
}

// Spawn spec for the Spotify playback sidecar (apps/spotify-player/) — a
// headless castlabs-Electron app hosting the Spotify Web Playback SDK.
//
// PREFER THE SIGNED BUNDLE EVERYWHERE. The VMP-signed packaged app is the only
// config that reliably provisions Widevine — and crucially it works the same in
// dev as in prod, so the main-app dev loop never re-signs. Build it once with
// `pnpm build:sidecars` (or `pnpm --filter @curator/spotify-player
// package:signed`), which stages it to resources/spotify-player.
//   - Dev resolves that staged dir at apps/desktop/resources/spotify-player.
//   - Prod resolves it at process.resourcesPath/spotify-player.
//
// Dev fallback (only if the signed bundle isn't staged): run the unsigned JS
// build via the castlabs Electron this process already runs under. That relies
// on castlabs' unpackaged dev-mode Widevine, which works for a visible window
// but can refuse to provision for the sidecar's HIDDEN window — so it's a
// last resort with a loud warning, not the default. It does let you iterate
// sidecar code with just `pnpm --filter @curator/spotify-player build`.
//
// Missing both ⇒ null ⇒ Spotify playback disabled (handler rejects cleanly),
// same "disabled is a supported state" contract as the other sidecars.
// ELECTRON_RUN_AS_NODE is stripped so a spawned Electron boots as Electron, not
// a bare Node (the parent or its tooling may have it set).
function getSpotifySpec(): { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	delete childEnv['ELECTRON_RUN_AS_NODE'];
	const isDev = !!process.env.ELECTRON_RENDERER_URL;
	const exeName = process.platform === 'win32' ? 'curator-spotify.exe' : 'curator-spotify';

	// 1. Signed staged bundle — preferred in dev AND prod.
	const stagedDir = isDev
		? join(__dirname, '..', '..', 'resources', 'spotify-player') // apps/desktop/resources/spotify-player
		: join(process.resourcesPath ?? __dirname, 'spotify-player');
	const stagedExe = join(stagedDir, exeName);
	if (existsSync(stagedExe)) {
		return { executable: stagedExe, cwd: stagedDir, env: childEnv };
	}

	// 2. Dev-only fallback — unsigned JS build via our own castlabs Electron.
	if (isDev) {
		const playerDir = join(__dirname, '..', '..', '..', 'spotify-player');
		const mainBundle = join(playerDir, 'out', 'main', 'index.cjs');
		if (existsSync(mainBundle)) {
			mainLog.for('spotify').warn('using UNSIGNED dev build — Widevine may refuse to provision in the hidden window. For reliable playback run `pnpm build:sidecars` to stage the signed bundle.');
			return { executable: process.execPath, args: [mainBundle], cwd: playerDir, env: childEnv };
		}
		mainLog.for('spotify').warn(`no signed bundle and no dev build (${mainBundle}) — Spotify playback disabled. Run \`pnpm build:sidecars\`.`);
		return null;
	}

	mainLog.for('spotify').warn('signed bundle not found; Spotify playback disabled', { stagedExe });
	return null;
}

// Register the `curator-cover://` scheme as a standard, secure scheme that
// supports the Fetch API so the renderer's CSP allows img-src curator-cover:.
// Must be called BEFORE app.whenReady() — Chromium only knows about privileged
// schemes at process boot.
//
// `curator-local://` streams audio from disk for the local-playback backend.
// secure:true is required so the HTML5 <audio> element will preload + seek in
// production builds; supportFetchAPI:true keeps it usable via fetch() too;
// stream:true unlocks Chromium's Range/streaming pathway so seeks return 206
// instead of buffering the whole file.
protocol.registerSchemesAsPrivileged([
	{ scheme: 'curator-cover', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
	{ scheme: 'curator-local', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
	// .cpk peak files for the player's waveform. supportFetchAPI:true so the
	// renderer can `await fetch('curator-peaks://...').arrayBuffer()`;
	// bypassCSP:true keeps it usable without a CSP allowlist for a binary
	// scheme. URL shape: curator-peaks://<trackId>/<lo|hi>
	{ scheme: 'curator-peaks', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

const MIME_BY_EXT: Record<string, string> = {
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
	'.webp': 'image/webp', '.gif': 'image/gif',
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
	'.flac': 'audio/flac',
	'.m4a': 'audio/mp4',
	'.mp4': 'audio/mp4',
	'.wav': 'audio/wav',
	'.mp3': 'audio/mpeg',
	'.aiff': 'audio/aiff',
	'.aif': 'audio/aiff',
};

// Audio stream handler for `curator-local://<encoded-absolute-path>`.
// Verifies the requested path is an ingested local file (security: only
// paths we know about are served — random filesystem reads from the renderer
// are denied) and streams the bytes back with Range support so HTML5 <audio>
// can seek without buffering the whole track.
async function handleLocalAudioRequest(request: Request, svc: CoreService): Promise<Response> {
	try {
		const url = new URL(request.url);
		// URL shape: curator-local://x/<segment>/<segment>/…
		// The sentinel host (`x`) sidesteps Chromium's strict standard-scheme
		// host parsing (a leading "c:" would otherwise be eaten as host:port).
		// Each segment is percent-encoded so drive colons + spaces round-trip
		// without surprises.
		const raw = url.pathname
			.replace(/^\/+/, '')
			.split('/')
			.map(decodeURIComponent)
			.join('/');
		const lookup = await svc.resolveLocalFile(raw);
		if (!lookup) return new Response('not in library', { status: 404 });

		if (!existsSync(lookup.path)) {
			return new Response('file missing on disk', { status: 410 });
		}

		const stat = await fsp.stat(lookup.path);
		const total = stat.size;
		const ext = extname(lookup.path).toLowerCase();
		const mime = AUDIO_MIME_BY_EXT[ext] ?? 'application/octet-stream';

		const range = request.headers.get('range');
		if (!range) {
			// No Range header — return the whole file. Some <audio> code paths
			// open with an open-ended request first to learn duration.
			const buf = await fsp.readFile(lookup.path);
			return new Response(buf as unknown as BodyInit, {
				status: 200,
				headers: {
					'Content-Type': mime,
					'Content-Length': String(total),
					'Accept-Ranges': 'bytes',
				},
			});
		}

		// Parse `bytes=START-END`. END is optional (open-ended request).
		const m = /^bytes=(\d+)-(\d+)?$/.exec(range.trim());
		if (!m) return new Response('bad range', { status: 416 });
		const start = Number(m[1]);
		const end = m[2] ? Number(m[2]) : total - 1;
		if (start >= total || end >= total || start > end) {
			return new Response('range not satisfiable', {
				status: 416,
				headers: { 'Content-Range': `bytes */${total}` },
			});
		}

		const chunkSize = end - start + 1;
		const fh = await fsp.open(lookup.path, 'r');
		const buf = Buffer.alloc(chunkSize);
		await fh.read(buf, 0, chunkSize, start);
		await fh.close();

		return new Response(buf as unknown as BodyInit, {
			status: 206,
			headers: {
				'Content-Type': mime,
				'Content-Length': String(chunkSize),
				'Content-Range': `bytes ${start}-${end}/${total}`,
				'Accept-Ranges': 'bytes',
			},
		});
	} catch (err) {
		mainLog.for('curator-local').error('failed', err);
		return new Response('error', { status: 500 });
	}
}

// Lazy cover-image cache served via custom protocol. URL shape:
//   curator-cover://<trackId>
// Main process resolves trackId → remote URL via the core service, hashes
// it to a cache filename, downloads on first request, then serves from disk.
// curator-peaks:// — serves a track's .cpk peak-file bytes for the player's
// waveform render. URL shape: curator-peaks://<trackId>/<lo|hi>.
//
// Resolution lives in the core service (resolveTrackPeaksPath); we keep this
// handler thin so the disk-lookup logic stays one place. Cache-Control is
// max-age 1 day rather than immutable because the analyzer could re-run and
// overwrite the file in place — but the renderer also caches in an LRU so
// this header mostly matters for cross-window scenarios.
async function handlePeaksRequest(request: Request, svc: CoreService): Promise<Response> {
	try {
		const url = new URL(request.url);
		const trackId = decodeURIComponent(url.hostname);
		const tier = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
		if (!trackId) return new Response('missing track id', { status: 400 });
		if (tier !== 'lo' && tier !== 'hi') {
			return new Response(`bad tier "${tier}" (expected lo|hi)`, { status: 400 });
		}
		const path = await svc.resolveTrackPeaksPath(trackId, tier);
		if (!path) return new Response('no peaks for track', { status: 404 });
		const data = await fsp.readFile(path);
		// Tell the renderer which producer wrote this file. `rb_*.cpk` came
		// from the rekordbox importer (Pioneer's PWV5 encoding); anything
		// else from the Essentia analyzer. The two producers use different
		// channel→frequency conventions, and the renderer's display-colour
		// mapping needs to know which it's looking at.
		const source = /[\\/]rb_[^\\/]+\.cpk$/i.test(path) ? 'rekordbox' : 'essentia';
		return new Response(data as unknown as BodyInit, {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Cache-Control': 'public, max-age=86400',
				'X-Peaks-Source': source,
			},
		});
	} catch (err) {
		mainLog.for('curator-peaks').error('failed', err);
		return new Response('error', { status: 500 });
	}
}

async function handleCoverRequest(request: Request, svc: CoreService): Promise<Response> {
	try {
		const url = new URL(request.url);
		// `url.hostname` holds the trackId for curator-cover://<trackId>
		const trackId = decodeURIComponent(url.hostname);
		if (!trackId) return new Response('missing track id', { status: 400 });

		// Fast path A — remote URL from Spotify/Tidal payload, cached by URL hash.
		const remote = await svc.getTrackCoverUrl(trackId);
		if (remote) {
			const hash = createHash('sha1').update(remote).digest('hex');
			const remoteExt = (() => {
				try { return extname(new URL(remote).pathname).toLowerCase(); } catch { return ''; }
			})();
			const ext = MIME_BY_EXT[remoteExt] ? remoteExt : '.jpg';
			const filePath = join(getCoversDir(), `${hash}${ext}`);

			if (!existsSync(filePath)) {
				const res = await net.fetch(remote);
				if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status });
				const buf = Buffer.from(await res.arrayBuffer());
				await fsp.writeFile(filePath, buf);
			}

			const data = await fsp.readFile(filePath);
			return new Response(data as unknown as BodyInit, {
				headers: {
					'Content-Type': MIME_BY_EXT[ext] ?? 'image/jpeg',
					'Cache-Control': 'public, max-age=31536000, immutable',
				},
			});
		}

		// Fast path B — embedded album art from a local audio file. Cached on
		// disk under the trackId so subsequent renders never re-parse the
		// audio. `t_<id>` namespace keeps these distinct from URL-hash files.
		// Cache invalidation: we trust the trackId to be stable enough for v1
		// (re-ingest of the same file path keeps the same track id via the
		// scanner's ISRC/title resolver); manual user re-tag-of-cover is a
		// future concern.
		const localCache = join(getCoversDir(), `t_${trackId}.bin`);
		if (existsSync(localCache)) {
			const data = await fsp.readFile(localCache);
			return new Response(data as unknown as BodyInit, {
				headers: {
					'Content-Type': 'image/jpeg', // music-metadata pictures usually JPEG; PNG ok too — browsers detect from bytes
					'Cache-Control': 'public, max-age=31536000, immutable',
				},
			});
		}

		const embedded = await svc.extractLocalCover(trackId);
		if (embedded) {
			const buf = Buffer.from(embedded.data);
			await fsp.writeFile(localCache, buf);
			return new Response(buf as unknown as BodyInit, {
				headers: {
					'Content-Type': embedded.format || 'image/jpeg',
					'Cache-Control': 'public, max-age=31536000, immutable',
				},
			});
		}

		return new Response('no cover for track', { status: 404 });
	} catch (err) {
		mainLog.for('curator-cover').error('failed', err);
		return new Response('error', { status: 500 });
	}
}

let core: CoreService | null = null;
let ingestPool: IngestPool | null = null;
let coreSidecar: CoreSidecarHost | null = null;
let audioSidecar: AudioSidecarHost | null = null;
let spotifySidecar: SpotifySidecarHost | null = null;
let mcpHost: McpBridgeHost | null = null;
let cloudAccount: CloudAccount | null = null;
let cloudTransport: CloudTransport | null = null;
// Constructed eagerly (no side effects) so registerIpc can bind the
// confirm-response channel before the bridge host exists.
const mcpConfirm = new McpConfirmBroker();
let mainWindow: BrowserWindow | null = null;

// Two instances would open the same better-sqlite3 file (and both spawn
// sidecars + library watchers fighting over the same rows) — a corruption
// path, not just a UX wart. Second launch hands off to the running instance
// and exits; the running instance surfaces its window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});
}

// Reload the window when a network change (WSL/VPN/Docker adapter coming up)
// aborts its page or module loads — see load-recovery.ts. did-fail-load
// covers the page itself in every build. Subresources only fail this way when
// they come over the network stack, i.e. from the Vite dev server; packaged
// builds load from file:// and custom schemes, so the webRequest hook is
// dev-only, scoped to the dev origin (a failed third-party fetch must never
// reload the app). onErrorOccurred only calls into JS for failed requests
// that match the filter, so it costs the main loop nothing on the happy path.
function attachLoadRecovery(win: BrowserWindow): void {
	const wc = win.webContents;
	const wcId = wc.id;
	const recovery = new LoadRecovery(
		{ reload: () => wc.reloadIgnoringCache(), isDestroyed: () => wc.isDestroyed() },
		mainLog.for('window'),
	);
	wc.on('did-fail-load', (_e, errorCode, _desc, url, isMainFrame) => recovery.onFailLoad(errorCode, url, isMainFrame));
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	const webRequest = wc.session.webRequest;
	if (devUrl) {
		try {
			webRequest.onErrorOccurred({ urls: [`${new URL(devUrl).origin}/*`] }, (details) => {
				if (details.webContentsId === wcId) recovery.onRequestError(details.error, details.url);
			});
		} catch (err) {
			mainLog.for('window').warn('load recovery: could not watch dev-server requests', { devUrl }, err);
		}
	}
	win.on('closed', () => {
		recovery.dispose();
		// One listener per session — drop ours so it doesn't outlive the window.
		if (devUrl) webRequest.onErrorOccurred(null);
	});
}

function createWindow(): void {
	// Resolve icon.png both for dev (`out/main` → ../../resources) and packaged
	// builds (resources live next to the main bundle). Electron tolerates a
	// missing icon by falling back to its default, so we never crash on it.
	const iconPath = join(__dirname, '../../resources/icon.png');

	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1200,
		minHeight: 720,
		backgroundColor: '#0a0a0b',
		// Frameless — no OS title bar, no system min/max/close. Designer will
		// supply a custom top bar later. Window is draggable via CSS
		// -webkit-app-region rules on .brand + .topbar (see style.css).
		frame: false,
		icon: iconPath,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Wired before loadURL so a failure of the very first load is caught.
	attachLoadRecovery(mainWindow);

	// The load promise rejects on did-fail-load, which LoadRecovery already
	// handles — log it here instead of letting it surface as an unhandled
	// rejection.
	const onLoadFailed = (err: unknown): void => mainLog.for('window').warn('initial load failed', undefined, err);
	if (process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch(onLoadFailed);
		mainWindow.webContents.openDevTools({ mode: 'detach' });
	} else {
		mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch(onLoadFailed);
	}

	// Grant system-audio loopback to the renderer's getDisplayMedia call,
	// picker-free. The SmallPlayer FFTs this to draw the streaming seek bar's
	// live spectrum — the only way to visualize Spotify, whose Widevine media
	// element Chromium refuses to expose to Web Audio (see renderer/spectrum.ts).
	// Audio-only: we never grant the screen video. This trusts the renderer
	// (sandboxed, our own code) not to abuse the loopback for anything else.
	mainWindow.webContents.session.setDisplayMediaRequestHandler(
		(_request, callback) => { callback({ audio: 'loopback' }); },
		{ useSystemPicker: false },
	);

	// Hook the audio sidecar's event stream to this window's webContents.
	// State_changed + ended events now flow Rust → main → renderer without
	// the renderer having to poll. setEventTarget is idempotent so re-running
	// createWindow on macOS (re-open after close) re-wires cleanly.
	audioSidecar?.setEventTarget(mainWindow.webContents);
	spotifySidecar?.setEventTarget(mainWindow.webContents);
	mainWindow.on('closed', () => {
		audioSidecar?.setEventTarget(null);
		spotifySidecar?.setEventTarget(null);
	});

	// Defer the library scanner's initial walk until AFTER the renderer has
	// finished its first load + bootstrap. Otherwise a watched folder with
	// thousands of files pegs the main event loop with sync better-sqlite3
	// calls before the renderer's IPC requests can land, producing a blank
	// window on launch. Idempotent — LibraryScanner.startWatching short-circuits
	// when a folder already has a live watcher, so dev HMR reloads are safe.
	//
	// SKIPPED when CORE_SIDECAR=1: the sidecar owns the scanner in that mode,
	// and running it here too would have both processes' chokidars fighting
	// over the same files (and both writing source_link rows).
	if (!coreSidecar) {
		mainWindow.webContents.once('did-finish-load', () => {
			setTimeout(() => {
				core?.startLibraryWatching().catch((err) =>
					mainLog.for('scanner').error('startLibraryWatching failed', err),
				);
			}, 2000);
		});
	}

	// Discover feed poll loop — same deferred-start constraint as the
	// scanner. Always started on main's CoreService (the sidecar, when
	// enabled, only serves migrated read channels — feed polling + writes
	// live here).
	//
	// The analyzer sidecar rides the same gate, first in line. On Windows it
	// spawns through wsl.exe, and a cold WSL boot brings up a Hyper-V network
	// adapter ~2 s later; Chromium answers a new adapter by aborting every
	// in-flight request with ERR_NETWORK_CHANGED — at launch that was the
	// renderer's module graph, leaving a blank window. Analysis enqueued
	// before this waits inside the sidecar wrapper. Always main's core: the
	// core sidecar gets no analyzer spec.
	mainWindow.webContents.once('did-finish-load', () => {
		setTimeout(() => {
			try {
				core?.startAnalyzer();
			} catch (err) {
				mainLog.for('analyzer').error('startAnalyzer failed', err);
			}
			try {
				core?.startFeedPolling();
			} catch (err) {
				mainLog.for('feed').error('startFeedPolling failed', err);
			}
			// Spotify album fill — background, paced through the shared rate
			// gate; idles when Spotify is disconnected.
			try {
				core?.startAlbumEnrichment();
			} catch (err) {
				mainLog.for('album-enrich').error('startAlbumEnrichment failed', err);
			}
			// Backup scheduler: overdue check ~2 min after launch, then a
			// coarse tick; yields to any heavy job (see heavyJobInFlight).
			try {
				core?.startBackupScheduler();
			} catch (err) {
				mainLog.for('backup').error('startBackupScheduler failed', err);
			}
			// Cloud sync: first cycle (and a first-sign-in push of the existing
			// library, chunked to yield to the loop) only after the window is up.
			try {
				core?.startCloudSync();
			} catch (err) {
				mainLog.for('cloud-sync').error('startCloudSync failed', err);
			}
		}, 2000);
	});
}

function registerIpc(svc: CoreService): void {
	// Bind every channel from the catalog. The handlers map is exhaustive
	// over keyof IpcChannels — TypeScript errors if a channel is added to
	// the catalog without a matching handler (or vice-versa).
	const handlers = buildHandlers(svc, { getMainWindow: () => mainWindow, coreSidecar, audioSidecar, spotifySidecar, mcpConfirm, cloudAccount, cloudTransport });
	for (const name of Object.keys(TOOL_CATALOG) as (keyof IpcChannels)[]) {
		const fn = handlers[name] as (...args: unknown[]) => Promise<unknown>;
		ipcMain.handle(name, (_evt, ...args) => fn(...args));
	}

	// tRPC transport seam. A single `trpc:call` channel fronts the whole router
	// (apps/desktop/src/main/trpc.ts); the renderer's data/api.ts facades route
	// through it. The router delegates to the same `handlers` map above, so this
	// adds NO business logic — only a typed transport. Legacy per-channel
	// handlers stay registered for non-facade callers (they coexist). The
	// createCaller object is path-walkable: `caller.tracks.list(input)` etc.,
	// so we resolve `op.path` ("tracks.list") by reducing down the object.
	const appRouter = buildAppRouter(handlers);
	const caller = appRouter.createCaller({});
	ipcMain.handle('trpc:call', async (_evt, op: { path: string; input: unknown }) => {
		const fn = op.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], caller as unknown);
		if (typeof fn !== 'function') throw new Error(`unknown trpc path: ${op.path}`);
		return (fn as (i: unknown) => Promise<unknown>)(op.input);
	});

	// Renderer log shipping — fire-and-forget batches from the renderer's IPC
	// sink (renderer/data/log.ts). Shallow-validate and force proc:'renderer':
	// records cross a trust boundary even though the renderer is our code, and
	// the proc field is the one thing a reader uses to reconstruct the
	// multi-process timeline.
	ipcMain.on(LOG_BATCH_CHANNEL, (_evt, records: unknown) => {
		if (!Array.isArray(records) || records.length > 100) return;
		for (const r of records) {
			if (typeof r !== 'object' || r === null) continue;
			const rec = r as Record<string, unknown>;
			if (!isLogLevel(rec['level']) || typeof rec['msg'] !== 'string' || typeof rec['area'] !== 'string') continue;
			mainLog.emit({
				ts: typeof rec['ts'] === 'number' ? rec['ts'] : Date.now(),
				level: rec['level'],
				proc: 'renderer',
				area: rec['area'],
				msg: rec['msg'],
				...(rec['data'] !== undefined ? { data: rec['data'] as Record<string, unknown> } : {}),
				...(rec['err'] !== undefined ? { err: rec['err'] as { name: string; message: string; stack?: string } } : {}),
			});
		}
	});

	// One-shot subscription for the lifetime of the service — broadcasts queue
	// changes to the renderer so the Downloads view can re-render live.
	svc.subscribeDownloadQueue((evt) => {
		sendEvent(mainWindow, 'download:queue-event', evt);
	});

	// Library scan progress — broadcast to every renderer so the settings UI
	// can show live counters while the scanner walks watched folders.
	svc.subscribeLibraryScan((p) => {
		broadcastEvent('library:scan-progress', p);
	});

	// Analyzer queue events — broadcast state transitions + progress/partial
	// frames so the planned waveform widget can swap a placeholder the moment
	// `partial`/`done` lands for its current track.
	//
	// We deliberately drop `enqueued` here. A library scan calls enqueue once
	// per file, so a 4,500-file folder fires 4,500 `enqueued` events back to
	// back; no renderer surface currently consumes them, and the IPC volume
	// alone is enough to peg the renderer's message pump while the scan runs.
	// If a future "X tracks queued for analysis" badge wants this, re-emit it
	// from a coalesced source.
	svc.subscribeAnalysisEvents((evt) => {
		if (evt.kind === 'enqueued') return;
		broadcastEvent('analysis:event', evt);
	});
	// AI engine: status snapshots are coalesced in core (<= 4/s), so even a
	// whole-library backfill stays a trickle on the renderer's message pump.
	svc.subscribeMirEvents((evt) => broadcastEvent('mir:event', evt));

	// Feed enrichment completions — push each enriched item so the Discover
	// view folds fresh genre/label/bpm chips onto the card without a manual
	// refresh. Paced by the enricher's 1.5s WAF delay, so the IPC volume is low.
	svc.subscribeFeedEnriched((item) => {
		broadcastEvent('feed:enriched', item);
	});

	// KB expansion progress — background provider pages + research results
	// landing. The entity page appends the new rows live off this stream.
	svc.subscribeKbEvents((e) => {
		broadcastEvent('kb:event', e);
	});

	// In-app agent turn stream — text deltas, tool activity, result sets,
	// view commands. The Discover agent panel is a pure consumer.
	svc.subscribeAgentEvents((e) => {
		broadcastEvent('agent:event', e);
	});

	// Rekordbox import lifecycle — broadcast every event so the settings
	// modal can render a live progress strip and per-phase totals.
	svc.subscribeRekordboxEvents((evt) => {
		broadcastEvent('rekordbox:event', evt);
	});
	// Rekordbox EXPORT lifecycle — same broadcast pattern, separate
	// channel. Consumed by the sync-to-rekordbox modal's progress strip.
	svc.subscribeRekordboxExportEvents((evt) => {
		broadcastEvent('rekordbox:export-event', evt);
	});
	// Convert to WAV lifecycle — progress is throttled core-side (≤4/s).
	svc.subscribeWavConvertEvents((evt) => {
		broadcastEvent('wav:convert-event', evt);
	});
	// Backup & restore lifecycle + coalesced status (progress throttled in
	// the worker, ≤4/s).
	svc.subscribeBackupEvents((evt) => {
		broadcastEvent('backup:event', evt);
	});
	// Cloud sync: status snapshots (progress coalesced ≤ 4/s in core) and
	// applied batches (changed row ids) for the track list. A sign-in or
	// sign-out changes the status too, so re-broadcast it then.
	svc.subscribeCloudSync((e) => {
		if (e.kind === 'status') broadcastEvent('cloud-sync:status', { ...e.status, enabled: true });
		else broadcastEvent('sync:applied', e.applied);
	});
	cloudAccount?.onChange(() => {
		void svc.getCloudSyncStatus().then((s) => broadcastEvent('cloud-sync:status', s), () => { /* closing */ });
		void svc.getCatalogueStatus().then((s) => broadcastEvent('catalogue:status', s), () => { /* closing */ });
	});
	// Shared analysis: status (coalesced ≤ 4/s in core) for Settings →
	// Account, and tracks filled in from the catalogue outside an analysis
	// job, which the track list refreshes exactly like rows a sync pull
	// changed.
	svc.subscribeCatalogue((e) => {
		if (e.kind === 'status') broadcastEvent('catalogue:status', e.status);
		else broadcastEvent('sync:applied', { tracks: e.trackIds, playlists: [], entities: [] });
	});
}

app.whenReady().then(async () => {
	// Second instance — quit is already in flight from the lock check above;
	// bail before opening the DB or spawning sidecars against it.
	if (!gotSingleInstanceLock) return;
	// File sink needs userData, which is only reliable post-ready. The
	// logger's replay ring back-fills everything logged since process start.
	attachFileSink();
	// Castlabs' Widevine CDM is downloaded + installed on first run; on
	// subsequent runs it's loaded from the user-data dir. The Spotify Web
	// Playback SDK won't find a keysystem until this completes, so we await
	// it before opening the BrowserWindow. ~200ms warm, several seconds cold.
	try { await components.whenReady(); }
	catch (err) { mainLog.for('widevine').error('components.whenReady failed', err); }
	// Drop the default File/Edit/View/Window menu — we don't need it.
	// (Cmd/Ctrl+Q, devtools shortcut, etc. still work via accelerators.)
	Menu.setApplicationMenu(null);

	// Windows taskbar grouping + notification identity. Without this, the
	// app appears under "electron.app.Electron" instead of our brand. macOS
	// and Linux ignore this call; safe to invoke on every platform.
	if (process.platform === 'win32') {
		app.setAppUserModelId('com.curator.app');
	}

	// A staged restore (Settings → Backup → Restore…) is applied HERE, before
	// the first DB open below: files are swapped while no handle is live, and
	// the replaced ones are parked in userData/pre-restore-<ts>/. The path
	// remap for audio files restored under a new root runs right after the
	// migration, against the restored DB.
	const restoreApplied = await applyPendingRestore(app.getPath('userData'));
	if (restoreApplied) bootLog.info('staged restore applied', { snapshotId: restoreApplied.snapshotId, preRestoreDir: restoreApplied.preRestoreDir, error: restoreApplied.error });

	const dbPath = getDbPath();
	bootLog.info('db path', { dbPath });
	migrate(dbPath, { logger: mainLog });
	if (restoreApplied?.remap && !restoreApplied.error) {
		const r = remapLocalPathsAt(dbPath, restoreApplied.remap.from, restoreApplied.remap.to);
		bootLog.info('library root remapped after restore', { ...restoreApplied.remap, ...r });
	}

	// Ensure the cover-cache directory exists before we register the protocol
	// handler — the handler writes downloaded images into it.
	const coversDir = getCoversDir();
	if (!existsSync(coversDir)) await fsp.mkdir(coversDir, { recursive: true });
	bootLog.info('covers dir', { coversDir });

	// Peaks directories sit alongside the DB + covers in userData. We use
	// two subdirs: <userData>/peaks/lo (20 Hz strips, always loaded) and
	// <userData>/peaks/hi (100 Hz detail, lazy). The sidecar mkdirs them
	// too on each write, but creating them at boot guarantees the directory
	// is there for the renderer's fs.readFile path even before the first
	// analysis lands.
	const peaksDir = getPeaksDir();
	const peaksLoDir = join(peaksDir, 'lo');
	const peaksHiDir = join(peaksDir, 'hi');
	if (!existsSync(peaksLoDir)) await fsp.mkdir(peaksLoDir, { recursive: true });
	if (!existsSync(peaksHiDir)) await fsp.mkdir(peaksHiDir, { recursive: true });
	bootLog.info('peaks dir (lo + hi)', { peaksDir });

	// CURATOR_DISABLE_ANALYZER=1 skips analyzer spawning entirely — useful
	// when the Python env isn't set up (Essentia has no PyPI wheels for
	// Windows; see apps/analyzer/README.md). The analyzer sidecar also
	// auto-disables itself on the first ImportError, but the flag avoids
	// even the one-shot traceback.
	const analyzerSpec = process.env['CURATOR_DISABLE_ANALYZER'] === '1' ? null : getAnalyzerSpec();
	if (analyzerSpec) bootLog.info('analyzer sidecar', { executable: analyzerSpec.executable, args: (analyzerSpec.args ?? []).join(' ') });
	else bootLog.info('analyzer sidecar disabled (CURATOR_DISABLE_ANALYZER or missing spec)');
	const mirSpec = process.env['CURATOR_DISABLE_MIR'] === '1' ? null : getMirSpec();
	if (mirSpec) bootLog.info('AI engine sidecar', { executable: mirSpec.spec.executable, provision: mirSpec.provision?.extra ?? 'dev' });
	else bootLog.info('AI engine disabled (CURATOR_DISABLE_MIR or missing env)');
	const rekordboxSpec = process.env['CURATOR_DISABLE_REKORDBOX'] === '1' ? null : getRekordboxSpec();
	if (rekordboxSpec) bootLog.info('rekordbox sidecar', { executable: rekordboxSpec.executable, args: (rekordboxSpec.args ?? []).join(' ') });
	else bootLog.info('rekordbox sidecar disabled (CURATOR_DISABLE_REKORDBOX or missing spec)');
	// Research sidecar (KB agent tier). Needs ANTHROPIC_API_KEY + a built
	// apps/researcher; either missing just disables similar-artists research.
	const researcherSpec = process.env['CURATOR_DISABLE_RESEARCHER'] === '1' ? null : getResearcherSpec();
	if (researcherSpec) bootLog.info('research sidecar', { entry: (researcherSpec.args ?? []).join(' ') });
	// In-app agent sidecar (BYOK harness). Missing build / disable flag just
	// disables the agent panel; BYOK config is loaded + pushed after core
	// exists below.
	const agentSpec = process.env['CURATOR_DISABLE_AGENT'] === '1' ? null : getAgentSpec();
	if (agentSpec) bootLog.info('agent sidecar', { entry: (agentSpec.args ?? []).join(' ') });
	else bootLog.info('agent sidecar disabled (CURATOR_DISABLE_AGENT or missing build)');
	// Audio sidecar resolution — same shape as analyzer + rekordbox.
	// CURATOR_DISABLE_AUDIO=1 falls back to the legacy Web Audio backend
	// in the renderer (useful for comparing latency, debugging the sidecar
	// in isolation, or shipping without the native binary).
	// One resolution of the audio binary serves both the playback sidecar and
	// Convert to WAV (`<binary> convert`, one short-lived process per track).
	// CURATOR_DISABLE_AUDIO only switches off the long-lived playback engine.
	const audioBinary = getAudioSpec();
	const audioSpec = process.env['CURATOR_DISABLE_AUDIO'] === '1' ? null : audioBinary;
	if (audioSpec) bootLog.info('audio sidecar', { executable: audioSpec.executable, args: (audioSpec.args ?? []).join(' ') });
	else bootLog.info('audio sidecar disabled (CURATOR_DISABLE_AUDIO or missing spec)');
	if (audioSpec) {
		// Spawn the audio engine sidecar at boot and keep it alive for the
		// session. setEventTarget below (after the window exists) wires
		// state_changed / ended push events to the renderer.
		audioSidecar = new AudioSidecarHost(audioSpec);
		audioSidecar.start();
	}

	// Spotify playback sidecar — the headless Electron app hosting the Web
	// Playback SDK. CURATOR_DISABLE_SPOTIFY=1 (or a missing build/bundle)
	// disables it; `spotify:rpc` then rejects and the renderer treats Spotify
	// playback as unavailable. The token provider is lazy: `core` isn't created
	// until below, but getToken only fires on a `need_token` event, which can't
	// happen before the first play.
	const spotifySpec = process.env['CURATOR_DISABLE_SPOTIFY'] === '1' ? null : getSpotifySpec();
	if (spotifySpec) bootLog.info('spotify sidecar', { executable: spotifySpec.executable, args: (spotifySpec.args ?? []).join(' ') });
	else bootLog.info('spotify sidecar disabled (CURATOR_DISABLE_SPOTIFY or missing spec)');
	if (spotifySpec) {
		spotifySidecar = new SpotifySidecarHost(spotifySpec, {
			getToken: async () => (core ? await core.auth.getSpotifyAccessToken() : null),
		});
		spotifySidecar.start();
	}

	// Boot the ingest pool — N Electron utility processes that parse audio
	// metadata off the main process. Sized via INGEST_POOL_SIZE env var
	// (defaults to cpus-1, capped at 8). The worker script is the second
	// rollup input in electron.vite.config; it sits next to index.cjs in
	// the build output, so the path resolution is just __dirname-relative.
	const ingestWorkerPath = join(__dirname, 'ingest-worker.cjs');
	const poolSize = defaultPoolSize();
	ingestPool = new IngestPool(ingestWorkerPath, poolSize);
	bootLog.info('ingest pool', { size: poolSize });

	// net.fetch uses Chromium's network stack — real Chrome TLS fingerprint
	// + UA. Required for Beatport, whose Cloudflare WAF 403s Node/undici.
	//
	// CURATOR_BP_DUMP=<path> dumps the raw __NEXT_DATA__ JSON from every
	// /track/<slug>/<id> response to <path> so we can inspect the actual
	// schema when label/genre parsing falls through. Disabled by default.
	const bpDumpPath = process.env['CURATOR_BP_DUMP'] ?? null;
	const beatportFetch = async (url: string, init?: RequestInit): Promise<Response> => {
		const res = await net.fetch(url, init);
		if (bpDumpPath && res.ok && /\/track\/[^/]+\/\d+(?:\?|$)/.test(url)) {
			const body = await res.clone().text();
			const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
			if (m && m[1]) {
				try {
					await fsp.writeFile(bpDumpPath, m[1], 'utf8');
					mainLog.for('beatport').info('dumped __NEXT_DATA__', { url, bpDumpPath });
				} catch (err) {
					mainLog.for('beatport').warn('dump failed', undefined, err);
				}
			}
		}
		return res;
	};
	// Curator account: the Supabase session lives here in main. It needs the
	// Supabase project baked into this build (cloud-config.ts); library sync
	// additionally needs the API base — without it core gets no transport and
	// sync is off. Both "not configured" states are supported.
	if (cloudAccountConfigured()) {
		try {
			cloudAccount = new CloudAccount();
		} catch (err) {
			bootLog.error('cloud account unavailable', err);
		}
	} else {
		bootLog.info('cloud account not configured (CURATOR_SUPABASE_URL / CURATOR_SUPABASE_PUBLISHABLE_KEY unset at build time)');
	}
	const apiUrl = cloudApiUrl();
	cloudTransport = cloudAccount && apiUrl ? createHttpCloudTransport(apiUrl, cloudAccount) : null;
	bootLog.info('cloud sync', { account: !!cloudAccount, api: apiUrl || null, enabled: !!cloudTransport });
	const accountForCore = cloudAccount;
	core = createCoreService(dbPath, {
		beatportFetch,
		cloud: cloudTransport && accountForCore
			? {
				transport: cloudTransport,
				subscribeWakeups: (onWake) => accountForCore.subscribeWakeups(onWake),
				// Focus + OS idle time decide the fallback poll's cadence.
				watchActivity: (onChange) => watchAppActivity(() => mainWindow, onChange),
				device: { name: hostname(), platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32' },
				// Shared analysis: waveform blobs move directly between this
				// device and Supabase Storage under the user's own session.
				blobs: createCatalogueBlobStore(accountForCore),
			}
			: undefined,
		peaksDir,
		analyzer: analyzerSpec ?? undefined,
		rekordbox: rekordboxSpec ?? undefined,
		mir: mirSpec?.spec,
		mirProvision: mirSpec?.provision,
		researcher: researcherSpec ?? undefined,
		agent: agentSpec ?? undefined,
		// Agent workspace runs in a kill-able utility process — agent-written
		// SQL must never block the main loop (better-sqlite3 has no interrupt).
		workspaceHost: (paths) => new UtilityWorkspaceHost(join(__dirname, 'workspace-worker.cjs'), paths),
		parseAudio: ingestPool.parse,
		// `cargo run` fallback (dev, no prebuilt binary) needs `--` before the
		// binary's own argument.
		wavConverter: audioBinary
			? { command: audioBinary.executable, args: [...(audioBinary.args ?? []), ...(audioBinary.args?.length ? ['--'] : []), 'convert'], cwd: audioBinary.cwd }
			: undefined,
		// Follows the OS Music known folder (it can live outside the profile).
		wavDefaultOutputDir: join(app.getPath('music'), 'WAV'),
		// In-process core shares main's root logger — records land in the
		// session JSONL file (userData/logs). The core-sidecar copy injects
		// its own port-forwarding logger instead (core-sidecar/entry.ts).
		logger: mainLog,
		// Backup engine runs in its own utility process (VACUUM INTO, hashing
		// 190 GB, zstd, uploads — none of it on main's loop). The Drive refresh
		// token stays in main (safeStorage); the worker only ever asks for
		// short-lived access tokens over a host-call.
		backup: {
			userDataDir: app.getPath('userData'),
			peaksDir,
			coversDir,
			appVersion: app.getVersion(),
			// The worker can always ask main for a Drive token; main answers
			// "not connected" until the user connects — so connecting mid-
			// session needs no worker restart.
			host: (cfg) => new UtilityBackupHost(join(__dirname, 'backup-worker.cjs'), cfg, true),
			beforeRun: () => writeHostArtifacts(mainWindow, core!),
			google: { status: getGoogleAuthStatus, needsReconnect: googleNeedsReconnect, accessToken: getGoogleAccessToken },
		},
		// shell.trashItem is main-only; injecting here keeps CoreService
		// usable from the headless build (tests/CLI) where the Electron
		// surface isn't bound. Paths are stored normalized to forward
		// slashes (apps/core/src/local/scanner.ts:normalizePath), but
		// shell.trashItem on Windows routes through SHCreateItemFromParsingName
		// which has inconsistent forward-slash handling — convert to
		// native separators here so the trash call works on every OS.
		trashFile: (filePath) => shell.trashItem(normalizePath(filePath)),
		// Enables remote streaming writes (Spotify/Tidal playlist CRUD, unfollow).
		// They run ONLY here, in the real desktop app, where the renderer has
		// already taken the user's confirmation before invoking the write IPC.
		// Off-product builds (tests/CLI, the read-only core sidecar) construct
		// CoreService WITHOUT this and are default-deny — a stray script can't
		// mutate the live account. See CLAUDE.md "Streaming remote writes".
		remoteWritePolicy: { allow: () => true },
		// Append-only forensics trail: every streaming remote-write attempt and
		// every rekordbox write batch, one JSON line each. The 2026-07 playlist
		// order investigation took hours of backup archaeology precisely because
		// no such record existed. Fire-and-forget appendFile + swallowed errors:
		// auditing must never slow or break a write.
		writeAudit: (entry) => {
			const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
			appendFile(join(app.getPath('userData'), 'write-audit.jsonl'), line, () => {});
		},
	});

	// Same-machine restore: put the Spotify/Tidal sessions back from the
	// safeStorage sidecar (undecryptable elsewhere ⇒ the user reconnects).
	if (restoreApplied?.tokens) {
		const r = await importRestoredTokens(restoreApplied.tokens, core);
		bootLog.info('restored token sidecar', { result: r });
	}

	// Arm the agent sidecar with the persisted BYOK config (safeStorage key →
	// configure RPC). No config / undecryptable key ⇒ the agent stays
	// 'unconfigured' and the panel shows the setup card.
	if (agentSpec) {
		const agentConfig = loadAgentConfig();
		if (agentConfig) {
			core.configureAgent(agentConfig).then(
				() => bootLog.info('agent configured', { provider: agentConfig.provider, researchModel: agentConfig.researchModel }),
				(err: unknown) => bootLog.error('agent configure failed', err instanceof Error ? err : undefined),
			);
		} else {
			bootLog.info('agent unconfigured (no stored BYOK config)');
		}
	}

	// MCP bridge: lets an external Claude (Claude Desktop via the apps/mcp
	// stdio shim) drive the agent tool registry + the confirm-gated write
	// tools against this live core. The host writes userData/mcp-bridge.json
	// (port + token) for the shim to discover; streaming-account writes block
	// on the in-app confirm modal (McpConfirmBroker) before executing.
	// CURATOR_DISABLE_MCP=1 disables it — disabled is a supported state.
	if (process.env['CURATOR_DISABLE_MCP'] !== '1') {
		const coreForMcp = core;
		mcpHost = new McpBridgeHost({
			core: coreForMcp,
			userDataDir: app.getPath('userData'),
			appVersion: app.getVersion(),
			writeTools: buildMcpWriteTools({
				svc: () => coreForMcp,
				confirm: (req) => mcpConfirm.confirm(req),
				notify: (msg) => mcpConfirm.notify(msg),
			}),
		});
		mcpHost.start();
	}

	// Optionally boot the core sidecar — a second copy of @curator/core
	// running in a Node utility process. When CORE_SIDECAR=1, migrated IPC
	// channels route through this sidecar instead of the in-process `core`,
	// so their sync DB calls never block main's event loop. During the
	// channel-by-channel migration both paths coexist; once everything is
	// migrated the in-process `core` goes away. See plans/core-sidecar-
	// architecture.md.
	//
	// Still opt-in, deliberately: the sidecar's core gets no analyzer/
	// rekordbox specs yet, and in sidecar mode the SCANNER runs there — so
	// flipping the default today would silently break scanner-driven
	// auto-analysis (onIngest → AnalysisQueue.enqueue only exists where the
	// analyzer spec lives). Default-on is gated on migrating those specs
	// (+ their event plumbing) into entry.ts.
	if (process.env['CORE_SIDECAR'] === '1') {
		const scriptPath = join(__dirname, 'core-sidecar.cjs');
		coreSidecar = new CoreSidecarHost({
			scriptPath,
			env: { CURATOR_DB_PATH: dbPath },
		});
		// Reverse-RPC: the sidecar's scanner calls `parseAudio(path)`, which
		// is wired to fire a `parse.audio` host-call back to main. Main
		// dispatches into the existing IngestPool. Same pool, two clients.
		coreSidecar.onHostCall('parse.audio', async (args) => {
			const [path] = args as [string];
			return ingestPool!.parse(path);
		});
		coreSidecar.start();
		try {
			await coreSidecar.ready();
			bootLog.info('core sidecar ready');
		} catch (err) {
			bootLog.error('core sidecar failed to start, falling back to in-process core', err);
			// Shut the host down BEFORE dropping the reference. Without this
			// the host's respawn loop keeps running and resurrects the sidecar
			// a few seconds later — a zombie no handler routes to, whose own
			// scanner + DB connection fight the in-process core we just fell
			// back to. One CoreService owns the session; pick it and stick.
			await coreSidecar.shutdown().catch(() => { /* already dead */ });
			coreSidecar = null;
		}
	}

	// Cover protocol handler. Bind here (not at module load) so we can
	// reference `core` for the trackId→URL lookup.
	protocol.handle('curator-cover', (request) => handleCoverRequest(request, core!));
	protocol.handle('curator-local', (request) => handleLocalAudioRequest(request, core!));
	protocol.handle('curator-peaks', (request) => handlePeaksRequest(request, core!));

	registerIpc(core);
	createWindow();

	// Auto-update — packaged builds only, and only functional once the
	// publish block in electron-builder.yml points at a real release feed
	// (until then checkForUpdatesAndNotify fails its feed lookup and we
	// swallow it). Lazy import keeps electron-updater entirely out of the
	// dev startup path. NOTE: an applied update replaces the exe — the EVS
	// VMP signature must be applied to every published artifact or Widevine
	// stops provisioning after the first update (see package:signed).
	if (app.isPackaged) {
		import('electron-updater')
			.then(({ autoUpdater }) => {
				autoUpdater.checkForUpdatesAndNotify().catch((err) => {
					mainLog.for('updater').warn('check failed (no feed configured yet?)', undefined, err?.message ?? err);
				});
			})
			.catch((err) => mainLog.for('updater').warn('unavailable', undefined, err));
	}

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});

	// After the laptop wakes from sleep, Chromium's parked sockets fail any
	// in-flight requests with ERR_NETWORK_IO_SUSPENDED until it reconnects —
	// in dev that strands the Vite-loaded renderer with broken HMR / missing
	// modules. Reload the renderer on resume to recover. Scoped to dev
	// (ELECTRON_RENDERER_URL set) so a packaged build doesn't wipe renderer
	// state (in-progress playback, scroll position, etc.) on every wake. The
	// 800ms wait lets Chromium's network stack reconnect before the reload —
	// reloading the instant resume fires often re-triggers the same error.
	if (process.env.ELECTRON_RENDERER_URL) {
		powerMonitor.on('resume', () => {
			setTimeout(() => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainLog.for('power').info('resume — reloading renderer to clear suspended sockets');
					mainWindow.webContents.reloadIgnoringCache();
				}
			}, 800);
		});
	}
});

// Graceful shutdown, bounded. The previous shape fired the sidecar
// shutdowns and quit immediately — racing app teardown against in-flight
// graceful-exit RPCs. Awaiting them unbounded has the opposite failure: one
// hung sidecar freezes quit until the user force-kills mid-write. So: wait
// for all shutdowns, but never longer than SHUTDOWN_TIMEOUT_MS; stragglers
// get reaped by OS child-process cleanup when the app exits.
const SHUTDOWN_TIMEOUT_MS = 5000;

// Single teardown path for EVERY way the app goes down. Idempotent — the
// first caller runs it, later callers get the same in-flight promise.
//
// This used to live inline in window-all-closed, which only fires when the
// last BrowserWindow closes. It does NOT fire when the dev runner kills us
// (SIGINT/SIGTERM) or when app.quit() comes from a menu/updater — and that
// gap is exactly what orphaned the core sidecar (a node process holding
// better_sqlite3.node) and made the next `rebuild:node` fail with EPERM.
let shutdownPromise: Promise<void> | null = null;
function gracefulShutdown(): Promise<void> {
	if (shutdownPromise) return shutdownPromise;
	core?.close();
	const shutdowns = Promise.allSettled([
		ingestPool?.shutdown(),
		coreSidecar?.shutdown(),
		audioSidecar?.shutdown(),
		spotifySidecar?.shutdown(),
		mcpHost?.shutdown(),
		cloudAccount?.close(),
	]).then((results) => {
		for (const r of results) {
			if (r.status === 'rejected') shutdownLog.error('sidecar shutdown failed', r.reason);
		}
	});
	const deadline = new Promise<void>((resolve) => {
		const t = setTimeout(() => {
			shutdownLog.warn('timed out — quitting with stragglers', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
			resolve();
		}, SHUTDOWN_TIMEOUT_MS);
		void shutdowns.then(() => clearTimeout(t));
	});
	// Drain the log file last so the shutdown records themselves land.
	shutdownPromise = Promise.race([shutdowns, deadline]).then(() => mainLog.flush());
	return shutdownPromise;
}

app.on('window-all-closed', () => {
	if (process.platform === 'darwin') return;
	app.quit(); // teardown runs in before-quit below
});

// before-quit owns teardown for every app.quit() route (window-all-closed,
// app menu, autoUpdater, …). preventDefault, run teardown, then re-quit —
// the `teardownDone` latch lets the second quit through cleanly.
let teardownDone = false;
app.on('before-quit', (e) => {
	if (teardownDone) return;
	e.preventDefault();
	void gracefulShutdown().then(() => {
		teardownDone = true;
		app.quit();
	});
});

// Dev hard-stop: when the dev runner stops us it sends SIGINT/SIGTERM (and
// SIGBREAK on a Windows console). app.quit()'s before-quit dance isn't
// reliable mid-signal, so run teardown directly and exit. Idempotent with
// before-quit via the shared promise. (A TerminateProcess with no signal —
// e.g. the VS Code stop button — still can't run JS here; the child
// sidecars' stdin-EOF self-exit is the backstop for that case.)
let signalHandled = false;
function onShutdownSignal(sig: NodeJS.Signals): void {
	if (signalHandled) return;
	signalHandled = true;
	shutdownLog.info(`received ${sig} — tearing down sidecars`);
	void gracefulShutdown().then(() => process.exit(0));
}
process.on('SIGINT', () => onShutdownSignal('SIGINT'));
process.on('SIGTERM', () => onShutdownSignal('SIGTERM'));
process.on('SIGBREAK', () => onShutdownSignal('SIGBREAK'));

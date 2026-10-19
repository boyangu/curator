// Client for the audio sidecar binary's `convert` mode (apps/audio/src/
// convert.rs). One process per track: the playback sidecar serves RPCs
// serially on its main thread, so a minute-long WAV write there would stall
// transport. A short-lived process also gives cancellation for free (kill).
//
// Protocol: one job JSON line on stdin; JSON lines on stdout —
// started → progress* → done | error — then exit 0 / 1.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface WavConverterSpec {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface WavJobTags {
	title?: string | null;
	artist?: string | null;
	album?: string | null;
	genre?: string | null;
	label?: string | null;
	bpm?: number | null;
	key?: string | null;
	year?: string | null;
	comment?: string | null;
	trackNo?: number | null;
}

export interface WavJob {
	input: string;
	output: string;
	maxSampleRate: number;
	tags: WavJobTags;
	cover: boolean;
}

export interface WavJobDone {
	sampleRate: number;
	bitDepth: number;
	channels: number;
	frames: number;
	bytes: number;
	resampled: boolean;
	sourceSampleRate: number;
	sourceBitDepth: number;
}

export class WavJobError extends Error {
	constructor(message: string, readonly cancelled = false) {
		super(message);
		this.name = 'WavJobError';
	}
}

export function runWavJob(
	spec: WavConverterSpec,
	job: WavJob,
	opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<WavJobDone> {
	return new Promise<WavJobDone>((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(new WavJobError('cancelled', true));
			return;
		}
		const child = spawn(spec.command, spec.args ?? [], {
			cwd: spec.cwd,
			env: spec.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		let settled = false;
		let done: WavJobDone | null = null;
		let errorMessage: string | null = null;
		let stderrTail = '';
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			opts.signal?.removeEventListener('abort', onAbort);
			fn();
		};
		const onAbort = (): void => {
			try { child.kill(); } catch { /* already gone */ }
			finish(() => reject(new WavJobError('cancelled', true)));
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			// Keep only the tail — tracing logs can be chatty and we only need
			// the last words of a crash for the failure toast.
			stderrTail = (stderrTail + chunk).slice(-2000);
		});
		const rl = createInterface({ input: child.stdout });
		rl.on('line', (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let msg: Record<string, unknown>;
			try { msg = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
			if (msg.kind === 'progress') {
				const total = Number(msg.totalFrames);
				const frames = Number(msg.frames);
				if (total > 0 && Number.isFinite(frames)) opts.onProgress?.(Math.min(1, frames / total));
			} else if (msg.kind === 'done') {
				done = {
					sampleRate: Number(msg.sampleRate),
					bitDepth: Number(msg.bitDepth),
					channels: Number(msg.channels),
					frames: Number(msg.frames),
					bytes: Number(msg.bytes),
					resampled: msg.resampled === true,
					sourceSampleRate: Number(msg.sourceSampleRate),
					sourceBitDepth: Number(msg.sourceBitDepth),
				};
			} else if (msg.kind === 'error') {
				errorMessage = typeof msg.message === 'string' ? msg.message : 'conversion failed';
			}
		});
		child.on('error', (err) => {
			finish(() => reject(new WavJobError(`converter failed to start: ${err.message}`)));
		});
		child.on('close', (code) => {
			finish(() => {
				if (code === 0 && done) resolve(done);
				else reject(new WavJobError(errorMessage ?? (stderrTail.trim().split('\n').pop() || `converter exited with code ${code}`)));
			});
		});
		child.stdin.on('error', () => { /* child died early — 'close' reports it */ });
		child.stdin.end(JSON.stringify(job) + '\n');
	});
}

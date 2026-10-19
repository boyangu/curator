// Loopback system-audio FFT source — the live signal behind the streaming
// seek bar's spectrum line.
//
// Why loopback and not a tap on the media element: Spotify plays through the
// Web Playback SDK's EME/Widevine <audio> element, and Chromium deliberately
// yields *silence* from `createMediaElementSource` on protected media — a DRM
// boundary, the same wall that makes the Widevine signing step necessary. But
// the decoded audio still reaches the OS output mixer, and Electron can tap
// that mixer via getDisplayMedia({ audio: 'loopback' }) — granted picker-free
// by the main process's setDisplayMediaRequestHandler. So we FFT what's
// actually coming out of the speakers.
//
// Caveat the caller must honour: loopback is the *whole* system output, not
// just Spotify. Only read the analyser while a Spotify track is playing, or
// the line dances to notification dings and every other app's sound.
//
// Lifetime: acquired lazily on the first Spotify play (inside the user
// gesture — getDisplayMedia needs transient activation) and kept alive for the
// session. Re-acquiring per track would re-arm the capture each time; instead
// the consumer simply stops reading when nothing streams.

import { log } from './data/log.js';

const slog = log.for('spectrum');

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let starting: Promise<AnalyserNode | null> | null = null;

// Synchronous peek for the rAF draw loop — null until the loopback grant lands.
export function currentAnalyser(): AnalyserNode | null {
	return analyser;
}

// Shared loopback auto-gain. The loopback signal is the post-OS-volume speaker
// output, so its absolute level scales with the Windows master slider — which is
// ~logarithmic, so a 30–40% slider already means ~-20 dB ≈ 1/10 of full scale.
// Local playback's meters, by contrast, read the Rust mix-bus floats *before*
// the OS slider, so they're volume-independent and always lively. To make the
// streaming visuals read like the local ones — responsive no matter where the
// volume knob sits — every reading is normalized against a slow-decaying
// envelope of its own recent peak, targeting the same ~0.9 ceiling local
// transients reach. AGC_FLOOR keeps near-silence (noise) from being amplified to
// full; the slow release (AGC_DECAY) means the gain rides the music, not the
// per-frame jitter. Freq- and time-domain peaks live on different scales, so
// each visual keeps its own envelope.
const AGC_TARGET = 0.9, AGC_FLOOR = 0.03, AGC_DECAY = 0.9975;
function gainFor(env: { v: number }, rawPeak: number): number {
	env.v = Math.max(rawPeak, env.v * AGC_DECAY);
	return AGC_TARGET / Math.max(env.v, AGC_FLOOR);
}
const bandEnv = { v: 0 };
const levelEnv = { v: 0 };

// Read the live loopback FFT into `n` bands, each normalized 0–1. Returns null
// until the analyser is granted (caller falls back to a static bar). Bands are
// LOG-spaced over the lower ~60% of bins — most musical energy sits below
// ~10kHz and the top bins are mostly hiss, and log spacing keeps bass/mid/
// treble balanced (linear bins would crowd the highs into one band). Each band
// takes the MAX bin it covers, not the mean: the upper log bands span 200+ bins
// that are nearly all near-silent, so averaging buried the real spectral peak
// and made the bars read ~1/10 of the music. The frame is then run through the
// shared auto-gain so it's volume-independent. Temporal smoothing already comes
// from the analyser's smoothingTimeConstant; callers add their own EMA.
let freqScratch = new Uint8Array(0);
export function readBands(n: number): number[] | null {
	const an = analyser;
	if (!an) return null;
	const bins = an.frequencyBinCount;
	if (freqScratch.length !== bins) freqScratch = new Uint8Array(bins);
	an.getByteFrequencyData(freqScratch);
	const minBin = 1; // skip DC
	const maxBin = Math.max(minBin + n, Math.floor(bins * 0.6));
	const logMin = Math.log(minBin), logSpan = Math.log(maxBin) - logMin;
	const out: number[] = new Array(n);
	let frameMax = 0;
	for (let b = 0; b < n; b++) {
		const lo = Math.floor(Math.exp(logMin + (logSpan * b) / n));
		const hi = Math.max(lo + 1, Math.floor(Math.exp(logMin + (logSpan * (b + 1)) / n)));
		let m = 0;
		for (let i = lo; i < hi && i < bins; i++) { const v = freqScratch[i]!; if (v > m) m = v; }
		const lvl = m / 255;
		out[b] = lvl;
		if (lvl > frameMax) frameMax = lvl;
	}
	const gain = gainFor(bandEnv, frameMax);
	for (let b = 0; b < n; b++) out[b] = Math.min(1, out[b]! * gain);
	return out;
}

// Peak output level (0–1) from the loopback time-domain data — for the VU meter
// during streaming playback (no Rust per-channel peaks there). Run through the
// shared auto-gain (loopbackLevelGain) so it's volume-independent and reads at
// the same scale as the seek-bar oscilloscope. Returns null until the grant lands.
//
// Mono only: the Windows system loopback is a mono mix — Chromium duplicates it
// across both channels even when it reports a 2-channel track (verified — a
// ChannelSplitter's L and R came back bit-identical), so there's no L/R to
// recover. The streaming VU shows the same level on both rows. (Local playback's
// VU is true stereo via the Rust sidecar's per-channel peaks — a different path,
// unaffected.)
let timeScratch = new Uint8Array(0);
export function readLevel(): number | null {
	const an = analyser;
	if (!an) return null;
	const n = an.fftSize;
	if (timeScratch.length !== n) timeScratch = new Uint8Array(n);
	an.getByteTimeDomainData(timeScratch);
	let peak = 0;
	for (let i = 0; i < n; i++) { const d = Math.abs(timeScratch[i]! - 128); if (d > peak) peak = d; }
	const raw = peak / 128;
	return Math.min(1, raw * loopbackLevelGain(raw));
}

// Makeup gain for a caller that already measured its own loopback time-domain
// peak (the seek-bar oscilloscope, which reads the waveform itself). Shares
// readLevel's envelope so the oscilloscope and the VU meter stay at one scale.
export function loopbackLevelGain(rawPeak: number): number {
	return gainFor(levelEnv, rawPeak);
}

// Idempotent. Safe to call repeatedly; returns the live analyser once granted,
// null if the platform/permission refused (the UI then just shows a plain bar).
// MUST be reached from within a user gesture the first time — getDisplayMedia
// consumes transient activation.
export async function acquireLoopbackAnalyser(): Promise<AnalyserNode | null> {
	if (analyser) return analyser;
	if (starting) return starting;
	starting = (async () => {
		try {
			// Audio-only loopback. Electron's request handler answers with the
			// system mixer; we never want the screen video.
			const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
			// Belt-and-suspenders: drop any video track a platform attached.
			for (const t of s.getVideoTracks()) t.stop();
			if (s.getAudioTracks().length === 0) {
				for (const t of s.getTracks()) t.stop();
				throw new Error('loopback stream carried no audio track');
			}
			const audioCtx = new AudioContext();
			const src = audioCtx.createMediaStreamSource(s);
			const an = audioCtx.createAnalyser();
			an.fftSize = 1024;            // 512 bins, ~43 Hz resolution @ 44.1k
			an.smoothingTimeConstant = 0.6; // was .72 — snappier; the auto-gain restores the body
			an.minDecibels = -90;          // tighten the byte-mapping window onto the loopback's
			an.maxDecibels = -25;          // real span (defaults -100/-30 burn range on the noise floor)
			// Tap only — do NOT connect `an` onward to ctx.destination, or we'd
			// re-emit captured system audio into the output and feed back.
			src.connect(an);
			// The OS can end the capture under us (device removed, session
			// change). An ended track feeds the analyser silence forever, so
			// treat it like a device change: drop it and re-arm.
			for (const t of s.getAudioTracks()) t.addEventListener('ended', () => rearm('capture track ended'));
			ctx = audioCtx;
			stream = s;
			analyser = an;
			return an;
		} catch (err) {
			slog.error('loopback capture unavailable', err);
			return null;
		} finally {
			starting = null;
		}
	})();
	return starting;
}

// ── Following the output device ─────────────────────────────────────────────
// Windows loopback capture is bound to the DEFAULT OUTPUT DEVICE AT ACQUISITION
// TIME. When the default changes — plugging/unplugging the DDJ-FLX10 flips it
// between the controller and the laptop speakers — the audio engine rebuilds
// onto the new device and keeps playing, but this capture keeps listening to
// the old device: pure silence, and every loopback visual (now-playing eq,
// seek-bar spectrum, streaming VU) froze flat until restart. So on any device
// change (or a capture that ends) we drop the capture and take a fresh one.
// getDisplayMedia may insist on transient user activation, so if the immediate
// re-acquire is refused we retry on the user's next click/key.
let rearmOnGesture = false;
let watching = false;

function rearm(reason: string): void {
	if (!analyser && !starting) return; // never acquired — nothing to follow
	slog.info('re-arming loopback capture', { reason });
	releaseLoopbackAnalyser();
	void acquireLoopbackAnalyser().then((an) => { if (!an) armOnNextGesture(); });
}

function armOnNextGesture(): void {
	if (rearmOnGesture) return;
	rearmOnGesture = true;
	const onGesture = (): void => {
		rearmOnGesture = false;
		document.removeEventListener('pointerdown', onGesture, true);
		document.removeEventListener('keydown', onGesture, true);
		void acquireLoopbackAnalyser();
	};
	document.addEventListener('pointerdown', onGesture, true);
	document.addEventListener('keydown', onGesture, true);
}

// Wire once at boot.
export function followOutputDeviceChanges(): void {
	if (watching || !navigator.mediaDevices?.addEventListener) return;
	watching = true;
	navigator.mediaDevices.addEventListener('devicechange', () => rearm('output devices changed'));
}

// Tear down the capture (stops the OS "sharing audio" state). Not called on
// pause — only when the capture has to follow a new output device.
export function releaseLoopbackAnalyser(): void {
	stream?.getTracks().forEach((t) => t.stop());
	ctx?.close().catch(() => {});
	ctx = null;
	stream = null;
	analyser = null;
}

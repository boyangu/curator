// Runs engine-probe's latency test on the attached phone (adb), in several
// set-ups, and prints one line per set-up. Nothing is installed: the program
// and two generated test tracks go to /data/local/tmp and are removed after.
// The phone plays quiet noise while it runs.
//
//   node scripts/run-phone.mjs [--audio c:/tmp/curator-audio-spike] [--trials 30] [--play 15] [--volume 0.02]
//
// The test tracks (six minutes of pink noise and a tone, FLAC, at 44.1 and
// 48 kHz) are made once with ffmpeg into --audio. Results: <audio>/results.json.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const audio = resolve(arg('audio', 'c:/tmp/curator-audio-spike'));
const trials = arg('trials', '30');
const play = arg('play', '15');
const volume = arg('volume', '0.02');

mkdirSync(audio, { recursive: true });
for (const rate of [44100, 48000]) {
	const file = join(audio, `noise-${rate}.flac`);
	if (existsSync(file)) continue;
	execFileSync('ffmpeg', ['-loglevel', 'error', '-y',
		'-f', 'lavfi', '-i', `anoisesrc=color=pink:sample_rate=${rate}:duration=360:amplitude=0.4`,
		'-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=360`,
		'-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.5,aformat=channel_layouts=stereo',
		'-c:a', 'flac', '-sample_fmt', 's16', file], { stdio: 'inherit' });
}

const adbPath = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const adb = (...a) => execFileSync(adbPath, a, { encoding: 'utf8', maxBuffer: 1 << 26 });
const sh = (cmd) => adb('shell', cmd).trim();
const t = '/data/local/tmp/curator-audio-spike';
sh(`rm -rf ${t} && mkdir -p ${t}`);
adb('push', join(root, 'target', 'aarch64-linux-android', 'release', 'engine-probe'), `${t}/engine-probe`);
for (const rate of [44100, 48000]) adb('push', join(audio, `noise-${rate}.flac`), `${t}/noise-${rate}.flac`);
sh(`chmod 755 ${t}/engine-probe`);

// CURATOR_AUDIO_BUFFER_MS is the engine's own knob (engine.rs): 0 leaves the
// buffer to the device (here: two bursts); unset is the desktop's 30 ms.
const setups = [
	{ name: '48 kHz track, smallest buffer', env: 'CURATOR_AUDIO_BUFFER_MS=0', file: 'noise-48000.flac' },
	{ name: '48 kHz track, the desktop\'s 30 ms buffer', env: '', file: 'noise-48000.flac' },
	{ name: '44.1 kHz track, engine converts, smallest buffer', env: 'CURATOR_AUDIO_BUFFER_MS=0', file: 'noise-44100.flac' },
	{ name: '44.1 kHz track, stream opened at 44.1 kHz (system converts)', env: 'CURATOR_AUDIO_BUFFER_MS=0 CPAL_STANDIN_RATES=any', file: 'noise-44100.flac' },
	{ name: '48 kHz track, device to ourselves (exclusive), smallest buffer', env: 'CURATOR_AUDIO_BUFFER_MS=0 CPAL_STANDIN_EXCLUSIVE=1', file: 'noise-48000.flac' },
];
const device = { model: sh('getprop ro.product.model'), soc: sh('getprop ro.soc.model'), android: sh('getprop ro.build.version.release') };
const results = [];
for (const s of setups) {
	let out;
	try {
		out = sh(`cd ${t} && ${s.env} ./engine-probe latency ${t}/${s.file} --trials ${trials} --play ${play} --volume ${volume} 2>${t}/err.log; echo; echo "exit=$?"; tail -3 ${t}/err.log`);
	} catch (err) {
		out = String(err.stdout ?? err.message);
	}
	const at = out.indexOf('{');
	const end = out.lastIndexOf('}');
	let r = null;
	try { r = JSON.parse(out.slice(at, end + 1)); } catch { /* the run failed: its output is kept below */ }
	results.push({ setup: s.name, result: r, output: r ? undefined : out.slice(-600) });
	if (!r) { console.log(`${s.name}: FAILED\n${out.slice(-400)}`); continue; }
	const st = r.stream;
	console.log(`${s.name}\n  stream ${st.sampleRate} Hz, burst ${st.framesPerBurst} frames (${st.burstMs} ms), buffer ${st.bufferFrames} frames (${st.bufferMs} ms), ${st.performanceMode}, ${st.sharingMode}${st.engineResamples ? ', engine converts the rate' : ''}`
		+ `\n  play -> callback  median ${r.play.callToCallbackMs.median} ms, p95 ${r.play.callToCallbackMs.p95}, max ${r.play.callToCallbackMs.max}`
		+ `\n  play -> output    median ${r.play.callToOutputMs.median} ms, p95 ${r.play.callToOutputMs.p95}, max ${r.play.callToOutputMs.max} (${r.play.callToOutputMs.n} of ${r.play.trials} trials, ${r.play.missed} missed)`
		+ `\n  ${r.steady.seconds} s of playback: ${r.steady.glitches} glitches, callback mean ${r.steady.callbackMeanUs} us, max ${r.steady.callbackMaxUs} us, up to ${r.steady.framesPerCallbackMax} frames a callback`
		+ `\n  load: load() returned after ${r.load.loadReturnedMs} ms, whole track decoded in ${r.load.fullyDecodedMs} ms (${r.load.decodeSpeedTimesRealtime}x), ${r.load.memoryForTrackMb} MB for the track`);
}
writeFileSync(join(audio, 'results.json'), JSON.stringify({ device, at: new Date().toISOString(), results }, null, 1));
sh(`rm -rf ${t}`);
console.log(join(audio, 'results.json'));

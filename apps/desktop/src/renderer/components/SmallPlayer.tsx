// SmallPlayer — the entire 56px small-mode player strip.
//
// Two layouts, decided by the variant prop (shell.effectiveVariant — the
// PLAYING track's backend; the shell owns that split so this strip, the dock
// edge, and the big-mode gate can never disagree):
//
//   local      [sec1][sec2][mini wavemap 256px][compact main waveform — fills]
//   streaming  [sec1+rating] … centered( prev/play/next over pos·seek 312px·len ) … [sec2 right]
//
// Section 1 (196px — cover + title/artist/album) is always leftmost.
// Section 2 (188px — bpm·key / genre / label) sits beside it in local
// mode and docks to the RIGHT edge in streaming mode (the transport
// block centers on the strip, Spotify-style). The rating stars live in
// sec2's top row in local mode and next to the track title in streaming.
//
// The local strip has no play/pause or beat-jump buttons — Space and the
// global Arrow-key jumps cover both — so the whole right side is the
// deck's own scrolling waveform (MainWaveformView in `compact`) carrying
// the time readout in its overlay; the mini wavemap beside sec2 is the
// whole-track locator.
//
// Mounted by PlayerFooter as the small-mode branch of its mode <Show>; the
// big-mode tree (NowPlayingCard + deck) is a separate subtree, so nothing
// here needs to coexist with the workstation layout.

import { Show, Index, createMemo, createSignal, createEffect, onCleanup, onMount, untrack } from 'solid-js';
import { ArtistCredits } from './ArtistCredits.jsx';
import { formatTrackTitle } from '@curator/shared';
import { artistCreditFormat } from '../features/uiSettings.js';
import type { Accessor } from 'solid-js';
import type { Track, SegmentRecord } from '@curator/shared';
import type { PeaksTier, CueData } from '../stores/analysisStore.js';
import type { SkinId } from '../renderers/waveformStyles.js';
import { MainWaveformView, type LoopRegionView } from './MainWaveformView.jsx';
import { MiniWaveMapView } from './MiniWaveMapView.jsx';
import { coverImage } from './NowPlayingCard.jsx';
import { KeyChip } from './KeyChip.jsx';
import { formatBpm } from '../music-utils.js';
import * as player from '../player.js';
import { currentAnalyser, acquireLoopbackAnalyser, loopbackLevelGain } from '../spectrum.js';

export interface SmallPlayerProps {
	getTrack: (id: string) => Track | undefined;
	tracksCacheRev?: Accessor<number>;
	onSetRating?: ((trackId: string, rating: number) => void) | null;
	// Click on one artist name — see NowPlayingCardProps.onArtistClick.
	onArtistClick?: ((name: string) => void) | null;
	// Which layout to render (shell.effectiveVariant) — deck strip for local
	// playback, streaming transport for Spotify/Tidal.
	variant: Accessor<'local' | 'streaming'>;
	// Local-layout inputs — forwarded verbatim to MiniWaveMapView and
	// MainWaveformView (the strip mounts the same component as the big
	// deck, in compact geometry). Zoom + skin are the deck-wide shared
	// values; the strip has no picker of its own (`.big-only`, CSS-hidden).
	peaks: Accessor<PeaksTier | null>;
	beats: Accessor<Float32Array | null>;
	downbeats: Accessor<Float32Array | null>;
	cues: Accessor<CueData[]>;
	segments: Accessor<SegmentRecord[] | null>;
	duration: Accessor<number>;
	positionSec: Accessor<number>;
	isPlaying: Accessor<boolean>;
	initialZoomIdx?: number;
	onZoomChange?: (idx: number) => void;
	skin: Accessor<SkinId>;
	onSkinChange: (id: SkinId) => void;
	activeLoop: Accessor<LoopRegionView | null>;
	onSeek: (positionSec: number) => void;
	onScrubStart: (targetSec?: number) => void;
	onScrubMove: (positionSec: number) => void;
	onScrubEnd: (positionSec: number, resumePlaying: boolean) => void;
	// Registers / clears the waveform's instant-jump hook — see
	// MainWaveformViewProps.setSnapTo.
	setSnapTo: (fn: ((positionSec: number) => void) | null) => void;
}

function fmtTime(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = String(Math.floor(sec) % 60).padStart(2, '0');
	return `${m}:${s}`;
}

// Live oscilloscope line for the streaming seek bar. A canvas overlay inside
// .sp-seekbar that draws the time-domain waveform of the system loopback (see
// spectrum.ts) — the real audio leaving the speakers, which for a Spotify track
// IS the Spotify signal. Runs a rAF loop only while `active()`; idle otherwise
// (and when no loopback grant exists, it simply draws nothing).
//
// The samples swing +/- around the vertical center (128 = zero crossing), so
// the line is genuinely bipolar — a thin waveform wiggling around the midline.
// It's brightened up to the playhead via `progress()` so it doubles as the
// progress cue (there's no separate baseline). A faded-decay trail leaves a
// soft ghost behind the moving line.
function SpectrumLine(props: { active: Accessor<boolean>; progress: Accessor<number> }) {
	let canvas: HTMLCanvasElement | undefined;
	let raf = 0;
	// Resolved once from CSS custom props so the canvas matches the theme.
	let accent = 'rgba(120,170,255,1)';
	let dim = 'rgba(160,170,190,0.35)';

	const POINTS = 160;          // polyline points sampled across the width
	const GAIN = 1.1;            // gentle extra swing on top of the shared auto-gain
	const wave = new Uint8Array(1024); // an.fftSize time-domain samples

	// Peak-driven glow — the line's opacity tracks the frame's peak amplitude
	// so it goes fully opaque on transients and dims between them. GLOW_FLOOR is
	// the resting opacity (kept high so the line is always clearly visible);
	// GLOW_EXP shapes the rise. A fast-attack / slow-release envelope avoids
	// per-frame strobe. The peak is taken post-auto-gain so it lights at any
	// system volume (loopback is post-OS-volume — see spectrum.ts).
	const GLOW_FLOOR = 0.5;
	const GLOW_EXP = 1.8;
	let glow = 0;                // smoothed 0..1 envelope of peak amplitude

	const resize = () => {
		if (!canvas) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = canvas.clientWidth, h = canvas.clientHeight;
		canvas.width = Math.max(1, Math.round(w * dpr));
		canvas.height = Math.max(1, Math.round(h * dpr));
		const c = canvas.getContext('2d');
		if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0);
	};

	const draw = () => {
		const c = canvas?.getContext('2d');
		if (!canvas || !c) { raf = requestAnimationFrame(draw); return; }
		const w = canvas.clientWidth, h = canvas.clientHeight;
		// Faded decay — erase a fraction of the previous frame toward
		// transparent each tick (destination-out keeps the canvas background
		// clear instead of darkening it), leaving a soft trailing ghost behind
		// the moving line.
		c.globalAlpha = 1;
		c.globalCompositeOperation = 'destination-out';
		c.fillStyle = 'rgba(0,0,0,0.12)';
		c.fillRect(0, 0, w, h);
		c.globalCompositeOperation = 'source-over';
		const an = currentAnalyser();
		if (an && props.active()) {
			an.getByteTimeDomainData(wave);
			const len = an.fftSize;            // 1024 time samples
			const playX = Math.max(0, Math.min(1, props.progress())) * w;
			const mid = h / 2;
			// Build the waveform polyline, sampled linearly across the width.
			// Each byte is 0..255 centered at 128; (v-128)/128 → -1..1, drawn as
			// an offset from the vertical center so the line is bipolar. Track the
			// frame's peak (pre-gain, pre-clamp) to drive the glow envelope.
			// Frame peak over the full waveform → one shared auto-gain for the line
			// AND the glow (loopback is post-OS-volume; normalize so both read the
			// music, not the slider). Called once so the envelope ticks once/frame.
			let framePeak = 0;
			for (let i = 0; i < len; i++) { const d = Math.abs((wave[i] ?? 128) - 128); if (d > framePeak) framePeak = d; }
			framePeak /= 128;
			const agc = loopbackLevelGain(framePeak);
			const pts: Array<[number, number]> = [];
			for (let i = 0; i < POINTS; i++) {
				const f = i / (POINTS - 1);
				const idx = Math.min(len - 1, Math.floor(f * (len - 1)));
				const raw = ((wave[idx] ?? 128) - 128) / 128; // -1..1
				let v = raw * GAIN * agc;
				if (v > 1) v = 1; else if (v < -1) v = -1;
				const x = f * w;
				const y = mid - v * (mid - 0.75);
				pts.push([x, y]);
			}
			// Glow envelope: snap up toward the (auto-gained) peak, ease back down
			// between them, then map to opacity exponentially with a floor (still
			// noticeable when quiet, fully opaque on transients).
			const target = Math.pow(Math.min(1, framePeak * agc), GLOW_EXP);
			glow += (target - glow) * (target > glow ? 0.6 : 0.12);
			c.globalAlpha = GLOW_FLOOR + (1 - GLOW_FLOOR) * glow;
			// The waveform line, stroked twice through a horizontal clip: accent
			// behind the playhead, dim ahead of it (so the line doubles as the
			// progress cue now that there's no separate baseline).
			c.lineWidth = 2;
			c.lineJoin = 'round';
			const strokeClipped = (x0: number, x1: number, color: string) => {
				c.save();
				c.beginPath();
				c.rect(x0, 0, Math.max(0, x1 - x0), h);
				c.clip();
				c.beginPath();
				for (let i = 0; i < pts.length; i++) {
					const p = pts[i]!;
					if (i === 0) c.moveTo(p[0], p[1]);
					else c.lineTo(p[0], p[1]);
				}
				c.strokeStyle = color;
				c.stroke();
				c.restore();
			};
			strokeClipped(0, playX, accent);
			strokeClipped(playX, w, dim);
			c.globalAlpha = 1;
		}
		raf = requestAnimationFrame(draw);
	};

	onMount(() => {
		const root = getComputedStyle(document.documentElement);
		accent = root.getPropertyValue('--accent').trim() || accent;
		const fg3 = root.getPropertyValue('--fg-3').trim();
		if (fg3) dim = fg3;
		resize();
		window.addEventListener('resize', resize);
	});

	// Drive the loop only while streaming audio plays — saves the canvas churn
	// (and the per-frame getByteFrequencyData) when the strip is idle/local.
	createEffect(() => {
		if (props.active()) {
			// A late-mounted strip may have missed the play-gesture grant; try
			// once more (no-op if already granted, or if outside a gesture).
			void acquireLoopbackAnalyser();
			if (!raf) raf = requestAnimationFrame(draw);
		} else if (raf) {
			cancelAnimationFrame(raf);
			raf = 0;
			const c = canvas?.getContext('2d');
			if (canvas && c) c.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
		}
	});

	onCleanup(() => {
		if (raf) cancelAnimationFrame(raf);
		window.removeEventListener('resize', resize);
	});

	return <canvas ref={canvas} class="sp-spectrum" />;
}

export function SmallPlayer(props: SmallPlayerProps) {
	const state = player.getState();

	const variant = props.variant;

	const display = createMemo(() => {
		props.tracksCacheRev?.();
		const cur = state.current;
		if (!cur) return null;
		// Prefer the live cache row (reflects in-list rating/re-analysis edits);
		// fall back to the player's own snapshot when the row has left the
		// visible cache (track removed from the current playlist / navigated
		// away) so BPM/key/rating don't blank out under the playing audio.
		const t = props.getTrack(cur.trackId) ?? player.currentTrack() ?? undefined;
		const coverUrl = coverImage(cur);
		const rating = t?.rating != null ? Math.max(0, Math.min(5, Math.round(t.rating))) : null;
		const artists = t?.artists ?? cur.artists ?? [];
		return {
			title: formatTrackTitle(cur.title, artists, artistCreditFormat().remixStyle),
			artist: cur.artist,
			artists,
			album: t?.albumTitle ?? '',
			bpm: formatBpm(t?.bpm),
			keyCamelot: t?.keyCamelot ?? null,
			genre: t?.genre ?? '',
			label: t?.label ?? '',
			coverUrl,
			rating,
		};
	});

	const togglePause = () => { player.togglePause().catch(() => {}); };

	// ── Streaming seek bar ──────────────────────────────────────────────
	// Spotify-style: drag updates the visual fill only; the actual seek
	// commits on pointerup (streaming seeks are a network roundtrip — no
	// point spamming them per-move).
	const [dragRatio, setDragRatio] = createSignal<number | null>(null);
	let barRef: HTMLDivElement | undefined;
	let barPointerId: number | null = null;

	const ratioFromX = (clientX: number): number => {
		if (!barRef) return 0;
		const rect = barRef.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	};
	const barDown = (evt: PointerEvent): void => {
		if (evt.button !== 0) return;
		const dur = untrack(() => props.duration());
		if (!dur) return;
		barPointerId = evt.pointerId;
		try { barRef?.setPointerCapture(evt.pointerId); } catch { /* unsupported */ }
		setDragRatio(ratioFromX(evt.clientX));
	};
	const barMove = (evt: PointerEvent): void => {
		if (barPointerId !== evt.pointerId) return;
		setDragRatio(ratioFromX(evt.clientX));
	};
	const barUp = (evt: PointerEvent): void => {
		if (barPointerId !== evt.pointerId) return;
		barPointerId = null;
		try { barRef?.releasePointerCapture(evt.pointerId); } catch { /* */ }
		const ratio = ratioFromX(evt.clientX);
		setDragRatio(null);
		const dur = untrack(() => props.duration());
		if (dur) props.onSeek(ratio * dur);
	};
	const barCancel = (evt: PointerEvent): void => {
		if (barPointerId !== evt.pointerId) return;
		barPointerId = null;
		try { barRef?.releasePointerCapture(evt.pointerId); } catch { /* */ }
		setDragRatio(null);
	};

	const shownPos = (): number => {
		const r = dragRatio();
		return r != null ? r * props.duration() : props.positionSec();
	};
	const fillPct = (): number => {
		const dur = props.duration();
		if (!dur) return 0;
		return Math.max(0, Math.min(100, (shownPos() / dur) * 100));
	};

	// Rating stars — placed next to the title in streaming mode, in sec2's
	// top row in local mode. Double-click writes the rating, same gesture
	// as the big player's NowPlayingCard.
	const RatingStars = () => (
		<Show when={props.onSetRating != null && display() != null}>
			<span
				class="sp-rating"
				title={display()?.rating != null ? `${display()!.rating}/5 — double-click a star to change` : 'Double-click a star to rate'}
				role="group"
				aria-label="Rating"
			>
				<Index each={[1, 2, 3, 4, 5]}>
					{(n) => (
						<button
							type="button"
							class="np-rating__star"
							classList={{ 'is-on': (display()?.rating ?? 0) >= n() }}
							aria-label={`Set rating to ${n()}`}
							onDblClick={() => {
								const cur = state.current;
								if (cur && props.onSetRating) props.onSetRating(cur.trackId, n());
							}}
						>★</button>
					)}
				</Index>
			</span>
		</Show>
	);

	return (
		<div class="sp" classList={{ 'sp--local': variant() === 'local', 'sp--streaming': variant() === 'streaming' }}>
			{/* Section 1 — cover + title / artist / album (196px). */}
			<div class="sp-sec1">
				<div
					class="sp-cover"
					classList={{ 'is-loading': state.loading }}
					style={display()
						? {
							'background-image': display()!.coverUrl,
							'background-size': 'cover, cover',
							'background-position': 'center, center',
						}
						: {}}
				>
					<Show when={state.loading}>
						<div class="np-cover-spinner" />
					</Show>
				</div>
				<div class="sp-meta">
					<div class="sp-title-row">
						<div class="sp-title">{display()?.title ?? 'No track playing'}</div>
						<Show when={variant() === 'streaming'}><RatingStars /></Show>
					</div>
					<div class="sp-artist">
						<Show when={display() && display()!.artists.length > 0} fallback={display()?.artist ?? 'Select a track to begin auditioning'}>
							<ArtistCredits artists={display()!.artists} onClick={props.onArtistClick ?? null} />
						</Show>
					</div>
					<div class="sp-album">{display()?.album ?? ''}</div>
				</div>
			</div>

			{/* Section 2 — bpm · key (+ rating in local mode) / genre / label
			    (188px). Sits beside sec1 in local mode; streaming mode docks
			    it to the right edge via CSS order/margin (the transport
			    block centers on the strip). */}
			<div class="sp-sec2">
				<div class="sp-tech">
					<span>{display()?.bpm ?? '—'}</span>
					<span class="sp-dot">·</span>
					<KeyChip keyCamelot={display()?.keyCamelot ?? null} />
					<Show when={variant() === 'local'}><RatingStars /></Show>
				</div>
				<div class="sp-genre">{display()?.genre ?? ''}</div>
				<div class="sp-label">{display()?.label ?? ''}</div>
			</div>

			{/* Right dock — layout per playing source. */}
			<div class="sp-right">
				<Show
					when={variant() === 'streaming'}
					fallback={
						<div class="sp-local">
							<div class="sp-minimap">
								<MiniWaveMapView
									peaks={props.peaks}
									cues={props.cues}
									duration={props.duration}
									positionSec={props.positionSec}
									isPlaying={props.isPlaying}
									onSeek={props.onSeek}
									onScrubStart={props.onScrubStart}
									onScrubMove={props.onScrubMove}
									onScrubEnd={props.onScrubEnd}
									skin={props.skin}
									activeLoop={props.activeLoop}
								/>
							</div>
							{/* The deck's scrolling waveform at strip height. Its own
							    .t-time-overlay carries the time readout; the zoom /
							    skin / bar-count overlays are .big-only and stay
							    CSS-hidden here. */}
							<MainWaveformView
								compact
								peaks={props.peaks}
								beats={props.beats}
								downbeats={props.downbeats}
								cues={props.cues}
								segments={props.segments}
								duration={props.duration}
								positionSec={props.positionSec}
								isPlaying={props.isPlaying}
								initialZoomIdx={props.initialZoomIdx}
								onZoomChange={props.onZoomChange}
								skin={props.skin}
								onSkinChange={props.onSkinChange}
								onSeek={props.onSeek}
								onScrubStart={props.onScrubStart}
								onScrubMove={props.onScrubMove}
								onScrubEnd={props.onScrubEnd}
								activeLoop={props.activeLoop}
								setSnapTo={props.setSnapTo}
							/>
						</div>
					}
				>
					<div class="sp-stream">
						<div class="sp-stream-btns">
							<button class="t-btn" title="Previous track" onClick={() => { player.prev().catch(() => {}); }}>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
									<path d="M6 4h2v16H6zM20 4l-10 8 10 8z" />
								</svg>
							</button>
							{/* Seek jumps — flank the play button, biggest leap outermost
								    so the row reads ‹24 ‹12 ‹4 ▸ 4› 12› 24›. */}
								<button class="t-btn sp-jump" title="Back 24s" onClick={() => { player.seekBy(-24).catch(() => {}); }}>‹24</button>
								<button class="t-btn sp-jump" title="Back 12s" onClick={() => { player.seekBy(-12).catch(() => {}); }}>‹12</button>
								<button class="t-btn sp-jump" title="Back 4s" onClick={() => { player.seekBy(-4).catch(() => {}); }}>‹4</button>
								<button class="t-btn play sp-stream-play" title="Play / Pause (Space)" onClick={togglePause}>
								{state.playing ? (
									<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
										<path d="M6 4h4v16H6zM14 4h4v16h-4z" />
									</svg>
								) : (
									<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
										<path d="M5 3v18l15-9z" />
									</svg>
								)}
							</button>
							<button class="t-btn sp-jump" title="Forward 4s" onClick={() => { player.seekBy(4).catch(() => {}); }}>4›</button>
								<button class="t-btn sp-jump" title="Forward 12s" onClick={() => { player.seekBy(12).catch(() => {}); }}>12›</button>
								<button class="t-btn sp-jump" title="Forward 24s" onClick={() => { player.seekBy(24).catch(() => {}); }}>24›</button>
								<button class="t-btn" title="Next track" onClick={() => { player.next().catch(() => {}); }}>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
									<path d="M16 4h2v16h-2zM4 4l10 8-10 8z" />
								</svg>
							</button>
						</div>
						<div class="sp-stream-seek">
							<span class="sp-time">{fmtTime(shownPos())}</span>
							<div
								ref={barRef}
								class="sp-seekbar"
								classList={{ 'is-dragging': dragRatio() != null }}
								onPointerDown={barDown}
								onPointerMove={barMove}
								onPointerUp={barUp}
								onPointerCancel={barCancel}
							>
								<SpectrumLine
									active={() => variant() === 'streaming' && state.playing}
									progress={() => fillPct() / 100}
								/>
							</div>
							<span class="sp-time">{fmtTime(props.duration())}</span>
						</div>
					</div>
				</Show>
			</div>
		</div>
	);
}

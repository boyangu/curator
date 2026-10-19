// Controller mapping — TypeScript source of truth for the bindings the
// Rust sidecar applies to incoming MIDI/HID. Per planning/tech/
// controllers-pioneer.md the renderer ships this table to the sidecar
// via the `controller_set_mapping` RPC at boot (and may push updates
// during dev to retune without restarting the sidecar).
//
// Rust mirror: apps/audio/src/controllers/mapping.rs. Both ends agree
// on the JSON shape; the Rust side deserialises Mapping → MappingRow.
//
// Protocol spec (note numbers, channel layout): planning/tech/
// controllers-pioneer-flx10-protocol.md. Values marked `TBD` are
// inferred from cross-checks against the Mixxx PR data dictionary and
// need verbatim verify against Pioneer's official PDF before shipping.

// ─── Trigger pattern ──────────────────────────────────────────────────────

export type Trigger =
	// Inbound Note On with non-zero velocity. Status includes channel
	// nibble (e.g. 0x90 = Note On channel 1).
	| { kind: 'note_on'; status: number; note: number }
	// Note Off OR Note On with velocity 0. Used for release semantics
	// (jog touch off, SHIFT release).
	| { kind: 'note_off'; status: number; note: number }
	// CC message. Downstream Action decides how to interpret the data
	// byte (delta, position, …).
	| { kind: 'control_change'; status: number; cc: number };

// ─── Action ───────────────────────────────────────────────────────────────

export type Action =
	// Audio-affecting — sidecar dispatches directly to engine state.
	| { kind: 'cue_trigger'; slot: number }
	| { kind: 'beat_jump'; delta: number }
	| { kind: 'loop_in' }
	| { kind: 'loop_out' }
	| { kind: 'loop_n_beats'; n: number }
	| { kind: 'loop_halve' }
	| { kind: 'loop_double' }
	| { kind: 'play_pause' }
	| { kind: 'scrub_motion' }
	| { kind: 'scrub_touch' }
	// Renderer-bound — sidecar emits ControllerEvent.
	| { kind: 'browse_rotate' }
	| { kind: 'browse_press' }
	| { kind: 'back' }
	| { kind: 'view' }
	| { kind: 'shift' };

export interface MappingRow {
	trigger: Trigger;
	action: Action;
	label?: string;
	// When set, this binding only fires while SHIFT is held.
	shift?: boolean;
}

export interface Mapping {
	device: string;
	version?: string;
	// FLX10 firmware version the mapping was authored against. Logged
	// at controller_connected; mismatch is a warning, not fatal.
	firmware_tested?: string;
	rows: MappingRow[];
}

// ─── FLX10 channel constants ──────────────────────────────────────────────
// Per planning/tech/controllers-pioneer-flx10-protocol.md.
// v1 binds physical deck 1 only — decks 2/3/4 channels silently dropped
// until Performance Mode lands.

/** Deck 1 Note On status nibble. */
const D1_NOTE = 0x90;
/** Deck 1 CC status nibble. */
const D1_CC = 0xb0;
/** Deck 1 pad-mode activate-layer Note On status. */
const D1_PAD = 0x97;
/** Mixer / browser shared Note On status. */
const SHARED_NOTE = 0x96;
/** Mixer / browser shared CC status. */
const SHARED_CC = 0xb6;

// ─── FLX10 mapping rows ───────────────────────────────────────────────────

export const FLX10_MAPPING: Mapping = {
	device: 'DDJ-FLX10',
	// 1.0.0 = first version verified verbatim against Pioneer's official
	// "DDJ-FLX10 List of MIDI message" PDF (e1 revision). Bump on any
	// schema or value change.
	version: '1.0.0',
	firmware_tested: undefined, // TBD — populate at first device connect via SysEx identity request
	rows: [
		// ─── Transport ────────────────────────────────────────────────────
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x0b }, action: { kind: 'play_pause' }, label: 'Play/Pause' },
		// SHIFT modifier — track held state inside the sidecar. The
		// matching note_off binding flips it back. Confirmed via
		// Mixxx data extraction.
		{ trigger: { kind: 'note_on',  status: D1_NOTE, note: 0x3f }, action: { kind: 'shift' }, label: 'SHIFT press' },
		{ trigger: { kind: 'note_off', status: D1_NOTE, note: 0x3f }, action: { kind: 'shift' }, label: 'SHIFT release' },

		// ─── Beat-jump dedicated buttons ──────────────────────────────────
		// Plain → 1 beat. SHIFT → 4 bars (16 beats). The hardware ±4
		// buttons (notes 0x5E / 0x5F) → 1 bar (4 beats); SHIFT+those
		// (notes 0x61 / 0x62) → 4 bars (16 beats). Mirrors the new
		// keyboard binding shipped this session.
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x19 }, action: { kind: 'beat_jump', delta: -1 },  label: 'Beat-jump -1' },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x1a }, action: { kind: 'beat_jump', delta:  1 },  label: 'Beat-jump +1' },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x5e }, action: { kind: 'beat_jump', delta: -4 },  label: 'Beat-jump -1 bar' },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x5f }, action: { kind: 'beat_jump', delta:  4 },  label: 'Beat-jump +1 bar' },
		// SHIFT-emitted notes carry shift:true so the Rust dispatcher's
		// "skip plain rows when SHIFT held" gating allows them. Without
		// the flag, the gating swallowed them silently when SHIFT was
		// held (which is the only time FLX10 emits these notes).
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x61 }, action: { kind: 'beat_jump', delta: -16 }, label: 'SHIFT + beat-jump -4 bars', shift: true },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x62 }, action: { kind: 'beat_jump', delta:  16 }, label: 'SHIFT + beat-jump +4 bars', shift: true },

		// ─── Loop section ─────────────────────────────────────────────────
		// LOOP IN / OUT have SEPARATE physical notes for SHIFT variants
		// (FLX10 PDF, D14/D15): plain LOOP IN = 0x10, SHIFT+LOOP IN =
		// 0x4C; plain LOOP OUT = 0x11, SHIFT+LOOP OUT = 0x4D. Earlier
		// mapping put SHIFT variants on the plain notes with shift:true
		// gating — wrong; the FLX10 never emits 0x10 while SHIFT is held.
		// 4-Beat Loop toggle uses deck.loopNBeats(4) which exits when
		// a loop is already active.
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x10 }, action: { kind: 'loop_in' },         label: 'Loop IN' },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x4c }, action: { kind: 'loop_halve' },      label: 'SHIFT + Loop IN — halve loop',   shift: true },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x11 }, action: { kind: 'loop_out' },        label: 'Loop OUT' },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x4d }, action: { kind: 'loop_double' },     label: 'SHIFT + Loop OUT — double loop', shift: true },
		{ trigger: { kind: 'note_on', status: D1_NOTE, note: 0x14 }, action: { kind: 'loop_n_beats', n: 4 }, label: '4-Beat Loop / Exit' },

		// ─── Hot-cue pads (deck 1, HOT CUE mode) ──────────────────────────
		// v1: trigger-only. Empty-pad press is a no-op (cue set requires
		// player-cues — see PRD Roadmap). SHIFT-layer (status 0x98) for
		// delete is intentionally NOT mapped here — v2 wires those once
		// player-cues ships its cues:delete IPC.
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x00 }, action: { kind: 'cue_trigger', slot: 0 }, label: 'Hot cue pad 1' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x01 }, action: { kind: 'cue_trigger', slot: 1 }, label: 'Hot cue pad 2' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x02 }, action: { kind: 'cue_trigger', slot: 2 }, label: 'Hot cue pad 3' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x03 }, action: { kind: 'cue_trigger', slot: 3 }, label: 'Hot cue pad 4' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x04 }, action: { kind: 'cue_trigger', slot: 4 }, label: 'Hot cue pad 5' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x05 }, action: { kind: 'cue_trigger', slot: 5 }, label: 'Hot cue pad 6' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x06 }, action: { kind: 'cue_trigger', slot: 6 }, label: 'Hot cue pad 7' },
		{ trigger: { kind: 'note_on', status: D1_PAD, note: 0x07 }, action: { kind: 'cue_trigger', slot: 7 }, label: 'Hot cue pad 8' },

		// ─── Browser / shared ─────────────────────────────────────────────
		// BROWSE rotary turn / press, BACK, VIEW all live on channel 7
		// (status 0x96 Note / 0xB6 CC) per Pioneer PDF — confirmed
		// against device. Browse rotary +SHIFT uses CC 0x64 (a separate
		// CC); v1 doesn't differentiate so SHIFT-rotate is unmapped.
		// Action types surface to the renderer via ControllerEvent for
		// dispatch into the tracklist / sidebar / footer layers per
		// the PRD navigation table.
		{ trigger: { kind: 'note_on',        status: SHARED_NOTE, note: 0x46 }, action: { kind: 'browse_press' }, label: 'BROWSE press' },
		{ trigger: { kind: 'note_on',        status: SHARED_NOTE, note: 0x65 }, action: { kind: 'back' },         label: 'BACK' },
		// SHIFT + BACK lives on a DIFFERENT note (0x66) — FLX10 emits
		// distinct messages for the two; we map both to action=back
		// and the renderer's Back handler reads isShiftHeld() to
		// decide between focus-toggle and open-omnibar.
		{ trigger: { kind: 'note_on',        status: SHARED_NOTE, note: 0x66 }, action: { kind: 'back' },         label: 'SHIFT + BACK', shift: true },
		{ trigger: { kind: 'note_on',        status: SHARED_NOTE, note: 0x67 }, action: { kind: 'view' },         label: 'VIEW — toggle footer small/big' },
		{ trigger: { kind: 'control_change', status: SHARED_CC,   cc:   0x40 }, action: { kind: 'browse_rotate' }, label: 'BROWSE rotary' },

		// ─── Jog (MIDI — v1 primary path) ─────────────────────────────────
		// 7-bit MIDI CC is the v1 jog input — HID jog is a per-device
		// [P2] roadmap item (DDJ/FLX/XDJ HID input layout isn't in
		// public sources). Vinyl-on (scratch mode) only — vinyl-off
		// path mapped later if needed.
		{ trigger: { kind: 'note_on',        status: D1_NOTE, note: 0x36 }, action: { kind: 'scrub_touch'  }, label: 'Jog touch on'  },
		{ trigger: { kind: 'note_off',       status: D1_NOTE, note: 0x36 }, action: { kind: 'scrub_touch'  }, label: 'Jog touch off' },
		{ trigger: { kind: 'control_change', status: D1_CC,   cc:   0x22 }, action: { kind: 'scrub_motion' }, label: 'Jog turn — scratch' },
	],
};

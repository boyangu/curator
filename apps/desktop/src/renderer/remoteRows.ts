// Remote rows (track.remoteOnly): tracks the Curator account holds that this
// device has no file or stream link for — another device of the account
// does (track.remoteSource says how it holds them). They show in every list
// so each device sees the account's whole library, and they take ratings,
// tags and playlist membership like any row (those sync). Anything that
// needs the audio or a device-local link can't run on them: playback,
// analysis, WAV conversion, the rekordbox push, provider matching. One
// reason string for every such refusal, so the row mark, the menu items and
// the play toast all say the same thing.
//
// Pure (types-only imports): the track list's row factory, the command
// table and the player all read it, and it is tested without a DOM.

import type { Track } from '@curator/shared';

export const REMOTE_ONLY_REASON = 'Not on this device — another device in your account holds this track';

// How the holding device has it, for the row mark's tooltip.
const HELD_AS: Record<string, string> = {
	local: 'as a local file',
	spotify: 'on Spotify',
	tidal: 'on Tidal',
};

export const isRemoteRow = (t: Pick<Track, 'remoteOnly'>): boolean => !!t.remoteOnly;

export const anyRemoteRow = (tracks: readonly Pick<Track, 'remoteOnly'>[]): boolean => tracks.some(isRemoteRow);

export function remoteRowTitle(t: Pick<Track, 'remoteSource'>): string {
	const held = t.remoteSource ? HELD_AS[t.remoteSource] : undefined;
	return held ? `${REMOTE_ONLY_REASON} (${held})` : REMOTE_ONLY_REASON;
}

// The source the row mark is tinted with (the holding device's source
// colour); anything unknown renders neutral.
export function remoteMarkSource(t: Pick<Track, 'remoteSource'>): string {
	return t.remoteSource && t.remoteSource in HELD_AS ? t.remoteSource : 'other';
}

// Thrown by player.play for a remote row. Every play entry point (double
// click, Enter, controller, omnibar) already toasts a failed play with the
// error's message, so the refusal reads the same everywhere without each
// caller knowing about remote rows.
export class RemoteOnlyPlayError extends Error {
	constructor() {
		super(REMOTE_ONLY_REASON);
		this.name = 'RemoteOnlyPlayError';
	}
}

// The account's view of the network and of its Realtime wake channel, as
// pure steps (account.ts drives them from net.isOnline() polls and the
// channel's subscribe callback; tests drive them directly — account.ts
// needs Electron).

export type Connectivity = { online: boolean; offlineSince: number | null };

export type ConnectivityChange =
	| { kind: 'offline' }
	// `offlineForSec`: how long the device was seen offline (null when the
	// start of the outage was not seen).
	| { kind: 'online'; offlineForSec: number | null };

export function initialConnectivity(online: boolean, now: number): Connectivity {
	return { online, offlineSince: online ? null : now };
}

// One probe of the network: the state after it, and the transition it made
// (null when nothing changed — the 10 s poll must not log per tick).
export function stepConnectivity(prev: Connectivity, online: boolean, now: number): { next: Connectivity; change: ConnectivityChange | null } {
	if (online === prev.online) return { next: prev, change: null };
	if (!online) return { next: { online: false, offlineSince: now }, change: { kind: 'offline' } };
	const offlineForSec = prev.offlineSince === null ? null : Math.max(0, Math.round((now - prev.offlineSince) / 1000));
	return { next: { online: true, offlineSince: null }, change: { kind: 'online', offlineForSec } };
}

// Whether a channel status means pings reach this device: SUBSCRIBED is
// joined; CLOSED, CHANNEL_ERROR and TIMED_OUT are not (Supabase keeps
// rejoining an errored channel and reports SUBSCRIBED again when it does).
// Null for a status that says nothing either way.
export function realtimeLiveFor(status: string): boolean | null {
	if (status === 'SUBSCRIBED') return true;
	if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') return false;
	return null;
}

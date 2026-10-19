// Hybrid-lite clock for `client_ts` (design: "The op" field table; open
// question "Clock", resolved as hybrid-lite).
//
// A device stamps every op with max(wall clock, last server time seen + 1,
// last ts it issued + 1). The wall clock keeps timestamps human-readable and
// makes an offline edit lose to a later online one by real time (scenario 1);
// the two "+1" floors stop a device from stamping an op below anything it has
// already observed, so its own ops are monotonic and never sort under a
// server-acknowledged write it has seen. This is not a full HLC: a clock that
// is an hour fast still stamps the future (scenario 9), which is why the
// server clamps and logs rather than trusting the device.

export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function nextClientTs(wallMs: number, lastServerMs: number, lastIssuedMs: number): number {
	return Math.max(wallMs, lastServerMs + 1, lastIssuedMs + 1);
}

export type ClampResult = { clientTs: number; clamped: boolean };

// Server side. A `client_ts` more than `maxSkewMs` ahead of `receivedAtMs` is
// replaced by `receivedAtMs`; a few seconds of ordinary skew keep the device's
// own stamp so LWW between two online devices stays by their clocks, not by
// arrival. Non-finite or negative stamps are malformed and clamp too. The
// caller logs `clamped` with the device id (scenario 9).
export function clampClientTs(clientTs: number, receivedAtMs: number, maxSkewMs = MAX_CLOCK_SKEW_MS): ClampResult {
	if (!Number.isFinite(clientTs) || clientTs < 0) return { clientTs: receivedAtMs, clamped: true };
	if (clientTs > receivedAtMs + maxSkewMs) return { clientTs: receivedAtMs, clamped: true };
	return { clientTs, clamped: false };
}

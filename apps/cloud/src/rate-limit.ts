// Per-device token buckets (design: "Limits": 10 pushes/s, 100 pulls/min;
// catalogue plan: 20 burst, 5/s per user + device for catalogue.*).
// In memory on purpose: the limit protects this process and the database
// behind it from a runaway client loop, not a billing quota, so a bucket
// that resets on deploy or differs per machine is fine and costs no round
// trip. A well-behaved client never meets it; one that does backs off by
// `retryAfterSec` (exponential with jitter on its side).

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

type Bucket = { tokens: number; at: number };

export class TokenBucketLimiter {
	private readonly buckets = new Map<string, Bucket>();

	constructor(
		readonly capacity: number,
		readonly refillPerSec: number,
		private readonly now: () => number = Date.now,
		// Idle buckets are dropped past this many keys so a stream of fresh
		// device ids cannot grow the map without bound.
		private readonly maxKeys = 50_000,
	) {}

	take(key: string): TakeResult {
		const t = this.now();
		let b = this.buckets.get(key);
		if (!b) {
			if (this.buckets.size >= this.maxKeys) this.evictFull(t);
			b = { tokens: this.capacity, at: t };
			this.buckets.set(key, b);
		} else {
			b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
			b.at = t;
		}
		if (b.tokens >= 1) {
			b.tokens -= 1;
			return { ok: true };
		}
		return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerSec)) };
	}

	get size(): number {
		return this.buckets.size;
	}

	private evictFull(t: number): void {
		for (const [k, b] of this.buckets) {
			if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
		}
	}
}

export type RateLimits = { push: TokenBucketLimiter; pull: TokenBucketLimiter; catalogue: TokenBucketLimiter };

export function defaultRateLimits(now: () => number = Date.now): RateLimits {
	return {
		push: new TokenBucketLimiter(10, 10, now),
		pull: new TokenBucketLimiter(100, 100 / 60, now),
		// A hydrating device looks up 50 hashes per call and an uploader puts
		// 100 items per call: 5 calls/s is ~250 tracks/s, far past what the
		// desktop's own 2 MB/s blob budget lets it use.
		catalogue: new TokenBucketLimiter(20, 5, now),
	};
}

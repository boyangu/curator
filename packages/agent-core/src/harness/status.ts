// What an agent is doing right now, in the three words a person supervising
// several of them needs (borrowed from Herdr's pane status): idle, working,
// or blocked — and blocked means one thing only, waiting on a human (an
// approval, an answer, a confirmation). Not "slow", not "retrying": those
// are working. Each surface reports its own; a rollup shows the worst.

export type AgentActivityState = 'idle' | 'working' | 'blocked';

export interface AgentActivity {
	state: AgentActivityState;
	// When this state began (ms since epoch).
	since: number;
	// blocked only: what the human is being asked, in a few words.
	waitingOn?: string;
}

const RANK: Record<AgentActivityState, number> = { idle: 0, working: 1, blocked: 2 };

// Several agents' activity as one: blocked beats working beats idle, and the
// state keeps the earliest start among those that share it.
export function rollupActivity(all: readonly AgentActivity[]): AgentActivity {
	let out: AgentActivity = { state: 'idle', since: Date.now() };
	for (const a of all) {
		if (RANK[a.state] > RANK[out.state]) out = { ...a };
		else if (a.state === out.state && a.since < out.since) out = { ...out, since: a.since, ...(a.waitingOn && !out.waitingOn ? { waitingOn: a.waitingOn } : {}) };
	}
	return out;
}

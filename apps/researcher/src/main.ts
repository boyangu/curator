// curator-researcher — agent research sidecar.
//
// Protocol: JSON-RPC over stdio, one frame per line (analyzer/rekordbox
// conventions). Host side: apps/core/src/knowledge/researcher-sidecar.ts —
// keep the two in sync.
//
//   stdout, on boot:   {event:'hello', name:'curator-researcher', version, protocol:1}
//   stdin  request:    {id, method:'research', params: ResearchRequest}
//                      {method:'shutdown'}
//   stdout response:   {id, result: {claims: [...]}} | {id, error: {message}}
//
// Research runs on the Claude Agent SDK (web search/fetch tools, cited).
// The prompt confines the model to the requested (kind, aspect) question
// and demands strict JSON out; the host treats every claim as exactly
// that — a claim, confidence-scored and cited, never a catalog fact.
//
// ANTHROPIC_API_KEY must be in the environment — the host doesn't spawn
// this process without one (disabled is a supported state).

import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROTOCOL = 1;
const VERSION = '0.1.0';

interface ResearchRequest {
	kind: string;
	aspect: string;
	entity: {
		name: string;
		knownFacts: Record<string, unknown>;
	};
}

interface ResearchClaim {
	name: string;
	confidence: number;
	citations: string[];
	rationale?: string;
}

function send(frame: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(frame) + '\n');
}

function buildPrompt(req: ResearchRequest): string {
	// v1 supports one aspect; the shape generalizes (the host routes only
	// supported (kind, aspect) pairs here, but guard anyway).
	if (req.kind !== 'artist' || req.aspect !== 'similar-artists') {
		throw new Error(`unsupported research aspect: ${req.kind}.${req.aspect}`);
	}
	const facts = JSON.stringify(req.entity.knownFacts ?? {});
	return [
		`Research task: find artists most similar to the music artist "${req.entity.name}".`,
		`Known facts about this artist (from a DJ library — use them to disambiguate homonyms): ${facts}`,
		'',
		'Use web search to research: shared labels, remix relationships, back-to-back sets,',
		'press/RA/Beatport editorial groupings, "fans also like" style coverage. Prefer',
		'electronic/DJ-culture sources. 5 to 10 artists, best first.',
		'',
		'Rules:',
		'- Only include artists you found actual evidence for; every claim needs 1-3 citation URLs.',
		'- confidence is 0..1: your belief that a fan of the subject would rate this artist as similar.',
		'- rationale is ONE short sentence naming the evidence (e.g. "both release on Afterlife; b2b at Awakenings 2025").',
		'- If the known facts point to a specific scene/genre, stay inside it.',
		'',
		'Respond with ONLY this JSON, no prose around it:',
		'{"claims": [{"name": "...", "confidence": 0.0, "citations": ["https://..."], "rationale": "..."}]}',
	].join('\n');
}

// Pull the JSON object out of the agent's final text — models occasionally
// wrap it in a code fence despite instructions.
function parseClaims(text: string): { claims: ResearchClaim[] } {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) throw new Error('no JSON in research result');
	const parsed = JSON.parse(text.slice(start, end + 1)) as { claims?: unknown };
	if (!Array.isArray(parsed.claims)) throw new Error('research result has no claims array');
	const claims: ResearchClaim[] = [];
	for (const raw of parsed.claims) {
		const c = raw as Partial<ResearchClaim>;
		if (typeof c.name !== 'string' || c.name.trim().length === 0) continue;
		claims.push({
			name: c.name.trim(),
			confidence: Math.min(Math.max(typeof c.confidence === 'number' ? c.confidence : 0.5, 0), 1),
			citations: Array.isArray(c.citations) ? c.citations.filter((u): u is string => typeof u === 'string').slice(0, 3) : [],
			...(typeof c.rationale === 'string' ? { rationale: c.rationale } : {}),
		});
	}
	return { claims };
}

async function research(req: ResearchRequest): Promise<{ claims: ResearchClaim[] }> {
	const prompt = buildPrompt(req);
	const stream = query({
		prompt,
		options: {
			allowedTools: ['WebSearch', 'WebFetch'],
			maxTurns: 16,
			systemPrompt:
				'You are a music-discovery research agent embedded in a DJ library app. '
				+ 'You research relationships between electronic-music artists, labels and scenes '
				+ 'using web search, and you answer in strict JSON only.',
		},
	});
	let text = '';
	for await (const msg of stream) {
		if (msg.type === 'result') {
			if (msg.subtype === 'success') text = msg.result;
			else throw new Error(`research agent ended: ${msg.subtype}`);
		}
	}
	return parseClaims(text);
}

async function main(): Promise<void> {
	send({ event: 'hello', name: 'curator-researcher', version: VERSION, protocol: PROTOCOL });
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let frame: { id?: number; method?: string; params?: unknown };
		try {
			frame = JSON.parse(line) as typeof frame;
		} catch {
			// Not our protocol — ignore rather than crash the loop.
			continue;
		}
		if (frame.method === 'shutdown') {
			process.exit(0);
		}
		if (frame.method === 'research' && typeof frame.id === 'number') {
			const id = frame.id;
			// Serial by design: the host's agent lane sends one request at a
			// time; awaiting here keeps the process simple.
			try {
				const result = await research(frame.params as ResearchRequest);
				send({ id, result });
			} catch (err) {
				send({ id, error: { message: err instanceof Error ? err.message : String(err) } });
			}
			continue;
		}
		if (typeof frame.id === 'number') {
			send({ id: frame.id, error: { message: `unknown method: ${String(frame.method)}` } });
		}
	}
}

void main();

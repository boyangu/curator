// Sidecar-local web_fetch — the provider-independent floor for web
// research. Providers without native web tools (DeepSeek, arbitrary
// openai-compatible endpoints) still get page fetching; search stays a
// provider capability (its absence is a supported disabled state).
//
// Deliberately minimal: GET, 15s timeout, 100KB of extracted text, crude
// HTML→text. Not a crawler — one page per call, the model pages itself.

import type { LocalTool } from './types.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_BYTES = 100_000;

// Strip HTML down to readable text: drop script/style/nav noise, unwrap
// tags, collapse whitespace. Good enough for the model to quote from.
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n\s*/g, '\n')
		.trim();
}

export const webFetchTool: LocalTool = {
	spec: {
		name: 'web_fetch',
		description:
			'Fetch a public web page and return its readable text (truncated to ~100KB). '
			+ 'Call this to read a specific URL you already know — an artist page, a label site, a review. '
			+ 'HTTP(S) only; one page per call.',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
			},
			required: ['url'],
			additionalProperties: false,
		},
	},
	async execute(args: unknown, abort: AbortSignal): Promise<unknown> {
		const url = (args as { url?: unknown })?.url;
		if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
			throw new Error('web_fetch requires an absolute http(s) url');
		}
		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const res = await fetch(url, {
			signal: AbortSignal.any([abort, timeout]),
			redirect: 'follow',
			headers: { 'user-agent': 'curator-agent/0.1 (+music research)' },
		});
		const contentType = res.headers.get('content-type') ?? '';
		if (!res.ok) return { url, status: res.status, error: `HTTP ${res.status}` };
		if (!/text\/|json|xml/i.test(contentType)) {
			return { url, status: res.status, error: `unsupported content-type: ${contentType}` };
		}
		const body = await res.text();
		const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
		const text = /html/i.test(contentType) ? htmlToText(body) : body;
		return {
			url,
			status: res.status,
			...(titleMatch?.[1] ? { title: titleMatch[1].trim() } : {}),
			text: text.slice(0, MAX_TEXT_BYTES),
			truncated: text.length > MAX_TEXT_BYTES,
		};
	},
};

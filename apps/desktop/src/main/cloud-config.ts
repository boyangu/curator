// Curator cloud endpoints (planning/tech/cloud.md). All three come from the
// environment and are baked into the main bundle at build time
// (electron.vite.config.ts `define`, hence the literal `process.env.X`
// accesses) — nothing is committed, and a packaged app never reads the end
// user's shell. The Supabase publishable key is public by design (it only
// identifies the project; RLS and the API's JWT check guard every row), but
// it still names a project, so it lives with the rest in .env.
//
// Missing CURATOR_SUPABASE_URL or _PUBLISHABLE_KEY ⇒ no account at all
// (sign-in is refused, the Account tab says "not configured"). Missing
// CURATOR_CLOUD_API_URL ⇒ sign-in works against Supabase Auth alone but core
// gets no cloud transport: sync is off, a supported state.

function text(v: string | undefined): string {
	return (v ?? '').trim();
}

export const SUPABASE_URL = text(process.env.CURATOR_SUPABASE_URL).replace(/\/+$/, '');
export const SUPABASE_PUBLISHABLE_KEY = text(process.env.CURATOR_SUPABASE_PUBLISHABLE_KEY);

// Whether this build can host a Curator account (sign-in) at all.
export function cloudAccountConfigured(): boolean {
	return SUPABASE_URL !== '' && SUPABASE_PUBLISHABLE_KEY !== '';
}

// The tRPC base (no trailing slash, no /trpc suffix), or '' when sync is off.
export function cloudApiUrl(): string {
	return text(process.env.CURATOR_CLOUD_API_URL).replace(/\/+$/, '');
}

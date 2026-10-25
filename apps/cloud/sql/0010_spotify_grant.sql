-- Curator cloud, migration 0010: the account's Spotify grant ('spotify_gateway', stage 1).
--
-- The grant lives here, not on any device (packages/protocol/src/spotify-gateway.ts): every device
-- signs in to Spotify once through the API and asks it for short-lived access tokens. One owner of
-- the refresh token also ends the refresh race: Spotify may rotate the refresh token on every
-- refresh, so two holders refreshing on their own strand one of them.
--
-- Tokens are stored as ciphertext only (AES-256-GCM, src/spotify/crypto.ts). The key is a Fly
-- secret (CURATOR_TOKEN_KEY) and never enters the database, so a database dump or a Supabase
-- backup alone holds nothing usable; `key_id` names which key sealed a row, so a rotated key
-- (CURATOR_TOKEN_KEY_PREV) still opens rows sealed before the rotation. Each ciphertext is bound
-- to its user and field, so a row's bytes cannot be moved to another account or swapped between
-- the refresh and access columns.
--
-- The API reads and writes it as the user, through RLS, like every other table (src/db/user-tx.ts).
-- The `curator` schema is not exposed through PostgREST (README "Database setup", step 6); were it
-- ever exposed, a user would see their own ciphertext and nothing more.
create table curator.spotify_grant (
	user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
	refresh_ct bytea not null check (octet_length(refresh_ct) between 29 and 8192),
	-- The cached access token every device is handed until shortly before it expires; null until
	-- the first refresh after an adopt that returned none.
	access_ct bytea check (octet_length(access_ct) between 29 and 8192),
	access_expires_at timestamptz,
	scopes text[] not null,
	-- { id, displayName, avatarUrl } from Spotify's /v1/me at connect / adopt.
	profile jsonb not null,
	connected_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	-- Spotify refused the refresh token (revoked in the user's Spotify account, a scope change):
	-- every device shows "reconnect Spotify", and nothing asks Spotify again until a connect or an
	-- adopt replaces the grant.
	needs_reconnect boolean not null default false,
	key_id text not null check (char_length(key_id) between 1 and 64),
	check ((access_ct is null) = (access_expires_at is null))
);

alter table curator.spotify_grant enable row level security;

create policy spotify_grant_select on curator.spotify_grant
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy spotify_grant_insert on curator.spotify_grant
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy spotify_grant_update on curator.spotify_grant
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

-- spotify.disconnect.
create policy spotify_grant_delete on curator.spotify_grant
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.spotify_grant to authenticated;
-- Column-level: the owner of a row is fixed once written.
grant update (refresh_ct, access_ct, access_expires_at, scopes, profile, connected_at, updated_at, needs_reconnect, key_id)
	on curator.spotify_grant to authenticated;

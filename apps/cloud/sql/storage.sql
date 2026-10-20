-- The catalogue's Storage bucket and its policies (workstream D). Run as `postgres` in the
-- Supabase SQL editor AFTER the migrations (it calls curator.catalogue_entitled() from
-- 0004_catalogue.sql), the same way as roles.sql. Unnumbered on purpose: the migration runner
-- skips it, because the `storage` schema belongs to Supabase's storage service rather than to
-- this project's migrations. Re-runnable: every statement is idempotent.
--
-- Devices upload and download catalogue files (waveform peaks, vector packs) DIRECTLY, with
-- their own Supabase session: no service key anywhere, and nothing proxied through the API
-- (which would double the bandwidth and need its 1.5 MB body cap lifted). So a signed-in device
-- reaches Storage, but only this:
--
--   bucket    `catalogue`, private (no public URLs), 16 MiB per object, octet-stream only
--   select    objects under its own `<uid>/` prefix
--   insert    under `<uid>/peaks/<sha256>.cpk` or `<uid>/vec/<sha256>.cvec` only, and only
--             while the account is entitled (curator.catalogue_account) and under its quota
--   delete    objects under its own prefix (superseded versions, which the API names)
--   update    NO policy: objects are immutable. Paths are content-addressed, so the same
--             bytes always land on the same path; a client uploads with `upsert: false` and
--             takes "already exists" (409) as done. Without an update policy an upsert is
--             refused, so a device can never swap the bytes behind a path another of its
--             devices already verified.
--
-- The API never touches Storage objects itself; catalogue.put only reads storage.objects under
-- the caller's RLS to check that each named object exists with the stated size.
--
-- ── If the SQL editor refuses this file ─────────────────────────────────────────────────────
-- Supabase owns the `storage` schema; if `postgres` may not create policies on storage.objects
-- in your project (error 42501, "must be owner of table objects"), make the same thing in the
-- dashboard instead, and run only the curator.catalogue_upload_allowed() function below:
--
--   1. Storage → New bucket: name `catalogue`, Public OFF, "Restrict file upload size" 16 MB,
--      "Allowed MIME types" application/octet-stream.
--   2. Storage → Policies → `catalogue` → New policy → "For full customization", three times,
--      each "Target roles: authenticated":
--        SELECT  using:      bucket_id = 'catalogue' and (storage.foldername(name))[1] = (select auth.uid())::text
--        INSERT  with check: bucket_id = 'catalogue' and (storage.foldername(name))[1] = (select auth.uid())::text
--                              and name ~ ('^' || (select auth.uid())::text || '/(peaks/[0-9a-f]{64}\.cpk|vec/[0-9a-f]{64}\.cvec)$')
--                              and (select curator.catalogue_upload_allowed())
--        DELETE  using:      bucket_id = 'catalogue' and (storage.foldername(name))[1] = (select auth.uid())::text
--      No UPDATE policy.
--   3. Check: `select policyname, cmd from pg_policies where tablename = 'objects' and policyname
--      like 'curator_catalogue%'` lists the three (dashboard names differ; check cmd + qual).

-- ── bucket ──────────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogue', 'catalogue', false, 16777216, array['application/octet-stream'])
on conflict (id) do update set
	public = excluded.public,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

-- ── upload gate ─────────────────────────────────────────────────────────────────────────────
-- Entitled and still under quota, counting what the account already holds in the bucket
-- (orphans included: an upload that was never put still takes room). A soft cap: the check
-- sees objects already stored, so concurrent uploads can overshoot by at most a few 16 MiB
-- objects. SECURITY INVOKER on purpose: run as `authenticated`, the sum sees only the caller's
-- own objects (the select policy below), so it needs no cross-user read.
create or replace function curator.catalogue_upload_allowed()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
	select curator.catalogue_entitled()
		and coalesce((
			select sum((o.metadata ->> 'size')::bigint)
			from storage.objects o
			where o.bucket_id = 'catalogue' and (storage.foldername(o.name))[1] = auth.uid()::text
		), 0) < coalesce((select a.quota_bytes from curator.catalogue_account a where a.user_id = auth.uid()), 0)
$$;

revoke execute on function curator.catalogue_upload_allowed() from public, anon, authenticated;
grant execute on function curator.catalogue_upload_allowed() to authenticated;

-- ── policies on storage.objects ─────────────────────────────────────────────────────────────
-- `(storage.foldername(name))[1]` is the first path segment, the user id. Prefixed names, so
-- they cannot collide with policies for other buckets.
drop policy if exists curator_catalogue_select on storage.objects;
create policy curator_catalogue_select on storage.objects
	for select to authenticated
	using (bucket_id = 'catalogue' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists curator_catalogue_insert on storage.objects;
create policy curator_catalogue_insert on storage.objects
	for insert to authenticated
	with check (
		bucket_id = 'catalogue'
		and (storage.foldername(name))[1] = (select auth.uid())::text
		and name ~ ('^' || (select auth.uid())::text || '/(peaks/[0-9a-f]{64}\.cpk|vec/[0-9a-f]{64}\.cvec)$')
		and (select curator.catalogue_upload_allowed())
	);

drop policy if exists curator_catalogue_delete on storage.objects;
create policy curator_catalogue_delete on storage.objects
	for delete to authenticated
	using (bucket_id = 'catalogue' and (storage.foldername(name))[1] = (select auth.uid())::text);

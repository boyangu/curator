-- Curator cloud, migration 0017: the review queue.
--
-- Wherever the pipeline refuses to guess — a label whose lookup found namesakes, an artist the
-- planner could not link, two catalogue objects that look like one — it opens a review with the
-- candidates and what it knows (src/catalog/admin.ts). A back-office session (Claude Code with the
-- resolve CLI, or an operator) reads the evidence, looks further, and decides: attach, merge, not
-- the same, or skip. The decision, who made it and why stay on the row; a decided "not the same"
-- keeps the pipeline from proposing the pair again.
create table curator.catalog_review (
	id bigint generated always as identity primary key,
	kind text not null check (kind in ('label_page', 'artist_link', 'duplicate')),
	object_id uuid not null references curator.catalog_object (id),
	-- The same question asked once: kind, object and the candidate set.
	digest text not null unique,
	candidates jsonb not null,
	evidence jsonb not null default '{}'::jsonb,
	status text not null default 'open' check (status in ('open', 'decided')),
	decision jsonb,
	decided_by text,
	note text,
	opened_at timestamptz not null default now(),
	decided_at timestamptz
);
create index catalog_review_open on curator.catalog_review (kind, opened_at) where status = 'open';
create index catalog_review_object on curator.catalog_review (object_id);

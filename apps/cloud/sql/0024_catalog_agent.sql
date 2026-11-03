-- Curator cloud, migration 0024: the catalogue reasoner's cases, and what it teaches ingestion.
--
-- Where the identity rules give up or guess — two releases of one title on one label, one artist
-- held under two ids by one store, a store profile that is a bucket of namesakes, a credit cut into
-- pieces, a label's page the lookups could not settle — the catalogue now writes a CASE instead of
-- acting or minting a twin (src/catalog/agent/). A worker step reasons about queued cases with the
-- catalogue's evidence (and web research), applies or proposes the answer through the operator
-- inbox (0021), and keeps the verdict, the model, its usage and its cost here: the decision log.
-- Not catalog_enrich_task: its key is one row per object and need, a release can be in two cases,
-- and a merge moves enrich rows onto the winner.
create table curator.catalog_agent_case (
	id bigint generated always as identity primary key,
	kind text not null check (kind in ('credit', 'release_twin', 'artist_twin', 'artist_bucket', 'label_pages')),
	-- The catalogue objects the case is about (the back office links them).
	subjects uuid[] not null default '{}',
	-- The case's inputs, per kind (the pairs, the credit text and its pieces, the review ids …).
	input jsonb not null default '{}'::jsonb,
	-- The same question once while it is live: kind, sorted subjects, a per-kind key.
	digest text not null,
	-- queued → leased → decided (a verdict, nothing done yet) → applied | proposed (an inbox item
	-- holds it) | declined (the model would not answer) | failed (after the retries) | moot (a
	-- subject was merged away or the pair ruled apart before the case ran).
	status text not null default 'queued' check (status in ('queued', 'leased', 'decided', 'applied', 'proposed', 'declined', 'failed', 'moot')),
	next_due_at timestamptz not null default now(),
	lease_holder text,
	lease_until timestamptz,
	attempts integer not null default 0,
	last_error text,
	verdict jsonb,
	confidence real check (confidence between 0 and 1),
	-- The model that answered, its token usage and what the call cost (USD), from the provider's
	-- usage block and the model's published rates.
	model text,
	prompt_hash text,
	usage jsonb,
	cost_usd numeric(8, 4),
	inbox_id bigint references curator.catalog_inbox (id),
	created_at timestamptz not null default now(),
	decided_at timestamptz
);
create unique index catalog_agent_case_digest on curator.catalog_agent_case (digest) where status in ('queued', 'leased', 'decided');
create index catalog_agent_case_due on curator.catalog_agent_case (next_due_at) where status = 'queued';
create index catalog_agent_case_subjects on curator.catalog_agent_case using gin (subjects);
create index catalog_agent_case_decided on curator.catalog_agent_case (decided_at desc) where decided_at is not null;

-- A credit string the readers must never cut apart ("Saints & Sinners" is one act) or must always
-- cut ("Kaske, Ilka Rane" is two): what the reasoner or the operator ruled about a credit, applied
-- by ingestion to every reader's claims (src/catalog/ingest.ts), so a Tidal re-read cannot split
-- Saints & Sinners into Saints and Sinners again.
create table curator.catalog_credit_rule (
	name_fold text primary key,
	name text not null,
	kind text not null check (kind in ('compound', 'split')),
	pieces text[] not null default '{}',
	case_id bigint references curator.catalog_agent_case (id),
	-- claude-code | worker | guy | agent
	actor text not null,
	created_at timestamptz not null default now()
);

-- A store id the catalogue must not bind an object to again: a profile that holds many namesakes
-- (Deezer artist 81453 is several Supernovas). Unlinking it from the artist is not enough — the
-- next poll would attach it to a fresh artist — so ingestion reads a claim under a blocked id as a
-- name only (a weak key), never as the store's word on who the artist is.
create table curator.catalog_source_block (
	provider text not null,
	kind text not null,
	provider_id text not null,
	reason text not null,
	case_id bigint references curator.catalog_agent_case (id),
	by_whom text not null,
	at timestamptz not null default now(),
	primary key (provider, kind, provider_id)
);

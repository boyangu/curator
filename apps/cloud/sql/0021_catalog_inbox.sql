-- Curator cloud, migration 0021: the operator's inbox.
--
-- One layer above the review queue: the pipeline asks the agent (catalog_review); the agent and
-- the worker answer to the operator here (src/catalog/inbox.ts). Every important action the
-- back office takes becomes an item — held until approved when it cannot be undone (a merge),
-- applied and surfaced with an undo when it can (an unlink, a rename, a ruling), or just logged.
-- Detectors in the worker pass raise items for what went wrong on its own (twin releases after
-- an import, a dead label page, a tracker failing). Audit entries are items too, closed at
-- birth, so the audit trail and the inbox are one log with one shape.
create table curator.catalog_inbox (
	id bigint generated always as identity primary key,
	-- label.merge · review.merge · review.attach · review.not_same · review.escalated ·
	-- label.unlink · label.rename · label.link · label.import · library.import ·
	-- release.link · release.fill · release.dedupe · repair.previews ·
	-- release.twins · page.dead · page.mismatch · tracker.failing · provider.parked
	kind text not null,
	severity text not null check (severity in ('audit', 'notice', 'approval')),
	-- audit items are born 'logged'; the rest 'open' until the operator resolves them, or the
	-- detector pass finds the condition gone ('cleared').
	status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'cleared', 'logged')),
	title text not null,
	-- The catalogue objects it is about (links in the back office); merged-away ones redirect.
	subjects uuid[] not null default '{}',
	evidence jsonb not null default '{}'::jsonb,
	-- A held action: { op, args } replayed on approve. A done action's undo: { op, args }.
	apply jsonb,
	undo jsonb,
	-- claude-code | worker | guy
	actor text not null,
	-- Set at birth when the operator said so in chat (--approved): logged, not asked.
	approved_by text,
	review_id bigint references curator.catalog_review (id),
	-- The same item once: kind, subjects and a per-kind key (the pairs, the page, the day).
	digest text not null,
	raised_at timestamptz not null default now(),
	snoozed_until timestamptz,
	resolved_at timestamptz,
	resolved_by text,
	resolution text,
	note text,
	-- An apply or undo that failed; the item stays open and says why.
	last_error text
);
-- A dismissed item is never raised again; a cleared one may come back.
create unique index catalog_inbox_digest on curator.catalog_inbox (digest) where status <> 'cleared';
create index catalog_inbox_open on curator.catalog_inbox (severity, raised_at desc) where status = 'open';
create index catalog_inbox_raised on curator.catalog_inbox (raised_at desc);
create index catalog_inbox_subjects on curator.catalog_inbox using gin (subjects);

-- A review the agent skips is left for the operator (escalated); one whose merge waits for
-- approval is held, out of the agent's queue until the inbox resolves it.
alter table curator.catalog_review drop constraint catalog_review_status_check;
alter table curator.catalog_review add constraint catalog_review_status_check
	check (status in ('open', 'decided', 'escalated', 'held'));

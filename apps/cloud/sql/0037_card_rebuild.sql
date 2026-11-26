-- Event cards kept current (catalog/card-rebuild.ts, events.ts refreshEvents).
--
-- An event's card is a copy of the release taken when the event was raised. Until now five places
-- re-sent a card by hand, each comparing only stores and credits, and everything else that changed
-- a release (a device's own finding, a label linked later, a tracklist filled) never reached the
-- devices holding the card. Now every write that can change what a card states marks the objects
-- it touched, and the API rebuilds the cards of the marked ones about once a minute.
--
-- The marks are an append-only queue, not a set: a unique key here would make two ingests that
-- touch the same artists in a different order wait on each other, and deadlock. Duplicates cost a
-- row each and are collapsed when the queue is drained. `force`: move the event whatever the card
-- says (it gained a subject where it stands; events.ts markCards).

create table curator.catalog_card_dirty (
	id bigint generated always as identity primary key,
	object_id uuid not null,
	force boolean not null default false
);

-- refreshEvents finds the events about a marked object by their subject.
create index catalog_event_subject_id on curator.catalog_event (subject_id);

-- Statement triggers over the transition tables: one insert per writing statement, however many
-- rows it wrote, and no round trip from the writer (the upkeep worker is 130 ms from the database).
-- Definer functions, like catalog_watch_count: the writers need no grant on the queue to mark it.

-- catalog_source_object, catalog_identifier: the object a store id or an ISRC/UPC belongs to.
create function curator.catalog_card_touch_ref() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op <> 'DELETE' then
		insert into curator.catalog_card_dirty (object_id) select distinct object_id from new_rows;
	end if;
	if tg_op <> 'INSERT' then
		insert into curator.catalog_card_dirty (object_id) select distinct object_id from old_rows;
	end if;
	return null;
end;
$$;

-- catalog_edge: both ends (a release and its track, artist, label or genre).
create function curator.catalog_card_touch_edge() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op <> 'DELETE' then
		insert into curator.catalog_card_dirty (object_id) select src from new_rows union select dst from new_rows;
	end if;
	if tg_op <> 'INSERT' then
		insert into curator.catalog_card_dirty (object_id) select src from old_rows union select dst from old_rows;
	end if;
	return null;
end;
$$;

-- catalog_object: only a change to what a card reads. Most updates of this table are a scan stamp
-- or a watch count and mark nothing.
create function curator.catalog_card_touch_object() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into curator.catalog_card_dirty (object_id)
	select n.id from new_rows n join old_rows o on o.id = n.id
	where (n.name, n.attrs, n.label_text, n.release_type, n.duration_sec, n.merged_into)
		is distinct from (o.name, o.attrs, o.label_text, o.release_type, o.duration_sec, o.merged_into);
	return null;
end;
$$;

revoke execute on function curator.catalog_card_touch_ref() from public, anon, authenticated;
revoke execute on function curator.catalog_card_touch_edge() from public, anon, authenticated;
revoke execute on function curator.catalog_card_touch_object() from public, anon, authenticated;

-- A trigger with transition tables takes one event, so one per table and event.
create trigger catalog_card_touch_ins after insert on curator.catalog_source_object
	referencing new table as new_rows for each statement execute function curator.catalog_card_touch_ref();
create trigger catalog_card_touch_upd after update on curator.catalog_source_object
	referencing old table as old_rows new table as new_rows for each statement execute function curator.catalog_card_touch_ref();
create trigger catalog_card_touch_del after delete on curator.catalog_source_object
	referencing old table as old_rows for each statement execute function curator.catalog_card_touch_ref();

create trigger catalog_card_touch_ins after insert on curator.catalog_identifier
	referencing new table as new_rows for each statement execute function curator.catalog_card_touch_ref();
create trigger catalog_card_touch_upd after update on curator.catalog_identifier
	referencing old table as old_rows new table as new_rows for each statement execute function curator.catalog_card_touch_ref();
create trigger catalog_card_touch_del after delete on curator.catalog_identifier
	referencing old table as old_rows for each statement execute function curator.catalog_card_touch_ref();

create trigger catalog_card_touch_ins after insert on curator.catalog_edge
	referencing new table as new_rows for each statement execute function curator.catalog_card_touch_edge();
create trigger catalog_card_touch_upd after update on curator.catalog_edge
	referencing old table as old_rows new table as new_rows for each statement execute function curator.catalog_card_touch_edge();
create trigger catalog_card_touch_del after delete on curator.catalog_edge
	referencing old table as old_rows for each statement execute function curator.catalog_card_touch_edge();

create trigger catalog_card_touch_upd after update on curator.catalog_object
	referencing old table as old_rows new table as new_rows for each statement execute function curator.catalog_card_touch_object();

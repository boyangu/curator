-- Curator cloud, migration 0018: Bandcamp credits made by a label's own account id.
--
-- Until 2026-10-28 the Bandcamp tracker named a release's artist by the item's band id. Items a
-- label hosts on its own account carry the LABEL's band id (the artist is only the item's text),
-- so the first artist seen on a label's account got that id as its Bandcamp representation and
-- every later release the label hosts resolved to it: Steyoyoke's 436 such releases all credited
-- "Navid Kaya, AliPink". The tracker now credits those by name within the label
-- (src/catalog/trackers/bandcamp.ts). Here: the artist representations that are really a label's
-- id go, with every credit only Bandcamp asserted through them, and each label's Bandcamp
-- discography is read again (src/catalog/trackers/backfill.ts) to credit it right.

create temporary table bad_artist_rep on commit drop as
select a.id as rep_id, a.object_id
from curator.catalog_source_object a
join curator.catalog_source_object l on l.provider = 'bandcamp' and l.kind = 'label' and l.provider_id = a.provider_id
where a.provider = 'bandcamp' and a.kind = 'artist';

-- Bandcamp's word for those credits: the evidence rows from Bandcamp release / recording reps
-- on edges touching the mis-identified artists.
delete from curator.catalog_edge_evidence ev
using curator.catalog_edge e, curator.catalog_source_object so
where ev.edge_id = e.id and so.id = ev.source_object_id and so.provider = 'bandcamp'
	and e.kind in ('artist-release', 'recording-artist', 'label-artist')
	and (e.src in (select object_id from bad_artist_rep) or e.dst in (select object_id from bad_artist_rep));

-- A credit no source asserts any more is no credit.
delete from curator.catalog_edge e
where e.kind in ('artist-release', 'recording-artist', 'label-artist')
	and (e.src in (select object_id from bad_artist_rep) or e.dst in (select object_id from bad_artist_rep))
	and not exists (select 1 from curator.catalog_edge_evidence ev where ev.edge_id = e.id);

delete from curator.catalog_source_object where id in (select rep_id from bad_artist_rep);

-- Every label with a Bandcamp page reads its discography again.
insert into curator.catalog_enrich_task (object_id, need, provider)
select so.object_id, 'backfill', 'bandcamp'
from curator.catalog_source_object so join curator.catalog_object o on o.id = so.object_id
where so.provider = 'bandcamp' and so.kind = 'label' and o.merged_into is null
on conflict (object_id, need, provider) do update set next_due_at = now(), attempts = 0, last_error = null;

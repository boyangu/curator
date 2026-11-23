-- Curator cloud, migration 0035: Bandcamp tags are no longer genres.
--
-- A Bandcamp release carries several free tags, alphabetised, with nothing marking the main one,
-- and "ambient" / "experimental" ride on most electronic releases. Every mapped tag became an
-- object-genre edge, and readers take the name-ordered first: Milio's deep house "Maybe Tomorrow"
-- (VIAVIA, 2026-11) showed as Ambient / Experimental on its card and all three tracks. The reader
-- (packages/catalog-readers bandcamp.ts) stops sending tags; this removes what they already wrote.
--
-- An edge goes only when Bandcamp was its sole evidence — the same genre from Beatport, Apple or a
-- device's facts-up stays. Cards already delivered to devices keep their genre until re-materialised.

create temporary table bandcamp_genre_edge on commit drop as
select distinct ev.edge_id
from curator.catalog_edge_evidence ev
join curator.catalog_edge e on e.id = ev.edge_id and e.kind = 'object-genre'
join curator.catalog_source_object s on s.id = ev.source_object_id and s.provider = 'bandcamp';

delete from curator.catalog_edge_evidence ev
using curator.catalog_source_object s
where ev.edge_id in (select edge_id from bandcamp_genre_edge)
	and s.id = ev.source_object_id and s.provider = 'bandcamp';

delete from curator.catalog_edge e
where e.id in (select edge_id from bandcamp_genre_edge)
	and not exists (select 1 from curator.catalog_edge_evidence ev where ev.edge_id = e.id);

delete from curator.catalog_fact where field = 'genres' and source = 'bandcamp';

delete from curator.genre_alias where provider = 'bandcamp';

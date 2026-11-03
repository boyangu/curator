-- Genre strings from the stores the fill and the store linker read (src/catalog/store-links.ts),
-- onto the Beatport taxonomy of sql/0012. Bandcamp's tags are the taggers' own words, so only
-- exact names and the plain synonyms are mapped; Apple's primaryGenreName is its coarse tree.
-- Broad words ("electronic", "dance") are orthogonal (genre_id null): recorded, never forced.
-- The `raw` column holds nameFold (packages/library-logic) of the provider's string.

-- Each canonical name maps to itself for Bandcamp and Apple, as it does for Beatport.
insert into curator.genre_alias (provider, raw_fold, genre_id)
select p.provider, o.name_fold, g.object_id
from curator.catalog_genre g
join curator.catalog_object o on o.id = g.object_id
cross join (values ('bandcamp'), ('apple')) as p (provider)
on conflict do nothing;

create temporary table store_alias_seed (provider text, raw text, slug text) on commit drop;
insert into store_alias_seed (provider, raw, slug) values
	('bandcamp', 'melodic techno', 'melodic-house-techno'),
	('bandcamp', 'melodic house', 'melodic-house-techno'),
	('bandcamp', 'deep melodic techno', 'melodic-house-techno'),
	('bandcamp', 'ethereal techno', 'melodic-house-techno'),
	('bandcamp', 'deep tech', 'minimal-deep-tech'),
	('bandcamp', 'minimal', 'minimal-deep-tech'),
	('bandcamp', 'minimal techno', 'minimal-deep-tech'),
	('bandcamp', 'techno', 'techno-peak-time-driving'),
	('bandcamp', 'deep techno', 'techno-raw-deep-hypnotic'),
	('bandcamp', 'hypnotic techno', 'techno-raw-deep-hypnotic'),
	('bandcamp', 'raw techno', 'techno-raw-deep-hypnotic'),
	('bandcamp', 'trance', 'trance-main-floor'),
	('bandcamp', 'psytrance', 'psy-trance'),
	('bandcamp', 'progressive trance', 'trance-main-floor'),
	('bandcamp', 'nu disco', 'nu-disco-disco'),
	('bandcamp', 'disco', 'nu-disco-disco'),
	('bandcamp', 'ambient', 'ambient-experimental'),
	('bandcamp', 'experimental', 'ambient-experimental'),
	('bandcamp', 'drum and bass', 'drum-bass'),
	('bandcamp', 'dnb', 'drum-bass'),
	('bandcamp', 'jungle', 'drum-bass'),
	('bandcamp', 'breaks', 'breaks-breakbeat-uk-bass'),
	('bandcamp', 'breakbeat', 'breaks-breakbeat-uk-bass'),
	('bandcamp', 'uk bass', 'breaks-breakbeat-uk-bass'),
	('bandcamp', 'uk garage', 'uk-garage-bassline'),
	('bandcamp', 'garage', 'uk-garage-bassline'),
	('bandcamp', 'bassline', 'uk-garage-bassline'),
	('bandcamp', 'house music', 'house'),
	('bandcamp', 'chillout', 'downtempo'),
	('bandcamp', 'chill out', 'downtempo'),
	('bandcamp', 'trip hop', 'downtempo'),
	('bandcamp', 'hardcore', 'hard-dance-hardcore-neo-rave'),
	('bandcamp', 'hard dance', 'hard-dance-hardcore-neo-rave'),
	('bandcamp', 'afro', 'afro-house'),
	('bandcamp', 'afro tech', 'afro-house'),
	('bandcamp', 'hip hop', 'hip-hop'),
	('bandcamp', 'rap', 'hip-hop'),
	('bandcamp', 'rnb', 'r-b'),
	('apple', 'techno', 'techno-peak-time-driving'),
	('apple', 'trance', 'trance-main-floor'),
	('apple', 'ambient', 'ambient-experimental'),
	('apple', 'idm experimental', 'ambient-experimental'),
	('apple', 'breakbeat', 'breaks-breakbeat-uk-bass'),
	('apple', 'garage', 'uk-garage-bassline'),
	('apple', 'jungle drum n bass', 'drum-bass'),
	('apple', 'hardcore', 'hard-dance-hardcore-neo-rave'),
	('apple', 'hip hop rap', 'hip-hop'),
	('apple', 'r and b soul', 'r-b');
insert into curator.genre_alias (provider, raw_fold, genre_id, confidence)
select a.provider, a.raw, g.object_id, 0.8
from store_alias_seed a join curator.catalog_genre g on g.slug = a.slug
on conflict do nothing;

-- Too broad to place.
insert into curator.genre_alias (provider, raw_fold, genre_id, confidence) values
	('bandcamp', 'electronic', null, 1),
	('bandcamp', 'electronic music', null, 1),
	('bandcamp', 'dance', null, 1),
	('bandcamp', 'edm', null, 1),
	('bandcamp', 'electro', null, 1),
	('bandcamp', 'club', null, 1),
	('bandcamp', 'dj', null, 1),
	('bandcamp', 'vinyl', null, 1),
	('bandcamp', 'remix', null, 1),
	('bandcamp', 'remixes', null, 1),
	('bandcamp', 'ep', null, 1),
	('bandcamp', 'album', null, 1),
	('bandcamp', 'compilation', null, 1),
	('apple', 'dance', null, 1),
	('apple', 'electronic', null, 1),
	('apple', 'music', null, 1)
on conflict do nothing;

---
name: curator-identify-tracks
description: Identify and enrich Curator library tracks with label, genre and release date by researching Beatport, Discogs and MusicBrainz. Use when the user asks to identify, enrich, complete or fix track metadata — e.g. "find labels for my unlabeled tracks", "fill in release dates for playlist X", "what label is this track on". Requires the Curator MCP server with the desktop app running.
---

# Identify tracks — metadata enrichment over Beatport / Discogs / MusicBrainz

You enrich Curator library tracks with **label, genre, release date** (and, where found, the Beatport link). The flow is strict: **scope → research → present a table → wait for explicit approval → update**. Never write before the user approves.

## 1. Scope the subset

Resolve which tracks the user means, using Curator tools:

- Simple scopes: `query_library` (playlistId, genre, label, search, state…).
- "Missing X" scopes: `query_workspace` SQL over `v_track`, e.g.
  `SELECT id, title, artists, duration_sec, label, genre, release_date FROM v_track WHERE label IS NULL LIMIT 25`.
- Keep a round to **≤ 25 tracks** (Beatport is rate-limited; big jobs run in rounds — tell the user and continue round by round).
- Fetch each track's existing source links along the way (`get_track_detail`) — you need to know later whether a Beatport link already exists.

## 2. Research each track

Source priority — stop when you have confident values for the fields you need:

1. **Beatport** (authoritative for electronic: label, genre, release date, BPM, key).
   Use `lookup_beatport` (title + artists + durationSec). For more than ~5 tracks, load the subset into a workspace table (`loadInto`) and fan out with `map_tool_over_table` (tool `lookup_beatport`, cap 25 rows) instead of calling once per track yourself.
   The hit carries `url` and `beatportId` — keep both. If Beatport reports itself blocked, don't retry this session; fall through to the other sources.
2. **MusicBrainz** (best for release dates; open API, no auth). Fetch
   `https://musicbrainz.org/ws/2/recording/?query=recording:"TITLE" AND artist:"ARTIST"&fmt=json`
   (URL-encode; ≤ 1 request/second). Label and date come from the recording's releases (`label-info`, `date`). Source URL: `https://musicbrainz.org/recording/<mbid>`.
3. **Discogs** (good for label + year on vinyl/older releases). Web-search `"ARTIST" "TITLE" site:discogs.com`, open the release page, read Label / Genre / Style / Released. Source URL is the release page.

**Match rule:** normalized artist + title must match, and duration within ±5 s when both sides have it. Remix/mix names must match too ("Original Mix" vs a remix are different records). Anything weaker is **low confidence** — include it in the table flagged `⚠ low`, but exclude it from the default update set.

When sources disagree: prefer Beatport for label/genre on electronic releases, MusicBrainz for release dates; say so in the Notes column.

## 3. Present the table and ask

One row per track. Show only fields you propose to change (current → found); leave confirmed-correct fields out of the patch.

| # | Track | Label | Genre | Release date | Source | Notes |
|---|-------|-------|-------|--------------|--------|-------|
| 1 | Artist — Title | — → Afterlife | Melodic Techno (unchanged) | — → 2023-05-12 | [Beatport](url) | |
| 2 | … | | | | [MusicBrainz](url) | ⚠ low: duration off by 9s |

Then ask explicitly, e.g.: *"Update Curator with these values? You can exclude rows (e.g. 'all except 2')."* **Wait for the answer. Do not update without it.**

## 4. Apply on approval

For the approved rows only:

1. `update_track_fields` with the approved values (`label`, `genre`, `releaseDate` — dates as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`). Group tracks that share an identical patch into one bulk call; otherwise one call per track. These land as user overrides — they survive future syncs.
2. **Beatport link rule:** for every row whose data came from Beatport where the track has **no existing beatport source link** (check the source links you fetched in step 1), also call `set_track_source_links` with the Beatport URL. This links the track and triggers a server-side Beatport refetch that fills remaining canonical fields. Do the link call *in addition to* step 1, not instead of it.
3. Surface any per-source errors returned (e.g. "already linked to another library track" — an identity conflict the user must resolve; never force it).

## 5. Report

Summarize: N tracks updated (which fields), M Beatport links added, rows skipped (low confidence / excluded / errors). Offer the next round if the scope had more tracks than this pass covered.

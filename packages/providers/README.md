# providers

Per-service client packages. Each subdirectory is its own workspace package and owns the
auth + fetch + normalization for one external source. They're pure clients — no DB, no app
state — so `@curator/core` can compose them.

| Package | Source | What it does |
|---|---|---|
| `@curator/spotify` (`spotify/`) | Spotify | PKCE OAuth + Web API client (user data, playlists, tracks) |
| `@curator/tidal` (`tidal/`) | Tidal | OAuth (auth-code + PKCE + client_secret); token refresh owned by the caller |
| `@curator/beatport` (`beatport/`) | Beatport | HTML-scrape client + scorer (no public API). Strict accept: ISRC **or** title+artist+duration |
| `@curator/traxsource` (`traxsource/`) | Traxsource | HTML-scrape client (search page only; detail pages blocked by WAF). Gap-fill for Beatport misses |
| `@curator/musicbrainz` (`musicbrainz/`) | MusicBrainz | ISRC-pivot lookup + cross-platform URL harvest; rate-limited to ~1 req/s per policy |

The Beatport and Traxsource clients share [`@curator/matcher`](../matcher/) for accept/score
decisions. Both honor a debug env var (`CURATOR_BP_DEBUG=1`, `CURATOR_TX_DEBUG=1`). Key
notations are converted to Camelot at the client boundary.

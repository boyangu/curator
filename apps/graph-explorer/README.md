# @curator/graph-explorer

An **experimental side-app**: an in-memory knowledge-graph view of `curator.db`. No backend,
no graph database — it loads an exported snapshot and builds the graph in the browser.

It visualizes the local library as a network of tracks and their artist / label / genre
relationships, laid out with a force-directed algorithm. A scratchpad for experimenting with
graph modeling over the library, separate from the main desktop app.

## Stack

- [`graphology`](https://graphology.github.io/) — graph data structure
- `graphology-layout-forceatlas2` — ForceAtlas2 force-directed layout
- [`sigma`](https://www.sigmajs.org/) v3 — WebGL renderer
- Vite

## Data

`pnpm export` runs `scripts/export-graph.mjs`, which reads `curator.db` and writes
`graph-data.json` (a flat track list with denormalized artist / genre / label / BPM / key /
release date). **Only local files are included** — tracks with a `source='local'` source-link;
streaming-only tracks are excluded by design. The app loads that JSON; it never touches the DB
at runtime.

The UI has per-label / genre / artist filters with min-track thresholds and node search.

## Run

```bash
pnpm --filter @curator/graph-explorer export   # regenerate graph-data.json from curator.db
pnpm --filter @curator/graph-explorer dev       # Vite dev server
```

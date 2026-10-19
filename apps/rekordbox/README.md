# curator-rekordbox

Python sidecar that reads the user's Rekordbox library (`master.db` + ANLZ
files) and feeds selected fields into Curator's SQLite via stdio JSON-RPC.

## Running locally (dev)

```bash
cd apps/rekordbox
uv venv
uv pip install -e .

# Cache the SQLCipher key once per machine (community-cached fetch).
# Required on rekordbox >= 6.6.5.
python -m pyrekordbox download-key

# Smoke test — should print one detect frame then exit on EOF.
echo '{"id":1,"method":"detect"}' | python -m curator_rekordbox.main
```

## Protocol

Documented at the top of `src/curator_rekordbox/main.py`. Mirror in the Node
sidecar manager at `apps/core/src/rekordbox/sidecar.ts`.

## Bundling for production

PyInstaller `--onedir` artifact at `resources/rekordbox/curator-rekordbox(.exe)`.
Same packaging pattern as the analyzer sidecar; see `scripts/build-sidecar.sh` (TODO).

"""Curator analyzer sidecar — see main.py for the entry point."""

# 2.3.0: brightness is now the learned curator-aligned score (was raw spectral
# centroid); adds `power`. Both via scoring.py over one MusicExtractor pass.
# 2.4.0: adds the Chromaprint fingerprint stage (source_link.fingerprint). The
# analysis scalars and grid are unchanged, so the queue's full-re-analysis
# floor (MIN_FULL_REANALYSIS_VERSION in apps/core/src/analyzer/queue.ts)
# stays at 2.3.0 — missing prints are backfilled by a decode-only pass.
ANALYZER_VERSION = "2.4.0"

# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
#
# The syntax line pins the BuildKit frontend too (docker/dockerfile:1, which
# was 1.27 on 2026-10-19): it is code the builder downloads and runs.
#
# The cloud API image (apps/cloud), built from the repo root so the workspace
# packages it bundles (`@curator/protocol`) are in the build context. Only the
# cloud package and its workspace dependencies are installed; the desktop,
# its Electron download and every native SQLite module stay out.
#
#   docker build -t curator-api .
#
# Production images are built only by scripts/release-cloud.mjs, from a
# `git archive` of a tagged commit on main (apps/cloud/README.md "Release"),
# which passes GIT_SHA.
#
# .dockerignore whitelists what the build needs; anything new the cloud build
# reads has to be added there.
#
# The base image is pinned by digest (the multi-arch index), so a rebuild of
# the same commit gets the same Node and Debian; Dependabot (docker) bumps
# it. Tag: node:22-slim, Node 22.23.3 on bookworm, resolved 2026-10-19.

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# pnpm comes from the root package.json's `packageManager` field.
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @curator/cloud...
RUN pnpm --filter @curator/cloud build
# A self-contained copy of the package with production dependencies only:
# dist/ (server + CLIs, workspace code bundled in) and sql/ (migrations).
RUN pnpm deploy --filter @curator/cloud --prod /out

# node:22-slim, the same digest as above.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ENV NODE_ENV=production
ENV PORT=8080
# The V8 heap cap, set for the 512 MB Fly machine (fly.toml [[vm]]) rather
# than left to V8's guess from the memory it detects. A snapshot build holds
# one user's whole folded library on the heap, plus Buffers outside it (the
# gunzipped JSON, the gzip output). A build too big for the machine should
# end as V8's "JavaScript heap out of memory", its stack on stderr in Fly's
# logs, not as a SIGKILL from the kernel's OOM killer with nothing from the
# process to say what it was doing. Fatal either way (Fly restarts the
# machine); the difference is knowing why. 384 MB of heap leaves ~128 MB for
# what lives outside it: code, the young generation, those Buffers. Through
# NODE_OPTIONS so it reaches every node process in the image, the CLIs run
# over `fly ssh console` included, and so a bigger machine is a fly.toml
# change: set NODE_OPTIONS there in [env], about 3/4 of the new memory.
ENV NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY --from=build --chown=node:node /out .
# Build provenance, served by the health procedure. Declared after the
# COPY so a new commit does not invalidate the cached layers above.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server.js"]

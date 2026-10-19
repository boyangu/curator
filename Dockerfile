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
# Production images are built by .github/workflows/deploy-cloud.yml only
# (apps/cloud/README.md "Release"), which passes GIT_SHA.
#
# .dockerignore whitelists what the build needs; anything new the cloud build
# reads has to be added there.
#
# The base image is pinned by digest (the multi-arch index), so a rebuild of
# the same commit gets the same Node and Debian; Dependabot (docker) bumps
# it. Tag: node:22-slim, Node 22.23.3 on bookworm, resolved 2026-10-19.

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
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
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out .
# Build provenance, served by the health procedure. Declared after the
# COPY so a new commit does not invalidate the cached layers above.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server.js"]

# syntax=docker/dockerfile:1.7
FROM node:24.19.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_CONFIG_FETCH_TIMEOUT=300000
ENV PNPM_CONFIG_FETCH_RETRIES=5
ENV PNPM_CONFIG_NETWORK_CONCURRENCY=8
RUN --mount=type=cache,id=aeonic-apt-build-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=aeonic-apt-build-cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends g++ make python3
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=aeonic-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @aeonic/api...
COPY apps apps
COPY packages packages
COPY scripts scripts
RUN pnpm --filter @aeonic/api... build

FROM node:24.19.0-bookworm-slim AS runtime
RUN --mount=type=cache,id=aeonic-apt-runtime-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=aeonic-apt-runtime-cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends \
    ca-certificates ffmpeg fonts-dejavu-core libreoffice-calc libreoffice-impress \
    libreoffice-writer poppler-utils tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /workspace/apps/api/drizzle ./apps/api/drizzle
COPY --from=build --chown=node:node /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /workspace/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /workspace/packages/contracts/package.json ./packages/contracts/package.json
RUN mkdir -p /app/data/objects /app/data/tus && chown -R node:node /app/data
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/api/dist/index.js"]

# syntax=docker/dockerfile:1.7
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_CONFIG_FETCH_TIMEOUT=300000
ENV PNPM_CONFIG_FETCH_RETRIES=5
ENV PNPM_CONFIG_NETWORK_CONCURRENCY=8
RUN --mount=type=cache,id=aeonic-apt-build-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=aeonic-apt-build-cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends g++ make python3
RUN corepack enable \
  && attempt=1 \
  && until corepack install --global pnpm@11.25.0; do \
    [ "$attempt" -ge 5 ] && exit 1; \
    sleep "$((attempt * 2))"; \
    attempt="$((attempt + 1))"; \
  done
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
RUN --mount=type=cache,id=aeonic-pnpm-store,target=/pnpm/store \
    pnpm --filter @aeonic/api deploy --prod /opt/aeonic \
  && mkdir -p /opt/aeonic/data/objects /opt/aeonic/data/tus

FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS worker-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_CONFIG_FETCH_TIMEOUT=300000
ENV PNPM_CONFIG_FETCH_RETRIES=5
ENV PNPM_CONFIG_NETWORK_CONCURRENCY=8
RUN --mount=type=cache,id=aeonic-apk-worker-build,target=/var/cache/apk,sharing=locked \
    attempt=1 \
  && until apk add --no-cache build-base python3; do \
    [ "$attempt" -ge 5 ] && exit 1; \
    sleep "$((attempt * 2))"; \
    attempt="$((attempt + 1))"; \
  done
RUN corepack enable \
  && attempt=1 \
  && until corepack install --global pnpm@11.25.0; do \
    [ "$attempt" -ge 5 ] && exit 1; \
    sleep "$((attempt * 2))"; \
    attempt="$((attempt + 1))"; \
  done
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN --mount=type=cache,id=aeonic-pnpm-worker-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @aeonic/api...
COPY apps apps
COPY packages packages
COPY scripts scripts
RUN pnpm --filter @aeonic/api... build
RUN --mount=type=cache,id=aeonic-pnpm-worker-store,target=/pnpm/store \
    pnpm --filter @aeonic/api deploy --prod /opt/aeonic \
  && mkdir -p /opt/aeonic/data/objects /opt/aeonic/data/tus

FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS worker
RUN --mount=type=cache,id=aeonic-apk-worker,target=/var/cache/apk,sharing=locked \
    attempt=1 \
  && until apk add --no-cache ffmpeg font-dejavu libreoffice poppler-utils tini; do \
    [ "$attempt" -ge 5 ] && exit 1; \
    sleep "$((attempt * 2))"; \
    attempt="$((attempt + 1))"; \
  done \
  && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-build --chown=node:node /opt/aeonic ./
USER node
ENTRYPOINT ["/sbin/tini", "--", "node"]
CMD ["--enable-source-maps", "dist/worker.js"]

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /opt/aeonic ./
USER 1000:1000
CMD ["--enable-source-maps", "dist/index.js"]

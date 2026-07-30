# Pharos API image — referenced by deploy/docker-compose.prod.yml
# (${PHAROS_IMAGE:-pharos/api:latest}) and deploy/helm/values.yaml, which
# shipped without any Dockerfile in the repo.
#
# Runtime executes TypeScript sources via tsx: the workspace package manifests
# export ./src/*.ts directly, so a dist-only image would require rewriting
# 15+ package.json exports. tsx keeps the image faithful to how CI runs.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable \
  && corepack prepare pnpm@10.32.1+sha512.a706938f0e89ac1456b6563eab4edf1d1faf3368d1191fc5c59790e96dc918e4456ab2e67d613de1043d2e8c81f87303e6b40d4ffeca9df15ef1ad567348f2be --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# Build is a validation gate (typecheck via tsc project builds), not the runtime artifact.
RUN pnpm build
# Materialize only the API's production dependency closure. This excludes the
# console, Vitest/Vite, linters, compilers, and other build-only workspace
# dependencies from the artifact that is scanned, signed, and deployed.
RUN pnpm --filter @pharos/api deploy --prod --legacy /prod

FROM ${NODE_IMAGE}
ARG NODE_IMAGE
LABEL org.opencontainers.image.base.name="${NODE_IMAGE}"
WORKDIR /app
ENV NODE_ENV=production
# Consume Debian security updates at image-build time and remove Node's global
# package-management toolchain. The service only needs the node runtime plus
# its deployed production closure; retaining npm/corepack in production adds
# unused archive, glob, and signing clients to the attack surface.
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Local-kms keystore location; docker-compose.prod.yml mounts a named volume
# here so signing keys survive container replacement.
ENV PHAROS_KMS_KEYSTORE_DIR=/var/lib/pharos/keys/keystore
ENV PHAROS_JUDGE_MODEL_DIR=/var/lib/pharos/judges
COPY --from=build --chown=node:node /prod /app
RUN mkdir -p /var/lib/pharos/keys /var/lib/pharos/judges && chown -R node:node /var/lib/pharos
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PHAROS_API_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/server.ts"]

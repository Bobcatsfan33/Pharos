# syntax=docker/dockerfile:1
# Pharos API image — referenced by deploy/docker-compose.prod.yml
# (${PHAROS_IMAGE:-pharos/api:latest}) and deploy/helm/values.yaml, which
# shipped without any Dockerfile in the repo.
#
# Runtime executes TypeScript sources via tsx: the workspace package manifests
# export ./src/*.ts directly, so a dist-only image would require rewriting
# 15+ package.json exports. tsx keeps the image faithful to how CI runs.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# Build is a validation gate (typecheck via tsc project builds), not the runtime artifact.
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Local-kms keystore location; docker-compose.prod.yml mounts a named volume
# here so signing keys survive container replacement.
ENV PHAROS_KMS_KEYSTORE_DIR=/var/lib/pharos/keys/keystore
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /var/lib/pharos/keys && chown -R node:node /var/lib/pharos
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PHAROS_API_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "services/api/src/server.ts"]

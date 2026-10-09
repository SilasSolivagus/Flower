FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @flower/core build:migrate && pnpm --filter @flower/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 FLOWER_MIGRATIONS_DIR=/app/migrations FLOWER_STORAGE_DIR=/app/data/storage
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/packages/core/dist/migrate.mjs ./migrate.mjs
COPY --from=build /repo/packages/core/migrations ./migrations
COPY docker/entrypoint.sh ./entrypoint.sh
RUN mkdir -p /app/data/storage && chown -R node:node /app/data
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "./entrypoint.sh"]

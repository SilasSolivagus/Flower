FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile

FROM deps AS build
# 看板图片用的字体：下载并校验 sha256，复制到运行镜像。用 curl：busybox wget 经 HTTPS 代理下载会失败
COPY scripts/fetch-fonts.sh scripts/
RUN apk add --no-cache curl && ./scripts/fetch-fonts.sh
COPY . .
RUN pnpm --filter @flower/core build:migrate && pnpm --filter @flower/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 FLOWER_MIGRATIONS_DIR=/app/migrations FLOWER_STORAGE_DIR=/app/data/storage FLOWER_FONT_DIR=/app/fonts
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/packages/core/dist/migrate.mjs ./migrate.mjs
COPY --from=build /repo/packages/core/migrations ./migrations
COPY --from=build /repo/packages/core/assets/fonts ./fonts
COPY docker/entrypoint.sh ./entrypoint.sh
RUN mkdir -p /app/data/storage && chown -R node:node /app/data
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "./entrypoint.sh"]

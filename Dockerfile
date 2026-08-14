FROM node:20-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
# pnpm resolves workspace dependencies from each package manifest at install
# time. Copy every frontend manifest before installing so their build-only
# React, Vite, and type packages are present when the workspace build runs.
COPY packages/ops-console/package.json ./packages/ops-console/package.json
COPY packages/mock-consumer/package.json ./packages/mock-consumer/package.json
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY packages ./packages
RUN pnpm build && pnpm prune --prod

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/runtime-api/src/db/migrations ./dist/packages/runtime-api/src/db/migrations
COPY --from=build /app/packages/runtime-api/src/db/seed.sql ./dist/packages/runtime-api/src/db/seed.sql
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]

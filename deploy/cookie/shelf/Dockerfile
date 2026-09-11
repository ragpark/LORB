# The logic tier on Cookie: the Runtime API with the Evidence API, the evidence forwarder, and the
# three browser applications served from this process (SERVE_WEB_APPS). One image, one container,
# port 8080, non-root, on the platform's approved Node base. Migrations run at start-up, once per
# deploy, under the advisory lock the setup script takes; see start.sh.
#
# This file is exported to the root of the Cookie app repository by deploy/cookie/export.sh; in
# this repository the root Dockerfile stays on a public base for docker compose.
FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24 AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY src ./src
RUN pnpm install --frozen-lockfile
RUN pnpm build && pnpm prune --prod

FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24
ENV NODE_ENV=production \
    PORT=8080 \
    SERVE_WEB_APPS=true \
    PLATFORM_SESSION_ENDPOINT=true \
    WEB_APPS_ROOT=web
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/runtime-api/src/db/migrations ./dist/packages/runtime-api/src/db/migrations
COPY --from=build --chown=node:node /app/packages/runtime-api/src/db/seed.sql ./dist/packages/runtime-api/src/db/seed.sql
COPY --from=build --chown=node:node /app/packages/learner-portal/dist ./web/portal
COPY --from=build --chown=node:node /app/packages/admin-ui/dist ./web/admin
COPY --from=build --chown=node:node /app/packages/ops-console/dist ./web/console
COPY --chown=node:node start.sh ./start.sh
USER node
EXPOSE 8080
CMD ["sh", "./start.sh"]

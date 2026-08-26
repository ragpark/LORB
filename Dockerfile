FROM node:20-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
# The whole workspace, before installing. This used to be a hand-written list of the manifests the
# root build happens to need, kept short so a source change did not invalidate the install layer.
# That list is a second copy of the dependency graph, and it drifted the moment a package was added:
# `@lorb/web-auth` arrived as a dependency of learner-portal, nothing copied its manifest, and every
# image build died in `pnpm install` with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. A list that has to be
# updated by whoever remembers is not worth the layer cache it buys.
COPY packages ./packages
COPY src ./src
RUN pnpm install --no-frozen-lockfile
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

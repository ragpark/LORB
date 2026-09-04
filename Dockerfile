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
# The browser applications. `pnpm build` above already builds all three, so this copies bundles the
# build stage has produced regardless; carrying them costs a few megabytes and buys one artifact
# that serves either topology. SERVE_WEB_APPS decides at run time whether they are actually served,
# so the same image is what runs behind separate static origins and what serves them itself, and
# switching between the two is a variable rather than a rebuild.
COPY --from=build /app/packages/learner-portal/dist ./web/portal
COPY --from=build /app/packages/admin-ui/dist ./web/admin
COPY --from=build /app/packages/ops-console/dist ./web/console
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]

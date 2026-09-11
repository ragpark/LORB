# The learning record store on Cookie: packages/lrs on its own, with its own database. The xAPI
# resources are served under /api/xapi (LRS_PATH_PREFIX), the one prefix the platform's sign-in
# gateway leaves to callers that carry their own credentials; /health and /ready stay at the root.
FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24 AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY src ./src
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -p tsconfig.build.json && pnpm prune --prod

FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24
ENV NODE_ENV=production \
    PORT=8080 \
    LRS_PATH_PREFIX=/api/xapi
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/lrs/src/migrations ./dist/packages/lrs/src/migrations
USER node
EXPOSE 8080
CMD ["node", "dist/packages/lrs/src/server.js"]

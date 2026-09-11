# The Player Shell and the bundled content packages on Cookie. Static files, served by a small Node
# server (server.mjs) rather than nginx, which the platform has no approved base for. Everything is
# served under /api — the one prefix the sign-in gateway leaves unauthenticated — because a module
# runs in an iframe sandboxed without allow-same-origin, sends no cookies, and could never sign in.
FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24 AS build
RUN npm install -g pnpm@9.15.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY src ./src
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
RUN pnpm --filter player-shell build \
    && pnpm --filter example-react-xapi-experience build \
    && pnpm --filter quiz-player build \
    && pnpm --filter video-player build \
    && pnpm --filter document-player build \
    && pnpm --filter audio-player build \
    && pnpm --filter ebook-player build

FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24
ENV NODE_ENV=production \
    PORT=8080 \
    PLAYER_BASE_PATH=/api
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
COPY --from=build --chown=node:node /app/packages/player-shell/dist ./www
COPY --from=build --chown=node:node /app/packages/player-shell/lti-launch-fallback ./www/modules/lti-launch
COPY --from=build --chown=node:node /app/packages/player-shell/external-embed-fallback ./www/modules/external-embed
COPY --from=build --chown=node:node /app/packages/example-module/src ./www/module
COPY --from=build --chown=node:node /app/packages/example-react-xapi-experience/dist ./www/modules/reflective-practice-studio
COPY --from=build --chown=node:node /app/packages/example-coaching-chatbot/src ./www/modules/career-coach-chat
COPY --from=build --chown=node:node /app/packages/quiz-player/dist ./www/modules/quiz-player
COPY --from=build --chown=node:node /app/packages/coach-player/src ./www/modules/coach-player
COPY --from=build --chown=node:node /app/packages/video-player/dist ./www/modules/video-player
COPY --from=build --chown=node:node /app/packages/document-player/dist ./www/modules/document-player
COPY --from=build --chown=node:node /app/packages/audio-player/dist ./www/modules/audio-player
COPY --from=build --chown=node:node /app/packages/ebook-player/dist ./www/modules/ebook-player
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

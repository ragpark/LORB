# Build stage — compiles the Vite/React app
FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage — tiny Node static host, non-root, port 8080, /health
FROM 322587279590.dkr.ecr.eu-west-2.amazonaws.com/node:26-alpine3.24
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY package.json ./
EXPOSE 8080
USER 1000
CMD ["node", "server/index.mjs"]

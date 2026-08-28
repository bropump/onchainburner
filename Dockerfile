FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.quote-service.json ./
COPY quote-service ./quote-service
RUN pnpm exec tsc -p tsconfig.quote-service.json && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/dist ./dist
USER node

CMD ["node", "dist/quote-service/server.js"]

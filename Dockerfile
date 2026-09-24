FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/duelloop-0.2.1.tgz ./vendor/duelloop-0.2.1.tgz
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ARG APP_REVISION=local
ENV APP_REVISION=$APP_REVISION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/jev.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/duelloop-0.2.1.tgz ./vendor/duelloop-0.2.1.tgz
RUN npm ci --omit=dev && mkdir -p /app/data && chown -R node:node /app/data
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/cli/serve.js"]

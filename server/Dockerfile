# One image, three roles: ROLE=api | gateway | worker (spec §14). `ROLE=all` for dev/single-node.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY image ./image
COPY migrations ./migrations
COPY scripts/check-dist-sandbox-provider.mjs ./scripts/check-dist-sandbox-provider.mjs
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ENV NODE_ENV=production
# The source commit, so a running server can name its revision (/v1/version) and record it
# when it opens a migration-held launch gate (UPGRADE_ON_START). CI passes it; a local build
# can pass --build-arg SOURCE_SHA=$(git rev-parse HEAD).
ARG SOURCE_SHA=
ENV PIPOD_SOURCE_SHA=${SOURCE_SHA}
WORKDIR /app
# wget is required for the Compose healthcheck.
RUN apk add --no-cache wget \
  && addgroup -g 10001 -S pipod \
  && adduser -u 10001 -S -G pipod -H -s /sbin/nologin pipod
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/image ./image
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./
# The web dashboard's static files, served at /dashboard/.
COPY dashboard ./dashboard
# Zitadel setup scripts, which selfhost/upgrade and selfhost/add-user run in this image.
COPY zitadel ./zitadel
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/main.js"]

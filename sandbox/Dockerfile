# The service runs as root and needs mount, cgroup, and netlink access on the host it manages
# (§2): it is the thing creating containers, not a thing running inside one. Debian rather than
# Alpine because node-pty and better-sqlite3 build against glibc and crun ships packaged here.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build \
 && ./scripts/build-init.sh \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# crun runs the sandboxes; iproute2/nftables build their networks; e2fsprogs + mount
# create the sparse fixed-size ext4 filesystem behind each writable overlay; tar+zstd+attr
# pack archives (attr supplies setfattr, without which overlayfs opaque-directory whiteouts
# cannot be reproduced on pull); ca-certificates lets the registry client verify TLS; tini is
# the reaping PID 1 below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      crun \
      iproute2 \
      nftables \
      e2fsprogs \
      mount \
      tar \
      zstd \
      attr \
      ca-certificates \
      curl \
      tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/bin/pps-init /usr/local/lib/pi-pod-sandbox/pps-init
ENV PI_POD_SANDBOX_INIT=/usr/local/lib/pi-pod-sandbox/pps-init
VOLUME ["/state"]
EXPOSE 8433
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://localhost:8433/v1/healthz || exit 1
# `crun run -d` detaches the sandbox: the runtime process and the in-sandbox init reparent to
# PID 1 here, and node reaps only children it spawned itself, so every stopped sandbox left two
# zombies behind. PID 1 has to be something that reaps.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

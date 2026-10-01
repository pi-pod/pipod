# image/Dockerfile  (built via: pi-pod image build)
#
# The canonical artifact is a plain OCI image (§12). Each adapter maps it to its provider's
# native form — Daytona ingests it as a snapshot. One Dockerfile, every provider.
#
# Pinned to a specific Debian release rather than a floating tag, so a rebuild of the same
# image tag is reproducible. If your organization forbids direct pulls from public
# registries, repoint this one line at your mirror — it is the only registry reference in
# the whole repo.
FROM node:22-bookworm-slim

# build-essential is here for pi extensions with native dependencies (§7.5). Those normally
# install a prebuilt binary and never touch a compiler — but when no prebuild matches this
# platform and Node ABI, npm falls back to node-gyp, and without a toolchain that fallback
# fails at compile time. It failed *earlier* than that until recently, because node-gyp could
# not reach nodejs.org for headers either; fixing only the egress side would have moved the
# error from "cannot fetch headers" to "no such file or directory: make", which is not better.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git gh ripgrep jq curl openssh-client python3 python3-pip \
      tmux procps \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

ARG PI_VERSION=latest
# no --ignore-scripts: TUI deps (e.g. node-pty) may need postinstall native builds
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}


# pi extension packages (§7.5), one `npm:`-style source per line. Empty for an image built
# without them, in which case this is a no-op layer.
#
# Installed here rather than at session start because it is the same bytes every time — ~450 MB
# and a native-module build for a representative list. The tag carries a digest of this file,
# so an image and its package set cannot disagree.
#
# Built *in* the image rather than copied from the host on purpose: this list pulls in native
# modules, and a host `node_modules` is compiled for the developer's own platform (typically
# darwin/arm64). Those binaries do not load here, and would fail as a confusing require error
# rather than as a missing package.
# pi-packages.txt is the full source list (provenance; the tag digests it). The launcher
# also writes pi-packages-npm.txt with only the resolved npm specs, one per line, so this
# step needs no sed/grep filtering — template builders (E2B) re-parse the Dockerfile and
# have mangled regex escapes in that pipeline before, silently baking zero packages.
COPY pi-packages.txt /usr/local/share/pi-pod/pi-packages.txt
COPY pi-packages-npm.txt /usr/local/share/pi-pod/pi-packages-npm.txt
RUN if [ -s /usr/local/share/pi-pod/pi-packages-npm.txt ]; then \
      mkdir -p /root/.pi/agent/npm && \
      xargs --no-run-if-empty npm install --prefix /root/.pi/agent/npm --legacy-peer-deps \
        < /usr/local/share/pi-pod/pi-packages-npm.txt; \
    fi

# Bake script: the org/template/project `bake.sh` layers, composed by the launcher into one
# file (empty for an image built without one, in which case both steps are no-op layers).
# The tag carries a digest of this file, so editing any bake layer derives a new image
# rather than mutating this one. Deliberately the last layer: a bake edit re-uses every
# layer above it. Runs with no secrets and no /workspace — an image build has neither, and
# the launcher's live fallback run of the same script matches that on purpose, so a bake
# script that depends on either fails the same way on both paths.
COPY bake.sh /usr/local/share/pi-pod/bake.sh
RUN if [ -s /usr/local/share/pi-pod/bake.sh ]; then \
      cd /root && CI=1 DEBIAN_FRONTEND=noninteractive bash /usr/local/share/pi-pod/bake.sh; \
    fi

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /workspace

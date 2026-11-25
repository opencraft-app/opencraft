# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
FROM ${NODE_IMAGE} AS build
ARG OPENCRAFT_BUILD_ID=development
ARG OPENCRAFT_SOURCE_REVISION=unknown
ARG SOURCE_DATE_EPOCH
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV NODE_OPTIONS=--max-old-space-size=4096
WORKDIR /src
COPY . .
RUN test "$(node --version)" = "v$(cat .nvmrc)"
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN --mount=type=cache,target=/root/.npm env -u ELECTRON_SKIP_BINARY_DOWNLOAD node scripts/packaging/package-container.mjs /out

# Export with --target host-artifact --output type=local,dest=./.local/docker-host.
FROM scratch AS host-artifact
COPY --from=build /out/opencraft-server/ /

FROM ${RUNTIME_IMAGE} AS runtime-payload
ARG OPENCRAFT_UID=1000
ARG OPENCRAFT_GID=1000
ARG OPENCRAFT_BUILD_ID=development
ARG OPENCRAFT_SOURCE_REVISION=unknown
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 ca-certificates git openssh-client libatomic1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    fonts-noto-cjk fonts-noto-color-emoji \
    libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && if ! getent group "${OPENCRAFT_GID}" >/dev/null; then groupadd --gid "${OPENCRAFT_GID}" opencraft; fi \
    && if ! getent passwd "${OPENCRAFT_UID}" >/dev/null; then useradd --uid "${OPENCRAFT_UID}" --gid "${OPENCRAFT_GID}" --no-create-home opencraft; fi
COPY deploy/docker/install-sandbox-deps.sh /usr/local/share/opencraft/install-sandbox-deps.sh
RUN /bin/sh /usr/local/share/opencraft/install-sandbox-deps.sh
COPY --from=build /out/opencraft-server /opt/opencraft
LABEL org.opencontainers.image.title="OpenCraft" \
      org.opencontainers.image.description="OpenCraft self-hosted Gateway, Brain and Hands runtime" \
      org.opencontainers.image.source="https://github.com/opencraft-app/opencraft" \
      org.opencontainers.image.licenses="MIT-0" \
      org.opencontainers.image.version="${OPENCRAFT_BUILD_ID}" \
      org.opencontainers.image.revision="${OPENCRAFT_SOURCE_REVISION}"
# /var/lib/opencraft-workspace is the layout of a provisioned workspace volume
# (docker-provisioner): Docker copies it into the empty named volume on first mount.
RUN chown root:root /opt/opencraft/runtime/browser/electron/chrome-sandbox \
    && chmod 4755 /opt/opencraft/runtime/browser/electron/chrome-sandbox \
    && install -d -o "${OPENCRAFT_UID}" -g "${OPENCRAFT_GID}" -m 0700 /run/opencraft-agent \
    && install -d -o "${OPENCRAFT_UID}" -g "${OPENCRAFT_GID}" -m 0700 /var/lib/opencraft-workspace \
       /var/lib/opencraft-workspace/data /var/lib/opencraft-workspace/data/execution \
       /var/lib/opencraft-workspace/workspace /var/lib/opencraft-workspace/logs
ENV PATH=/opt/opencraft/bin:$PATH
WORKDIR /opt/opencraft
USER ${OPENCRAFT_UID}:${OPENCRAFT_GID}

# Cloudflare workspace: the same pinned release payload, including the
# AppServer and official Hands exec-server, under one workspace agent.
FROM runtime-payload AS workspace
ENV OPENCRAFT_DATA_DIR=/var/lib/opencraft-workspace/data \
    OPENCRAFT_WORKSPACE_DIR=/var/lib/opencraft-workspace/workspace \
    OPENCRAFT_LOG_DIR=/var/lib/opencraft-workspace/logs \
    OPENCRAFT_HANDS_EXECUTION_SOCKET=/var/lib/opencraft-workspace/data/execution/exec-owner.sock \
    OPENCRAFT_HANDS_EXECUTION_TOKEN=/var/lib/opencraft-workspace/data/execution/exec-owner.token \
    OPENCRAFT_CODEX_EXECUTABLE=/opt/opencraft/runtime/codex/bin/codex \
    OPENCRAFT_PROXY_MODE=workspace-egress \
    HOME=/var/lib/opencraft-workspace/data
ENTRYPOINT ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/workspace-agent.mjs", "--role", "hands", "--role", "brain"]

# Cloudflare exposes a delegated cgroup root. Set the owner budget as PID 1
# before dropping to the workspace user and starting the standard entrypoint.
FROM workspace AS cloudflare-workspace
USER root
ENV OPENCRAFT_CLOUDFLARE_UID=${OPENCRAFT_UID} OPENCRAFT_CLOUDFLARE_GID=${OPENCRAFT_GID}
COPY --chmod=0555 deploy/docker/start-cloudflare-workspace.sh /usr/local/bin/start-cloudflare-workspace
ENTRYPOINT ["/usr/local/bin/start-cloudflare-workspace"]

FROM runtime-payload AS runtime
ENTRYPOINT ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/container-service.mjs", "gateway"]

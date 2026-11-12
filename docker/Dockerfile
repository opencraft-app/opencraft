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
RUN --mount=type=cache,target=/root/.npm env -u ELECTRON_SKIP_BINARY_DOWNLOAD node scripts/package-container.mjs /out

# Export with --target host-artifact --output type=local,dest=./.local/docker-host.
FROM scratch AS host-artifact
COPY --from=build /out/opencraft-server/ /

FROM ${RUNTIME_IMAGE} AS runtime
ARG OPENCRAFT_BUILD_ID=development
ARG OPENCRAFT_SOURCE_REVISION=unknown
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-client libatomic1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    fonts-noto-cjk fonts-noto-color-emoji \
    libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 opencraft && useradd --uid 1000 --gid 1000 --no-create-home opencraft
COPY --from=build /out/opencraft-server /opt/opencraft
LABEL org.opencontainers.image.title="OpenCraft" \
      org.opencontainers.image.description="OpenCraft self-hosted Gateway, Brain and Hands runtime" \
      org.opencontainers.image.source="https://github.com/opencraft-app/opencraft" \
      org.opencontainers.image.licenses="MIT-0" \
      org.opencontainers.image.version="${OPENCRAFT_BUILD_ID}" \
      org.opencontainers.image.revision="${OPENCRAFT_SOURCE_REVISION}"
RUN chown root:root /opt/opencraft/runtime/browser/electron/chrome-sandbox \
    && chmod 4755 /opt/opencraft/runtime/browser/electron/chrome-sandbox
ENV PATH=/opt/opencraft/bin:$PATH
WORKDIR /opt/opencraft
USER 1000:1000
ENTRYPOINT ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/container-gateway.mjs"]

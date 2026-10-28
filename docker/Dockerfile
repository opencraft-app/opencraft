# syntax=docker/dockerfile:1
ARG NODE_VERSION=26.7.0
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /src
COPY . .
RUN test "$(node --version)" = "v$(cat .nvmrc)"
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN --mount=type=cache,target=/root/.npm env -u ELECTRON_SKIP_BINARY_DOWNLOAD node scripts/package-container.mjs /out

# Export with --target host-artifact --output type=local,dest=./.local/docker-host.
FROM scratch AS host-artifact
COPY --from=build /out/opencraft-server/ /

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-client libatomic1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 opencraft && useradd --uid 1000 --gid 1000 --no-create-home opencraft
COPY --from=build /out/opencraft-server /opt/opencraft
ENV PATH=/opt/opencraft/bin:$PATH
WORKDIR /opt/opencraft
USER 1000:1000
ENTRYPOINT ["/opt/opencraft/bin/node", "/opt/opencraft/runtime/container-gateway.mjs"]

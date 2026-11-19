# syntax=docker/dockerfile:1
# Component update for an existing OpenCraft Linux x64 application image.
# Supply the verified distribution as the named context "owned-electron".
ARG BASE_IMAGE=opencraft:local
FROM ${BASE_IMAGE}
USER 0
ARG OPENCRAFT_SOURCE_REVISION
ARG OPENCRAFT_BASE_IMAGE_ID
ARG RUNTIME_USER=1000:1000
COPY vendor/electron/fork.json /tmp/opencraft-browser-install/fork.json
COPY scripts/install-owned-browser-runtime.mjs scripts/remote-browser-artifact.mjs /tmp/opencraft-browser-install/
RUN --mount=type=bind,from=owned-electron,target=/tmp/opencraft-owned-electron,ro \
    /opt/opencraft/bin/node /tmp/opencraft-browser-install/install-owned-browser-runtime.mjs \
    /tmp/opencraft-owned-electron /opt/opencraft /tmp/opencraft-browser-install/fork.json \
    "$OPENCRAFT_SOURCE_REVISION" "$OPENCRAFT_BASE_IMAGE_ID" \
    && chown root:root /opt/opencraft/runtime/browser/electron/chrome-sandbox \
    && chmod 4755 /opt/opencraft/runtime/browser/electron/chrome-sandbox \
    && rm -rf /tmp/opencraft-browser-install
LABEL app.opencraft.browser.source-revision="${OPENCRAFT_SOURCE_REVISION}" \
      app.opencraft.browser.base-image="${OPENCRAFT_BASE_IMAGE_ID}"
USER ${RUNTIME_USER}

# syntax=docker/dockerfile:1
# Native Linux x64 toolchain. Build from the repository root.
ARG NODE_IMAGE=node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32
FROM ${NODE_IMAGE}
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-venv lsb-release sudo \
    pkg-config xvfb xauth xz-utils zip unzip file util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/opencraft-electron-builder
COPY vendor/electron/fork.json vendor/electron/container-inputs.json ./vendor/electron/
# Use Chromium's own installer for the pinned fork; verify downloaded bytes.
RUN python3 - <<'PY'
import hashlib, json, pathlib, subprocess, urllib.request
here = pathlib.Path('vendor/electron')
inputs = json.loads((here / 'container-inputs.json').read_text())
fork = json.loads((here / 'fork.json').read_text())
assert inputs['schemaVersion'] == 1 and inputs['chromiumVersion'] == fork['chromiumVersion']
url = 'https://raw.githubusercontent.com/chromium/chromium/' + inputs['chromiumVersion'] + '/build/install-build-deps.py'
payload = urllib.request.urlopen(url, timeout=120).read()
assert hashlib.sha256(payload).hexdigest() == inputs['buildDependenciesSha256']
installer = pathlib.Path('/tmp/install-build-deps.py')
installer.write_bytes(payload)
subprocess.run(['python3', str(installer), '--no-prompt', '--no-chromeos-fonts', '--no-arm', '--no-android', '--no-nacl', '--no-syms'], check=True)
installer.unlink()
PY
RUN rm -rf /var/lib/apt/lists/*
ENV DEPOT_TOOLS_UPDATE=0 \
    DEPOT_TOOLS_METRICS=0 \
    DEPOT_TOOLS_WIN_TOOLCHAIN=0 \
    PATH=/opt/depot_tools:$PATH \
    LANG=C.UTF-8 \
    OPENCRAFT_ELECTRON_WORKSPACE=/workspace
RUN python3 - <<'PY'
import json, subprocess
revision = json.load(open('vendor/electron/container-inputs.json'))['depotToolsRevision']
subprocess.run(['git', 'init', '/opt/depot_tools'], check=True)
subprocess.run(['git', '-C', '/opt/depot_tools', 'remote', 'add', 'origin', 'https://chromium.googlesource.com/chromium/tools/depot_tools.git'], check=True)
subprocess.run(['git', '-C', '/opt/depot_tools', 'fetch', '--depth=1', 'origin', revision], check=True)
subprocess.run(['git', '-C', '/opt/depot_tools', 'checkout', '--detach', revision], check=True)
actual = subprocess.check_output(['git', '-C', '/opt/depot_tools', 'rev-parse', 'HEAD'], text=True).strip()
assert actual == revision
PY
# Warm the pinned depot_tools bootstrap while the image is writable.
RUN gclient --version && dpkg-query -W > /opt/opencraft-electron-builder/os-packages.txt
COPY LICENSE ./LICENSE
COPY vendor/electron/ ./vendor/electron/
COPY apps/headless-server/src/remote-browser/focus.cjs ./apps/headless-server/src/remote-browser/focus.cjs
RUN node -e "if (typeof require('./apps/headless-server/src/remote-browser/focus.cjs').initializeNativeFocus !== 'function') throw new Error('Native probe focus helper missing')"
RUN mkdir /workspace && chown 1000:1000 /workspace
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["python3", "/opt/opencraft-electron-builder/vendor/electron/container.py"]
CMD ["preflight"]
ARG OPENCRAFT_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="OpenCraft Electron native builder" \
      org.opencontainers.image.source="https://github.com/opencraft-app/opencraft" \
      org.opencontainers.image.revision="${OPENCRAFT_SOURCE_REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

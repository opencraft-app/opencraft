# Rehearsal image for `npm run cf:rehearsal -- --containers` (rehearsal-containers.ts):
# the real `workspace-agent --bare` (bundled from scripts/container-deployment) as the
# container's main process, Python 3 for the shared broker and the endpoint relay.
# Not a product image: no roles, engines or credentials.
FROM python:3.12-alpine
COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-alpine /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /usr/lib/
COPY workspace-agent.mjs /opt/opencraft/workspace-agent.mjs
ENV OPENCRAFT_DATA_DIR=/var/tmp/oc-data OPENCRAFT_WORKSPACE_DIR=/var/tmp/oc-workspace
ENTRYPOINT ["/usr/local/bin/node", "/opt/opencraft/workspace-agent.mjs", "--bare"]

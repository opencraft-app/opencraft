# CloudAgent single-host ACP gateway

This package runs the ACP gateway on one Linux host. The host is the compute
machine for Wisp runtimes; workspace persistence still uses SMH.

## Quick start

```bash
tar -xzf cloudagent-single-host-linux-amd64-*.tar.gz
cd cloudagent-single-host-linux-amd64-*
cp config/env.example config/env
vi config/env
./scripts/start-acp-gateway.sh
```

The ACP endpoint listens on:

```text
http://127.0.0.1:18094/acp
```

Required config:

- `TOKENHUB_API_KEY`
- `GATEWAY_AGENT_SIDECAR_URL`
- `SMH_LIBRARY_ID`
- `SMH_ACCESS_DOMAIN`
- `SMH_LIBRARY_SECRET`

The startup script serves the bundled Wisp package from a local HTTP server and
passes that URL to the gateway as `GATEWAY_WISP_PACKAGE_URL`.

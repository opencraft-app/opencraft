# Wisp Cloud SDK

`pkg/wispcloud` is the external control-plane SDK for creating a Wisp runtime on
cloud sandboxes. It owns the AGS runtime creation, SMH workspace token flow, Wisp
release bootstrap script, and runtime attach/exec/stop/delete operations.

It does not import or depend on `cloudagent/gateway`.

## CLI

Build only the cloud CLI on macOS:

```bash
GOWORK=off GOTOOLCHAIN=local go build -o /tmp/wispcloud ./cmd/wispcloud
```

Create a new SMH-backed Wisp environment:

```bash
wispcloud create \
  --template "$GATEWAY_AGS_TEMPLATE" \
  --package-url "$WISP_PACKAGE_URL" \
  --root-upper-size 5G
```

Reuse an existing SMH workspace:

```bash
wispcloud create --workspace-id "$SMH_SPACE_ID"
```

Run a command in the Wisp environment:

```bash
wispcloud exec --workspace-id "$SMH_SPACE_ID" -- 'pwd && ls -la /'
```

Stop the Wisp container but keep the AGS runtime:

```bash
wispcloud stop --workspace-id "$SMH_SPACE_ID"
```

Delete the runtime and SMH workspace:

```bash
wispcloud delete --workspace-id "$SMH_SPACE_ID"
```

State is stored in `WISPCLOUD_STATE_DIR` or `~/.wispcloud/environments`.

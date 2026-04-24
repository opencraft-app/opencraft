# nextgen-dashboard-client

Local terminal client for `nextgen-dashboard`.

It connects directly to the admin websocket:

- `wss://<host>/admin/ws/terminal`
- HTTP Basic Auth during websocket handshake
- local raw TTY
- initial and resize-aware terminal dimensions

## Usage

```bash
cd nextgen-dashboard-client
go run ./cmd/nextgen-dashboard-client \
  --url https://lightclaw.tech/admin \
  --username skipzhang
```

The client will prompt for the password if `--password` and `NEXTGEN_DASHBOARD_CLIENT_PASSWORD` are both absent.

## Environment variables

- `NEXTGEN_DASHBOARD_CLIENT_URL`
- `NEXTGEN_DASHBOARD_CLIENT_USERNAME`
- `NEXTGEN_DASHBOARD_CLIENT_PASSWORD`

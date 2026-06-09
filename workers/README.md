# Tencent CVM Rescue Exporter

Go Temporal worker/client for Tencent CVM rescue-mode export.

The workflow creates a CVM image backup unless skipped, enters rescue mode, waits for the instance and TAT/SSH to become reachable, read-only mounts candidate disks such as `/dev/vda*`, streams selected paths into a gzip archive, uploads it to an existing COS bucket through signed URLs, and attempts `ExitRescueMode` after rescue may have been entered. Cleanup uses Temporal compensation activities so cancellation can still drive the instance back out of rescue mode. After the signed download URL TTL expires, a detached Temporal child workflow deletes the exported COS object.

Secrets are intentionally not stored in this repo or passed as Temporal workflow arguments. The worker process reads Tencent credentials and rescue passwords from its own environment.

## Build

```bash
go build ./cmd/rescue-exporter
```

## Required Environment

```bash
export TEMPORAL_ADDRESS=temporal-frontend.lightclaw.tech:443
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TLS=true
export TEMPORAL_BEARER_TOKEN='...'

export TENCENTCLOUD_SECRET_ID='...'
export TENCENTCLOUD_SECRET_KEY='...'
export RESCUE_PASSWORD='...'
```

`TEMPORAL_BEARER_TOKEN` is preferred; `TEMPORAL_AUTH_TOKEN` is accepted as a fallback.

## Temporal Cluster

The currently validated Temporal frontend for this worker is:

```bash
export TEMPORAL_ADDRESS=temporal-frontend.lightclaw.tech:443
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TLS=true
export TEMPORAL_BEARER_TOKEN='...'
```

Connection requirements:

- TLS must be enabled.
- The TLS server name/SNI must be `temporal-frontend.lightclaw.tech`.
- The gRPC metadata key is lowercase `authorization`.
- The metadata value is `Bearer <JWT>`.
- Tokens and Tencent Cloud secrets must not be committed to this repository.

When replacing the Temporal cluster or frontend endpoint, verify the ingress/load balancer as a gRPC endpoint, not as a generic HTTP endpoint. Temporal workers issue long-poll gRPC calls such as `PollWorkflowTaskQueue` and `PollActivityTaskQueue`; these calls can sit idle for about a minute when no task is available. A healthy frontend returns gRPC responses that the SDK retries or repolls normally.

If the worker logs show HTML `502 Bad Gateway` or `504 Gateway Timeout` responses every roughly 60 seconds, the failure is usually in the gateway in front of Temporal, not in the worker workflow code. Check that the new endpoint:

- Preserves HTTP/2 gRPC upstreams.
- Does not convert failed gRPC polls into HTML error pages.
- Has request/read/stream idle timeouts above the Temporal long-poll duration; use at least 120 seconds, preferably several minutes.
- Preserves the `authorization` metadata header.
- Routes by the same TLS SNI/host that the worker uses.

## Run Worker

```bash
./rescue-exporter worker
```

## Start Export

Dry-run first:

```bash
./rescue-exporter start \
  --instance-id ins-0fverxpd \
  --remote-path /etc \
  --remote-path /var/log \
  --local-output-dir ./exports
```

Real execution with the default TAT/COS path:

```bash
./rescue-exporter start \
  --instance-id ins-0fverxpd \
  --region ap-beijing \
  --command-transport tat \
  --tat-username root \
  --tat-working-directory /root \
  --cos-upload-bucket-url https://bucket-appid.cos.ap-beijing.myqcloud.com \
  --remote-path /etc \
  --remote-path /var/log \
  --execute \
  --i-understand-this-enters-rescue-mode-and-copies-data
```

Real execution refuses to default to `/`; pass every export path explicitly with `--remote-path`.

If the legacy SSH path is used and scp must use the rescue password rather than a key or ssh-agent, pass:

```bash
export RESCUE_SSH_PASSWORD="$RESCUE_PASSWORD"
./rescue-exporter start ... --ssh-password-env RESCUE_SSH_PASSWORD --execute --i-understand-this-enters-rescue-mode-and-copies-data
```

## Notes

- Region is optional; if omitted, the workflow probes common Tencent Cloud regions until it finds the instance.
- Disk candidates default to `/dev/vda*` then `/dev/vdb*`; override with repeated `--device-glob`.
- Backup defaults to a CVM image before entering rescue mode. Use `--skip-backup` only when a fresh backup already exists.
- The mount is read-only and the workflow attempts `ExitRescueMode` after export or cancellation once rescue may have been entered.
- COS archive objects are automatically deleted after `--cos-upload-url-ttl-seconds` seconds, defaulting to 28800 seconds. Use `--disable-cos-auto-delete` only for debugging or retention exceptions.
- Use `rescue-exporter cancel --workflow-id <id>` to stop through Temporal and allow cleanup compensation. `terminate` is a last-resort Temporal operation and can bypass workflow cleanup.
- Temporal token is read only from `TEMPORAL_BEARER_TOKEN` or `TEMPORAL_AUTH_TOKEN`; raw Tencent secrets and rescue passwords are not accepted as workflow parameters.

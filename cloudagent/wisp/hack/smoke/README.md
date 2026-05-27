# Smoke Harness

This directory contains repeatable smoke checks for the runtime.

## Checkpoint

Runs the real `/root/ck.txt` checkpoint/restore flow against a live daemon:

```bash
./hack/smoke/checkpoint.sh
```

Optional explicit server URL:

```bash
./hack/smoke/checkpoint.sh http://127.0.0.1:8520
```

The check currently verifies:

- wisp create/start
- write `before`
- checkpoint create
- write `after`
- restore
- restart
- `exec` returns `before`
- `fs read` returns base64 for `before`

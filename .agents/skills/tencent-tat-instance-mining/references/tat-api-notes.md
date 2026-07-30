# Tencent Cloud TAT Notes

Use these notes only when debugging or patching `scripts/hermes_insights_tat.py`.

## APIs

- CVM list: `DescribeInstances`, service `cvm`, version `2017-03-12`.
- TAT command: `RunCommand`, service `tat`, version `2020-10-28`.
- TAT result: `DescribeInvocationTasks`, service `tat`, version `2020-10-28`.
- Region is usually `ap-shanghai`.
- `RunCommand` must use `Username=agentuser` for Hermes collection.

## TAT Output Limit

Avoid returning full Hermes reports in bulk. Default to `--remote-output overview`, which returns only:

- `No sessions found...`, or
- `Period`
- `Overview`

Do not use COS unless the user explicitly asks for it.

## Common Terminal/Failure States

Treat these as terminal and record them; do not retry automatically:

- `SUCCESS`
- `FAILED`
- `TIMEOUT`
- `CANCELLED`
- `START_FAILED`
- `DELIVER_FAILED`

Common per-instance skip reasons:

- TAT Agent not installed or instance does not exist.
- `agentuser` does not exist.
- Hermes output is empty.
- Hermes output cannot be parsed.

## Resume Pattern

If a long run is interrupted:

1. Preserve completed invocation IDs from terminal output.
2. Read completed batches with repeated `--invocation-id`.
3. Continue remaining instances with `--offset` or a new `--instance-file`.
4. Merge result JSON files locally; do not rerun successful batches.

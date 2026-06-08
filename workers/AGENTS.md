# AGENTS.md - workers

This directory contains Temporal workers. Treat worker changes as backend infrastructure changes: keep workflow determinism, compensation paths, and deployment rollback behavior explicit.

## Release Surface

- Source-facing Kubernetes lives under `workers/k8s/base` and `workers/k8s/overlays/<env>`.
- Deploy-facing generated files must stay out of source overlays; `generated/` is local/CI material only.
- CI image publishing uses `.ci/runtime/commands/build_release_image.py --service workers --env <env> --tag <tag>`.
- The Docker image must include both `rescue-exporter` and `rescue-uploader`; production workers must not compile uploader binaries at runtime.

## Runtime

- Default command is `rescue-exporter worker`.
- Temporal auth must be provided as runtime secrets, not command-line args.
- Tencent Cloud credentials, rescue password, and COS signing secrets must be Kubernetes secrets.
- `TEMPORAL_DEPLOYMENT_NAME` and `TEMPORAL_WORKER_BUILD_ID` are optional, but if one is set both must be set to enable Temporal Worker Versioning.

## Verification

- Run `go test ./...` and `go vet ./...` inside `workers/` after code changes.
- For release metadata changes, validate the release bundle manifest from the repo root.
- For container changes, build the Docker image when Docker is available.

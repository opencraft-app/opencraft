# CloudAgent Wisp Runtime

This directory owns the Wisp runtime source and release packaging used by
CloudAgent outer workspaces.

Rules:

- Keep generated artifacts out of git: `dist/`, `.tmp/`, `dist-release/`,
  `assets/bin/`, downloaded rootfs tarballs, and rootfs image files.
- Treat `config.jsonnet` as local runtime material. Commit
  `config.jsonnet.example` instead.
- Build and publish release packages through
  `cloudagent/gateway/scripts/publish_cloudagent_wisp_package.sh` or the
  combined CloudAgent artifact CI path.
- Do not change checkpoint or writeback ordering without a live Wisp restore
  e2e that closes and restores a session.

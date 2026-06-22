# CloudAgent Operating Notes

This directory owns CloudAgent gateway, ChannelGateway, Wisp runtime packages,
sandbox-host, agent-loader, and related runtime artifacts.

## DevCloud Release Triggers

DevCloud does not become current just because a CloudAgent code commit lands on
`master`. Always check the release surface that owns the changed code:

- `cloudagent/gateway/**` or `cloudagent/sandbox-host/**` triggers
  `.ci/cloudagent-gateway.yml`, which builds and pins the
  `cloudagent-gateway` image for `devcloud-dep`.
- `cloudagent/channelgateway/**` triggers `.ci/channelgateway.yml`, which
  builds and pins the `channelgateway` image for `devcloud-dep`.
- `cloudagent/wisp/**`, `cloudagent/research/hermes-rs/**`, and
  `cloudagent/agent-loader/**` trigger `.ci/cloudagent-agent-artifact.yml`,
  which builds and uploads CloudAgent runtime artifacts to Shanghai COS.

If a change spans Wisp/runtime artifacts and gateway behavior, verify both:

1. The runtime artifact CI produced a new Wisp/sidecar artifact URL and SHA.
2. `argocd/services/cloudagent-gateway/devcloud-dep/cloudagent-gateway-platform.env`
   has been pinned to the desired gateway image and Wisp artifact URL.
3. Argo `cloudagent-gateway-devcloud-dep` is `Synced / Healthy`.
4. `GET /v1/selfcheck` on the DevCloud internal endpoint reports the expected
   sidecar/Wisp artifact values.

When a gateway image rebuild is required but the source change did not touch a
gateway-owned watched path, use the existing CI trigger-note convention by
adding a dated no-op line under `cloudagent/gateway/README.md` `CI trigger
notes`. When a Wisp artifact rebuild is required, touch a Wisp-owned watched
path such as this file or `cloudagent/wisp/AGENTS.md`.

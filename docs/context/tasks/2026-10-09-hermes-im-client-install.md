---
id: hermes-im-client-install-2026-10-09
type: task
scope: First-install IM client artifact on Beijing COS and managed Bot installation entry.
triggers: ["hermes im client install"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-09
review_due: 2027-01-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
Build the migrated Hermes-capable Tencent IM client, upload to Beijing COS,
and allow existing managed Bots to perform a first installation.

## requirements
- User authorized COS upload and installation steps, using cloud desktop as precedent.
- User explicitly requested no special region restriction and a first-install flow.

## non_goals
- No external Computer enrollment, TAT re-registration or replacement of a running Hermes.
- No automatic credential creation or claim that installing a binary connects a Bot to IM.
- Keep ref/velachat unchanged.

## context_receipt
- AGENTS.md, frontend/AGENTS.md, frontend/DESIGN.md, vela-computer/AGENTS.md, ctl/AGENTS.md.
- docs/context/domains/agent-gateway-runtime.md and services/cloudagent.md,
  services/collaboration.md, services/vela-computer.md under docs/context/project.
- vela-computer/docs/README.md and scripts/build-vela-candidate.sh.
- docs/context/project/adjacency/argocd-ci-secrets.md; .ci/vela-computer.yml.
- ctl/pkg/instance/desktop.go: first-install detection, execution ownership and idempotence.
- frontend/src/lib/deepseek-harness-command.ts: authenticated existing Bot execution and installer bucket.

## decisions
- Use writable vela-computer source, not the frozen subtree.
- Pin immutable binary and installer checksums, verify before execution, install per user.
- Preserve existing unrelated binaries; repeat installs reuse verified bytes.
- Reuse existing authenticated Bot command execution; no region-specific install authorization.

## evidence
- Beijing endpoint for existing vela-installer bucket returned HTTP 200 for its DSH installer.
- Initial COS upload probe lacked authentication; user subsequently provided
  temporary upload authentication, used only through a private RAM-backed file.
- Native TAT release library and CGO-enabled Linux AMD64 binary built successfully.
- Binary version v0.1.0-bot.20261009.1; SHA-256
  4f67820d94071f3e38e6d6d962aec58b08d321fe66a7025a7f8c94e833921c41.
- Full vela-computer Go tests and vet passed; five installer scenarios passed.
- Eight installer frontend checks passed, including unpublished-release gating,
  Bot-switch isolation and failed-launch retry; the earlier combined run passed 15 checks.
- Real binary first install and repeated reuse passed using an isolated local
  download fixture; evidence /data/vela-im-client-release-20261009/installer-smoke.json.
- Actual generated background launcher installed the real binary with a 10ms
  launcher return; evidence /data/vela-im-client-release-20261009/background-smoke.json.
- Frontend check passed: 166 baseline diagnostics, zero new; documentation errors zero.
- Uploaded all five files to the existing Beijing installer bucket and verified
  their ordinary HTTPS download SHA-256. Frontend published=true now permits install.
  No region restriction was added to Bot installation.
- Existing Bot debug commands have a 30s backend limit; installation runs in a
  detached, flock-protected job with status polling, rather than lengthening that limit.
- Actual first install and repeated reuse via unauthenticated public COS downloads
  passed; evidence /data/vela-im-client-release-20261009/public-cos-install.json.
- Standalone installation instructions uploaded separately to immutable guide path
  vela-im/guides/v0.1.0-bot.20261009.1/INSTALL.md; public bytes match the local guide.
- Enabled-release frontend check passed (zero new diagnostics); all 16 targeted tests passed.
- Enabled-release Beijing build passed; generated console gate verified 130 files;
  final documentation validation reports zero errors. Release enablement commit 5aa8226df.

## handoff
- COS upload completed; its temporary authentication file was deleted immediately.
- Prepared payload at /data/vela-im-client-release-20261009/v0.1.0-bot.20261009.1/linux-amd64.
- Installing the client does not itself wire an existing Hermes gateway into IM.
- Beijing frontend build, full Go tests/vet and message/runtime race checks passed.
- Source locally committed as 88929a070; generated console locales separately
  committed as 3d6b790f6. The read-only console gate verified all 130 files.
- Public COS release and installation steps complete. The install entry is enabled
  in the deployed Beijing frontend (deployment 8af0b894-7583-43c5-b3d6-090400cfd3e5).
- Source MR !5134 is pushed and awaiting required review; master is not merged.
- Existing Bots were not bulk-installed or restarted. Release credentials were not persisted.

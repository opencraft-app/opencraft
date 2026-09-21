---
id: task-hermes-gateway-install-diagnosis-20260921
type: task
scope: Read-only diagnosis of the requested user's Hermes gateway installation.
triggers: ["Hermes gateway installation", "instance diagnosis", "gateway service failure"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [ctl/main/api/server.go, ctl/pkg/transport/instance.go]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal
Locate instances belonging to the user specified in this conversation and explain the Hermes gateway installation failure with current read-only evidence.

## non_goals
- No restart, reinstallation, configuration changes, cloud resource changes, or deployment.
- Do not collect credentials or user conversation content.

## requirement_refs / requirement_excerpt
- Current user request: why installing Hermes gateway fails on this user's machine.

## interface_refs / data_structure_refs
- CTL GET /v1/instances; POST /v1/instances/{id}/debug/exec with a read-only command, agentuser and TAT backend.
- Scope all requests to the supplied user and resolved instances.

## history_context
- current_design_refs: ctl/docs/README.md; docs/context/domains/agent-gateway-runtime.md.
- relevant_evolution: distinguish installed files, service registration and running gateway; no prior incident is assumed to be this incident.

## acceptance
- Resolve owner/instance, gather installation and service health evidence, report cause or exact remaining uncertainty.

## affected_paths
- This diagnostic Task Pack only.

## context_receipt
| File | Reason | Use |
|---|---|---|
| docs/context/domains/agent-gateway-runtime.md | Router must_read | Ownership boundaries |
| docs/context/project/services/ctl.md | Router must_read | Instance authority |
| docs/context/project/services/cloudagent.md | Router must_read | Runtime ownership |
| ctl/AGENTS.md | Service entry | Read-only boundaries |
| cloudagent/AGENTS.md | Service entry | Runtime artifacts |
| ctl/docs/README.md | CTL authority | API semantics |
| docs/context/project/adjacency/argocd-ci-secrets.md | Deployment neighbor | Read shprod kustomization and API test; no secret values |
| .agents/skills/tencent-tat-instance-mining/SKILL.md | Read-only instance diagnostics | agentuser, compact redacted output |

## evidence
- Router matched agent-gateway-runtime, control-plane-ops and service-cloudagent.
- SSH operator host reachable; Shanghai and Singapore CTL services discovered via read-only Kubernetes queries.
- Initial exact query ctl/internal failed because this service uses ctl/pkg and ctl/main; bounded search there located debug transport/API tests.
- 2026-09-21 live: Shanghai returns zero instances, Singapore returns one Running instance, ins-933029868eef426191caff15ae7cf44a (sandbox f60818ab-6413-43f8-9471-a86b63351527).
- As agentuser through owner-scoped CTL/TAT, ~/.local/bin/hermes resolves to ~/.hermes/hermes-agent/venv/bin/hermes. The target is a 673-byte Bash wrapper, not the Python console entrypoint. Line 9 execs that same absolute target when running as agentuser, proving a self-exec loop. File modification time is 2026-08-22 20:21:57 UTC; this is not attribution of who wrote it.
- Installed distribution entry_points.txt declares hermes = hermes_cli.main:main; pyproject declares version 0.20.3.
- Two process snapshots show dozens of Bash Hermes wrappers, including 15–17 --version processes. No new Hermes CLI command was launched by the diagnosis, to avoid adding another loop.
- Gateway user unit is loaded/active/running since 2026-09-21 14:16:52 CST, NRestarts=0. ExecStart uses venv/bin/python -m hermes_cli.main gateway run, bypassing the corrupted wrapper. This proves process state, not end-to-end channel health.
- Bare systemctl --user in TAT reports No medium found; with explicit /run/user/1002 bus it succeeds. Linger=yes and bus exists, so this is a diagnostic-session environment difference, not the primary failure.
- Disk 49% used, 25 GiB available; approximately 2.8 GiB memory available. Resource exhaustion is not supported by this snapshot.
- Current repository exact wrapper-text search found no matching writer. Do not attribute the historical overwrite to a specific installer without additional evidence.
- Diagnostic helper is local only: /tmp/hermes-gateway-diagnosis.A4HbIZ/inspect.py. It reads machine files/process metadata and returns redacted/allowlisted output; no user chat content or credential values collected.

## validation
- No runtime source changes; validation consists of owner-scoped API and read-only machine observations.
- validate_change_impact.py --repo . --staged passed with no staged files (not a runtime test).

## risks
- Logs may contain credentials; extract allowlisted fields or redact on the machine before returning output.

## handoff
- Diagnosis complete: self-referential Bash wrapper breaks Hermes CLI entrypoint. Existing Python-launched gateway remains running.
- Suggested repair, not performed: back up the damaged entrypoint, restore the distribution's Python console script, verify bounded --version/status, then separately identify/clean only confirmed loop processes. No reinstall/restart or cloud mutation authorized in this turn.
- Historical writer remains unconfirmed. Temporary operator port-forwards are cleaned up after inspection.

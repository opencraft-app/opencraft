---
id: velachat-reference-subtree-2026-10-09
type: task
scope: Import VelaChat into ref/velachat as an unchanged Git subtree.
triggers: ["velachat reference subtree"]
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
Import https://git.woa.com/skipzhang/velachat.git master into mono2 ref/velachat, commit, push and integrate into master as explicitly requested.

## non_goals
- No product integration, upstream edits, deployment or dependency installation.
- Preserve other worktrees and their unfinished changes.

## requirement_ids / requirement_refs / requirement_excerpt
- User: clone VelaChat into ref/velachat using subtree, commit, push and merge into master.

## interface_refs / data_structure_refs
- Upstream master: c0f8fa280d33ea3eb6edc8a32a679e0847d28def.
- Destination: ref/velachat, an ordinary tracked tree rather than a submodule or nested clone.
- Keep its tree identical to upstream and retain Git subtree ancestry and trailers.

## history_context
- current_design_refs: docs/context/project/upstream-subtrees.md.
- relevant_evolution: existing ref/hypernode is an ordinary reference tree.
- superseded_refs: none.

## acceptance
- Destination tree hash equals the upstream root tree hash.
- Upstream commit is an ancestor of the subtree import.
- Diff is confined to ref/velachat and this task record.
- Remote master contains the import after an ordinary fast-forward push or reviewed merge.

## affected_paths
- ref/velachat/**
- docs/context/tasks/2026-10-09-velachat-reference-subtree.md

## required_context
- upstream-subtrees.

## context_receipt
| File | Reason | Use |
|---|---|---|
| AGENTS.md | Repository boundaries | Isolated worktree and explicit delivery authorization |
| docs/context/project/upstream-subtrees.md | Subtree routing | Preserve provenance and avoid copying |
| docs/context/tasks/TASK-TEMPLATE.md | Work record | Record scope and validation |
| ref/velachat/AGENTS.md | Upstream constraints | Preserve sources and credentials boundary |
| ref/velachat/backend/scripts/scan-secrets.sh | Direct validation neighbor | Scan the imported tree |

## evidence
- Authenticated Git read confirms both remote repositories are reachable.
- Clean import worktree starts at mono2 master 429405660860261caac138eddee439e72a4390c9.
- Upstream cloned separately to /data/velachat-upstream-20261009.
- Command: git subtree add --prefix=ref/velachat /data/velachat-upstream-20261009 c0f8fa280d33ea3eb6edc8a32a679e0847d28def.
- No squash: retain complete upstream ancestry. Subtree commit trailers identify prefix and source commit.

## risks
- Future updates should use git subtree pull --prefix=ref/velachat https://git.woa.com/skipzhang/velachat.git master, preserving the same history strategy.
- This import is a reference snapshot; it does not prove VelaChat deployment or consumer integration.

## validation
- Exact tree identity, ancestry, file modes and absence of nested .git entries.
- Upstream credential scan reports only three security-test fixture files; each finding reviewed as deliberately synthetic credentials or private-key markers. No production credential finding.
- Documentation integrity and documentation-impact checks.
- No runtime tests required because no executable behavior is changed or consumed by mono2.

## decisions
- Use a clean isolated worktree and an unchanged, full-history subtree.
- User authorization covers commit, push and master integration.

## scan_scope
- All files in ref/velachat, including hidden files.

## scan_output
- Synthetic findings: agent/cmd/vela-computer/startup_test.go, agent/internal/hermes/diagnostic_test.go and web/apps/client/src/security/credential-scan.test.ts.
- Secret scan output stays outside Git; no credential values recorded.

## handoff
- Import prepared; finish gates, push topic and integrate into remote master, then verify remote ancestry and tree identity.

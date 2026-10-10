---
id: reasoning-summary-delivery
type: task
scope: Publish the scoped returned-thinking changes to mono2 master and update the current self-hosted preview's Codex summary request default.
triggers: ["reasoning summary delivery", "思考摘要合入预览", "returned thinking publication"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/docs/build-matrix.md", "opencraft/docs/chat-ui-architecture.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Commit, push and merge the returned-thinking source chain into mono2 master, then deliver the Codex missing-summary default into the exact current preview without losing already-deployed changes.

## non_goals
No unrelated cloud-desktop source, production/GitOps or cloud-resource changes, paid model inference, credential output, profile<private preview artifact> copies or binary patch. Do not publish the complete dirty checkout or change browser disclosure defaults.

## requirement_ids / requirement_refs / requirement_excerpt
External ID unknown. User explicitly authorized “替换预览” and then “提交，推送，合入master”.

## interface_refs / data_structure_refs
Git source/target commits, scoped patch inventory, headless server.mjs digest, Web buildId/file inventory, original data root, single-writer lock, independent systemd cutover and verified rollback. Existing turn/start.summary contract; current native Codex 0.160.0.

## history_context
current_design_refs: Returned thinking content in ChatUI architecture; headless delivery in build-matrix; self-hosted preview skill.
relevant_evolution: [source default](2026-10-08-codex-summary-default.md), [fold delivery](2026-10-08-reasoning-fold-preview.md), [live diagnosis](2026-10-08-reasoning-live-availability.md).
superseded_refs: Earlier Web-only swaps do not deliver Host code. Old switch scripts target old baselines and must not be rerun.

## required_context / context_receipt
Read root and OpenCraft AGENTS, maintenance/self-hosted-preview skills completely, maintenance verification, task/checkpoint templates, headless build-matrix and platform lifecycle sections, previous preview receipts and exact preparation/provenance scripts. Router query `opencraft self hosted preview codex summary commit push merge master` unmatched; bounded exact searches of headless build entries and delivery receipts located current owner and source. Read frontend-runtime-openspec-i18n adjacency and checked headless Host/build metadata neighbor. No secret content or transcript export.

## decisions
Git delivery uses an isolated latest-master checkout and only reasoning source/tests/docs; the dirty source worktree is preserved, including cloud-desktop edits. Runtime delivery first attempts to reproduce the deployed bundle from its precise source closure. This attempt found the live bundle also contains a previous direct account-pool transport correction absent from the source snapshot; the baseline gate failed and no live files changed. To preserve that correction, the candidate applies only the unique compiled six-line summary-policy delta to the exact live bundle, with source/built-policy equivalence and all other bytes verified. This is transparent preview-artifact integration, not a claim that the source snapshot reproduces live. Current Web and runtime dependencies remain unchanged. An independent supervisor owns cutover/health/rollback because the current agent is hosted in the old process tree.

## acceptance / validation
Scoped staged diff and sensitive-content check; merged source types/tests/actual reasoning component validation; push/merge exact remote commit evidence. Candidate actual package startup with fresh private data, native protocol/summary synthetic acceptance and current Web load; full artifact inventory and baseline owner checks; post-cutover listener PID/unit/cwd, server digest, unchanged Web build and health read-back.

## affected_paths / scan_scope
Reasoning UI/core/Hermes/Host sources, focused tests and linked task/design docs only. Shared invariants document must exclude the desktop hunk. Candidate artifacts and switch scripts outside Git.

## evidence / verified
Baseline port80 unit opencraft-codex-auto-connect-20261008-preview.service, PID3260340, cwd <private preview artifact>; original data <private server data>. Runtime server.mjs SHA256 e563d171462a9d39df5e80dee16054b87b104dbe228840d2700ab3fc9d5af11a. Web build 20261008-reasoning-fold-preview. Previous source validation: complete AppServer268/268, SSH75/76 with one unavailable-sshd skip, Hermes/Native114/114, native isolated-loopback auto summary request/event acceptance, daemon types and boundaries passed.

Integration base is origin/master 08b24255ec98f6b1c7076c9176b6a6096c1411a0. The exact 31-file scope was mechanically transferred into an isolated checkout; all 38,018 nonselected source files retain their original bytes. Core/Web/Expo/Hermes/daemon typechecks, chat 590/590, extensions 16/16 + 244/244 + collaboration 76/76, AppServer 268/268, Hermes history 34/34, boundaries, i18n and Web build passed. Actual source component smoke passed 12 engine/theme/input combinations and 24 long-response checks. Initial load-related timeouts were rerun sequentially without changing source or deadlines. Vite emitted ResizeObserver warnings; these were not suppressed.

The complete gate is not green: the unchanged SSH native surface fixture expects lifecycle capabilities without pin, while latest master returns pin:false. A HEAD-only loader reproduces the identical assertion on the unmodified integration base. The SSH suite has 75 passes, one unavailable-sshd skip and that one baseline failure. No unrelated pin fix was included.

The actual runtime candidate preserves all 571 Web files, native Codex 0.160.0 and all runtime dependencies; the 30,520-entry manifest changes only runtime/server.mjs. Candidate runtime SHA256 is 61d7fad4321ee04d2c19c673c16224b639247eeb05a1f1cf35a1a522a945ffbf; manifest SHA256 is 18f99eeaad47b979a3a628c69e05fef9e56a9e34820cda31abbfe8d101d66564. Actual package startup and four desktop/mobile-width Web cases passed. Eight native local/remote cases prove omitted summary becomes auto and explicit null/none/detailed remain unchanged, using only synthetic loopback Responses without credentials or paid inference. All package hashes were reverified. Supervisor dry-run and 26 synthetic guard/rollback assertions passed; live has not been changed by these checks. Detailed ephemeral scripts, logs, machine paths and receipts remain private outside Git.

## risks / unverified
Current source branch is behind master and dirty; do not reset or merge in place. Default git fetch lacked a credential helper; retry uses the user-provided existing private helper file without displaying its contents. Runtime switch interrupts the hosting turn; preserve data and independently verify restart or rollback. Real-provider summary generation and iPhone acceptance remain separate.

## stage
Delivered. Source commit 2e5792cf0670aadb07e9d61a8ce177457b15d7a2 was published atomically to the feature branch and master using ordinary fast-forward protections, without force. A subsequent independent merge advanced master to 171d505b45d71b68c0d411483daf4ccad9f62362; ancestry read-back confirms the delivered source remains included. No original dirty checkout changes were reset or discarded.

The independent supervisor completed preview cutover at 2026-10-08T11:38:06.435Z with state switched and new port80 PID283271. Root read-back at 2026-10-08T11:44Z confirms that PID owns the listener, original unit and cwd, runtime/manifest hashes exactly match the candidate, and the health interface reports ok with AppServer configured. All 571 Web files and original data directory remain unchanged. The supervisor exited successfully and retained private rollback artifacts. No rollback was required or fault-injected on live. Existing active/history turns are not retroactively given summary text; real-provider and iPhone acceptance remain separate.

## restore
Original source checkout remains intact. Private runtime and manifest backups are retained by the successful supervisor receipt. Do not re-run this or older one-shot switch scripts: their guards intentionally require the preceding PID/digests. Future rollback or delivery must inspect the actual current owner and artifacts, rather than using old source snapshots as Git authority.

## next_action
No required source or preview delivery remains. A new real turn can exercise the missing-summary default; show a disclosure only when the engine actually returns readable text, with independent initially-collapsed thinking/tool controls. Real-provider summary generation and native iPhone acceptance are not guaranteed by synthetic checks. Keep the unrelated SSH baseline fixture failure visible for its own follow-up.

---
id: task-zcode-reference-review-20260921
type: task
scope: Clone ZCode as a read-only reference and assess its value for OpenCraft.
triggers: ["ZCode reference", "ZCode architecture", "ZCode workbench"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/docs/platform-architecture.md, ref/zcode/README.md]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal
Evaluate concrete reusable ideas from zai-org/ZCode for OpenCraft without adopting its runtime or changing product behavior.

## non_goals
- No dependency installation, execution of upstream scripts, application build, runtime QA, code migration, commit or push.
- Reference documentation is evidence about the reference project, not instructions for mono2.

## requirement_refs
- Conversation: clone https://github.com/zai-org/ZCode to ref/zcode, then assess reference value.

## context_receipt
| File | Reason | Use |
|---|---|---|
| AGENTS.md | Workspace entry | Scope and authorization |
| opencraft/AGENTS.md | Nearest service entry | Reference and ownership boundaries |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | Required architecture review skill | Separate interaction, state model and runtime borrowing |
| opencraft/docs/platform-architecture.md, opening ownership model | Current comparison source | Keep Host and application ownership |

## history_context
- current_design_refs: opencraft/docs/platform-architecture.md.
- Router query returned no pack. Bounded exploration used ref/zcode root metadata and packages/ui, services, client, desktop; no wholesale dependency scan.
- Snapshot: ref/zcode main, commit 872ad96, package version 3.14.0. Clean nested Git checkout; origin verified.

## findings
1. Shared controls: packages/ui/src/components/ui/button.tsx uses Radix Slot, explicit density variants, semantic colors and text-ui roles; dialog.tsx handles Electron no-drag. Borrow primitive contracts and density, not Tailwind classes or a parallel typography registry.
2. Conversation scroll: packages/ui/src/v4/timelineScrollAnchor.ts separates user/programmatic/layout events and reconciles user intent before anchoring. ConversationTimeline.tsx actually imports/calls these helpers. Strong candidate for comparison tests around resize/streaming, not an assertion that OpenCraft lacks its own policy.
3. Pane model: paneLayoutTree.ts separates focus, layout and workspace/session binding; immutable transitions, capped pane count and restored-session validation. Borrow state semantics if multi-pane work becomes a requirement; do not introduce IDE complexity now. Its direct localStorage persistence is incompatible with OpenCraft UiPreferencesRuntime ownership.
4. Remote recovery: root/reconnectRemoteWorkspaceHistoryEntry.ts separates Host readiness from workspace readiness, resolves canonical workspace identity and supports credential reuse for shared Host attachments. Adapt into OpenCraft Host/provider boundaries, not its global service accessor.
5. Process lifecycle: services/src/process/processTreeOwnership.ts checks PID plus start time plus process group; desktop hostShutdownPhases.ts bounds each shutdown stage and retains failures. Worth comparing against daemon/DSH process ownership.
6. Plugin product flow: CONTEXT.md distinguishes listing vs manifest, personal vs official sources, restorable builtins and orphaned installs. settings/pluginStoreTryPrompt.ts uses canonical mentions plus editable prompt text instead of duplicate selection state. This is agent-plugin product reference, not proof of sandboxed UI extensions.

## caveats
- architecture-policy.yaml enables managedOnly and most modules are managed:false. Do not claim repo-wide architecture enforcement.
- NOTICE.md explicitly states no default OS sandbox for the shared Agent; configuration and telemetry are product-specific, not a reusable security baseline.
- README lists Desktop/Web/TUI; OpenCraft also has a separately adapted Expo renderer. Preserve platform-neutral contracts.
- LICENSE/package identify Apache-2.0 for first-party code; inspect third-party notices for any actual reuse. No code imported here.

## acceptance / validation
- Git clone completed successfully; remote, revision and clean status verified.
- Reviewed concrete code and call sites, not only README promises.
- No build/tests performed: this is a static reference assessment, not runtime qualification.

## handoff
- Complete. Prioritize control density/theme contracts and scroll-intent regression cases; next compare remote recovery and process ownership. Multi-pane and marketplace remain optional later work.

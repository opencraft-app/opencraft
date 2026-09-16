---
id: opencraft-sign-in-menu-20260913
type: task
scope: Provider-owned sign-in choices in the shared account entrance
owner: mingyuxiao
authority: primary
source_of_truth: [opencraft/apps/workbench-web/src/components/shell-navigation/account-sign-in-menu.tsx]
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---
## goal
Footer Sign in opens a lightweight regional menu; selection directly starts system-browser login without an intermediate dialog.
## non_goals
- No native credential/OAuth redesign, production changes, commits, WB source edits or cloud creation.
- Embedded environment login keeps its feature-owned continuation; not a redesign of all account views.
## requirement_ids / requirement_refs / requirement_excerpt
- Current conversation: user approved “登录 → 菜单选国内／国际 → 对应认证网页”.
## interface_refs / data_structure_refs
- AuthenticationFlowRequest.optionId; provider.signIn(optionId); PlatformAccountContribution.signInOptions; ShellSignIn.
## history_context
- current_design_refs: opencraft/docs/platform-architecture.md Authentication ownership.
- relevant_evolution: Cordis flow services already own cancellation/epoch; preserve those boundaries.
- superseded_refs: footer-specific intermediate sign-in dialog.
## acceptance
- Menu offers two provider-labelled actions, supports keyboard/Escape/focus and shared theme; no modal before browser handoff.
- Pending/error state lives in Cordis; cancel/retry do not overlap transactions; stale completion cannot affect replacement.
- Unit tests, typecheck, gate and real-rendered menu/native preview checks.
## affected_paths
- opencraft/packages/workbench-runtime/src/authentication/
- opencraft/packages/extension-react/src/index.ts
- opencraft/plugins/lightvela-hermes/src/extension.ts
- opencraft/apps/workbench-web/src/components/shell-navigation/ and runtime/use-authentication-presentation.tsx
## required_context
- identity-access, OpenCraft AGENTS and platform architecture.
## context_receipt
| File | Reason | Use |
|---|---|---|
| docs/context/domains/identity-access.md | Router must_read | Provider authority |
| opencraft/AGENTS.md | Workspace boundary | Full gate |
| opencraft/docs/platform-architecture.md | Current auth ownership | Preserve Cordis and Main boundaries |
## evidence
- Bounded source search located shared menu SCSS and existing Radix DropdownMenu; use these primitives.
- Login service tests 43/43 passed; new cases cover provider option fencing and rejecting URL-shaped unsupported options.
- `npm run gate` passed (exit 0), `/tmp/opencraft-sign-in-menu-gate.log`; workspace typecheck and boundary guards included.
- `scripts/smoke-sign-in-menu.ts` passed: light/dark menu, Enter/Home/Escape/focus, cn/intl handoff, retry cancellation ordering, late completion, error recovery, floating containment and draft retention. Report `/tmp/opencraft-sign-in-menu/report.json`, browser errors empty.
- `npm run build:electron:release`, independent package and `codesign --verify --deep --strict` passed.
- Packaged Mac `release/sign-in-menu-preview`, isolated profile `/tmp/opencraft-sign-in-menu.3qp0MN`, CDP19710: two menu items, no intermediate dialog, Escape/focus return. Screenshot `/tmp/opencraft-sign-in-menu/native.png`; app left open with menu visible. Real account login not initiated.
- Documentation validator errors empty; staged impact check empty (nothing staged); explicit changed-file impact check passed. `git diff --check` passed.
## risks
- Region switches must happen only after prior cancellation; menu disappearance must not cancel a selected login.
## validation
- Complete as above. Browser smoke explicitly awaits menu exit before opening the next interaction; Vite fixture prebundles Radix/React to avoid duplicate React instances.
## decisions
- Shell handles opaque option IDs only; LightVela validates cn/intl. No arbitrary login URLs in generic menu.
## scan_scope
- Shared footer, flow broker, provider metadata and UI tests.
## scan_output
- None.
## handoff
- Complete; independent Mac preview opened. No commit/push, production writes, cloud creates, or changes to existing user profiles/windows.
## stage
- Implemented and verified.
## verified
- Shared footer menu and Cordis option handoff, cancellation/retry, themes and floating presentation.
## unverified
- User's real browser login in the newly built preview; native transport itself was unchanged and covered by existing tests.
## discard
- Intermediate login dialog is no longer the anonymous footer path; remains available only to explicit other surfaces.
## restore
- Preserve other dirty work. Latest native profile and preview path are listed above.
## next_action
- User visual acceptance / real-account login if desired; Git operations require explicit authorization.

---
id: opencraft-tencentoa-footer-20261012
type: task
scope: Automatic verified employee identity in the OpenCraft account entrance.
triggers: ["tencentoa footer", "employee account entrance"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/tencentoa/
  - opencraft/apps/workbench-web/src/runtime/platform-account-contributions.ts
status: active
reviewed_at: 2026-10-12
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_excerpt
User authorized commit, push, master integration and local preview update. Show
the automatically recognized employee in the bottom-left account entrance.
User clarified: no fixed login entry; employee identity comes from request headers.

## non_goals
No production/GitOps changes, invented identity, gateway login URL, unsupported
logout, resource permission change or employee identity injection into model prompts.

## interface_refs / history_context
The existing Tencent OA implementation `615cf25b8f` is already an ancestor of
the locally cached `origin/master` (`0c4a75d3b`). `GET
/__opencraft_tencentoa/session` verifies TAI signature and authenticated JWE.
The controller remains the sole per-client employee identity owner.
Account entrance priority is presentation authority only; existing product
sessions remain separate. Current design: Tencent OA authentication documentation,
platform authentication ownership and workspace invariants.

## acceptance / affected_paths
Automatically display the verified employee, open details and refresh, clear
revoked/expired identity, preserve independent product account ownership and
restore its entrance when the employee extension unloads. Unconfigured servers
contribute no false employee capability. Plugin/Web typechecks, account and
identity regressions, boundaries, i18n and Headless-target Web build; real footer
controls and actual preview verification when the environment permits them.

## context_receipt
| File | Reason | Use |
|---|---|---|
| Root/OpenCraft AGENTS | Scope and Git authority | Isolated checkout; user authorized delivery |
| docs/context/project/services/frontend.md | Router must_read | No frontend source edits |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Neighbor | Read existing i18n validation script |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md and references/verification.md | Authentication and Shell task | Controller truth, shared controls and relevant checks |
| opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md | Current preview replacement | Independent switch and rollback required |
| opencraft/docs/platform-architecture.md | Authentication ownership | Explicit footer precedence, distinct sessions |
| opencraft/design/README.md and invariants.md | Shell behavior | Maintain presentation contract |
| .agents/skills/gongfeng/SKILL.md and DEPENDENCIES.md | Authorized Git delivery | Reuse existing authentication; no gate bypass |
| Previous Tencent OA task/checkpoint | Existing source | Avoid repeating historical delivery |

## decisions / risks
Explicit `entrancePriority` selects the footer provider (default 0, employee 100);
equal priorities remain exclusive. Optional signOut represents a genuinely
absent operation. Anonymous employee details remain accessible for refresh.
Existing signature/JWE verification is retained: headers alone without the
operator's private application key cannot be treated as verified identity.

## evidence / validation
Host restrictions lifted. Identity tests 13/13 (including real HTTP), authentication
flows 9/9 and LightVela account regressions 2/2 passed. Plugin, Web,
extension-react and LightVela platform typechecks, boundaries and i18n passed.
Real browser smoke passed at mobile/desktop widths and light/dark themes using
the real account footer and ModalHost: automatic identity, details, independent
users, refresh and revocation. Details use shared SettingsPanel to reserve the
modal close track; anonymous instructions request refresh without a fixed URL.

## delivery checkpoint
Fetched and integrated latest origin/master `21158dd3d`. User supplied the
application credential; installed outside source as a private 0600 file. Runtime
already supports verified identity, so preserve the current inbound SSH/desktop
runtime and update only Web plus the private token-file startup flag. Remote MR
and independently supervised preview switch are being completed; verify actual
live health, runtime hash, Web revision and identity endpoint before claiming delivery.

---
id: 2026-09-11-opencraft-announcement-window
type: task
scope: OpenCraft reusable announcement window, Settings laboratory preview, and trusted JavaScript API.
triggers: ["announcement modal", "laboratory", "showAnnouncement", "公告窗口"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/packages/extension-contract/src/index.ts
  - opencraft/packages/extension-runtime/src/announcement-center.ts
  - opencraft/apps/workbench-web/src/components/modal/
status: active
reviewed_at: 2026-09-11
review_due: 2026-12-10
revision: 1.0.0
precedence: task
derived: false
---

# OpenCraft announcement window

## goal

Provide a reusable, Host-owned announcement window that trusted JavaScript extensions can invoke through serialized data, with a Settings laboratory preview using the same path.

## non_goals

- Do not copy Cursor artwork or ship an automatic marketing campaign.
- Do not expose React nodes, DOM handles, Radix primitives, numeric z-index, focus ownership, or arbitrary callbacks to extensions.
- Do not persist impression/dismissal eligibility in this change; campaign orchestration remains a separate layer.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-11: add a Settings laboratory entry that opens the shown announcement style and make the capability reusable and callable from JavaScript.
- Codex reference evidence: `codex-home-announcements-*`, `imagegen-25-announcement-modal-*`, `wallet-onboarding-announcement-modal-*`, and `dialog-host-*` keep orchestration, reusable announcement content, and Dialog behavior separate.

## interface_refs / data_structure_refs

- `OpenCraftExtensionApiV1.window.showAnnouncement(AnnouncementContribution)` accepts renderer-neutral data and resolves to an action or dismissal result.
- `AnnouncementCenter` owns request identity, extension lifetime, replacement, settlement, and subscriptions.
- `ModalHost` remains the only Web projection owner; `AnnouncementDialogContent` owns content layout only.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `docs/context/tasks/2026-09-10-opencraft-modal-ownership.md`.
- `relevant_evolution`: OpenCraft already migrated application windows to one Radix-backed Web `ModalHost` and one React Native `ModalSurface` adapter.
- `superseded_refs`: none.

## acceptance

- Settings contains a Laboratory page and preview control.
- The preview and trusted JS extensions both enter through `AnnouncementCenter`.
- Announcement content contains no Dialog/Portal/z-index implementation.
- Extension deactivation resolves pending announcements without deadlocking callers.
- Focused extension-runtime and Workbench modal tests, types, boundaries, and Web build pass.

## affected_paths

- `opencraft/packages/extension-contract/`
- `opencraft/packages/extension-runtime/`
- `opencraft/apps/workbench-web/src/components/modal/`
- `opencraft/apps/workbench-web/src/components/settings-page.tsx`
- `opencraft/apps/workbench-web/src/components/ui/`
- `opencraft/scripts/publish-workbench-web.mjs`
- `opencraft/tests/`

## required_context

- `frontend-product-surface`
- `docs/context/project/services/frontend.md`
- `opencraft/AGENTS.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@master` | repository change protocol | Task Pack, impact validation, and evidence requirements |
| `opencraft/AGENTS.md@master` | OpenCraft boundaries and validation | keep shared semantics renderer-neutral and avoid generated upstream edits |
| `docs/context/project/services/frontend.md@master` | routed frontend authority | confirm frontend-owned interaction and validation scope |
| `opencraft/docs/platform-architecture.md@master` | current modal and extension ownership | preserve one ModalHost and data-only extension ABI |
| `ref/webview/assets/codex-home-announcements-*` | unpacked Codex reference | separate eligibility/orchestration from reusable announcement content |
| `ref/webview/assets/imagegen-25-announcement-modal-*` | unpacked Codex reference | confirm slot-like title/body/media/action announcement recipe |

## evidence

- `ExtensionSupervisor.announcements` owns trusted-JavaScript requests, owner disposal, replacement, and settlement without importing a renderer.
- Web projects the external-store snapshot into the existing Radix-backed `ModalHost`; announcement content owns no Portal, focus, Escape, inert, or z-index behavior.
- Settings > Laboratory invokes the same serialized `AnnouncementCenter.show(...)` path exposed as `api.window.showAnnouncement(...)`.
- Focused extension/runtime suites passed 74 tests; the full OpenCraft gate passed Web, Expo Web, Expo iOS, type, boundary, and test stages.

## risks

- A nested announcement can appear under Settings if request ordering is inverted; announcement projection is appended after existing modal requests.
- An extension may be removed while awaiting a result; owner dismissal happens before command invocation drain.
- Remote media may violate product policy; only root-relative, HTTP(S), and blob URLs are accepted, and extensions remain trusted-only.
- LightVela includes unhashed `public/assets/**` files; the publisher distinguishes those revalidated files from manifest-owned immutable assets before switching the entry.

## validation

- `npm run typecheck --workspace @opencraft/extension-contract`
- `npm run typecheck --workspace @opencraft/extension-runtime`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm exec tsx -- --test tests/extension-runtime.test.ts tests/workbench-timeline-host.test.ts`
- `npm run check:boundaries`
- `npm run build:web`
- `npm run gate`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions

- Announcement is a content recipe, not a new modality or z-layer.
- The public imperative API returns an action result instead of accepting callback functions or command IDs.
- The Settings laboratory is a manual preview and does not own campaign persistence.

## scan_scope

- `/root/decode-codex/ref/webview/assets/*announcement*`
- `opencraft/apps/workbench-web/src/components/modal/`
- `opencraft/packages/extension-{contract,runtime}/`

## scan_output

- Bounded source inspection summarized in `history_context` and `context_receipt`; no restored artifact produced.

## handoff

- Implementation and validation complete on `codex/announcement-lab-modal`. The user authorized commit, remote push, and publication to the current `chat.lightvela.com` Workbench host on 2026-09-11; production receipt is recorded after the atomic publish.

## production_receipt

- Release build: `20260911070154-b181f6c73287`.
- EdgeOne Makers project: `vela-cn`, production deployment `dp0dirik0lov`.
- Public verification: `https://chat.lightvela.com/version.json` and the root `opencraft-build-id` meta both returned the release build.
- Lazy-chunk verification: all three announcement-related JavaScript assets returned byte-identical SHA-256 hashes from the public origin.
- Host verification: `vela-workbench-web.service` now uses the server-owned `OPENCRAFT_WEB_*` environment contract; its health endpoint resolves `/vela/apps/workbench-web/dist-lightvela-web` and reports the same release build.
- Rollback boundary: EdgeOne keeps prior deployments and the atomic host publisher retained prior hashed assets/build material.

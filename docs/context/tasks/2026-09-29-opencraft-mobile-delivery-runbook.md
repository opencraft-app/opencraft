---
id: opencraft-mobile-delivery-runbook-2026-09-29
type: task
scope: OpenCraft mobile preview and package delivery instructions and local Android packaging helpers.
triggers: ["OpenCraft mobile packaging", "Expo Go preview", "Android APK filing"]
owner: opencraft
authority: primary
source_of_truth:
  - opencraft/AGENTS.md
  - opencraft/apps/workbench-expo/README.md
status: active
reviewed_at: 2026-09-29
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## goal
Make the OpenCraft mobile preview, internal build, signed Android package,
filing handoff, and temporary download path discoverable and repeatable from
the local Agent entry.

## non_goals
- No app-store submission, production deployment, key upload, or iOS signing on Linux.
- No changes to the existing iOS WebView or Android workbench behavior.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-29: review `AGENTS.md` for the entire mobile workflow, then “整改”.
- No external ticket ID.

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-expo/app.config.js` selects Android and iOS release identities.
- `opencraft/config/build-matrix.json` maps build targets to checked artifacts.
- `opencraft/apps/workbench-expo/scripts/build-android-release-apk.sh` verifies the APK against the external signing key.

## history_context
- `current_design_refs`: `opencraft/docs/architecture/product-identity.md`, `opencraft/docs/build-matrix.md`, `docs/context/decisions/ADR-0001-context-engineering-v2.md`.
- `relevant_evolution`: Expo Go preview instructions already exist; the `com.tencent.vela` signed APK and filing data were first built in an isolated worktree and were absent from the main checkout.
- `superseded_refs`: the removed `ai.lightvela.vela` Android release candidate; iOS retains that bundle ID.

## acceptance
- A new agent can choose the correct preview, internal APK, signed APK, or iOS IPA route from `opencraft/AGENTS.md`.
- The signed Android build uses `com.tencent.vela`, an external PKCS12 key, and emits an APK plus certificate MD5, APK MD5, and Base64 public key from the verified artifact.
- The download helper serves only the APK and provides a testable HTTP route.
- A local mobile APK task does not load the GitOps release pack on the generic word “release”.

## affected_paths
- `opencraft/AGENTS.md`, Expo app config/scripts/package metadata/README, build matrix, product identity, context routing/ADR/test, this Task Pack.

## required_context
- Root router returned no pack for the bounded query “OpenCraft mobile app packaging documentation AGENTS Expo APK IPA”.
- An earlier query containing “release” incorrectly selected `release-gitops`; its must-read pack was read during the review.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Root authority | Task Pack, authorization, and secret boundaries |
| `opencraft/AGENTS.md` | Local authority | Mobile entry and validation expectations |
| `opencraft/apps/workbench-expo/README.md` | Existing human runbook | Preview, IPA, and internal APK steps |
| `opencraft/docs/build-matrix.md` | Build authority | Artifact target separation |
| `.agents/context/context-routing.yaml` | Router authority | GitOps false positive |
| `docs/context/domains/release-gitops.md` | Routed must-read | Distinguish local packaging from deployment |

## evidence
- The signed isolated APK passed `apksigner` and `aapt` checks for `com.tencent.vela`; its public certificate and APK MD5 were extracted from that artifact.
- Main checkout initially had no `app.config.js` or signed Android build target; the path was not repeatable from its docs.
- Default Expo config remains `dev.vela.workbench`; Android release resolves to `com.tencent.vela`; iOS release resolves to `ai.lightvela.vela`.
- `npm run matrix:check` passed with 16 targets; Expo workspace typecheck, Bash/Node/Python syntax, focused GitOps route regression, and `git diff --check` passed.
- APK download helper passed local GET/HEAD byte and length checks; paths other than the one APK returned HTTP 404.
- Documentation validator returned zero errors and zero broken first-party links.
- The full context unit suite has four failures rooted in existing invalid historical Task Packs; the new focused route test passed. The context catalog still reports 3,869 errors from the existing Task Pack corpus, with none attributed to this new pack. The full signed Android build and an iOS IPA were not rerun in this checkout.

## risks
- A signing key in a repository or HTTP-served directory would leak update authority; require an external key and serve only APK bytes.
- Regenerating an APK changes its file MD5; derive filing data after each build.
- Existing main worktree has unrelated changes; preserve them and edit targeted paths only.

## validation
- Expo config output for default, Android release, and iOS release identities.
- `npm run matrix:check`, focused context routing test and context documentation validation.
- Shell/Python syntax checks, TypeScript typecheck, and HTTP HEAD/GET checksum smoke test.

## decisions
- Keep `AGENTS.md` as a compact router; place exact commands in Expo README.
- Use distinct Android internal and signed release build targets.
- Remove the broad English `release` token from GitOps routing; retain explicit deploy/promotion terms.

## scan_scope
- Exact searches in OpenCraft Agent entry, Expo scripts/config/README, build matrix, and context routing.

## scan_output
- No separate scan artifact; bounded results appear in this task's evidence.

## handoff
- Documentation and scripts are updated in the dirty main checkout. Existing unrelated changes were preserved. No commit, push, IPA signing, or publication has been performed.
- Android production signing still requires the external keystore and password file; a Mac with Apple signing is needed to produce the iOS IPA. Current-checkout APK install and live login remain unverified.

## stage
Implementation, focused validation, final diff, and context catalog review complete.

## verified
- Route selection, Expo identities, build matrix, typecheck, documentation links, and isolated HTTP behavior passed as recorded above.

## unverified
- Current-checkout signed APK build and device installation; iOS IPA export; live login on a phone.

## discard
- The generic `release` router match for local APK work and the superseded Android package `ai.lightvela.vela`.

## restore
- Start at `opencraft/AGENTS.md` → Expo README mobile route; preserve the existing dirty worktree and external signing key boundary.

## next_action
- Report changes and validation limits to the user.

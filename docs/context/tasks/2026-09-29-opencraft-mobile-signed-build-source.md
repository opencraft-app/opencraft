---
id: opencraft-mobile-signed-build-source-2026-09-29
type: task
scope: Integrate the Android signed APK and filing build, plus the iOS LightVela test IPA profile, into mono2.
triggers: ["OpenCraft signed Android APK", "OpenCraft iOS test IPA"]
owner: opencraft
authority: primary
source_of_truth:
  - opencraft/apps/workbench-expo/app.config.js
  - opencraft/apps/workbench-expo/scripts/build-android-release-apk.sh
  - opencraft/apps/workbench-expo/scripts/build-ios-ipa.sh
status: active
reviewed_at: 2026-09-29
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## goal

Make the existing local Android `com.tencent.vela` signing and filing workflow, and the iOS `ai.lightvela.vela` test IPA profile, available from a reviewed mono2 source checkout.

## non_goals

- No production key, password, signed binary, app-store submission, GitOps deployment, or production service change.
- No change to the existing Expo Go or Android internal APK identifiers.
- No change to the repository-wide context router.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-29: submit and merge the Android signed APK/filing build and iOS test IPA configuration.

## interface_refs / data_structure_refs

- `app.config.js` selects package identifiers only when an explicit release profile flag is set.
- Build scripts read signing material outside the repository and derive filing values from the verified APK.
- `config/build-matrix.json` declares the Android release artifact contract.

## history_context

- current_design_refs: `opencraft/docs/architecture/product-identity.md`, `opencraft/docs/build-matrix.md`.
- relevant_evolution: Expo Go, Android internal APK, and the iOS development IPA are already on master; the signed Android and branded iOS profiles were local-only.
- superseded_refs: none.

## acceptance

- Default Expo identity remains `dev.vela.workbench`; Android release is `com.tencent.vela`; iOS branded test IPA is `ai.lightvela.vela`.
- Android release requires an external PKCS12 key and checks both package identity and signature before producing filing values.
- Release prebuild does not silently replace an existing local native project.
- Documentation distinguishes source, build, signed artifact, installation, and publication.

## affected_paths

- `.agents/context/change-impact.json`, `opencraft/AGENTS.md`, `opencraft/apps/workbench-expo/`, `opencraft/config/build-matrix.json`, `opencraft/docs/build-matrix.md`, `opencraft/docs/architecture/product-identity.md`, `opencraft/package.json`.

## required_context

- The root context router returned no pack for the scoped mobile build query; a bounded search found the Expo profile and build matrix entry points.

## context_receipt

| File | Reason |
|---|---|
| `AGENTS.md` and `opencraft/AGENTS.md` | Repository and service boundaries |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | Platform delivery validation |
| `opencraft/apps/workbench-expo/README.md` | Existing mobile build routes |
| `opencraft/docs/build-matrix.md` and `config/build-matrix.json` | Artifact and platform contract |
| `docs/context/domains/release-gitops.md` | Distinguish local packaging from deployment |

## validation

- Verify Expo profile identities, build matrix, shell/Node/Python syntax, Expo typecheck and iOS JavaScript bundle.
- Test signing configuration against a generated-Gradle fixture and the APK-only download route.
- Signed Android APK and iOS IPA still require their respective external signing environments; source validation cannot substitute for an installed device test.

## decisions

- Preserve source-only scope and keep signing secrets outside the repository.
- Refuse existing native project directories before invoking release-mode clean prebuild.
- Keep internal and branded package profiles separate.
- Exclude Expo mobile packaging, the build matrix, and its root package-script entry from the Agent Gateway design-impact rule; none changes the gateway runtime.

## handoff

- Source merge is not a signed package, installation, store submission, or production deployment.

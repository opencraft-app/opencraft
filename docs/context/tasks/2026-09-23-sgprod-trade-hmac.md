## goal
Restore the Singapore production Trade rollout by supplying the general CloudLadder HMAC key required by Credit sendResource, through the protected SSM/SOPS/GitOps delivery path.

## non_goals
- Do not patch, restart, or delete production workloads directly.
- Do not expose, rotate, or change the effective HMAC value.
- Do not relax Trade startup validation or make Credit sendResource bypass CloudLadder authentication.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-23: fix the Singapore-region Trade startup failure.

## interface_refs / data_structure_refs
- Runtime key: `TRADE_CLOUDLADDER_HMAC_SECRET`.
- Historical SSM key: `TRADE_BILLING_CLOUDLADDER_HMAC_SECRET`.
- Runtime Secret: `trade/trade-runtime-secrets`.
- Delivery flow: SSM manifest -> `scripts/export_ssm_to_sops.py` -> SOPS Secret -> Trade sgprod overlay.

## history_context
- `current_design_refs`: `docs/engineering/domains/release-gitops.md`, `argocd/secrets/README.md`.
- `relevant_evolution`: commit `51492a834` intentionally separated the general CloudLadder HMAC from the Billing-only environment variable, but sgprod retained only the historical key.
- `superseded_refs`: none.

## acceptance
- The sgprod encrypted Trade Secret contains `TRADE_CLOUDLADDER_HMAC_SECRET` and no longer depends on the historical Billing-only key for general routes.
- The sgprod SSM export manifest can reproducibly generate the runtime Secret without exposing plaintext.
- Release contract tests fail if the general key or export manifest regresses.
- SOPS secret scan, sgprod render, CI contracts, documentation, and change-impact gates pass.

## affected_paths
- `scripts/ssm_manifest.trade.sgprod.yaml`
- `argocd/secrets/sgprod/trade-runtime-secrets.sops.yaml`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- Trade sgprod delivery documentation.

## required_context
- `site-environment-routing`, `release-gitops`, `commerce-trade-ops`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@69af15357` | Singapore is an independent production delivery surface | Keep the fix scoped to sgprod. |
| `docs/context/domains/release-gitops.md@69af15357` | Production release authority | Use master, CI, GitOps, and manual Argo sync. |
| `docs/context/project/services/trade.md@69af15357` | Trade ownership and validation | Preserve provider authentication boundaries. |
| `.ci/AGENTS.md@69af15357` | Protected delivery rules | Never emit decrypted secret payloads. |
| `argocd/apps/sgprod/README.md@69af15357` | Singapore release policy | Do not directly mutate production workloads. |
| `argocd/secrets/README.md@69af15357` | Secret source-of-truth flow | Regenerate encrypted artifacts from the declared manifest. |

## evidence
- Live Deployment `trade/trade` retained two ready old-image Pods while the new ReplicaSet entered `CrashLoopBackOff` and `ProgressDeadlineExceeded`.
- Failed Pod log: `init credit sendResource CloudLadder transport: secret is required`.
- Live Secret has a non-empty historical Billing HMAC key but no general HMAC key.
- Current master and gitops sgprod encrypted Secret have the same key mismatch.
- Commit `51492a834` removed the historical-key fallback for general CloudLadder routes by design.
- SSM `mono-sgprod-trade-runtime-secrets` was absent and has now been created in `ap-singapore` with `SSM_Current` from the existing encrypted values, migrating only the HMAC key name.
- The generated general HMAC matches the live historical HMAC, and all six decrypted values match the pre-change encrypted artifact after applying the intended key rename.
- The focused contract, 95 release-bundle contracts, 15 exporter tests, secret scan, and sgprod KSOPS render passed.

## risks
- Writing the wrong HMAC would let the Pod start but make CloudLadder calls fail; preserve the existing effective value under the corrected runtime key.
- Plaintext leakage is unacceptable; process secret material only through SSM/SOPS tooling and validate with the repository scanner.
- Secret updates do not change existing Pod environments; normal GitOps rollout must recreate Pods after the encrypted Secret is published.

## validation
- Focused release-bundle contract tests.
- `scripts/scan_secrets.py` for the sgprod Trade secret.
- SOPS decryptability and key-name-only checks.
- sgprod Kustomize render with KSOPS.
- Documentation and staged change-impact gates.

## decisions
- Keep the code separation introduced by `51492a834`; repair the missing delivery contract instead of restoring the unsafe fallback.
- Do not directly patch production or manually delete the failed Pod.

## scan_scope
- sgprod Trade SSM/SOPS inputs, Trade release bundle contracts, and Trade sgprod overlay.

## scan_output
- `scripts/scan_secrets.py argocd/secrets/sgprod/trade-runtime-secrets.sops.yaml` passed with no findings.

## handoff
- Repository implementation and local validation are complete. Commit, push, MR, GitOps promotion, manual Argo sync, and live rollout verification remain pending explicit confirmation and normal release controls.

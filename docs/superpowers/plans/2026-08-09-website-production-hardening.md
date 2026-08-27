# Website Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the COS upload-abuse, storage-quota, non-atomic publication, and CTL Secret publish-closure blockers while preserving the existing instance credential and test-environment behavior.

**Architecture:** CTL signs an exact upload contract and serializes one in-flight release per site. The deployer verifies actual bytes, publishes to an immutable release prefix, and activates it through CTL's existing transaction; site-gateway resolves the validated active prefix from CTL metadata. GitOps contract tests keep every referenced SOPS Secret inside its service bundle.

**Tech Stack:** Go 1.24, GORM/MySQL, Tencent COS Go SDK, Redis, Kustomize/KSOPS, Python unittest CI contracts, Markdown Agent Skill.

## Global Constraints

- Do not deploy, merge an MR, push production configuration, run production migration 000028, or mutate production DB/Redis/COS/Argo/DNS/TLS.
- Do not issue or distribute `VELA_WEBSITE_KEY` through TAT.
- Do not invent product quota values or production domain/TLS values.
- Preserve unrelated dirty-worktree changes and do not include the frontend font binary in this work.
- Use test-first red-green-refactor for every behavior change.
- Keep the production migration as one final 000028; do not restore test-only intermediate migrations.

---

### Task 1: Enforce the CTL upload and reservation contract

**Files:**
- Modify: `ctl/pkg/logic/website/logic.go`
- Modify: `ctl/pkg/errcode/website.go`
- Modify: `ctl/pkg/model/website/entity.go`
- Modify: `ctl/migrations/000028_create_static_website_platform.up.sql`
- Modify: `ctl/migrations/000028_create_static_website_platform.down.sql`
- Test: `ctl/pkg/logic/website/logic_test.go`
- Test: `ctl/pkg/logic/website/upload_quota_test.go`

**Interfaces:**
- Produce: `CreateReleaseResult.UploadHeaders map[string]string` serialized as `upload_headers`.
- Produce: `generateUploadURL(siteID, releaseID string, artifactSize int64, artifactHash string) (string, map[string]string)`.
- Produce: one-in-flight release enforcement for `pending`, `uploading`, and `deploying`.
- Produce: user-wide storage reservation check under the locked site transaction.

- [ ] **Step 1: Write failing upload-signing tests**

Add tests that call `generateUploadURL` with fixed credentials and assert the URL signature lists `content-length` and `x-cos-meta-artifact-sha256`, while returned headers contain the exact declared values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd ctl && go test ./pkg/logic/website -run 'TestGenerateUploadURL' -count=1`

Expected: compile or assertion failure because the function and result do not expose required headers.

- [ ] **Step 3: Implement signed headers**

Normalize `sha256:` prefixes to lowercase 64-character hex, build `cos.PresignedURLOptions{Header: &headers}`, sign `Content-Length` and `x-cos-meta-artifact-sha256`, and return the same headers in `CreateReleaseResult`.

- [ ] **Step 4: Verify signing tests GREEN**

Run the command from Step 2 and require exit 0.

- [ ] **Step 5: Write failing reservation tests**

Cover:

```text
existing pending release -> conflict
existing uploading release -> conflict
existing deploying release -> conflict
failed or active release -> allowed
used site storage + declared artifact > bundle storage -> WEBSITE_QUOTA_EXCEEDED
two site-scoped creates cannot both reserve the same remaining user budget
```

- [ ] **Step 6: Run reservation tests and verify RED**

Run: `cd ctl && go test ./pkg/logic/website -run 'TestCreateRelease.*(InFlight|Storage|Reservation)' -count=1`

Expected: assertions fail because CreateRelease currently permits all cases.

- [ ] **Step 7: Implement transactional guards**

Within the site-row transaction, count in-flight releases for that site, sum user-wide non-deleted `storage_bytes`, sum declared bytes of all user in-flight releases, and reject before inserting the release when the bundle storage limit is missing/non-positive or exceeded. Add a stable conflict error code for an in-flight release.

- [ ] **Step 8: Verify CTL package tests GREEN**

Run: `cd ctl && go test ./pkg/logic/website ./main/api -count=1`

Expected: both packages pass.

---

### Task 2: Make active release paths explicit and isolated

**Files:**
- Modify: `ctl/pkg/logic/website/logic.go`
- Modify: `site-gateway/internal/sitemeta/sitemeta.go`
- Modify: `site-gateway/internal/objectkey/objectkey.go`
- Modify: `site-gateway/internal/httpapi/server.go`
- Test: `ctl/pkg/logic/website/capability_test.go`
- Test: `site-gateway/internal/sitemeta/sitemeta_test.go`
- Test: `site-gateway/internal/objectkey/objectkey_test.go`
- Test: `site-gateway/internal/httpapi/server_test.go`

**Interfaces:**
- Produce: `SiteStatusView.CloudPath string` and `sitemeta.Site.CloudPath string` serialized as `cloud_path`.
- Produce: `objectkey.ValidatePublishedPrefix(siteID, cloudPath string) (string, bool)`.
- Produce: `objectkey.Candidates(prefix, requestPath string)` and `objectkey.NotFoundKey(prefix string)`.

- [ ] **Step 1: Write failing CTL metadata and gateway path tests**

Assert that CTL returns the stored release path, site-gateway decodes it, legacy `sites/<site>/current/` remains valid, another site's prefix is rejected, traversal/control characters are rejected, and candidates remain inside the validated prefix.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd ctl && go test ./pkg/logic/website -run 'TestGetSiteInternal.*CloudPath' -count=1
cd site-gateway && go test ./internal/sitemeta ./internal/objectkey ./internal/httpapi -count=1
```

Expected: compile/assertion failures because `cloud_path` is not propagated and object keys are fixed to `current/`.

- [ ] **Step 3: Implement metadata propagation and strict prefix validation**

Only accept these exact forms after path cleaning:

```text
sites/<site_id>/current/
sites/<site_id>/releases/<release_id>/
```

Require the same `site_id`, a safe `wr-` release identifier, and a trailing slash. Resolve the site once per request, validate its `cloud_path`, then build all origin keys from that prefix.

- [ ] **Step 4: Run gateway and CTL tests GREEN**

Run the commands from Step 2 and require exit 0.

---

### Task 3: Verify artifacts and publish immutable releases

**Files:**
- Modify: `workers/internal/website/deployer.go`
- Modify: `workers/internal/website/storage.go`
- Modify: `workers/internal/website/types.go`
- Test: `workers/internal/website/deployer_test.go`
- Test: `workers/internal/website/storage_test.go`
- Test: `workers/internal/website/publish_atomicity_test.go`

**Interfaces:**
- Consume: signed upload metadata and `website_releases.artifact_size/artifact_hash` from the claimed operation.
- Produce: `sites/<site_id>/releases/<release_id>/` as the completion `cloud_path`.
- Produce: cleanup of the artifact and candidate prefix on every terminal deploy failure.
- Produce: retention of the candidate plus CTL's exact previous active `cloud_path`, deleting older prefixes before final storage validation.

- [ ] **Step 1: Write failing artifact-verification tests**

Cover actual size too large, declared-size mismatch, missing/wrong COS hash metadata, computed SHA-256 mismatch, and successful verification. Each rejection must assert artifact deletion was attempted.

- [ ] **Step 2: Run verification tests and verify RED**

Run: `cd workers && go test ./internal/website -run 'Test.*Artifact.*(Size|Hash|Cleanup)' -count=1`

Expected: failures because the deployer does not compute/compare the complete upload contract or clean every failure.

- [ ] **Step 3: Implement bounded streaming verification**

Use `io.LimitReader(body, maxArtifactBytes+1)` and `sha256.New()` through `io.TeeReader`; compare actual byte count, release declaration, COS metadata, and normalized digest before opening the zip. Centralize best-effort cleanup so the original deployment error remains primary.

- [ ] **Step 4: Verify artifact tests GREEN**

Run the command from Step 2 and require exit 0.

- [ ] **Step 5: Write failing immutable-publication tests**

Assert all copies target only `sites/<site>/releases/<release>/`, failed copy leaves the prior prefix untouched and never completes the operation, successful completion reports the immutable prefix, and later success deletes only generations older than active plus previous.

- [ ] **Step 6: Run publication tests and verify RED**

Run: `cd workers && go test ./internal/website -run 'Test.*(Immutable|Atomic|ReleaseRetention)' -count=1`

Expected: failures because the deployer currently overwrites `current/`.

- [ ] **Step 7: Implement immutable publication and cleanup**

Copy into the release prefix, delete the verified temporary artifact, retain only the candidate and CTL's exact previous active prefix, validate retained size, then complete the operation with the candidate prefix. On pre-completion failure remove the candidate prefix and artifact.

- [ ] **Step 8: Verify worker package GREEN**

Run: `cd workers && go test ./internal/website -count=1`

Expected: package passes.

---

### Task 4: Teach the distributed Skill the signed upload contract

**Files:**
- Modify: `.agents/skills/website-builder/SKILL.md`
- Test: add or update the closest existing skill contract test discovered under `.agents/skills/website-builder` or `images/tests`.

**Interfaces:**
- Consume: `data.upload_headers` from release creation.
- Produce: upload request uses every returned header verbatim in addition to `Content-Type: application/zip` and never prints the URL or credential.

- [ ] **Step 1: Add a failing contract assertion**

Assert that the Skill requires `upload_headers`, applies `Content-Length` and `x-cos-meta-artifact-sha256`, and still treats `upload_url` as secret-bearing operational data.

- [ ] **Step 2: Verify RED**

Run the discovered focused shell or text contract test and confirm it fails on the missing instructions.

- [ ] **Step 3: Update the Skill upload procedure**

Document exact header consumption without exposing commands or internals to the end user. Unknown required upload headers must stop the publish attempt rather than being silently dropped.

- [ ] **Step 4: Verify GREEN**

Re-run the focused contract test and require exit 0.

---

### Task 5: Close CTL Secret publication and lifecycle configuration

**Files:**
- Modify: `.ci/runtime/bundles/ctl.bundle`
- Modify: `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- Modify: the existing repository-owned COS bucket configuration if present; otherwise add an explicit release-runbook lifecycle gate without applying it.
- Modify: `docs/superpowers/plans/2026-08-08-website-production-readiness.md`

**Interfaces:**
- Produce: CTL sgprod publish closure contains `argocd/secrets/{env}/ctl-website-runtime-secrets.sops.yaml`.
- Produce: contract test derives required SOPS inputs from KSOPS/Kustomize references.
- Produce: failed/incomplete artifact lifecycle is an explicit production rollout gate.

- [ ] **Step 1: Write a failing CI contract test**

Create a fixture/assertion that every CTL SOPS file referenced by the environment Kustomization is matched by a CTL bundle publish path.

- [ ] **Step 2: Run contract test and verify RED**

Run: `python3 -m unittest .ci.runtime.tests.contract_tests.test_release_bundle_contracts -v`

Expected: failure naming `ctl-website-runtime-secrets.sops.yaml`.

- [ ] **Step 3: Add the missing publish path and lifecycle gate**

Add the Secret path without widening unrelated environments. Represent lifecycle as desired configuration or a release gate; do not call COS mutation APIs.

- [ ] **Step 4: Verify CI contracts GREEN**

Run:

```bash
python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p 'test_release_bundle_contracts.py'
bash .ci/runtime/check_ci_runtime.sh
```

Expected: exit 0.

---

### Task 6: Full verification and release-readiness re-audit

**Files:**
- Modify only documentation when a verified command or remaining external gate needs recording.

**Interfaces:**
- Produce: evidence-backed pass/fail matrix; no production mutation.

- [ ] **Step 1: Run formatting and focused tests**

Run `gofmt` on changed Go files, then all focused CTL, worker, site-gateway, service-gateway, TAT shell, Skill, and frontend website tests.

- [ ] **Step 2: Run broad changed-service verification**

Run package tests, available race tests, frontend typecheck/build/i18n checks, CI contract/runtime checks, secret scan, `git diff --check`, and repository-supported GitOps static validation.

- [ ] **Step 3: Review the entire diff**

Compare the working tree with the branch base and latest remote `master`; identify unrelated files, generated drift, secrets, binary changes, migration inconsistencies, and release closure gaps. Do not revert unrelated user changes.

- [ ] **Step 4: Request independent read-only code review**

Provide the design, this plan, and exact diff scope to a reviewer. Fix all Critical and Important findings, then rerun affected verification.

- [ ] **Step 5: Repeat read-only production checks**

Confirm DB remains schema 27/clean, Redis capacity/backups remain healthy, COS bucket remains private and unchanged, Argo drift is recorded, and no website workloads have been deployed.

- [ ] **Step 6: Report final gates**

Separate local code readiness from the two expected external inputs: final domain/TLS and final product quotas. Do not claim production-ready if either code verification or an external launch gate remains open.

### Verification Record (2026-08-10)

- [x] CTL website/API race tests, worker full tests plus vet, site-gateway full race tests, service-gateway vet, TAT credential shell tests, website-builder contract tests, frontend website tests, frontend typecheck, and both i18n checks passed.
- [x] CI runtime validation passed 409 tests; sgprod GitOps static validation, SOPS ciphertext scan, migration-shape review, whitespace check, and a three-way merge-tree check against the current `origin/master` passed.
- [x] CTL production pipeline explicitly enables only the sgprod database migration. The target-cluster onboarding command can now upsert the two website AppProjects before root-sgprod creates their leaf Applications.
- [ ] Complete KSOPS rendering remains a release-environment gate because this workstation intentionally has no SOPS age private key. Run it in the protected CI/DevCloud environment without printing decrypted Secret values.
- [ ] External launch inputs remain: international root/wildcard domain plus TLS certificate, and product-approved final quota templates inserted into migration `000028` before execution.
- [ ] The full release-bundle suite has one unrelated existing failure: Beijing `velagw` OTEL image revision differs from the velagw subtree baseline. This change does not modify `velagw`.

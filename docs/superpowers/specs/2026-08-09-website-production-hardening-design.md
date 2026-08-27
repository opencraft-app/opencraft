# Website Production Hardening Design

## Goal

Make the COS-backed Hermes website flow safe to merge and prepare for `sgprod`
without deploying production, distributing TAT credentials, inventing product
quota values, or writing domain/TLS placeholders.

The design closes four release blockers:

1. a client can upload more bytes than it declared and leave failed artifacts in COS;
2. storage quota does not reserve or reject concurrent uploads;
3. publishing overwrites `current/` object by object and can leave a permanently mixed site;
4. the CTL GitOps publish closure omits `ctl-website-runtime-secrets.sops.yaml`.

## Non-Goals

- Do not deploy or mutate `sgprod`, its database, Redis, COS bucket, DNS, TLS, or Argo applications.
- Do not issue or distribute per-instance `VELA_WEBSITE_KEY` credentials through TAT.
- Do not change the accepted first-release capacity model of one deployer replica and two site-gateway replicas.
- Do not add CDN, WAF, HPA, or PDB in this change. At 1,000 creators per week, normal publishing load is below current COS and worker limits; visitor traffic remains a separately accepted launch risk.
- Do not choose the final `free`, `general`, or `ai` bundle quota values. Product supplies those values before production migration 000028 runs.
- Do not modify unrelated worktree changes, including the existing frontend font binary change.

## Selected Approach

Keep direct-to-COS upload, but make the presigned contract enforceable and make
published releases immutable. This retains the low-bandwidth control plane while
moving all trust decisions back to CTL and the deployer.

Rejected alternatives:

- Worker-only post-upload validation leaves an abuse window in which arbitrary-size objects occupy COS until a worker handles them.
- Proxying every artifact through CTL gives strong validation but consumes CTL bandwidth and long-lived HTTP connections for files up to the artifact limit.
- Reordering copies into `current/` cannot make a multi-object directory atomic; a failed copy can still leave a mixed permanent state.

## Upload Contract

### Release creation

CTL validates the declared SHA-256, artifact size, file count, bundle limits, and
site ownership as it does today. It additionally serializes release creation for
one site and rejects a new release while another release for that site is in
`pending`, `uploading`, or `deploying`.

Inside one database transaction CTL locks the site row, loads the user's current
bundle quota, sums `website_sites.storage_bytes` across that user's non-deleted
sites, and adds the declared bytes reserved by in-flight releases. The new release
is accepted only when:

```text
used_storage_bytes + in_flight_reserved_bytes + artifact_size <= storage_bytes
```

A missing or non-positive production storage quota fails closed for release
creation. This does not change capability display behavior for environments whose
website capability is disabled.

### Presigned PUT

The COS PUT signature includes both required request headers:

```text
Content-Length: <declared artifact_size>
x-cos-meta-artifact-sha256: <normalized 64-character lowercase SHA-256>
```

The release response returns these headers alongside the upload URL so the Hermes
Skill does not have to infer them. A request with a different length or metadata
value does not match the signature.

The presigned URL remains single-object and one-hour scoped. Only one in-flight
release per site limits the number of simultaneously valid artifact keys.

### Worker verification and cleanup

Before extraction, the deployer reads the object's actual content length, streams
at most the hard artifact limit plus one byte, and computes SHA-256 while
downloading. It rejects the artifact unless actual length, declared length, COS
metadata, and computed SHA-256 all agree.

Every terminal failure after an artifact key exists attempts to delete that key.
After a complete immutable release has been uploaded, the deployer deletes the
verified zip before measuring retained storage and activating the release. Cleanup
errors are logged without hiding the original failure. A bucket lifecycle rule for
the `_artifacts/` prefix removes abandoned uploads after two days and aborts
incomplete multipart uploads after one day as a second line of defense. The desired
rule is represented in repository-owned configuration and is applied only during
the separately approved production rollout.

Archive extraction continues to enforce path traversal protection, maximum file
count, and maximum unpacked bytes. The deployer reports the actual retained COS
bytes to CTL before activation. CTL rechecks the user's storage quota under a
transactional lock; if the final retained size would exceed quota, CTL refuses
activation and the deployer removes the candidate prefix and artifact.

## Atomic Publication

### Immutable layout

The deployer writes a complete candidate release to:

```text
sites/<site_id>/releases/<release_id>/
```

It never mutates the prefix of an already active release. After all objects are
present and storage validation succeeds, the deployer completes the operation with
that release prefix. CTL atomically marks the previous release `superseded`, marks
the new release `active`, and updates `website_sites.cloud_path` in the existing
completion transaction.

If any copy or completion step fails, `cloud_path` still points to the last complete
release. The failed candidate prefix is deleted best-effort and cannot become
public.

### Gateway routing

The CTL internal site metadata response adds `cloud_path`. The site-gateway validates
that it is either:

```text
sites/<same site_id>/releases/<safe release_id>/
```

or the legacy path:

```text
sites/<same site_id>/current/
```

Object-key construction accepts the validated prefix rather than rebuilding
`current/` from `site_id`. Existing test-environment sites therefore keep working,
while newly published sites use immutable releases.

The metadata cache may serve the previous complete release for up to its current
30-second positive TTL after activation. Different gateway replicas can converge
at different times, but every request targets a fully written release; a partial
candidate is never exposed.

The deployer retains the active and immediately previous complete release. On a
later successful publish it removes older superseded release prefixes. This bounds
normal retained storage while leaving one rollback/debugging generation available.
All retained objects are included in `website_sites.storage_bytes`.

## Error Semantics

- Invalid upload headers or actual content produce a terminal release failure with a stable website error code and no secret-bearing details.
- A concurrent release returns a conflict response and does not create another presigned key.
- Storage exhaustion returns `WEBSITE_QUOTA_EXCEEDED` before upload when declared bytes exceed the remaining budget, or before activation when expanded/retained bytes exceed it.
- COS cleanup failure does not turn an invalid release into success; it is observable for retry and lifecycle cleanup.
- An invalid `cloud_path` from CTL is treated as an upstream failure. The gateway never falls back to another site's prefix.
- A stale worker remains fenced by the existing operation generation and lease token checks.

## GitOps Publish Closure

The CTL release bundle must publish:

```text
argocd/secrets/{env}/ctl-website-runtime-secrets.sops.yaml
```

for environments that reference it. A release contract test parses the CTL
Kustomization/KSOPS inputs and fails when a referenced SOPS file is outside the
bundle publish paths. The test protects the complete Secret, which contains:

- `CTL_INTERNAL_TOKEN` for privileged credential issue/revoke calls;
- `WEBSITE_INTERNAL_API_TOKEN` shared by CTL, site-gateway, and deployer;
- website COS bucket, region, SecretId, and SecretKey.

These server-side values are distinct from the per-instance `VELA_WEBSITE_KEY`
distributed through TAT.

## Migration Boundary

Production remains on schema version 27 and receives one final migration 000028.
Schema changes required by reservation or immutable release activation are folded
into that migration because none of the website tables exist in production.

The migration continues to contain one explicit product-owned bundle quota section.
It is not executable in production until final package values replace that section.
No test-only 000028-000049 intermediate migrations are restored.

## Compatibility

- Public website API fields remain backward compatible; any new required upload headers are additive response data consumed by the updated `website-builder` Skill.
- Existing `current/` sites remain readable through validated legacy `cloud_path` support.
- Existing operation lease, generation fencing, suspend/resume, soft-delete, and per-instance credential behavior remain unchanged.
- Test and production use the same final schema shape; only product quota values and domain/TLS configuration differ.

## Verification

Implementation follows red-green-refactor cycles and includes:

1. CTL tests for signed headers, one in-flight release, transactional reservation, quota exhaustion, and final-size rejection.
2. Worker tests for size/hash/metadata mismatch, cleanup on every terminal failure, immutable prefix publication, failed-copy isolation, and retained-generation cleanup.
3. Site-gateway tests for metadata `cloud_path`, legacy compatibility, path validation, cross-site isolation, and immutable-prefix lookup.
4. CI contract tests proving every referenced CTL website SOPS file is in the publish closure.
5. Focused tests for CTL, worker, site-gateway, service-gateway, TAT scripts, and frontend website views.
6. Go race tests for changed packages, CI runtime checks, secret scanning, `git diff --check`, production builds, and available GitOps/Kustomize static validation.
7. A final diff review against the latest remote `master`, followed by read-only production checks of DB migration baseline, Redis, COS, Argo drift, workload capacity, and launch placeholders.

## Rollback

Before production, rollback is a source revert limited to this hardening change.
No production state is touched during implementation.

After a separately approved production release, rollback selects the previous
complete release prefix in CTL and rolls back the GitOps image revision. Because
published prefixes are immutable and the immediately previous release is retained,
rollback does not require reconstructing files. Database migration rollback is not
the first response; the new nullable/additive schema remains compatible with the
previous application until a planned rollback is verified.

## Remaining Launch Inputs

Only these external inputs are intentionally unresolved by implementation:

1. international site base domain, wildcard DNS, certificate, and TLS Secret name;
2. final product quota values for every production bundle.

Production publish, database migration, TAT credential distribution, commit, push,
merge request creation, and pipeline execution each remain separately gated.

# Website Production Readiness Plan

## Scope

- Prepare the COS-backed website platform for `sgprod` without deploying production workloads.
- Do not distribute instance website credentials through TAT in this phase.
- Do not invent final package quotas or final domain/TLS values.
- Do not commit, push, or create a merge request without separate approval.

## Implementation

- [x] Fix TAT command response parsing to use real `Response.*` fields.
- [x] Poll TAT invocation tasks to a terminal state and require `SUCCESS` with exit code `0`.
- [x] Remove plaintext website credentials from result artifacts and enforce private permissions.
- [x] Make the host installer require one gateway unit, restart it, verify active state, and roll back on failure.
- [x] Validate instance state and distinguish invalid credentials from Redis infrastructure failures.
- [x] Revoke all instance website credentials after successful instance destruction.
- [x] Verify key ownership when revoking one credential.
- [x] Return a minimal snake_case public operation DTO and keep frontend transition compatibility.
- [x] Rename the distributed Skill to `website-builder` and document the exact polling contract.
- [x] Remove active website TCB residue while preserving historical design documents.

## Production Configuration

- [x] Reuse the existing `sgprod` internal-service token as `CTL_INTERNAL_TOKEN`.
- [x] Create one shared website internal API token for CTL, site-gateway, and deployer.
- [x] Create the three `sgprod` SSM secrets without printing values.
- [x] Export SSM values to SOPS using the repository script and scan all generated files.
- [x] Verify Redis HA, persistence, backup, and eviction policy using read-only checks.

## Verification

- [x] Run focused CTL website authentication and API tests.
- [x] Run service-gateway tests.
- [x] Run TAT shell tests.
- [x] Run frontend type checks, focused tests, i18n checks, and production build.
- [x] Run `git diff --check`.
- [x] Redeploy the current branch frontend to Cloudflare Pages test production.
- [ ] Verify `My Works`, storage usage, and traffic usage with a real authenticated browser session. Both `/websites` and `/agents/websites` return HTTP 200, and the focused usage component tests pass.

## Remaining External Inputs

- [ ] Final international site domain, DNS, wildcard certificate, and TLS secret name.
- [ ] Final product package website quotas.

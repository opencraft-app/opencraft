# Hermes Website Bootstrap Design

## Goal

Every newly created Hermes image must contain the repository-owned `website-builder` Skill. CTL first marks a successfully provisioned instance `Running`, then makes a best-effort attempt to issue and deliver a unique `vik_` credential without making the optional delivery a prerequisite for machine creation.

## Boundaries

- The Skill is copied into the Hermes image from `.agents/skills/website-builder/SKILL.md`; the image build must fail if the source or installed Skill is missing.
- Credentials remain per-instance and are never baked into an image, committed, logged, or stored as plaintext after issuance.
- CTL signs the credential through `websiteauth.Store` only after a sandbox has been allocated.
- Tencent credentials stay in sandbox. CTL asks sandbox to invoke a pre-created parameterized TAT Command; the `website_key` parameter is hidden by TAT.
- Automatic delivery is disabled unless both the TAT CommandId and the public API base URL are configured.

## Data Flow

```text
CreateInstance task
  -> allocate sandbox and complete normal Hermes onboarding
  -> mark CTL instance Running and record create success
  -> best-effort credential bootstrap:
       revoke stale website credentials for this Running instance
       issue one 15-minute provisional vik_ credential
       sandbox InvokeCommand(command_id, cloud_id,
         {website_key: vik_, api_base: configured URL})
       make the key permanent only after SUCCESS/exit 0
```

The reusable TAT command continues to embed `images/helpers/install-hermes-website-credential.sh`. It writes `/etc/vela/website-credential.env`, creates the systemd drop-in, restarts the Hermes gateway, and verifies the environment without printing the token.

## Failure And Retry

- Stale-key cleanup or issue failure: record a credential-free warning, skip TAT, and continue instance creation.
- TAT submission, timeout, non-zero exit, or activation failure: revoke the newly issued KeyId and record a credential-free warning; the instance and Sandbox remain available.
- Automatic delivery keys are provisional for 15 minutes. A worker crash or failed explicit revoke cannot leave a permanent orphan key; only a confirmed successful TAT delivery activates the key without expiry.
- The feature is fail-open when enabled. Removing either bootstrap configuration value restores the previous create path.
- A failed bootstrap can be retried later by issuing a fresh `vik_` and invoking the same TAT Command for the existing machine; the failed key is never reused.
- Existing instances are unchanged; production acceptance and repair may continue using the existing manual batch scripts.

## Skill Delivery

`images/deploy-build.sh` uploads the repository Skill into the remote build workspace. `images/build.sh` installs it into `${RUNTIME_HOME}/.hermes/skills/website-builder/SKILL.md` before curation and treats a missing installed file as a build failure. This removes the current weak behavior where the keep-list only preserves an already-present Skill.

## Configuration

- `WEBSITE_CREDENTIAL_TAT_COMMAND_ID`: reusable TAT command created per production region.
- Sandbox accepts this command only when its own `WEBSITE_CREDENTIAL_TAT_COMMAND_ID` matches, and requires the same `SANDBOX_API_KEY` that CTL sends as `X-API-Key`.
- Internal invocation polling is metadata-only and requests `HideOutput=true`; credential-bearing command output is never returned to CTL.
- `WEBSITE_AGENT_API_BASE`: stable machine-facing API root, for example `https://api.lightvela.ai`.

Both values are non-secret. The CommandId must refer to the command whose `website_key` parameter is declared hidden.

## Verification

- Provider/API tests assert exact `InvokeCommand` parameters and instance scoping.
- CTL tests cover disabled mode, success, issue failure, TAT failure, activation, revocation, provisional expiry, and the requirement that every optional-delivery failure preserves `Running` without deleting the Sandbox.
- Image tests assert repository Skill upload, installation, and hard failure when missing.
- Existing CTL, sandbox, image-script, credential-script, and release-contract suites must pass.

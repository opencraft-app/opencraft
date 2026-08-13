# Hermes website token issuance and TAT delivery guide

This document is an execution contract for the agent that distributes the website skill and its
separate machine credential. The credential is not part of the skill directory and must not be
embedded in `SKILL.md`, an image, a TAT command body, Git, logs, or a shared environment file.

Target environment:

- Vela API: `https://api.lightvela.ai`
- Tencent Cloud region: `ap-singapore`
- Target OS user: `agentuser`
- Target systemd unit: the active Hermes gateway user service discovered by the installer

## 1. The token cannot be calculated offline

The platform does not use a shared HMAC/JWT signing key for website credentials. A valid token must
be issued by CTL because CTL also creates its server-side Redis binding.

Token format:

```text
vwk_<key_id>_<secret>
```

Generation and storage performed by CTL:

```text
key_id = base64url_no_padding(random(16 bytes))
secret = random(32 bytes)
salt   = random(32 bytes)
hash   = SHA-256(salt || secret_raw_bytes)
token  = "vwk_" + key_id + "_" + base64url_no_padding(secret)
```

Redis stores only:

- `key_id`
- random `salt`
- `SHA-256(salt || secret)`
- bound Vela `user_id`
- bound Vela `instance_id`
- creation time

Redis does not store the plaintext token and the credential has no TTL. The plaintext is returned
only in the successful issue response. A string assembled locally with the same format is invalid
because Redis has no matching binding.

Do not write directly to Redis. Do not accept `user_id` from an input file. CTL derives the owner
from the trusted `instance_id` row in its database.

## 2. Required inputs

For every target machine, prepare a mapping with two different identifiers:

```json
{"vela_instance_id":"<CTL instance_id>","cloud_id":"<Tencent CVM ins-xxx>"}
```

- `vela_instance_id` is used to issue and bind the credential in CTL.
- `cloud_id` is used by Tencent TAT to select the physical CVM.

The executing agent also needs:

- network access to CTL's internal API
- `CTL_INTERNAL_TOKEN` supplied by the protected deployment environment
- Tencent Cloud credentials that can create/invoke TAT commands in `ap-singapore`
- local `tccli`, `python3`, and the mono2 checkout containing the delivery scripts

Never ask an end user for any of these platform credentials.

## 3. Issue one credential per Vela instance

Call the CTL internal endpoint:

```http
POST /internal/ctl/instances/{vela_instance_id}/website-credential
Authorization: Bearer <CTL_INTERNAL_TOKEN>
```

Expected status: `201 Created`.

The standard response body contains:

```json
{
  "data": {
    "token": "vwk_<key_id>_<secret>",
    "key_id": "<key_id>",
    "user_id": "<derived by CTL>",
    "instance_id": "<vela_instance_id>",
    "created_at": "<UTC timestamp>"
  }
}
```

Required checks before delivery:

1. HTTP status is 201.
2. `data.instance_id` equals the requested Vela instance ID.
3. `data.token` matches the fixed `vwk_` format.
4. Do not print or log `data.token`.

Issue each instance separately. Never reuse one machine's token for another machine.

## 4. Create the parameterized TAT command once

Run from the mono2 repository:

```bash
HERMES_TAT_REGION=ap-singapore \
  bash .ci/runtime/commands/create_hermes_website_credential_command.sh
```

Record the returned command ID as protected deployment metadata. The command body contains no
credential. It declares `website_key` as a TAT hidden parameter and `api_base` as a normal parameter.

The same command ID can be reused for many machines in the same region. Do not create one command
per token.

## 5. Deliver with one TAT invocation per machine

For each issued token, pass exactly one JSONL row to the existing invocation script:

```jsonl
{"cloud_id":"ins-xxx","website_key":"vwk_<key_id>_<secret>"}
```

Invocation contract:

```bash
HERMES_TAT_COMMAND_ID=<command-id> \
HERMES_TAT_REGION=ap-singapore \
HERMES_TAT_API_BASE=https://api.lightvela.ai \
HERMES_TAT_OUTPUT_DIR=<private-ephemeral-directory> \
  bash .ci/runtime/commands/invoke_hermes_website_credential_command.sh
```

Send the JSONL row on stdin. Use a mode-0700 temporary directory on tmpfs when available, and remove
it immediately after recording only the non-secret success/failure summary. The invocation script's
detailed result files may contain the input row, so they must never be uploaded as CI artifacts or
attached to tickets.

TAT applies one Parameters object to all targets in one invocation. Since every instance has a
different token, use one `InvokeCommand` per machine. A single invocation targeting multiple
machines would incorrectly distribute the same token to all of them.

On the machine, the installer:

1. validates the token format without printing it;
2. atomically writes `/etc/vela/website-credential.env`;
3. sets ownership to `root:agentuser` and mode `0440`;
4. writes a systemd user-unit drop-in with
   `EnvironmentFile=/etc/vela/website-credential.env`;
5. restarts the Hermes gateway service.

The environment file contains:

```text
VELA_WEBSITE_KEY=<per-instance token>
VELA_API_BASE=https://api.lightvela.ai
```

The skill consumes these environment variables at runtime. The skill and token remain independently
replaceable even if the same TAT workflow distributes them in one operational batch.

## 6. Failure and rotation rules

- If issue fails, do not invoke TAT for that machine.
- If TAT fails, keep the issued `key_id` only for revocation; do not log the plaintext token.
- Retrying the same TAT invocation with the same token is safe for the same instance.
- To rotate, issue a new token, deliver it successfully, then revoke the old key.
- Revoke with:

```http
DELETE /internal/ctl/instances/{vela_instance_id}/website-credentials/{key_id}
Authorization: Bearer <CTL_INTERNAL_TOKEN>
```

- Never revoke the old key before the new token is installed and the Hermes gateway has restarted.
- Never verify installation by printing or downloading `/etc/vela/website-credential.env`.

## 7. Completion record

The delivery agent may retain only non-secret facts:

- Vela instance ID
- CVM cloud ID
- issued key ID
- TAT invocation ID
- final TAT status and exit code
- delivery timestamp

The delivery agent must not retain the plaintext token, its secret portion, CTL internal token, CAM
secret, detailed JSONL result, or machine credential file content.

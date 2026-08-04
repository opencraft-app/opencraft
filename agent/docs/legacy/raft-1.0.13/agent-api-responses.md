# Agent API successful-response compatibility（冻结证据）

The Codex-facing `raft` CLI treats an HTTP 2xx status as necessary but not
sufficient for success. Every non-binary response must first be a JSON object.
Operations then validate only the minimum required 1.0.13 top-level shape and
stable discriminators before decoding into command-specific output.

The behavior baseline is the immutable compiled first-party source recorded in
`agent-cli-evidence.json`. The relevant response schemas are in the
independently reviewed evidence range around lines 49978–51434. This document
records interoperability facts only; the Go implementation does not import or
compile that source.

## Validation rules

- Unknown object fields are accepted for forward compatibility.
- Missing required fields, wrong primitive/container types, and invalid stable
  discriminators fail the command even when HTTP status is 2xx.
- `message.send` accepts only `state=sent` with `ok=true` and `messageId`, or
  the observed `state=held` freshness response.
- Task claim/update preserve the observed success-or-held union.
- Profiles require `kind=human|agent` and an `id`.
- Action preparation requires `metadata.kind=action-card`.
- Integration login and App management preserve their observed status/mode
  and client/app response families.
- Binary attachment downloads remain byte streams and do not use JSON shape
  validation.
- Daemon helper responses retain their official optional-empty behavior:
  inbox rows, wake hints, and activity-forward counters may all be absent.

## Automated proof

`internal/agentapi` tests freeze missing-field, wrong-discriminator, discarded
destination, and minimum-valid-shape behavior for every registered operation.
`internal/agentcli` has one executable case for each of the 70 pinned public
command paths and runs success, HTTP 401, HTTP 403, invalid-argument, and
malformed-2xx outcomes where applicable.

The generic response matrix is complemented by
`agent-cli-output-evidence.json`. Sixty remote/orchestrated command paths
now use their official default text semantics rather than JSON dumps, including
message send/draft state, the task lifecycle, attachment receipts/comments,
manual/knowledge content, mention recovery, server/user discovery,
channel/server administration, reminder lifecycle output, action preparation,
migration control output, and the complete Integration family. No command path
now relies on an untyped generic JSON dump; `attachment view` remains binary.

Installed official-vs-Go process differentials compare request sequences, exit
codes, stdout, stderr, and—where applicable—request bodies plus durable draft
and consumed-sequence state. The evidence ledger lists the 54 command paths
covered directly; message send and task mutation paths each include multiple
success/held/error variants.

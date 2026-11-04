# Rsync-style byte deltas

`@opencraft/rsync-delta` is an independent, platform-neutral module. It implements
fixed-block signatures, a rolling weak checksum, SHA-256 confirmation,
COPY/LITERAL generation and checked reconstruction. It has no filesystem,
database, transport, directory, subscription or authorization owner. This is an
rsync-style algorithm, **not** rsync CLI/protocol wire compatibility.

The [rsync algorithm](https://rsync.samba.org/tech_report/node2.html) describes why
rolling checks find unchanged blocks even when insertions/deletions move their
offsets. Fixed page-position hashes do not provide that property. This module
chooses a greedy match, preferring full blocks over the shorter final block;
it does not promise an optimal or smallest delta.

## API

Supply a trusted SHA-256 implementation. Its input is borrowed for that call and
its result must contain exactly 32 SHA-256 bytes. The core imports neither Node
crypto nor browser globals. For example, in a Node adapter:

```ts
import { createHash } from "node:crypto";
import { RsyncDelta } from "@opencraft/rsync-delta";

const rsync = new RsyncDelta(bytes =>
  new Uint8Array(createHash("sha256").update(bytes).digest()));
const context = "authorized-view/source-epoch/query";
const signatures = await rsync.createSignatures(oldBytes, {
  context, basisId: "checkpoint-10", blockSize: 4096,
});
const { delta, statistics } = await rsync.createDelta(newBytes, signatures, {
  context, basisId: "checkpoint-10", targetId: "checkpoint-20",
});
// Obtain the expected target manifest through the authenticated source protocol,
// independently of an untrusted delta. This example uses the producer receipt.
const expectedTarget = { ...delta.target };
const rebuilt = await rsync.applyDelta(oldBytes, delta, {
  context, basisId: "checkpoint-10", target: expectedTarget,
});
```

`context` is opaque to this module. The caller binds it to the source epoch,
authorized view and canonical stream. `basisId` and the expected target manifest
bind the accepted revision boundaries. The module checks identity, byte lengths,
the full basis digest and the reconstructed target digest. A digest does not
authenticate its sender; a manifest copied blindly from an attacker is not a
trusted target. Permission checks, stable source snapshots, acknowledgements,
retained deltas and deletion tombstones belong to the source protocol.

Operations contain basis-relative byte offsets or owned `Uint8Array` literals.
The representation is suitable for structured transfer; no JSON/base64 codec is
implied. Applications own their transport encoding and canonical metadata
serialization. Recency display ordering should not be the stable record ordering
of a directory reconciliation stream.

## Work and ownership

Initial signatures and rolling traversal scan bytes linearly. A candidate weak
match gets one strong digest for that window; a map lookup resolves the block,
without hashing separately for every colliding signature. There are at most two
window lengths: the ordinary block size and the short final block. Each window
advances monotonically, including when a COPY skips multiple positions.
Repeated weak collisions can still cause O(N × blockSize) strong-hash work.
Hash budgets therefore bound work rather than claiming worst-case linear time.
The source still scans its bytes; the algorithm reduces transfer and rebuilding,
not the necessity of observing source changes.

The defaults bound one in-memory operation to 64 MiB per byte stream, 65,536
signatures, 65,536 instructions and 512 MiB of hashed input. Callers may choose
explicit `Limits`; `maxBytes` cannot exceed 2 GiB minus one. These are per-buffer
budgets, not an RSS bound: input snapshots, literals, provider copies and the output
can coexist. Larger resources require chunking or a separate streaming adapter.
Budget exhaustion returns `LIMIT_EXCEEDED`; no partial delta or output is returned.
The caller chooses whether to retry or use a full transfer.

Inputs, signature records, manifests and literals are defensively copied before
async digest boundaries, including Node `Buffer` inputs. Providers receive copies
of internal byte ranges. Cancellation is checked before and after each digest and
during traversal/apply. COPY bounds and cumulative output length are validated
before allocation; arithmetic uses subtraction against already bounded lengths.

## Verification

```sh
npm run test:rsync
npm run typecheck --workspace @opencraft/rsync-delta
python3 -m venv /tmp/rsync-verification
/tmp/rsync-verification/bin/pip install -r packages/rsync-delta/verification/requirements.txt
/tmp/rsync-verification/bin/python packages/rsync-delta/verification/verify.py --output /tmp/rsync-proof
```

The Python verifier uses pinned Z3 and saves replayable SMT-LIB queries when an
output directory is provided. It checks six counterexample queries:

- The rolling recurrence equals recomputation, modulo 2^16, for arbitrary window
  lengths represented by their modular length and defined tail aggregates.
- Every COPY byte index lies within its basis and destination segment.
- Outgoing and incoming rolling-window indices remain within the target.
- Coalescing adjacent contiguous COPY instructions preserves their source bytes
  and their bounds.
- A valid COPY or LITERAL preserves the target-prefix invariant. Given a correct
  old prefix and a matching next segment, reconstruction preserves equality.
- The greedy cursor strictly reduces its nonnegative remaining-byte rank.

All six must return `unsat`; `unknown` or timeout fails verification. The finite
model additionally enumerates all basis/target byte strings over `{0,1,2}` up to
length four, block sizes 1–4, with real weak checksums and forced constant weak
collisions: 117,128 cases. It checks progress, each intermediate prefix, bounds
and final reconstruction. `--max-length` changes this explicit finite bound.

The model treats a strong digest as collision-free byte identity. SHA-256
collision resistance, trusted source/view boundaries and a correct crypto
provider remain assumptions. These checks prove mathematical invariants and a
bounded abstract model, **not** the TypeScript program, compiler, cryptographic
primitive or distributed subscription system. Real TypeScript tests independently
check rolling conformance, generated edits, weak collisions, malformed inputs,
resource budgets, cancellation and async aliasing against actual SHA-256.

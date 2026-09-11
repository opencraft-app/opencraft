# Agent iteration guide

This repository is organized so an agent can change one semantic layer without
having to understand or rebuild both renderer hosts. Start from the contract,
keep platform code at the edge, and use the narrowest proof below before the
full gate.

## Change routing

| Change | Primary owner | Minimum focused proof |
| --- | --- | --- |
| JSON-RPC method or wire field | `packages/appserver-protocol` | protocol typecheck + AppServer tests |
| request lifecycle or host registry | `packages/appserver-client` | AppServer client tests |
| `epoch/nextSeq`, Journal, gap recovery, snapshot replacement | `packages/appserver-replica` | Replica tests |
| Codex Resume/View projection | `packages/appserver-session` | Session tests + `replica-resume` Lab scenario |
| Node/Web/Expo persistence | matching `appserver-replica-storage-*` package | adapter test/typecheck |
| daemon connection behavior | matching `appserver-transport-*` package | transport tests + Lab fault scenario |
| shared commands and view state | `packages/workbench-runtime` | runtime tests + both renderer builds |
| desktop frame or DOM editor | `apps/workbench-web`, `packages/codex-composer` | Vite build and browser review |
| native/iPad view | `apps/workbench-expo` | Expo Web export + iOS Metro bundle |

Do not add protocol, persistence, clocks, or daemon state directly to a React
component. Define a renderer-neutral port first and inject the platform
adapter. Do not edit recovered Codex or Paseo evidence; record its path in the
relevant architecture document and implement the behavior cleanly in OpenCraft.

## Replica invariants

- A V4 scope is one `(hostId, replica namespace)` and has one global sequence.
- `{ epoch, nextSeq }` names the exact next entry required by the receiver.
- Authority state is persisted atomically before a live event is published.
- Journal compaction never deletes command receipts or weakens idempotency.
- A cache may paint immediately but is non-authoritative until catch-up ends.
- Duplicate entries are ignored, adjacent entries apply, and gaps synchronize.
- Epoch change, compaction and rewind converge through atomic snapshot install.
- Codex V3 remains a View adapter; do not label its local revisions as a
  server-sequenced V4 Journal.

## Proof ladder

```bash
npm run typecheck --workspace @opencraft/appserver-replica
npx tsx --test tests/appserver-replica.test.ts
npm run test:appserver
npm run test:appserver:lab
npm run gate
```

Use the real daemon proof when changing the Codex adapter:

```bash
npm run lab -- scenario replica-resume \
  --thread <stable-thread-id> \
  --url ws://127.0.0.1:9988/rpc
```

The focused tests make local iteration fast. `npm run gate` is the merge
contract: platform boundaries, every workspace typecheck, protocol and Lab
tests, Vite production build, Expo Web export, and Expo iOS bundle must all
pass.

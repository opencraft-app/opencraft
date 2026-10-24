# DSH thread bindings

## goal
Restore correct model identity and dynamic capability inheritance across create/fork/resume, without activating cold Agents for display.

## phases
- [x] Inspect pinned DSH contracts.
- [x] Implement boundary fixes and regression tests.
- [x] Validate real isolated Host and desktop presentation; report artifact boundaries.

## decisions
Reuse ThreadCatalog configuration; no second model store or history mirror. Preserve protocol tool specs separately from normalized invocation descriptors. Reject malformed specs before native creation.

## errors
No context route matched. The pinned runtime is runtime/dsh.

First typecheck: selection-only projection incorrectly annotated as a full directory. Corrected return contract; no dummy catalog values added.

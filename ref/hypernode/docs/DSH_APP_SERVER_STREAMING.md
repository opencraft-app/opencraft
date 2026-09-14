# DSH to app-server streaming projection

HyperNode exposes DeepSeek Harness (DSH) through the Codex app-server item
lifecycle. The public thread and turn belong to HyperNode; DSH events are an
execution log that must be projected without changing their order or hiding
provider latency.

## Why this exists

DSH emits `assistant/chunk` events while the model is producing text, followed
by an authoritative `assistant/message` and a terminal `turn/end`. A text
message cannot be classified as `commentary` or `final_answer` from its first
chunk: a later tool call or steer input makes it commentary, while a completed
turn makes it final.

Buffering all chunks until `turn/end` preserves the phase but destroys
streaming. It also makes two different delays indistinguishable:

- time to first token from the provider;
- time HyperNode spent withholding already-received tokens.

The projection therefore treats text visibility and phase classification as
two separate state transitions.

## State machine

```text
first text-delta
  -> item/started(agentMessage, text="", phase=null)
  -> item/agentMessage/delta (for every chunk, in order)

assistant/message
  -> reconcile streamed text with authoritative text
  -> keep the item open when the phase is still unknown

later tool/call, step/start, or steer user/message
  -> item/completed(phase=commentary, authoritative full text)

turn/end(completed)
  -> item/completed(phase=final_answer, authoritative full text)
  -> turn/completed

turn/end(error/interrupted)
  -> close every open item first
  -> complete the failed/interrupted turn; never leave a spinner behind
```

`phase=null` is intentional. Native Codex providers do not always know or emit
the message phase at item start. `item/completed` is the authoritative item and
may refine the phase after the text was streamed.

## Reconciliation rules

1. Every non-empty DSH text delta is forwarded exactly once.
2. If `assistant/message` starts with the streamed prefix, only its missing
   suffix is emitted as a delta.
3. If the authoritative message disagrees with the streamed prefix, HyperNode
   does not append the full message again. It logs a length-only diagnostic and
   lets `item/completed` replace the live item with the authoritative text.
4. Completed history stores canonical items only. Historical delta events are
   never replayed during `thread/read` or `thread/resume`.

## Protocol gates

- `item/started` precedes every delta for the same item.
- Deltas retain source order and are never duplicated.
- Concatenated deltas equal the authoritative completed text for a conforming
  DSH stream.
- Text followed by a tool is completed as `commentary` before the tool starts.
- The terminal assistant message is completed as `final_answer` before the
  turn completes.
- Failure and interruption close all open reasoning, assistant, and tool items.
- Resume returns only the canonical item ledger, not the transient stream.

## Observability

Measure provider and projection latency independently:

- `provider_first_text_ms`: turn dispatch to first DSH text delta;
- `projection_first_delta_ms`: first DSH text delta to app-server broadcast;
- `provider_stream_ms`: first to last DSH text delta;
- `projection_completion_ms`: authoritative DSH message to item completion.

## Presentation pacing

The canonical DSH Session log and completed app-server items retain the exact
provider text. Only the live `item/agentMessage/delta` projection is paced by a
Cordis `TextDeltaPacerService`:

- first visible text is scheduled immediately;
- a critically damped controller follows the provider's recent grapheme rate;
- small bursts are absorbed over a few 16ms frames;
- every received grapheme has a hard 300ms presentation deadline;
- `item/completed`, tools, steer boundaries and Turn completion are strict
  barriers behind preceding paced text;
- failures and interrupts flush pending text before closing visible items.

The 300ms value is a ceiling, not a target. Normal projection lag should remain
within a few frames. When a provider emits an entire answer in one coarse SSE
chunk, the deadline controller deliberately sacrifices some smoothness rather
than withhold received text past the bound. Network and Renderer stalls are
outside this server-side scheduling guarantee. The deadline starts on the host
monotonic clock when HyperNode receives each delta; upstream wall-clock event
timestamps cannot shorten or extend the presentation window.

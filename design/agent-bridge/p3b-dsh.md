# P3b DSH ACP

Opt-in DSH dialect uses the existing generic ACP bridge and Host. The native DSH
owner and Hermes are unchanged. Companion calls the upstream `agent.steer()`;
no DSH fork code is copied. Companion patch was ported from the user's
`dsh-plugins/acp-steering`; the channel and bridge integration are independent.

Real local acceptance: DSH 0.2.2-rc.1, configured Ollama Cloud
`deepseek-v4.1-flash` (cheapest of the configured Flash/Pro choices).
[Recording](recordings/p3b/dsh-host.json) contains Host admission/nativeInputId
and the same private inbox claimed messageId. Each successful run used one `sleep 8` tool task and one steer;
query has one native execution and native-input-id evidence. This is native inbox
receipt evidence, not proof of model comprehension. No client deployment occurs.

The initial isolated launch failed before model execution because the temporary
DSH_HOME lacked credentials. Credentials were privately copied to the temporary
home for successful tasks, with no model upgrade and no mutation replay. Two
successful minimal tasks were run: the second refreshed the recording after
adding explicit private admission frames to the trace.

## Implementation decisions

- Integrate the private fd directly in generic ACP connection rather than run a
  second proxy process; use the existing Host-owned process sandbox tree.
- Wait up to 1.5 seconds after native initialize for ready, then narrow capability.
  Private requests have a 5-second uncertainty timeout and never retry.
- Ship readable companion source, create only an async temporary patch overlay;
  no persistent DSH profile edits. Linux/macOS only; Windows capability stays off.
- Use native-input-id evidence at claimed; admission remains a separate facet.
- Preserve existing prompt/queue/interrupt semantics for other ACP dialects.
- Tests run with exported shell function BASH_FUNC_which%% removed: sandbox
  correctly rejects that invalid environment key in existing Host test fixtures.

## Validation

Companion and bridge deterministic tests cover missing plugin/not ready,
withdrawal/claimed order, unclaimed cleanup, private-channel loss without replay,
admission and claimed evidence. Real task uses the local test sandbox backend,
which validates Host routing, not production kernel isolation. macOS is not run.

Final checks: `npm run test:agent-bridge` ten consecutive passes, 173/173 each
(with the invalid exported shell-function key removed as described above);
root `npm run typecheck` passed, ACP workspace typecheck passed after the
admitted-process-exit fix, `npm run check:boundaries` passed. Staged gitleaks scan
found no leaks. Ten DSH tests include admitted process loss becoming unknown
with exactly one native execution. No production client/window was rebuilt.

## Independent review disposition

Review `thr_xuhi7uq2pq` (CodeBuddy hy4std/high) covered the full staged change.
Accepted and fixed: DSH ready gating no longer falls back to agent-provided
capabilities; uncertain native withdrawal emits unknown and fences repeated
withdrawal; invalid cleanup barrier has an end-to-end unknown/no-replay test.

Reviewer withdrew the finding after the upstream contract was checked: rejected the finding that native `inbox.remove(false)` means deletion failed:
upstream `Inbox.remove` explicitly returns false when `locate(id)` is undefined
(the message is already absent), returns true after splice, and throws on storage
failure. Both normal return values confirm absence at the serialized plugin
boundary. Treating false as failure would misclassify an already absent message.
The companion documents this contract; a regression covers the false return.
No DSH core implementation was copied.

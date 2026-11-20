import assert from "node:assert/strict";
import test from "node:test";
import { completeConversationComposerSubmission } from "../../apps/workbench-web/src/runtime/composer-submission-admission";
import type { SubmitIntent, SubmissionReceipt } from "@opencraft/composer-core";
import { SubmissionOutcomeUnknownError } from '@opencraft/chat-runtime';
const intent = { commandId: "command", clientMessageId: "message", target: { type: "existing-thread", key: { hostId: "host", threadId: "thread" } } } as SubmitIntent;
const receipt = { commandId: "command", clientMessageId: "message", hostId: "host", threadId: "thread", turnId: null, acceptedAt: 1, replayed: false } as SubmissionReceipt;
for (const succeeds of [true, false]) test(`draft custody waits for acknowledgement (${succeeds})`, async () => {
  let accept!: (r: SubmissionReceipt) => void, reject!: (e: Error) => void;
  const pending = new Promise<SubmissionReceipt>((resolve, fail) => { accept = resolve; reject = fail; });
  let settled = false, failures = 0;
  const result = completeConversationComposerSubmission(intent, pending, () => { failures++; });
  void result.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  if (succeeds) { accept({ ...receipt, disposition: "local-queue" }); assert.equal(await result, true); }
  else { reject(new Error("attachments could not be saved")); await assert.rejects(result, /attachments/); }
  assert.equal(failures, succeeds ? 0 : 1);
});
test("a receipt for a different input or conversation cannot release the draft", async () => {
  for (const patch of [{ commandId: "other" }, { clientMessageId: "other" }, { hostId: "other" }, { threadId: "other" }])
    await assert.rejects(completeConversationComposerSubmission(intent, Promise.resolve({ ...receipt, ...patch }), () => {}), /does not match/);
});

test('unconfirmed delivery retains draft custody without surfacing a duplicate composer error', async () => {
  let failures = 0;
  const result = await completeConversationComposerSubmission(intent,
    Promise.reject(new SubmissionOutcomeUnknownError()), () => failures++);
  assert.equal(result, false, 'only a matching receipt may consume the draft');
  assert.equal(failures, 1);
  await assert.rejects(completeConversationComposerSubmission(intent,
    Promise.reject(new Error('Could not confirm whether the host accepted this message.')), () => {}),
    /Could not confirm/, 'never suppress errors by text matching');
});

import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRpcError } from "@opencraft/appserver-client";
import type { SubmitIntent, SubmissionReceipt } from "@opencraft/composer-core";
import { continueNativeSessionInBranch, nativeSessionBusyBeforeInput } from "../../apps/workbench-web/src/runtime/native-session-recovery.js";

const intent = { commandId: "command", clientMessageId: "message", target: { type: "existing-thread", key: { hostId: "local", threadId: "codex_source" } },
  document: { type: "doc", content: [] }, selections: { model: "codex:one" }, attachments: [], context: [], options: {}, createdAt: 1 } as unknown as SubmitIntent;
const receipt = { threadId: "codex_child" } as SubmissionReceipt;
test("only a structured pre-prompt rejection can automatically fork", () => {
  assert.equal(nativeSessionBusyBeforeInput(new Error("This Codex session is in use by another Codex client")), false);
  assert.equal(nativeSessionBusyBeforeInput(new AppServerRpcError({ code: 409, message: "busy", data: { code: "CODEX_SESSION_BUSY", inputNotSent: true } })), true);
  assert.equal(nativeSessionBusyBeforeInput(new AppServerRpcError({ code: 409, message: "busy", data: { code: "CODEX_SESSION_BUSY" } })), false);
});
test("automatic branch opens the acknowledged child then sends the identical immutable input once", async () => {
  const calls: string[] = []; let forwarded: SubmitIntent | undefined;
  assert.equal(await continueNativeSessionInBranch({ intent, current: () => true, supportsFork: async () => true,
    fork: async () => { calls.push("fork"); return "codex_child"; },
    open: async id => { calls.push("open:" + id); return true; },
    submit: async value => { calls.push("send"); forwarded = value; return receipt; },
  }), receipt);
  assert.deepEqual(calls, ["fork", "open:codex_child", "send"]);
  assert.equal(forwarded?.commandId, intent.commandId); assert.equal(forwarded?.clientMessageId, intent.clientMessageId);
  assert.equal(forwarded?.document, intent.document); assert.equal(forwarded?.attachments, intent.attachments);
});
test("late fork and unknown fork results do not navigate or dispatch the input", async () => {
  let current = true, opens = 0, sends = 0;
  const base = { intent, current: () => current, supportsFork: async () => true,
    fork: async () => { current = false; return "codex_child"; },
    open: async () => { opens++; return true; }, submit: async () => { sends++; return receipt; } };
  await assert.rejects(continueNativeSessionInBranch(base), /created/);
  assert.equal(opens, 0); assert.equal(sends, 0);
  current = true;
  await assert.rejects(continueNativeSessionInBranch({ ...base, fork: async () => { throw new Error("unknown creation"); } }), /unknown/);
  assert.equal(opens, 0); assert.equal(sends, 0);
});

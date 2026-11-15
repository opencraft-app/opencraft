import assert from "node:assert/strict";
import test from "node:test";
import { executionCliInstructions, type ExecutionCliLease } from "../../packages/session-capabilities/src/execution-cli";
import { THREAD_CLI_INSTRUCTION_OPEN, stripExecutionCliInstruction, threadCliFreeText, threadCliLabel } from "../../packages/session-capabilities/src/thread-cli-instruction";

const lease = (launcher: string): ExecutionCliLease => ({ environment: { OPENCRAFT_THREAD_CLI: launcher }, async revoke() {} });

test("the generated thread CLI note carries a stable marker and is removed as a whole block", () => {
  const note = executionCliInstructions(lease("/tmp/opencraft runtime/thread cli/opencraft"));
  assert.ok(note.startsWith(THREAD_CLI_INSTRUCTION_OPEN));
  assert.match(note, /OpenCraft execution-scoped thread CLI: '\/tmp\/opencraft runtime\/thread cli\/opencraft'/u);
  assert.equal(stripExecutionCliInstruction(note), "");
  assert.equal(threadCliFreeText(note), null);
});

test("only the complete generated note is removed; user text and near-matches survive", () => {
  const note = executionCliInstructions(lease("/tmp/opencraft-thread-cli/opencraft"));
  assert.equal(stripExecutionCliInstruction(`查一下旧会话\n${note}`), "查一下旧会话");
  assert.equal(stripExecutionCliInstruction(`user text\n\n${note}`), "user text\n");
  assert.equal(stripExecutionCliInstruction(`${THREAD_CLI_INSTRUCTION_OPEN}\nI copied the marker, not the note.`),
    `${THREAD_CLI_INSTRUCTION_OPEN}\nI copied the marker, not the note.`);
  assert.equal(stripExecutionCliInstruction("OpenCraft execution-scoped thread CLI: '/tmp/launcher'."),
    "OpenCraft execution-scoped thread CLI: '/tmp/launcher'.");
  assert.equal(threadCliFreeText("  "), null);
});

test("pre-marker native records are still removed without fuzzy matching", () => {
  const legacy = "OpenCraft execution-scoped thread CLI: '/tmp/opencraft runtime/thread cli/opencraft'. Use this exact executable in place of opencraft for thread commands. It is authorized only for this input and its initiating person. A conversation reference does not grant access. This launcher uses a loopback connection; if your Agent sandbox blocks it, request approval through its existing permission flow. Read referenced history with thread output; follow history.nextCursor with --cursor when needed.";
  assert.equal(stripExecutionCliInstruction(legacy), "");
  assert.equal(stripExecutionCliInstruction(`用户问题\n${legacy}`), "用户问题");
  assert.equal(stripExecutionCliInstruction(`${legacy} trailing user text`), `${legacy} trailing user text`);
});

test("truncated native labels keep the user text and lose the generated path", () => {
  const truncated = "Remember this unique verification passphrase: HANDOFF-4148F7808CE63489. Reply exactly STORED. Do not use tools or change files.\nOpenCraft execution-scoped thread CLI: '/data/code/opencraft/.runtime/ma";
  assert.equal(threadCliLabel(truncated), "Remember this unique verification passphrase: HANDOFF-4148F7808CE63489. Reply exactly STORED. Do not use tools or change files.");
  assert.equal(threadCliLabel("用户自己的标题"), "用户自己的标题");
  assert.equal(threadCliLabel(`${THREAD_CLI_INSTRUCTION_OPEN}\nOpenCraft execution-scoped thread CLI: '/data/code/opencraft/.runtime/ma`), "");
});

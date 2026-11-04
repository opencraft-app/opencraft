import assert from "node:assert/strict";
import test from "node:test";
import { completedResponsesBody } from "../../packages/account-pool-host/src/responses-stream.js";

async function inspect(text: string, keepOpen: boolean, chunkSize = 4093) {
  const events: string[] = [], chunks: Uint8Array[] = [];
  const bytes = new TextEncoder().encode(text); let offset = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset < bytes.length) { controller.enqueue(bytes.subarray(offset, offset += chunkSize)); }
    else if (!keepOpen) controller.close();
  }, cancel() { cancelled = true; } });
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([(async () => { for await (const chunk of completedResponsesBody(body, e => events.push(e))) chunks.push(chunk); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("terminal still awaiting EOF")), 4000); })]);
  } finally { clearTimeout(timer!); }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  return { events, cancelled };
}

for (const [type, result] of [["response.completed", "completion"], ["response.failed", "failure"], ["response.incomplete", "failure"]]) {
 test(`validated ${type} ends a provider stream without EOF`, async () => {
  const frame = `event: ${type}\r\ndata: ${JSON.stringify({ type, response: { id: "resp-test", output: [] } })}\r\n\r\n`;
  const { events, cancelled } = await inspect(frame, true, 1);
  assert.deepEqual(events, [result]); assert.equal(cancelled, true);
 });
}

test("a multi-megabyte terminal remains recognizable without buffering its output", async () => {
  const output = ('完成 \\"type\\":\\"response.failed\\" ').repeat(100_000);
  const frame = `data: ${JSON.stringify({ response: { output: [{ text: output }], id: "resp-large" }, type: "response.completed" })}\n\n`;
  assert.ok(Buffer.byteLength(frame) > 3 * 1024 * 1024);
  assert.deepEqual((await inspect(frame, true)).events, ["completion"]);
});

for (const [name, value] of [
  ["output text containing terminal JSON", JSON.stringify({ type: "response.output_text.delta", delta: '{"type":"response.completed","response":{"id":"fake"}}' })],
  ["duplicate final type", '{"type":"response.completed","response":{"id":"r"},"type":"delta"}'],
  ["duplicate final response", '{"type":"response.completed","response":{"id":"r"},"response":null}'],
  ["duplicate final id", '{"type":"response.completed","response":{"id":"r","id":7}}'],
  ["missing comma", '{"type":"response.completed" "response":{"id":"r"}}'],
  ["trailing comma", '{"type":"response.completed","response":{"id":"r"},}'],
  ["trailing garbage", '{"type":"response.completed","response":{"id":"r"}}garbage'],
  ["invalid nested value", '{"type":"response.completed","response":{"id":"r","output":[tru]}}'],
  ["invalid string escape", '{"type":"response.completed","response":{"id":"r","output":"\\q"}}'],
] as const) {
 test(`${name} cannot create terminal evidence`, async () => {
  assert.deepEqual((await inspect(`data: ${value}\n\n`, false, 3)).events, ["eof"]);
 });
}

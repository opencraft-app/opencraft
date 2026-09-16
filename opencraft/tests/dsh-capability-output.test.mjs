import test from "node:test";
import assert from "node:assert/strict";
import { admitCapabilityOutput } from "../apps/local-agent-host/src/dsh-capability-output.mjs";
test("text and image output preserve order and use durable attachment admission", async () => {
  const images = [];
  const result = await admitCapabilityOutput({ success: true, contentItems: [
    { type: "inputText", text: "before" },
    { type: "inputImage", imageUrl: "data:image/png;base64,YQ==" },
    { type: "inputText", text: "after" },
  ] }, { saveImage: async image => { images.push(image); return { attachmentId: "stored-image" }; } }, new AbortController().signal);
  assert.deepEqual(result.content.map(item => item.type), ["text", "image", "text"]);
  assert.equal(result.content[1].attachment.attachmentId, "stored-image");
  assert.equal(Buffer.from(images[0].data).toString(), "a");
});
test("unsupported output, failure and cancellation are explicit and never silently dropped", async () => {
  const attachments = { saveImage: async () => { throw new Error("should not save"); } };
  const signal = new AbortController().signal;
  await assert.rejects(admitCapabilityOutput({ success: true, contentItems: [{ type: "inputImage", imageUrl: "https://example.com/private" }] }, attachments, signal), /inline/);
  await assert.rejects(admitCapabilityOutput({ success: true, contentItems: [{ type: "inputAudio", audioUrl: "data:audio/wav;base64,YQ==" }] }, attachments, signal), /audio/);
  await assert.rejects(admitCapabilityOutput({ success: false, contentItems: [{ type: "inputText", text: "host denied" }] }, attachments, signal), /host denied/);
  await assert.rejects(admitCapabilityOutput({}, attachments, signal), /Malformed/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(admitCapabilityOutput({ success: true, contentItems: [] }, attachments, abort.signal), /cancelled/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { publicP4Frame } from "../../scripts/smoke/agent-bridge/p4-recording.js";

test("P4 recording omits native error text, credentials and cross-platform paths", () => {
  for (const path of ["/Users/someone/config", "/private/var/folders/config", "C:\\Users\\someone\\config", "$HOME/.codebuddy/config"]) {
    const result = publicP4Frame({ id: 4, error: { code: -32603, message: `ENOENT ${path} API_KEY=private-value`,
      data: { details: `Request failed with status code 500 ${path}`, accountConfig: { example: "private-value" } } } });
    const text = JSON.stringify(result);
    assert(!text.includes(path)); assert(!text.includes("private-value"));
    assert.equal((result.error as any).category, "native-http-500");
  }
});

test("P4 recording preserves correlation while omitting native content and metadata", () => {
  const request = publicP4Frame({ id: 3, method: "session/steer", params: { sessionId: "/Users/private", expectedRequestId: "owner",
    clientUserMessageId: "message", contentBlocks: [{ type: "text", text: "private-value" }] } });
  const insertion = publicP4Frame({ method: "session/update", params: { sessionId: "/Users/private", update: {
    sessionUpdate: "user_message_chunk", content: { text: "private-value" },
    _meta: { "codebuddy.ai/messageId": "message", "codebuddy.ai/conversationRequestId": "owner", token: "private-value" },
  } } });
  const params = request.params as any;
  const received = insertion.params as any;
  assert.equal(params.clientUserMessageId, received.update.messageId);
  assert.equal(params.expectedRequestId, received.update._meta["codebuddy.ai/conversationRequestId"]);
  assert.equal(params.sessionId, received.sessionId);
  assert(!JSON.stringify({ request, insertion }).includes("private-value"));
  assert(!JSON.stringify({ request, insertion }).includes("/Users/"));
});

test("P4 probe recording retains only the established probe category", () => {
  const frame = publicP4Frame({ id: 2, error: { code: -32602, message: "Invalid params",
    data: 'Steer operation requires "sessionId" /Users/someone/private-value' } });
  assert.equal((frame.error as any).category, "codebuddy-steer-session-required");
  assert(!JSON.stringify(frame).includes("private-value"));
});

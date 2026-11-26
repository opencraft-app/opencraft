import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexStartRequest } from "../../apps/headless-server/src/cloudflare/codex-thread-start.ts";

const attachment = {
  clientInstanceId: "client_instance_12345678",
  actorId: "human://user-1",
  actorGeneration: 1,
  expiresAt: 1_900_000_000_000,
  loginDigest: "a".repeat(64),
};

test("parseCodexStartRequest accepts null serviceTier and rejects non-null serviceTier", () => {
  const accepted = parseCodexStartRequest(
    {
      attachment,
      requestId: "req-1",
      options: {
        model: "gpt-oss-20b",
        serviceTier: null,
        historyMode: "paginated",
        runtimeWorkspaceRoots: [],
      },
    },
    "thread/start",
  );
  assert.equal(accepted?.options.model, "gpt-oss-20b");
  assert.equal(accepted?.options.historyMode, "paginated");

  const rejected = parseCodexStartRequest(
    {
      attachment,
      requestId: "req-2",
      options: {
        model: "gpt-oss-20b",
        serviceTier: "fast",
      },
    },
    "thread/start",
  );
  assert.equal(rejected, null);
});

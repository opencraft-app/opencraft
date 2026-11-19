import assert from "node:assert/strict";
import test from "node:test";
import { channelSearchSource } from "../../apps/workbench-web/src/runtime/channel-search-contribution";
import { parseChannelResource } from "../../plugins/im/src/channel-search";
test("native search keeps individual message destinations and bounded matching excerpts", async () => {
  const source = channelSearchSource(
    {
      id: "test",
      async search() {
        return {
          matches: [1, 2].map((sequence) => ({
            channel: { id: "group:one", title: "群", canSend: true },
            message: {
              sequence,
              text: "很长的历史".repeat(100) + " IOA 查询",
              author: "企微同事",
              at: sequence,
              status: "received" as const,
            },
          })),
          nextBefore: 1,
        };
      },
    },
    "群消息",
  );
  const result = await source.search("ioa", null, new AbortController().signal);
  assert.equal(new Set(result.matches.map((m) => m.id)).size, 2);
  for (const match of result.matches) {
    assert.match(match.snippet!, /IOA/);
    assert.ok(match.snippet!.length < 250);
    assert.equal(parseChannelResource(match.viewTarget?.resourceUri)?.id, "group:one");
  }
  assert.equal(parseChannelResource(result.matches[1].viewTarget?.resourceUri)?.sequence, 2);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(source.search("ioa", null, abort.signal));
});

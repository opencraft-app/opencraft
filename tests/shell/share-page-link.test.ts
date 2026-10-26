import assert from "node:assert/strict";
import test from "node:test";
import { sharePageLink } from "../../apps/workbench-web/src/runtime/share-page-link";

const data = { url: "https://example.test/local/conversation?hostId=host", title: "Conversation" };

test("share starts inside the original caller, before its first async continuation", async () => {
  let called = false, copied = false;
  let finish!: () => void;
  const result = sharePageLink(data, {
    share: payload => { assert.deepEqual(payload, data); called = true; return new Promise(resolve => { finish = resolve; }); },
    clipboard: { writeText: async () => { copied = true; } },
  });
  assert.equal(called, true);
  finish();
  assert.equal(await result, "shared");
  assert.equal(copied, false);
});

test("cancelling the system sheet does not copy or surface a failure", async () => {
  assert.equal(await sharePageLink(data, {
    share: async () => { throw new DOMException("Cancelled", "AbortError"); },
    clipboard: { writeText: async () => { assert.fail("Cancel must not write clipboard"); } },
  }), "cancelled");
});

test("absent or unsupported Web Share copies exactly the URL", async () => {
  for (const unsupported of [false, true]) {
    const writes: string[] = [];
    assert.equal(await sharePageLink(data, {
      ...(unsupported ? { canShare: () => false, share: async () => { assert.fail("Unsupported share"); } } : {}),
      clipboard: { writeText: async value => { writes.push(value); } },
    }), "copied");
    assert.deepEqual(writes, [data.url]);
  }
});

test("real share and clipboard errors remain failures, with no surprise fallback", async () => {
  const failure = new DOMException("Blocked", "NotAllowedError");
  await assert.rejects(sharePageLink(data, {
    share: async () => { throw failure; },
    clipboard: { writeText: async () => { assert.fail("No implicit write after failed share"); } },
  }), error => error === failure);
  await assert.rejects(sharePageLink(data, { clipboard: { writeText: async () => { throw failure; } } }), error => error === failure);
  await assert.rejects(sharePageLink(data, {}), /Clipboard/);
});

test("local protocols never escape to a share target", async () => {
  await assert.rejects(sharePageLink({ url: "file:///private/workbench.html" }, {
    share: async () => { assert.fail("Local URL must not be shared"); },
  }), /Unsupported/);
});

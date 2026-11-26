import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AttachmentRef } from "@opencraft/appserver-protocol";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.ts";
import { OpenCraftMessageAttachments } from "../../apps/opencraft-daemon/src/opencraft-message-attachments.ts";
import {
  projectThreadAttachmentNotification,
  projectThreadAttachmentResult,
} from "../../apps/opencraft-daemon/src/thread-message-attachment-projection.ts";

const file: AttachmentRef = {
  id: "file-1", name: "note.pdf", mimeType: "application/pdf", size: 12,
  location: { kind: "host-file", path: "/host/attachments/file-1/content-note.pdf" },
};

test("OpenCraft message attachments survive store reopen and follow forked history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-message-attachments-"));
  try {
    const first = new OpenCraftMessageAttachments(directory);
    first.record("thread-1", "client-1", [file]);
    first.record("thread-1", "client-1", [file]);
    assert.throws(() => first.record("thread-1", "client-1", [{ ...file, name: "other.pdf" }]));
    assert.equal(first.hasReference(file.id), true);
    first.cloneThread("thread-1", "thread-2");
    first.close();

    const reopened = new OpenCraftMessageAttachments(directory);
    assert.deepEqual(reopened.list("thread-1", "client-1"), [file]);
    assert.deepEqual(reopened.list("thread-2", "client-1"), [file]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Thread live acknowledgement and paged history receive the same typed file metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thread-message-projection-"));
  try {
    const store = new OpenCraftMessageAttachments(directory);
    store.record("thread-1", "client-1", [file]);
    const nativeItem = {
      type: "userMessage", clientId: "client-1",
      content: [{ type: "mention", name: file.name, path: file.location.kind === "host-file" ? file.location.path : "" }],
    };
    const notification = projectThreadAttachmentNotification(store, {
      method: "item/completed", params: { threadId: "thread-1", item: nativeItem },
    });
    const live = (notification.params as { item: { attachments: unknown[] } }).item.attachments;
    assert.deepEqual(live, [{
      id: file.id, name: file.name, mimeType: file.mimeType, size: file.size,
      path: file.location.path,
    }]);
    const ordinaryMention = projectThreadAttachmentNotification(store, {
      method: "item/completed", params: { threadId: "thread-1", item: {
        type: "userMessage", clientId: "unrelated-client",
        content: [{ type: "mention", name: "README.md", path: "/workspace/README.md" }],
      } },
    });
    assert.equal("attachments" in (ordinaryMention.params as { item: object }).item, false);

    const page = projectThreadAttachmentResult(store, "thread/turns/list", { threadId: "thread-1" }, {
      data: [{ id: "turn-1", params: {
        clientUserMessageId: "client-1", input: nativeItem.content,
      }, items: [nativeItem] }],
      nextCursor: null,
    }) as { data: Array<{ params: { attachments: unknown[] }; items: Array<{ attachments: unknown[] }> }> };
    assert.deepEqual(page.data[0]?.params.attachments, live);
    assert.deepEqual(page.data[0]?.items[0]?.attachments, live);
    const resumed = projectThreadAttachmentResult(store, "thread/resume", { threadId: "thread-1" }, {
      thread: { id: "thread-1", turns: [{ id: "turn-1", items: [nativeItem] }] },
    }) as { thread: { turns: Array<{ items: Array<{ attachments: unknown[] }> }> } };
    assert.deepEqual(resumed.thread.turns[0]?.items[0]?.attachments, live);
    const itemPage = projectThreadAttachmentResult(store, "thread/items/list", { threadId: "thread-1" }, {
      data: [{ turnId: "turn-1", item: nativeItem }], nextCursor: null,
    }) as { data: Array<{ item: { attachments: unknown[] } }> };
    assert.deepEqual(itemPage.data[0]?.item.attachments, live);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bridge live acknowledgements and forks preserve the same recorded attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-message-projection-"));
  const store = new OpenCraftMessageAttachments(directory);
  const adapter = new CodexEngineAdapter({
    executable: process.execPath,
    runtimeDirectory: directory,
    dataDirectory: directory,
    nativeCodexHomeDirectory: join(directory, "native"),
    upstreamBaseUrl: "http://127.0.0.1:9/backend-api/codex",
    bridgeThreadRequest: async () => assert.fail("Attachment projection must not execute a Bridge request"),
  });
  try {
    Object.assign(adapter, { messageAttachments: store });
    const owners = adapter.bridgeOwners();
    const source = "bridge:codex:source", fork = "bridge:codex:fork";
    store.record(source, "client-1", [file]);
    const item = { type: "userMessage", clientId: "client-1" };
    const live = owners.projectNotification({ method: "item/completed", params: { threadId: source, item } });
    owners.observeIdentityResult("thread/fork", { threadId: source }, { thread: { id: fork } });
    const history = owners.projectHistory("thread/items/list", { threadId: fork }, { data: [{ item }] }) as {
      data: Array<{ item: { attachments: Array<{ id: string }> } }>;
    };
    const liveItem = (live.params as { item: { attachments: unknown } }).item;
    assert.deepEqual(liveItem.attachments, history.data[0].item.attachments);
    assert.equal(history.data[0].item.attachments[0].id, file.id);
  } finally {
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});

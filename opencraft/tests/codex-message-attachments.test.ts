import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AttachmentRef } from "@opencraft/appserver-protocol";
import { CodexMessageAttachments } from "../apps/opencraft-daemon/src/codex-message-attachments.ts";
import {
  projectCodexAttachmentNotification,
  projectCodexAttachmentResult,
} from "../apps/opencraft-daemon/src/codex-message-attachment-projection.ts";

const file: AttachmentRef = {
  id: "file-1", name: "note.pdf", mimeType: "application/pdf", size: 12,
  location: { kind: "host-file", path: "/host/attachments/file-1/content-note.pdf" },
};

test("Codex message attachments survive store reopen and follow forked history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-message-attachments-"));
  try {
    const first = new CodexMessageAttachments(directory);
    first.record("thread-1", "client-1", [file]);
    first.record("thread-1", "client-1", [file]);
    assert.throws(() => first.record("thread-1", "client-1", [{ ...file, name: "other.pdf" }]));
    assert.equal(first.hasReference(file.id), true);
    first.cloneThread("thread-1", "thread-2");
    first.close();

    const reopened = new CodexMessageAttachments(directory);
    assert.deepEqual(reopened.list("thread-1", "client-1"), [file]);
    assert.deepEqual(reopened.list("thread-2", "client-1"), [file]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex live acknowledgement and paged history receive the same typed file metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-message-projection-"));
  try {
    const store = new CodexMessageAttachments(directory);
    store.record("thread-1", "client-1", [file]);
    const nativeItem = {
      type: "userMessage", clientId: "client-1",
      content: [{ type: "mention", name: file.name, path: file.location.kind === "host-file" ? file.location.path : "" }],
    };
    const notification = projectCodexAttachmentNotification(store, {
      method: "item/completed", params: { threadId: "thread-1", item: nativeItem },
    });
    const live = (notification.params as { item: { attachments: unknown[] } }).item.attachments;
    assert.deepEqual(live, [{
      id: file.id, name: file.name, mimeType: file.mimeType, size: file.size,
      path: file.location.path,
    }]);
    const ordinaryMention = projectCodexAttachmentNotification(store, {
      method: "item/completed", params: { threadId: "thread-1", item: {
        type: "userMessage", clientId: "unrelated-client",
        content: [{ type: "mention", name: "README.md", path: "/workspace/README.md" }],
      } },
    });
    assert.equal("attachments" in (ordinaryMention.params as { item: object }).item, false);

    const page = projectCodexAttachmentResult(store, "thread/turns/list", { threadId: "thread-1" }, {
      data: [{ id: "turn-1", params: {
        clientUserMessageId: "client-1", input: nativeItem.content,
      }, items: [nativeItem] }],
      nextCursor: null,
    }) as { data: Array<{ params: { attachments: unknown[] }; items: Array<{ attachments: unknown[] }> }> };
    assert.deepEqual(page.data[0]?.params.attachments, live);
    assert.deepEqual(page.data[0]?.items[0]?.attachments, live);
    const resumed = projectCodexAttachmentResult(store, "thread/resume", { threadId: "thread-1" }, {
      thread: { id: "thread-1", turns: [{ id: "turn-1", items: [nativeItem] }] },
    }) as { thread: { turns: Array<{ items: Array<{ attachments: unknown[] }> }> } };
    assert.deepEqual(resumed.thread.turns[0]?.items[0]?.attachments, live);
    const itemPage = projectCodexAttachmentResult(store, "thread/items/list", { threadId: "thread-1" }, {
      data: [{ turnId: "turn-1", item: nativeItem }], nextCursor: null,
    }) as { data: Array<{ item: { attachments: unknown[] } }> };
    assert.deepEqual(itemPage.data[0]?.item.attachments, live);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

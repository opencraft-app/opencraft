import assert from "node:assert/strict";
import test from "node:test";
import { createQueuedImageLoader } from "../../apps/workbench-web/src/queued-submission-presentation";

test("queued photos retain the active Host and cancellable media lease", async () => {
  const controller = new AbortController();
  let request: any,
    released = 0;
  const load = createQueuedImageLoader(
    async (value) => {
      request = value;
      return {
        source: "blob:resolved-photo",
        release: () => {
          released++;
        },
      };
    },
    { conversationId: "thread-a", hostId: "host-a", cwd: "/workspace" },
  );
  const result = await load("/workspace/photo.png", controller.signal);
  assert.equal(result?.source, "blob:resolved-photo");
  assert.equal(request.hostId, "host-a");
  assert.equal(request.conversationId, "thread-a");
  assert.equal(request.resolvedTarget, "file:///workspace/photo.png");
  assert.equal(request.signal, controller.signal);
  result?.release?.();
  assert.equal(released, 1);
});

test("browser photos need no Host file read; blocked schemes cannot reach the loader", async () => {
  let reads = 0;
  const load = createQueuedImageLoader(
    async () => {
      reads++;
      return null;
    },
    { conversationId: null, hostId: "host-a", cwd: "/workspace" },
  );
  const signal = new AbortController().signal;
  const photo = "data:image/png;base64,AA==";
  assert.equal((await load(photo, signal))?.source, photo);
  assert.equal(await load("javascript:alert(1)", signal), null);
  assert.equal(reads, 0);
});

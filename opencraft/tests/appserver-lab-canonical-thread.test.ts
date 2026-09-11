import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readCanonicalThreadIdentity,
  resolveCanonicalThread,
} from "../apps/appserver-lab/src/canonical-thread-identity";

async function withTemporaryIdentity(
  run: (identityFile: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-thread-identity-"));
  try {
    await run(join(directory, "identity.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("canonical identity creates once and then returns exactly the persisted ID", async () => {
  await withTemporaryIdentity(async (identityFile) => {
    let creates = 0;
    const first = await resolveCanonicalThread({
      identityFile,
      now: () => 123,
      create: async () => {
        creates += 1;
        return "thread-one-and-only";
      },
    });
    const second = await resolveCanonicalThread({
      identityFile,
      create: async () => {
        creates += 1;
        return "forbidden-second-thread";
      },
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.identity.threadId, "thread-one-and-only");
    assert.equal(second.identity.threadId, "thread-one-and-only");
    assert.equal(creates, 1);
    assert.deepEqual(await readCanonicalThreadIdentity(identityFile), {
      version: 1,
      threadId: "thread-one-and-only",
      createdAtMs: 123,
    });
  });
});

test("concurrent resolvers cannot create two canonical AppServer threads", async () => {
  await withTemporaryIdentity(async (identityFile) => {
    let creates = 0;
    const create = async () => {
      creates += 1;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
      return "thread-concurrent";
    };
    const resolutions = await Promise.all([
      resolveCanonicalThread({ identityFile, create }),
      resolveCanonicalThread({ identityFile, create }),
      resolveCanonicalThread({ identityFile, create }),
    ]);
    assert.equal(creates, 1);
    assert.deepEqual(resolutions.map((resolution) => resolution.identity.threadId), [
      "thread-concurrent",
      "thread-concurrent",
      "thread-concurrent",
    ]);
    assert.equal(resolutions.filter((resolution) => resolution.created).length, 1);
  });
});

test("a failed first creation releases the lock without inventing an identity", async () => {
  await withTemporaryIdentity(async (identityFile) => {
    await assert.rejects(
      resolveCanonicalThread({
        identityFile,
        create: async () => {
          throw new Error("thread/start failed");
        },
      }),
      /thread\/start failed/,
    );
    assert.equal(await readCanonicalThreadIdentity(identityFile), null);
    const recovered = await resolveCanonicalThread({
      identityFile,
      create: async () => "thread-after-retry",
    });
    assert.equal(recovered.identity.threadId, "thread-after-retry");
  });
});

test("corrupt identity and abandoned lock fail loudly instead of replacing the ID", async () => {
  await withTemporaryIdentity(async (identityFile) => {
    await writeFile(identityFile, "{\"version\":1,\"threadId\":\"\"}\n", "utf8");
    await assert.rejects(readCanonicalThreadIdentity(identityFile), /Invalid canonical/);
    await rm(identityFile);
    await mkdir(`${identityFile}.lock`);
    await assert.rejects(
      resolveCanonicalThread({
        identityFile,
        lockTimeoutMs: 5,
        create: async () => "must-not-be-created",
      }),
      /Timed out waiting for canonical Thread lock/,
    );
  });
});

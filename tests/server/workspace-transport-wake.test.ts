import test from "node:test";
import assert from "node:assert/strict";
import type { OwnerWake } from "@opencraft/owner-wake";
import {
  ARTIFACT_TRANSFER_CHECK_MS,
  ARTIFACT_TRANSFER_IDLE_MS,
  WorkspaceArtifactTransfers,
} from "../../apps/headless-server/src/workspaces/artifact-transports.ts";
import {
  BROWSER_CHANNEL_CHECK_MS,
  BROWSER_CHANNEL_IDLE_MS,
  WorkspaceBrowserTransfers,
} from "../../apps/headless-server/src/workspaces/browser-transports.ts";
import { fakeMonotonicOwnerWake, fakeWakeClock, flush, HOUR } from "../support/fake-wake-clock.ts";

/** The owner wake-up over a fake monotonic clock, counting the wake-ups it delivers. */
function countingWake(fake: ReturnType<typeof fakeWakeClock>) {
  const base = fakeMonotonicOwnerWake(fake),
    state = { wakes: 0 };
  const wake: OwnerWake = {
    now: base.now,
    timer: (callback) =>
      base.timer(() => {
        state.wakes++;
        callback();
      }),
  };
  return { wake, state };
}
const access = { actorId: "human:1" } as never;

function artifacts(fake: ReturnType<typeof fakeWakeClock>, current: () => boolean) {
  const { wake, state } = countingWake(fake);
  const transfers = new WorkspaceArtifactTransfers({
    current,
    // A download whose source never arrives keeps the transfer open until it is closed.
    download: (_access, _thread, _path, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")))),
    upload: () => Promise.reject(Error("unused")),
    wake,
  });
  return { transfers, state };
}

test("artifact transfers: idle expiry exactly 30 s after the last touch; authority checked only while open", async () => {
  const fake = fakeWakeClock(0);
  let allowed = true;
  const { transfers, state } = artifacts(fake, () => allowed);
  fake.elapse(HOUR);
  assert.equal(state.wakes, 0, "no transfer: no wake-up (each transfer had its own 50 ms interval)");
  const token = transfers.download(access, "thread", "/a.txt");
  assert.equal(fake.pending, 2, "authority check and idle expiry");
  fake.elapse(10_000);
  assert.equal(state.wakes, 10_000 / ARTIFACT_TRANSFER_CHECK_MS, "authority re-checked every 50 ms while open");
  transfers.read(token, 0);
  fake.elapse(ARTIFACT_TRANSFER_IDLE_MS - 1);
  await flush();
  assert.equal(transfers.read(token, 0).state, "pending", "a touch moved the expiry later");
  fake.elapse(ARTIFACT_TRANSFER_IDLE_MS);
  await flush();
  assert.equal(
    transfers.requestClose(token),
    "closed",
    "closed exactly 30 s after the last touch (formerly 30.00-30.05 s)",
  );
  assert.equal(fake.pending, 0, "no transfer left: nothing armed");
  const revoked = transfers.download(access, "thread", "/b.txt");
  allowed = false;
  fake.elapse(ARTIFACT_TRANSFER_CHECK_MS);
  await flush();
  assert.equal(transfers.requestClose(revoked), "closed", "revocation closes within one 50 ms check");
  allowed = true;
  transfers.download(access, "thread", "/c.txt");
  await transfers.closeAll();
  assert.equal(fake.pending, 0, "closeAll disarms");
});

function browser(fake: ReturnType<typeof fakeWakeClock>, current: () => boolean) {
  const { wake, state } = countingWake(fake);
  const peer = {
    connected: true,
    automationCancellation: 1,
    automationNavigation: 1,
    inventory: [],
    workerPid: 1,
    on() {},
    off() {},
    send() {},
    async close() {},
  };
  const binding = {
    isCurrent: () => true,
    browser: { assertCurrent() {}, connect: async () => peer },
    executionSelection: async () => ({ kind: "bound", workspaceId: "w", generation: 1 }),
  };
  const transfers = new WorkspaceBrowserTransfers({
    current,
    binding: async () => binding as never,
    wake,
  });
  return { transfers, state };
}

test("browser channels: idle expiry exactly 30 s after the last touch; authority checked only while open", async () => {
  const fake = fakeWakeClock(0);
  let allowed = true;
  const { transfers, state } = browser(fake, () => allowed);
  fake.elapse(HOUR);
  assert.equal(state.wakes, 0, "no channel: no wake-up (the 100 ms interval ran regardless)");
  const token = transfers.open(access, "thread", { workspaceId: "w", generation: 1 });
  await flush();
  assert.equal((await transfers.status(token)).state, "ready");
  assert.equal(fake.pending, 2, "authority check and idle expiry");
  fake.elapse(1_000);
  assert.equal(state.wakes, 1_000 / BROWSER_CHANNEL_CHECK_MS, "authority re-checked every 100 ms while open");
  fake.elapse(BROWSER_CHANNEL_IDLE_MS - 1_000 - 1);
  await flush();
  assert.equal((await transfers.status(token)).state, "ready", "touched just before expiry");
  fake.elapse(BROWSER_CHANNEL_IDLE_MS - 1);
  await flush();
  assert.equal(transfers.requestClose(token), "pending", "not yet idle for 30 s");
  // requestClose itself starts closing; reopen to test the expiry alone.
  await flush();
  const idle = transfers.open(access, "thread", { workspaceId: "w", generation: 1 });
  await flush();
  fake.elapse(BROWSER_CHANNEL_IDLE_MS - 1);
  await flush();
  assert.equal((await transfers.status(idle)).state, "ready");
  const touchedAt = fake.monotonic;
  fake.elapse(BROWSER_CHANNEL_IDLE_MS);
  await flush();
  assert.equal(fake.monotonic - touchedAt, BROWSER_CHANNEL_IDLE_MS);
  assert.equal(
    transfers.requestClose(idle),
    "closed",
    "closed exactly 30 s after the last touch (formerly 30.0-30.1 s)",
  );
  assert.equal(fake.pending, 0, "no channel left: nothing armed");
  const revoked = transfers.open(access, "thread", { workspaceId: "w", generation: 1 });
  await flush();
  allowed = false;
  fake.elapse(BROWSER_CHANNEL_CHECK_MS);
  await flush();
  assert.equal(transfers.requestClose(revoked), "closed", "revocation closes within one 100 ms check");
  allowed = true;
  transfers.open(access, "thread", { workspaceId: "w", generation: 1 });
  await flush();
  await transfers.closeAll();
  assert.equal(fake.pending, 0, "closeAll disarms");
});

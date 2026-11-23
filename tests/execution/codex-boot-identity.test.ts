import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootIdentity } from "../../apps/codex-core/src/boot-identity.ts";

test(
  "Linux keeps the kernel boot ID, so persisted owner state still matches",
  { skip: process.platform !== "linux" },
  async () => {
    assert.equal(await bootIdentity(), readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  },
);

test("macOS and Windows read their own per-boot identity", async () => {
  const calls: string[] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(" "));
    return " 4A0C2F3E-1B2D-4C5E-9F00-0123456789AB\n";
  };
  assert.equal(await bootIdentity("darwin", run), "4A0C2F3E-1B2D-4C5E-9F00-0123456789AB");
  assert.match(calls[0]!, /^\/usr\/sbin\/sysctl -n kern\.bootsessionuuid$/u);
  assert.equal(await bootIdentity("win32", async () => "134079852000000000\r\n"), "134079852000000000");
});

test("an unavailable or malformed identity is refused rather than guessed", async () => {
  await assert.rejects(bootIdentity("aix"), /unavailable on this platform/u);
  await assert.rejects(
    bootIdentity("darwin", async () => ""),
    /unavailable/u,
  );
  await assert.rejects(
    bootIdentity("darwin", async () => "not a uuid; rm -rf /"),
    /unavailable/u,
  );
  await assert.rejects(
    bootIdentity("darwin", async () => {
      throw Error("sysctl missing");
    }),
    /sysctl missing/u,
  );
});

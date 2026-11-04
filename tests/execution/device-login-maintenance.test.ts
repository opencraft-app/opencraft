import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { CodexAccountService } from "../../packages/account-pool-host/src/codex-account-service.js";

// The account RPC is the boundary. The old owner's original receipt is immutable.
test("device-login poll distinguishes maintenance interruption without changing the original receipt", async () => {
  const data = await mkdtemp(join(tmpdir(), "device-maintenance-"));
  let service: CodexAccountService | undefined;
  try {
    const original = { status: "error" as const, message: "Login cancelled." };
    const retained = { imageAffinities: [], resetReceipts: [], loginReceipts: [
      ["11111111-1111-4111-8111-111111111111", { expiresAt: Date.now() + 60_000, result: original }],
      ["manual-session", { expiresAt: Date.now() + 60_000, result: original }],
    ] as any };
    const before = structuredClone(retained);
    const directory = join(data, "device-login-maintenance");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "11111111-1111-4111-8111-111111111111.json"), JSON.stringify({
      version: 1, kind: "device-login-maintenance", operationId: "operation-1",
      source: { owner: "fixture-owner", epoch: 1, operationId: "operation-1", fence: "fixture-fence" },
      sessionId: "11111111-1111-4111-8111-111111111111", cancelAttempted: true,
      terminal: true, disposition: "maintenance-interrupted", originalResult: original,
      resultSha256: createHash("sha256").update(JSON.stringify({ message: original.message, status: original.status })).digest("hex"),
    }), { mode: 0o600 });
    service = await CodexAccountService.start({ executable: process.execPath, dataDirectory: data,
      nativeCodexHomeDirectory: join(data, "native"), proxyPort: 0,
      ownerHandoff: { admissionOpen: () => false, onUncertain: () => {}, retained },
      createMaintenanceClient: async () => { throw new Error("poll must not restart a login or replay cancellation"); } });
    assert.deepEqual(await service.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: "11111111-1111-4111-8111-111111111111" }),
      { ...original, reason: "maintenance-interrupted" });
    assert.deepEqual(await service.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: "manual-session" }), original);
    const metadata = join(directory, "11111111-1111-4111-8111-111111111111.json");
    await chmod(metadata, 0o644);
    assert.deepEqual(await service.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: "11111111-1111-4111-8111-111111111111" }), original);
    await chmod(metadata, 0o600);
    const wrong = JSON.parse(await readFile(metadata, "utf8"));
    wrong.resultSha256 = "0".repeat(64);
    await writeFile(metadata, JSON.stringify(wrong), { mode: 0o600 });
    assert.deepEqual(await service.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: "11111111-1111-4111-8111-111111111111" }), original);
    const external = join(data, "external-metadata.json");
    await writeFile(external, JSON.stringify(wrong), { mode: 0o600 });
    await rm(metadata); await symlink(external, metadata);
    assert.deepEqual(await service.request("opencraft/codex/accounts/deviceLogin/poll", { sessionId: "11111111-1111-4111-8111-111111111111" }), original);
    assert.deepEqual(service.retainedState(), before);
  } finally { await service?.close(); await rm(data, { recursive: true, force: true }); }
});

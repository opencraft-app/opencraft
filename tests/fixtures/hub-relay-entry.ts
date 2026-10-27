/** Test-only gateway composition. Never selected by the public Relay entry. */
import { runRelayCli } from "../../apps/relay-server/src/application";
import { readPrivateJson } from "../../packages/identity-core/src/node";

await runRelayCli({
  async createIdentity() {
    const file = process.env.OPENCRAFT_HUB_FIXTURE_CREDENTIAL_FILE;
    if (!file) throw new Error("The isolated Hub gateway requires its private fixture credential");
    const value = await readPrivateJson(file);
    if (typeof value !== "object" || value === null || !("credential" in value)
      || typeof value.credential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.credential)) {
      throw new Error("Invalid Hub fixture credential");
    }
    let credential: string | null = value.credential;
    const principal = { provider: "fixture", subject: "123", displayName: "Network member", expiresAt: Date.now() + 3_600_000 };
    return {
      provider: { authenticate: request => credential !== null && request.headers["x-fixture-credential"] === credential ? principal : null },
      close() { credential = null; },
    };
  },
});

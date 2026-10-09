import {spawnSync} from "node:child_process";
import {resolve} from "node:path";

describe("credential scan command", () => {
  it("runs under the Node release environment", () => {
    const clientRoot = resolve(__dirname, "../..");
    const webRoot = resolve(clientRoot, "../..");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve(clientRoot, "tools/scan-secrets.ts")],
      {
        cwd: webRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("凭证扫描通过");
  });
});

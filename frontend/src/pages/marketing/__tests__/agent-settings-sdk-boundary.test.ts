import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("agent settings TEA SDK boundary", () => {
  it("keeps SDK panel inputs stable so background refreshes cannot remount ready content as loading", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).toMatch(/const sdkInstance = useMemo<TeaSdkInstanceInfo \| null>/);
    expect(page).toMatch(/const sdkFeatureFlags = useMemo<TeaSdkFeatureFlags>/);
    expect(page).toMatch(/const sdkProductConfigArgs = useMemo/);
    expect(page).toMatch(/const productConfig = useMemo/);
    expect(page).not.toMatch(/productConfig=\{runtime\.createProductConfig\(productConfigArgs\)\}/);
    expect(page).not.toMatch(/const sdkInstance: TeaSdkInstanceInfo =/);
  });
});

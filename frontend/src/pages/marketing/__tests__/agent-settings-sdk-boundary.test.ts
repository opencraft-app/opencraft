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
    expect(page).toMatch(/composeDebugExecCommandLifecycles/);
    expect(page).toMatch(/createQqbotGroupPolicyCommandLifecycle/);
    expect(page).toMatch(/commandLifecycle: sdkCommandLifecycle/);
    expect(page).toMatch(/\{automationModelSwitchDialog\}/);
    expect(page).not.toMatch(/productConfig=\{runtime\.createProductConfig\(productConfigArgs\)\}/);
    expect(page).not.toMatch(/const sdkInstance: TeaSdkInstanceInfo =/);
  });

  it("uses the product provider catalog but routes model configuration through the real Hermes panel", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).toContain('import { AgentModelConfigPanel } from "@/pages/marketing/agent-model-config/agent-model-config-panel";');
    expect(page).toContain('import { resolveProductModelProviderOptions } from "@/pages/marketing/agent-model-config/product-provider-adapter";');
    expect(page).toMatch(/runtime\.useModelProviders\(\{ isI18n: isGlobal, useEnglish \}\)/);
    expect(page).toMatch(/resolveProductModelProviderOptions\(productConfig, modelProviders, \{[\s\S]*regionId: instance\.RegionId/);
    expect(page).toMatch(/<AgentModelConfigPanel[\s\S]*botId=\{botId\}[\s\S]*execDebugCommand=\{execDebugCommand\}/);
    expect(page).not.toContain("AgentModelConfigPrototypePanel");
    expect(page).not.toContain("sdk.ModelPanel");
    expect(page).not.toContain("runtime.ModelPanel");
  });
});

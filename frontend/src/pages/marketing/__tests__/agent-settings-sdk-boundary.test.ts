import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

// !3049 配置面板本地化后，settings-page 脱离 Tea SDK 输入体系：
// 面板输入（productConfig / commandLifecycle）改由本地 useMemo 稳定提供，
// 真实 debug exec adapter 定义在 agent-tat-adapter，
// authApiBaseUrl 空值守卫收敛到 repositories 层。
describe("agent settings TEA SDK boundary", () => {
  it("keeps panel inputs stable so background refreshes cannot remount ready content as loading", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).toMatch(/const productConfig = useMemo<IProductConfig>/);
    expect(page).toMatch(/const sdkCommandLifecycle = useMemo/);
    expect(page).toMatch(/composeDebugExecCommandLifecycles/);
    expect(page).toMatch(/createQqbotGroupPolicyCommandLifecycle/);
    expect(page).toMatch(/commandLifecycle: sdkCommandLifecycle/);
    expect(page).toMatch(/\{automationModelSwitchDialog\}/);
    // 老 SDK 架构的反模式不得回归
    expect(page).not.toMatch(
      /productConfig=\{runtime\.createProductConfig\(productConfigArgs\)\}/,
    );
    expect(page).not.toMatch(/const sdkInstance: TeaSdkInstanceInfo =/);
    expect(page).not.toMatch(/const sdkProductConfigArgs = useMemo/);
  });

  it("uses the product provider catalog but routes model configuration through the real Hermes panel", () => {
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");

    expect(page).toContain('import { AgentModelConfigPanel } from "@/pages/marketing/agent-model-config/agent-model-config-panel";');
    expect(page).toContain('import { resolveProductModelProviderOptions } from "@/pages/marketing/agent-model-config/product-provider-adapter";');
    expect(page).toMatch(/useModelProviders\(\{ isI18n: isGlobal, useEnglish \}\)/);
    expect(page).toMatch(/resolveProductModelProviderOptions\(productConfig, modelProviders, \{[\s\S]*regionId: instance\.RegionId/);
    expect(page).toMatch(/<AgentModelConfigPanel[\s\S]*botId=\{instance\.InstanceId\}[\s\S]*execDebugCommand=\{execDebugCommand\}/);
    expect(page).not.toContain("AgentModelConfigPrototypePanel");
    expect(page).not.toContain("sdk.ModelPanel");
    expect(page).not.toContain("runtime.ModelPanel");
    expect(page).not.toMatch(/const AgentModelPanel = lazy/);
  });

  it("uses the real debug exec adapter whenever an auth API backend is configured", () => {
    const tatAdapter = readSource("src/pages/marketing/agent-tat-adapter.ts");
    const repositories = readSource("src/repositories/http-repositories.ts");

    // 真实 adapter 由 agent-tat-adapter 提供
    expect(tatAdapter).toMatch(/export function createMonoDebugExecAdapter\(/);
    // authApiBaseUrl 未配置时 repositories 层显式兜底，不再静默降级
    expect(repositories).toMatch(/if \(authApiBaseUrl === null\) \{/);
    // 本地预览 mock adapter 不得回归
    const page = readSource("src/pages/marketing/agent-settings-page.tsx");
    expect(page).not.toMatch(/useLocalPreviewAdapter/);
    expect(page).not.toMatch(/activeBotId === LOCAL_PREVIEW_BOT_ID/);
  });
});

/**
 * 创建引导「只建一次 bot、且把配置写完」的行为回归。
 *
 * 这条用例针对一个线上实际发生过、且纯靠源码文本守卫抓不到的问题：
 *
 *   useBuddyProfile 每次渲染都返回新的对象字面量
 *     → 页面的 handleBuddyCreated（useCallback 依赖了它）引用每渲染都变
 *     → 传进面板的 onCreated prop 引用每渲染都变
 *     → 面板里「建实例 + 写配置」那个 effect 的依赖数组每渲染都变
 *     → React 每渲染一次就 cleanup + 重跑该 effect
 *
 * 而那个 effect 是带副作用的：重跑会再调一次 onCreateBot（又建一个 bot），
 * 同时 cleanup 把上一次的 cancelled 置 true，令正在进行的写配置中断。
 * 结果就是用户看到的：bot 越建越多、人设与技能一个都没写进去、配额耗尽后
 * 弹回创建表单。
 *
 * 所以这里刻意模拟「父组件在创建过程中持续重渲染、并且每次都传入全新的
 * onCreated 函数」，断言：
 *   1. onCreateBot 只被调用一次
 *   2. 配置计划真的跑完了（写沙箱的命令发出去了）
 *   3. onCreated 最终被回调一次
 */

import { render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentOnboardingPanel } from "../agent-onboarding-panel";

/*
 * 同时 mock useT 与 t：引导面板经由配置计划间接引入了 hermes-parsers 等模块，
 * 它们在模块顶层就用裸 `t(...)` 定义常量，只 mock useT 会让整个测试文件加载失败。
 */
vi.mock("@/i18n/t", () => {
  const translate = (text: string, vars?: Record<string, unknown>) => (
    vars
      ? text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""))
      : text
  );
  return { useT: () => translate, t: translate };
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * 宿主组件：模拟真实页面在创建期间的行为 ——
 * 不断重渲染，并且每次渲染都传入一个全新的 onCreated 闭包。
 */
function Host({
  onCreateBot,
  execDebugCommand,
  onCreated,
}: {
  onCreateBot: (params: { name: string; sourceBotId: string }) => Promise<
    { botId: string; profileId: string } | null
  >;
  execDebugCommand: (botId: string, command: string) => Promise<{ status: string; exitCode: number; output: string }>;
  onCreated: (createdBotId: string) => void;
}) {
  const [, setTick] = useState(0);

  // 创建期间父组件持续重渲染（真实页面里由 setBots / 轮询等触发）
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 10);
    return () => clearInterval(timer);
  }, []);

  return (
    <AgentOnboardingPanel
      botId=""
      onCreateBot={onCreateBot}
      // 每次渲染都是新函数：这正是当初引发重复创建的那个条件
      onCreated={(createdBotId) => onCreated(createdBotId)}
      execDebugCommand={execDebugCommand}
      cloneOptions={{
        value: "bot-main",
        onChange: () => {},
        choices: [{ id: "bot-main", label: "主 Bot", isDefault: true }],
      }}
    />
  );
}

describe("onboarding setup runs exactly once", () => {
  it("creates the bot once and finishes writing the setup plan despite parent re-renders", async () => {
    const onCreateBot = vi.fn(async () => ({
      botId: "bot-new",
      profileId: "profile-new",
    }));
    // 沙箱探活与写配置都成功
    const execDebugCommand = vi.fn(async (_botId: string, _command: string) => ({
      status: "ok",
      exitCode: 0,
      output: _command.includes("ContentBase64:")
        ? `Exists: yes\nByteLength: 12\nContentBase64: ${btoa("cloned soul!")}` : "",
    }));
    const onCreated = vi.fn();

    /*
     * 刻意套 StrictMode：next.config.mjs 开了 reactStrictMode，React 会在同一
     * 实例上重放 effect（setup → cleanup → setup）。只在 cleanup 里标记「已卸载」
     * 的写法会被这一重放永久污染，导致整个配置流程静默卡死在 0/2。
     * 不套 StrictMode 的话这类 bug 测不出来。
     */
    render(
      <StrictMode>
        <Host
          onCreateBot={onCreateBot}
          execDebugCommand={execDebugCommand}
          onCreated={onCreated}
        />
      </StrictMode>,
    );

    await userEvent.click(await screenCreateButton());

    // 配置流程跑完
    await waitFor(() => expect(onCreated).toHaveBeenCalled(), { timeout: 8000 });

    // 核心断言：实例只建了一次
    expect(onCreateBot).toHaveBeenCalledTimes(1);
    // onCreated 也不该被重复触发
    expect(onCreated).toHaveBeenCalledTimes(1);
    // 配置确实写进沙箱了（不只是建完实例就结束）
    expect(execDebugCommand.mock.calls.length).toBeGreaterThan(1);

    /*
     * 回调必须带上新建 bot 的 id —— 页面靠它切到新 bot 的总览页。
     * 不带的话用户配置完会停在创建前那个 bot 的页面上。
     */
    expect(onCreated).toHaveBeenCalledWith("bot-new");

    /*
     * 而且所有配置命令都得发给新 bot，不能串写到别的 bot 上。
     * （第一个参数是 botId）
     */
    const targets = new Set(execDebugCommand.mock.calls.map((call) => call[0]));
    expect([...targets]).toEqual(["bot-new"]);
  }, 15000);
});

/** 取「创建」按钮 —— 文案经 useT 直出中文 */
async function screenCreateButton() {
  const { screen } = await import("@testing-library/react");
  return screen.getByRole("button", { name: "创建" });
}

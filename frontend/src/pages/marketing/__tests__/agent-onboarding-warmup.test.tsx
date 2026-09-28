/**
 * 创建 Bot「卡在喂咖啡环节」的回归。
 *
 * 线上表现：点创建后进度恒为 0/7、全部步骤灰着不动，约三分钟后弹出
 * 「实例尚未就绪，请稍后在设置页重试配置」。
 *
 * 根因是预热等待的两个缺陷：
 *   1. 等沙箱可执行命令这段（原先最长 180s）发生在第一个步骤之前，且完全
 *      没有 UI 表达 —— 清单在进入 creating 时就全铺成 pending，而进度只数
 *      done，所以必然恒为 0/N，用户分不清「还要等」和「已经卡死」。
 *   2. 探活循环 `catch {}` 空吞一切异常，401/403/404 这类永不自愈的错误也
 *      被当成「沙箱还没起好」空转满超时，最后统一报一句无信息量的文案，
 *      真实的 status / code / request_id 全部丢失。
 *
 * 这里守住修复后的行为：预热行可见且会推进进度；永久性错误立刻中止并透出
 * 真实原因；可恢复错误仍然继续等待。
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentOnboardingPanel } from "../agent-onboarding-panel";
import { classifySandboxProbeFailure, isRetriableSetupFailure } from "../agent-buddy-setup-runner";
import { buildSandboxWarmupStep } from "../agent-buddy-setup";

vi.mock("@/i18n/t", () => {
  const translate = (text: string, vars?: Record<string, unknown>) => (
    vars
      ? text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""))
      : text
  );
  return { useT: () => translate, t: translate };
});

/*
 * 必须显式 cleanup：本套件用 screen 做全局查询，上一个用例残留的面板会一起
 * 被查到（它的主文案正是「正在给 LightVela Bot 喂咖啡」），让断言错判。
 * 同时清掉续跑快照，避免用例之间互相影响。
 */
beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 造一个带 status 的 RepositoryError 同形错误（鸭子类型，与生产判定一致） */
const repositoryError = (message: string, status: number, code?: string) => {
  const error = new Error(message) as Error & { status: number; code?: string };
  error.name = "RepositoryError";
  error.status = status;
  error.code = code;
  return error;
};

describe("classifySandboxProbeFailure", () => {
  it("treats auth / permission / missing-instance failures as fatal", () => {
    // 这三个是本次 bug 的核心：等多久都不会变好，必须立刻中止
    expect(classifySandboxProbeFailure(repositoryError("登录态已失效", 401))).toBe("fatal");
    expect(classifySandboxProbeFailure(repositoryError("无权配置该实例", 403))).toBe("fatal");
    expect(classifySandboxProbeFailure(repositoryError("实例不存在", 404))).toBe("fatal");
    expect(classifySandboxProbeFailure(repositoryError("参数非法", 400))).toBe("fatal");
  });

  it("keeps waiting for failures that can still recover", () => {
    // 沙箱侧超时：实例大概只是还没起好
    expect(classifySandboxProbeFailure(new Error("debug_exec_timeout:8000"))).toBe("transient");
    // 网络不可用：createNetworkUnavailableError 用 status 0 + network_error
    expect(classifySandboxProbeFailure(repositoryError("服务不可用", 0, "network_error"))).toBe("transient");
    // 代理掐连接
    const fetchError = new TypeError("Failed to fetch");
    expect(classifySandboxProbeFailure(fetchError)).toBe("transient");
    // 限流与请求超时会随时间好转，不能判死
    expect(classifySandboxProbeFailure(repositoryError("请求过于频繁", 429))).toBe("transient");
    expect(classifySandboxProbeFailure(repositoryError("请求超时", 408))).toBe("transient");
    // 服务端可能正在拉起实例
    expect(classifySandboxProbeFailure(repositoryError("内部错误", 500))).toBe("transient");
    // 非 Error 值不该被当成永久失败
    expect(classifySandboxProbeFailure("boom")).toBe("transient");
  });

  /*
   * 线上回归：新账号注册后开通 Bot，预热第一轮就拿到 409
   * DEBUG_NOT_SUPPORTED，被按「4xx 一律 fatal」判死，创建当场失败。
   *
   * 这个错误描述的恰恰是「实例当前状态还不能跑 debug 命令」—— 正是预热要
   * 等的那个状态本身，实例起好后就不再出现，所以必须继续等。
   */
  it("keeps waiting on DEBUG_NOT_SUPPORTED, which means the instance is still starting", () => {
    expect(classifySandboxProbeFailure(repositoryError(
      "debug command not supported in this instance state（DEBUG_NOT_SUPPORTED, request_id=81300f9a）",
      409,
      "DEBUG_NOT_SUPPORTED",
    ))).toBe("transient");
    // 只凭 409 也要继续等：409 的语义就是「当前状态不行」，而状态会变
    expect(classifySandboxProbeFailure(repositoryError("状态冲突", 409))).toBe("transient");
    // 只凭 code 也要认（万一后端换了状态码）
    const codeOnly = new Error("debug not supported") as Error & { code: string };
    codeOnly.code = "DEBUG_NOT_SUPPORTED";
    expect(classifySandboxProbeFailure(codeOnly)).toBe("transient");
  });
});

describe("isRetriableSetupFailure", () => {
  /*
   * 预热探活通过只说明「那一刻」能跑命令，紧接着的第一条配置命令仍可能撞上
   * 状态回退。SOUL 是 required，不重试会让整条计划当场中止。
   */
  it("retries setup commands that hit a not-yet-ready instance", () => {
    expect(isRetriableSetupFailure(repositoryError("状态不支持", 409, "DEBUG_NOT_SUPPORTED"))).toBe(true);
    expect(isRetriableSetupFailure(repositoryError("状态冲突", 409))).toBe(true);
  });

  it("still refuses to retry failures caused by the command itself", () => {
    // 命令已执行、只是结果不对 —— 重跑一百次也是同样的错
    expect(isRetriableSetupFailure(repositoryError("技能不存在", 404))).toBe(false);
    expect(isRetriableSetupFailure(repositoryError("无权限", 403))).toBe(false);
    expect(isRetriableSetupFailure(new Error("skill slug invalid"))).toBe(false);
  });
});

describe("sandbox warmup step", () => {
  it("is required and carries no sandbox command", () => {
    const step = buildSandboxWarmupStep();
    // 不是一条真命令：执行器不该拿它去 exec
    expect(step.command).toBe("");
    expect(step.kind).toBe("warmup");
    // 实例没起来，后面写人设装技能都没意义
    expect(step.required).toBe(true);
  });
});

/** 渲染面板：走 onCreateBot 路径（多 bot 入口），实例与 profile 直接给出 */
const renderPanel = (execDebugCommand: ReturnType<typeof vi.fn>) => {
  const onCreated = vi.fn();
  render(
    <AgentOnboardingPanel
      botId=""
      onCreateBot={async () => ({ botId: "bot-new", profileId: "profile-new" })}
      onCreated={onCreated}
      execDebugCommand={execDebugCommand as never}
      cloneOptions={{
        value: "bot-main",
        onChange: () => {},
        choices: [{ id: "bot-main", label: "主 Bot", isDefault: true }],
      }}
    />,
  );
  return { onCreated };
};

describe("onboarding warmup visibility", () => {
  it("shows the warmup row as running instead of a frozen 0/N list", async () => {
    /*
     * 探活永不成功（始终 exitCode 1），模拟实例迟迟不就绪 —— 这正是用户
     * 截图里的场景。断言此时清单不再是「全灰 + 0/N」。
     */
    const execDebugCommand = vi.fn(async () => ({ status: "failed", exitCode: 1, output: "" }));
    renderPanel(execDebugCommand);

    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    // 预热行出现，并且是在跑的状态（带等待计时，而不是灰色 pending）
    expect(await screen.findByText("正在唤醒 Bot 实例")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/已等待 \d+s/)).toBeTruthy();
    });
  }, 20000);

  it("aborts immediately with the real reason when the probe returns 403", async () => {
    /*
     * 核心回归：403 必须立刻中止。
     *
     * 修复前这里会空转满 180s 再报「实例尚未就绪，请稍后在设置页重试配置」，
     * 把真实原因（无权限）整个吞掉。
     */
    const execDebugCommand = vi.fn(async () => {
      throw repositoryError("无权配置该实例（forbidden, request_id=req-1）", 403);
    });
    renderPanel(execDebugCommand);

    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    /*
     * 服务端给的原因原样呈现，而不是被通用文案覆盖。
     *
     * 出现两处是预期的：顶部主文案（role="alert"）说明整体为什么停了，
     * 预热行下方的小字说明是哪一步停的。
     */
    const reasons = await screen.findAllByText(
      "无权配置该实例（forbidden, request_id=req-1）",
      {},
      { timeout: 10000 },
    );
    expect(reasons.length).toBe(2);
    // 主文案必须是那条无障碍告警，而不是继续顶着「正在喂咖啡」
    expect(screen.getByRole("alert").textContent).toContain("无权配置该实例");
    expect(screen.queryByText(/正在给 LightVela Bot 喂咖啡/)).toBeNull();
    // 而且没有反复轮询 —— 判定为 fatal 后第一轮就退出了
    expect(execDebugCommand).toHaveBeenCalledTimes(1);
    // 给出重试出口
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  }, 20000);

  it("marks warmup done and advances the progress once the sandbox answers", async () => {
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => ({
      status: "ok",
      exitCode: 0,
      output: command.includes("ContentBase64:")
        ? `Exists: yes\nByteLength: 12\nContentBase64: ${btoa("cloned soul!")}`
        : "",
    }));
    const { onCreated } = renderPanel(execDebugCommand);

    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bot-new"), { timeout: 15000 });
    // 第一条 exec 是探活用的 `true`，不是配置命令
    expect(execDebugCommand.mock.calls[0]?.[1]).toBe("true");
  }, 25000);

  /*
   * 端到端回归：新账号开通 Bot 的真实时序 —— 实例刚建好，前几轮探活都返回
   * 409 DEBUG_NOT_SUPPORTED，之后才起好。
   *
   * 必须跑完整条计划，而不是在第一个 409 上当场失败。
   */
  it("survives DEBUG_NOT_SUPPORTED while the fresh instance is still booting", async () => {
    let probes = 0;
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      if (command === "true") {
        probes += 1;
        // 前两轮：实例状态还不支持 debug 命令
        if (probes <= 2) {
          throw repositoryError(
            "debug command not supported in this instance state（DEBUG_NOT_SUPPORTED, request_id=req-boot）",
            409,
            "DEBUG_NOT_SUPPORTED",
          );
        }
      }
      return {
        status: "ok",
        exitCode: 0,
        // 克隆路径会先读来源 bot 的 SOUL，读不到就会中止
        output: command.includes("ContentBase64:")
          ? `Exists: yes\nByteLength: 12\nContentBase64: ${btoa("cloned soul!")}`
          : "",
      };
    });
    const { onCreated } = renderPanel(execDebugCommand);

    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    // 没有当场失败，而是等到实例就绪后把配置写完
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bot-new"), { timeout: 25000 });
    // 确实重试了探活，而不是一次就放弃
    expect(probes).toBeGreaterThanOrEqual(3);
    // 也没有弹出阻断错误
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  }, 40000);
});

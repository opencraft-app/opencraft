import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudDesktopResource, CloudDesktopViewerClaim, CloudDesktopViewerLease } from "@/domain/types";
import { AgentCloudDesktopPanel } from "@/pages/marketing/agent-cloud-desktop-panel";

// useT 必须返回稳定引用：面板的主流程 effect 把 t 作为依赖，若每次 render
// 都产生新函数会导致连接流程重跑（真实实现的 useT 是稳定的）。
const { translate } = vi.hoisted(() => ({ translate: (text: string) => text }));

vi.mock("@/i18n/t", () => ({
  useT: () => translate,
}));

const ensureDesktopResource = vi.fn<() => Promise<CloudDesktopResource>>();
const getDesktopResource = vi.fn<() => Promise<CloudDesktopResource>>();
// 面板先走 desktop/session 的准备状态机（含壁纸阶段），Ready 后才进入
// resource + viewer 租约流程，因此两个都要 mock。
const ensureDesktopSession = vi.fn();
const getDesktopSession = vi.fn();
const createDesktopViewer = vi.fn<() => Promise<CloudDesktopViewerLease>>();
const claimDesktopViewer = vi.fn<() => Promise<CloudDesktopViewerClaim>>();
const releaseDesktopViewer = vi.fn<() => Promise<void>>();
const getTerminalSession = vi.fn<() => Promise<{ sessionId: string }>>();
const openDesktopTatSocket = vi.fn();
const closeTransport = vi.fn();

const rfbConstructor = vi.fn();
// 捕获 noVNC 的事件回调：自动重连的用例需要主动触发 disconnect。
type RFBListener = (event?: { detail?: { clean?: boolean } }) => void;
const { rfbListeners, rfbInstances, rfbDisconnect } = vi.hoisted(() => ({
  rfbListeners: new Map<string, RFBListener>(),
  rfbInstances: [] as Map<string, RFBListener>[],
  rfbDisconnect: vi.fn(),
}));

// repositories 必须是稳定引用：面板主流程 effect 把它作为依赖，每次 render 都
// 产生新对象会导致连接流程重跑（真实实现来自 context，是稳定的）。
const { repositories } = vi.hoisted(() => ({
  repositories: { bots: {} as Record<string, unknown> },
}));
repositories.bots.ensureDesktopResource = ensureDesktopResource;
repositories.bots.getDesktopResource = getDesktopResource;
repositories.bots.ensureDesktopSession = ensureDesktopSession;
repositories.bots.getDesktopSession = getDesktopSession;
repositories.bots.createDesktopViewer = createDesktopViewer;
repositories.bots.claimDesktopViewer = claimDesktopViewer;
repositories.bots.releaseDesktopViewer = releaseDesktopViewer;
repositories.bots.getTerminalSession = getTerminalSession;

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

vi.mock("@/lib/desktop-tat-transport", () => ({
  openDesktopTatSocket: (...args: unknown[]) => openDesktopTatSocket(...args),
  DESKTOP_ATTACH_EVENT: "desktop/attach",
  DESKTOP_ATTACH_VERSION: 1,
}));

vi.mock("@novnc/novnc/lib/rfb", () => ({
  default: class {
    scaleViewport = false;
    resizeSession = false;
    listeners = new Map<string, RFBListener>();
    constructor(...args: unknown[]) {
      rfbConstructor(...args);
      rfbInstances.push(this.listeners);
    }
    addEventListener(type: string, fn: RFBListener) {
      rfbListeners.set(type, fn);
      this.listeners.set(type, fn);
    }
    disconnect() { rfbDisconnect(this.listeners); }
  },
}));

const prepared: CloudDesktopResource = {
  resourceId: "ins-1",
  generationId: "gen-1",
  state: "prepared",
};

const lease: CloudDesktopViewerLease = {
  version: 1,
  attachmentId: "att-1",
  ticket: "ticket-1",
  resourceId: "ins-1",
  generationId: "gen-1",
  access: "write",
  incarnation: "a".repeat(64),
  expiresAt: Date.now() + 300_000,
  // 可写端点：键鼠可用，且仍是沙箱内回环地址（无公网、无密码）。
  tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5903" },
};

const claim: CloudDesktopViewerClaim = {
  version: 1,
  attachmentId: "att-1",
  resourceId: "ins-1",
  generationId: "gen-1",
  access: "write",
  incarnation: lease.incarnation,
  expiresAt: lease.expiresAt,
  tunnel: lease.tunnel,
};

describe("AgentCloudDesktopPanel 观看租约与 TAT 隧道", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rfbListeners.clear();
    rfbInstances.length = 0;
    lease.expiresAt = Date.now() + 300_000;
    claim.expiresAt = lease.expiresAt;
    ensureDesktopSession.mockResolvedValue({ status: "Ready" });
    getDesktopSession.mockResolvedValue({ status: "Ready" });
    ensureDesktopResource.mockResolvedValue(prepared);
    getDesktopResource.mockResolvedValue(prepared);
    createDesktopViewer.mockResolvedValue(lease);
    claimDesktopViewer.mockResolvedValue(claim);
    releaseDesktopViewer.mockResolvedValue(undefined);
    getTerminalSession.mockResolvedValue({ sessionId: "sess-1" });
    openDesktopTatSocket.mockResolvedValue({
      channel: { readyState: 1, send: vi.fn(), close: vi.fn() },
      close: closeTransport,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("首次瞬时失败也按 1/2/4/8/16 秒退避，最多重试五次", async () => {
    vi.useFakeTimers();
    openDesktopTatSocket.mockRejectedValue(new Error("tunnel down"));
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => {});
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000].entries()) {
      expect(screen.getByRole("status")).toHaveTextContent("正在重新连接");
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(openDesktopTatSocket).toHaveBeenCalledTimes(index + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(openDesktopTatSocket).toHaveBeenCalledTimes(index + 2);
    }
    expect(screen.getByRole("alert")).toHaveTextContent("tunnel down");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(6);
    expect(releaseDesktopViewer).toHaveBeenCalledTimes(6);
  });

  it.each(["preparing", "unprepared"] as const)("resource 持续 %s 在90秒总时限停止", async (state) => {
    vi.useFakeTimers();
    ensureDesktopResource.mockResolvedValue({ ...prepared, state });
    getDesktopResource.mockResolvedValue({ ...prepared, state });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(89_999); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    const calls = getDesktopResource.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(getDesktopResource).toHaveBeenCalledTimes(calls);
    expect(createDesktopViewer).not.toHaveBeenCalled();
  });

  it.each(["provisioning", "pending", "backoff"])("resource 90秒预算覆盖后续 %s 重试等待", async (stage) => {
    vi.useFakeTimers();
    let rejectResource!: (error: Error) => void;
    ensureDesktopResource.mockReturnValueOnce(new Promise((_, reject) => { rejectResource = reject; }));
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => {});
    if (stage === "pending") ensureDesktopSession.mockReturnValue(new Promise(() => {}));
    else {
      ensureDesktopSession.mockResolvedValue({ status: "Provisioning" });
      getDesktopSession.mockResolvedValue({ status: "Provisioning" });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stage === "backoff" ? 89_500 : 1_000);
      rejectResource(new Error("temporary"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(stage === "backoff" ? 500 : 89_000); });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    const calls = ensureDesktopSession.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(ensureDesktopSession).toHaveBeenCalledTimes(calls);
    expect(createDesktopViewer).not.toHaveBeenCalled();
  });

  it("resource 预算在重连后的新一轮轮询进行中到点仍判死，不越预算继续", async () => {
    vi.useFakeTimers();
    // 第一轮 resource 请求可重试失败，触发一次重连；预算计时器跨重试保留。
    ensureDesktopResource.mockRejectedValueOnce(new Error("temporary"));
    // 重连后的新一轮始终停留在 preparing 轮询（既不失败也不就绪），
    // 用来复现「预算到点时正停在一个正常运行的新 attempt 上」这一时序。
    ensureDesktopResource.mockResolvedValue({ ...prepared, state: "preparing" });
    getDesktopResource.mockResolvedValue({ ...prepared, state: "preparing" });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    // 先让首轮失败并完成 1 秒退避进入新一轮轮询。
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(ensureDesktopResource).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // 推进到首次进入 connecting 起满 90 秒：预算到点必须无条件判死。
    await act(async () => { await vi.advanceTimersByTimeAsync(89_000); });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("云电脑启动失败");
    expect(createDesktopViewer).not.toHaveBeenCalled();
    // 判死后不得越过预算继续轮询或重连。
    expect(vi.getTimerCount()).toBe(0);
    const resourceCalls = getDesktopResource.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(getDesktopResource).toHaveBeenCalledTimes(resourceCalls);
  });

  it("resource 请求挂起也受90秒时限约束，迟到响应不签发租约", async () => {
    vi.useFakeTimers();
    let resolveResource!: (value: CloudDesktopResource) => void;
    ensureDesktopResource.mockReturnValue(new Promise((resolve) => { resolveResource = resolve; }));
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    await act(async () => { resolveResource(prepared); });
    expect(createDesktopViewer).not.toHaveBeenCalled();
  });

  it.each(["failed", "paused"] as const)("连接后 resource 变成 %s 也不自动重试", async (state) => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    act(() => { rfbListeners.get("connect")?.(); });
    ensureDesktopResource.mockResolvedValue({ ...prepared, state });
    vi.useFakeTimers();
    act(() => { rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(ensureDesktopResource).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(state === "paused" ? "云电脑已休眠，请点击重试" : "云电脑启动失败");
  });

  it.each([
    Object.assign(new Error("attach rejected"), { retryable: false }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    Object.assign(new Error("viewer conflict"), { status: 409 }),
  ])("已连过后也不重试明确安全/语义失败：$message", async (error) => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    act(() => { rfbListeners.get("connect")?.(); });
    openDesktopTatSocket.mockRejectedValue(error);
    vi.useFakeTimers();
    act(() => { rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(error.message);
    expect(releaseDesktopViewer).toHaveBeenCalledTimes(2);
  });

  it("租约身份失败立即释放已签发租约", async () => {
    claimDesktopViewer.mockResolvedValue({ ...claim, incarnation: "invalid" });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await screen.findByRole("alert");
    expect(releaseDesktopViewer).toHaveBeenCalledWith("bot_desktop", "att-1");
  });

  it("RFB 握手未成功就断线不能重置连续重试计数", async () => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    act(() => { rfbListeners.get("connect")?.(); });
    vi.useFakeTimers();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      act(() => { rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); await vi.dynamicImportSettled(); });
    }
    act(() => { rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
    expect(rfbConstructor).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("迟到的旧 connect/disconnect 不影响新连接心跳和租约计时", async () => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    const old = rfbInstances[0]!;
    act(() => { old.get("connect")?.(); });
    vi.useFakeTimers();
    act(() => { old.get("disconnect")?.({ detail: { clean: false } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await vi.dynamicImportSettled(); });
    expect(rfbConstructor).toHaveBeenCalledTimes(2);
    act(() => { rfbListeners.get("connect")?.(); });
    const timers = vi.getTimerCount();
    act(() => { old.get("disconnect")?.({ detail: { clean: false } }); old.get("connect")?.(); });
    expect(vi.getTimerCount()).toBe(timers);
    expect(screen.getByRole("status")).toHaveTextContent("云电脑已连接");
  });

  it("拆连接时同步 disconnect 不重复安排重试，旧 connect 不能复活连接", async () => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    const old = rfbInstances[0]!;
    rfbDisconnect.mockImplementationOnce((listeners: Map<string, RFBListener>) => listeners.get("disconnect")?.({ detail: { clean: false } }));
    vi.useFakeTimers();
    act(() => { old.get("disconnect")?.({ detail: { clean: false } }); old.get("connect")?.(); });
    expect(rfbDisconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在重新连接");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await vi.dynamicImportSettled(); });
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(2);
  });

  it("RFB 首次握手30秒无事件时关闭旧连接并有限退避", async () => {
    vi.useFakeTimers();
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(rfbConstructor).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在重新连接");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await vi.dynamicImportSettled(); });
    expect(rfbConstructor).toHaveBeenCalledTimes(2);
    for (const delay of [2_000, 4_000, 8_000, 16_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000 + delay); await vi.dynamicImportSettled(); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(rfbConstructor).toHaveBeenCalledTimes(6);
    expect(closeTransport).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["securityfailure", "credentialsrequired"])("RFB %s 不重试且清理连接", async (event) => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    act(() => { rfbListeners.get(event)?.(); rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(1);
  });

  it("真实 connect 重置退避预算并取消握手超时", async () => {
    vi.useFakeTimers();
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => { await vi.dynamicImportSettled(); });
    act(() => { rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await vi.dynamicImportSettled(); });
    act(() => { rfbListeners.get("connect")?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(screen.getByRole("status")).toHaveTextContent("云电脑已连接");
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(2);
    act(() => { rfbListeners.get("disconnect")?.({ detail: { clean: false } }); });
    expect(screen.getByText("1/5")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await vi.dynamicImportSettled(); });
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(3);
  });

  it("首连失败在后台挂起，重复可见事件仅恢复一次", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    openDesktopTatSocket.mockRejectedValue(new Error("temporary"));
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1/5")).toBeInTheDocument();
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(openDesktopTatSocket).toHaveBeenCalledTimes(2);
    expect(screen.getByText("2/5")).toBeInTheDocument();
  });

  it("卸载后签发返回的旧租约仅被释放，不再认领", async () => {
    let resolveLease!: (value: CloudDesktopViewerLease) => void;
    createDesktopViewer.mockReturnValue(new Promise((resolve) => { resolveLease = resolve; }));
    const view = render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(createDesktopViewer).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { resolveLease(lease); });
    expect(releaseDesktopViewer).toHaveBeenCalledWith("bot_desktop", "att-1");
    expect(claimDesktopViewer).not.toHaveBeenCalled();
    expect(openDesktopTatSocket).not.toHaveBeenCalled();
  });

  it("走 desktop/resource + viewer 租约 + TAT 隧道，且不下发 VNC 密码", async () => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);

    await waitFor(() => expect(createDesktopViewer).toHaveBeenCalledWith("bot_desktop"));
    expect(claimDesktopViewer).toHaveBeenCalledWith("bot_desktop", "att-1", "ticket-1");

    await waitFor(() => expect(openDesktopTatSocket).toHaveBeenCalledTimes(1));
    const input = openDesktopTatSocket.mock.calls[0]![0] as {
      tunnel: { mode: string; ip: string; port: string };
      attach?: { attachmentId: string; ticket: string };
    };
    expect(input.tunnel).toEqual({ mode: "rfb", ip: "127.0.0.1", port: "5903" });
    expect(input.attach).toEqual({ attachmentId: "att-1", ticket: "ticket-1" });

    // 关键回归：RFB 构造不再携带 credentials.password。
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    const [, channel, options] = rfbConstructor.mock.calls[0]!;
    expect(channel).toBeTruthy();
    expect((options as { credentials?: { password?: string } })?.credentials?.password).toBeUndefined();
  });

  it("卸载时释放观看租约并关闭隧道", async () => {
    const view = render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(openDesktopTatSocket).toHaveBeenCalledTimes(1));

    view.unmount();
    await waitFor(() => expect(releaseDesktopViewer).toHaveBeenCalledWith("bot_desktop", "att-1"));
    expect(closeTransport).toHaveBeenCalled();
  });

  it("物理身份未通过校验时不打开隧道", async () => {
    claimDesktopViewer.mockResolvedValue({ ...claim, incarnation: "not-a-hash" });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);

    await waitFor(() => expect(claimDesktopViewer).toHaveBeenCalled());
    // 租约换了目标机器/身份不合法：宁可看不到桌面，也不能连过去。
    expect(openDesktopTatSocket).not.toHaveBeenCalled();
  });

  it("租约有效期异常时不打开隧道", async () => {
    claimDesktopViewer.mockResolvedValue({ ...claim, expiresAt: Date.now() + 60 * 60_000 });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);

    await waitFor(() => expect(claimDesktopViewer).toHaveBeenCalled());
    expect(openDesktopTatSocket).not.toHaveBeenCalled();
  });

  it("资源准备失败时不再签发观看租约", async () => {
    ensureDesktopResource.mockResolvedValue({
      resourceId: "ins-1",
      state: "failed",
    });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);

    await waitFor(() => expect(ensureDesktopResource).toHaveBeenCalled());
    expect(createDesktopViewer).not.toHaveBeenCalled();
    expect(openDesktopTatSocket).not.toHaveBeenCalled();
  });

  it("断线后自动重连：重新签发租约并重开隧道", async () => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(openDesktopTatSocket).toHaveBeenCalledTimes(1));
    // noVNC 握手成功会先发 connect，之后才可能断线。
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    rfbListeners.get("connect")?.();

    rfbListeners.get("disconnect")?.({ detail: { clean: false } });

    // 重连不是「重连 socket」：租约单次使用，必须重新走一遍签发 + 开隧道。
    await waitFor(() => expect(createDesktopViewer).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await waitFor(() => expect(openDesktopTatSocket).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    // 旧租约必须先撤权，不能留下悬挂的键鼠权限。
    expect(releaseDesktopViewer).toHaveBeenCalledWith("bot_desktop", "att-1");
  });

  it("重连次数用尽后停止，落到失败态并保留手动重试", async () => {
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    rfbListeners.get("connect")?.();
    openDesktopTatSocket.mockRejectedValue(new Error("tunnel down"));

    // 只在重连阶段切假时钟：此时 noVNC 的动态 import 已完成，且重连会先在
    // openDesktopTatSocket 处失败、不再需要 import——假时钟下动态 import 不落地。
    vi.useFakeTimers();
    try {
      rfbListeners.get("disconnect")?.({ detail: { clean: false } });
      // 逐秒推进：一次性 advance 大跨度会让「失败后新排的退避定时器」落在已推进
      // 的虚拟时间之外，后续重连就永远不会被触发。
      for (let i = 0; i < 40; i += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      // 首次 + 5 次退避重连（1+2+4+8+16s）后停止，不无限重试。
      expect(openDesktopTatSocket).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByText("重试")).toBeTruthy();
  });

  it("安全校验失败不自动重连", async () => {
    claimDesktopViewer.mockResolvedValue({ ...claim, incarnation: "not-a-hash" });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(claimDesktopViewer).toHaveBeenCalledTimes(1));
    // 等过首个退避窗口：物理身份没校验通过属于安全失败，自动重试等于绕过校验。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(claimDesktopViewer).toHaveBeenCalledTimes(1);
    expect(openDesktopTatSocket).not.toHaveBeenCalled();
  });

  it("页面在后台时不自动重连，回到前台才继续", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      render(<AgentCloudDesktopPanel botId="bot_desktop" />);
      await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
      rfbListeners.get("connect")?.();
      rfbListeners.get("disconnect")?.({ detail: { clean: false } });
      // 后台期间不做无意义的续租：等过首个退避窗口也不重连。
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(openDesktopTatSocket).toHaveBeenCalledTimes(1);

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(openDesktopTatSocket).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    } finally {
      visibility.mockRestore();
    }
  });

  it("租约到期时若用户仍在页面，静默重新签发而不是判死", async () => {
    claimDesktopViewer.mockResolvedValue({ ...claim, expiresAt: Date.now() + 100 });
    render(<AgentCloudDesktopPanel botId="bot_desktop" />);
    await waitFor(() => expect(openDesktopTatSocket).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await waitFor(() => expect(rfbConstructor).toHaveBeenCalledTimes(1));
    rfbListeners.get("connect")?.();
    // 5 分钟硬到期防的是「撤权后隧道仍挂着键鼠」，不是把正在用的用户踢出去。
    await waitFor(() => expect(createDesktopViewer).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  });
});

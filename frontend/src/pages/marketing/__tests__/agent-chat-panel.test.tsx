import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleOverrideProvider } from "@/i18n/t";
import { AgentChatPanel } from "../agent-chat-panel";

type HostProps = ComponentProps<typeof AgentChatPanel>;
type ApiParams = { businessCode: string; token: string; timestamp: number };
type SdkProps = {
  lightvelaApiParams: ApiParams;
  refreshLightvelaApiParams: () => Promise<ApiParams>;
  multiSession?: HostProps["multiSession"];
  commandExecutor: HostProps["commandExecutor"];
  instanceId: string;
  userId: string;
};
const sdk = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn(), render: vi.fn() }));
vi.mock("@tencent/agentchat-lightvela-panel", async () => {
  const { useEffect, useRef } = await import("react");
  return { LightVelaPanel: (props: SdkProps) => {
    const initialApi = useRef(props.lightvelaApiParams);
    useEffect(() => { sdk.mounted(initialApi.current); return () => sdk.unmounted(initialApi.current); }, []);
    sdk.render(props);
    return <div data-testid="sdk-panel">SDK: {props.instanceId}</div>;
  } };
});
vi.mock("../workbench-prompt-auto-sender", () => ({ WorkbenchPromptAutoSender: () => null }));

const makeProps = (patch: Partial<HostProps> = {}): HostProps => ({
  accountId: "account-fixture", instanceId: "bot-fixture",
  commandExecutor: vi.fn() as unknown as HostProps["commandExecutor"],
  launchToken: null, launchTokenExpiresAt: null, launchTokenError: null, launchTokenStatus: "idle",
  onRetryLaunchToken: vi.fn(), onRefreshLaunchToken: vi.fn(async () => ({ token: "refreshed-token" })),
  ...patch,
});
const lastSdkProps = () => sdk.render.mock.calls.at(-1)?.[0] as SdkProps;
const host = (props: HostProps, locale: "zh-CN" | "en-US" = "zh-CN") => (
  <LocaleOverrideProvider locale={locale}><AgentChatPanel {...props} /></LocaleOverrideProvider>
);
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AgentChat host status and SDK lifetime", () => {
  it("announces loading before the first ready token without mounting the SDK", async () => {
    const props = makeProps();
    const view = render(host(props));
    expect(screen.getByRole("status")).toHaveTextContent("正在获取 AgentChat 启动 token…");
    expect(sdk.mounted).not.toHaveBeenCalled();
    view.rerender(host({ ...props, launchTokenStatus: "ready", launchToken: "first-ready" }));
    await screen.findByTestId("sdk-panel");
    expect(sdk.mounted).toHaveBeenCalledTimes(1);
    expect(lastSdkProps().lightvelaApiParams.token).toBe("first-ready");
  });

  it("announces token errors and invokes one keyboard retry without starting or refreshing the SDK", async () => {
    const user = userEvent.setup();
    const props = makeProps({ launchTokenStatus: "error", launchTokenError: "fixture failure" });
    render(host(props));
    expect(screen.getByRole("alert")).toHaveTextContent("fixture failure");
    const retry = screen.getByRole("button", { name: "重试" });
    act(() => retry.focus()); await user.keyboard("{Enter}");
    expect(props.onRetryLaunchToken).toHaveBeenCalledTimes(1);
    expect(props.onRefreshLaunchToken).not.toHaveBeenCalled();
    expect(sdk.mounted).not.toHaveBeenCalled();
  });

  it("keeps the mounted SDK and first API object across ready display updates and token refresh", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const multiSession = { selectedChatId: "session-one" } as HostProps["multiSession"];
    const props = makeProps({ launchTokenStatus: "ready", launchToken: "initial-token", launchTokenExpiresAt: Math.floor(now / 1000) + 3600, multiSession });
    const view = render(host(props));
    const originalElement = await screen.findByTestId("sdk-panel");
    const first = lastSdkProps();
    const originalApi = first.lightvelaApiParams;
    view.rerender(host({ ...props, launchToken: "later-prop-token", launchTokenError: "unused-ready-description", launchTokenExpiresAt: Math.floor(now / 1000) + 7200 }));
    expect(screen.getByTestId("sdk-panel")).toBe(originalElement);
    expect(lastSdkProps().lightvelaApiParams).toBe(originalApi);
    expect(lastSdkProps().refreshLightvelaApiParams).toBe(first.refreshLightvelaApiParams);
    expect(lastSdkProps().multiSession).toBe(multiSession);
    expect(lastSdkProps().commandExecutor).toBe(props.commandExecutor);
    expect(lastSdkProps().instanceId).toBe("bot-fixture");
    expect(lastSdkProps().userId).toBe("account-fixture");
    const nextSession = { ...multiSession, selectedChatId: "session-two" } as HostProps["multiSession"];
    view.rerender(host({ ...props, multiSession: nextSession }));
    expect(lastSdkProps().multiSession).toBe(nextSession);
    expect(lastSdkProps().lightvelaApiParams).toBe(originalApi);
    expect(screen.getByTestId("sdk-panel")).toBe(originalElement);
    expect(await lastSdkProps().refreshLightvelaApiParams()).toEqual(originalApi);
    expect(props.onRefreshLaunchToken).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(now + 3600_000);
    expect(await lastSdkProps().refreshLightvelaApiParams()).toMatchObject({ token: "refreshed-token" });
    expect(props.onRefreshLaunchToken).toHaveBeenCalledTimes(1);
    expect(originalApi.token).toBe("initial-token");
    expect(sdk.mounted).toHaveBeenCalledTimes(1);
    expect(sdk.unmounted).not.toHaveBeenCalled();
    view.unmount();
    expect(sdk.unmounted).toHaveBeenCalledExactlyOnceWith(originalApi);
  });

  it("uses the real English error and retry labels without changing the retry callback", async () => {
    const user = userEvent.setup();
    const props = makeProps({ launchTokenStatus: "error", launchTokenError: "English fixture failure" });
    render(host(props, "en-US"));
    expect(screen.getByRole("alert")).toHaveTextContent("English fixture failure");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetryLaunchToken).toHaveBeenCalledTimes(1);
    expect(sdk.mounted).not.toHaveBeenCalled();
  });
});

import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountDeleteDialog,
  AccountPageGate,
  BindEmailDialog,
  ChangePhoneDialog,
  PassDeleteDialog,
  PassDeleteDialogController,
} from "../account-dialogs";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => Object.entries(options ?? {}).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
    text,
  ),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const renderGate = (overrides: Partial<React.ComponentProps<typeof AccountPageGate>> = {}) => render(
  <AccountPageGate
    authReady
    isAuthenticated
    isSigningOut={false}
    subscriptionState="ready"
    passesError={false}
    onRetry={vi.fn()}
    loadingTitle="正在加载账号"
    errorTitle="套餐列表加载失败"
    retryLabel="重试"
    {...overrides}
  >
    <section>
      <h1>账号管理</h1>
      <button type="button">注销账号</button>
    </section>
  </AccountPageGate>,
);

describe("AccountPageGate", () => {
  it.each([
    { authReady: false },
    { isSigningOut: true },
    { subscriptionState: "loading" as const },
  ])("renders only the page loading state for $authReady $isSigningOut $subscriptionState", (overrides) => {
    renderGate(overrides);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("正在加载账号")).toBeVisible();
    expect(screen.queryByText("账号管理")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "注销账号" })).not.toBeInTheDocument();
  });

  it("renders a page error with the supplied retry action", async () => {
    const onRetry = vi.fn();
    renderGate({ subscriptionState: "error", passesError: true, onRetry });

    expect(screen.getByRole("alert")).toHaveTextContent("套餐列表加载失败");
    expect(screen.queryByText("账号管理")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

function DialogHarness({ children }: { children: (open: boolean, close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开确认</button>
      {children(open, () => setOpen(false))}
    </>
  );
}

describe("account destructive dialogs", () => {
  it.each([
    ["注销账号", "确认注销", (open: boolean, close: () => void, onConfirm: () => void) => (
      <AccountDeleteDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }} submitting={false} onConfirm={onConfirm} />
    )],
    ["销毁套餐", "确认销毁", (open: boolean, close: () => void, onConfirm: () => void) => (
      <PassDeleteDialog
        open={open}
        onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}
        passName="Hermes Pro"
        submitting={false}
        polling={false}
        error={null}
        onConfirm={onConfirm}
      />
    )],
  ] as const)("uses alertdialog semantics for %s and restores focus", async (_title, confirmLabel, dialog) => {
    const onConfirm = vi.fn();
    render(<DialogHarness>{(open, close) => dialog(open, close, () => { onConfirm(); close(); })}</DialogHarness>);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    trigger.focus();
    await userEvent.click(trigger);

    expect(screen.getByRole("alertdialog")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: confirmLabel }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each([
    <AccountDeleteDialog key="account" open onOpenChange={vi.fn()} submitting onConfirm={vi.fn()} />,
    <PassDeleteDialog key="pass" open onOpenChange={vi.fn()} passName="Hermes Pro" submitting polling={false} error={null} onConfirm={vi.fn()} />,
  ])("blocks escape and cancel while a destructive action is busy", async (dialog) => {
    render(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });
});

describe("account form dialogs", () => {
  it("uses Dialog semantics for phone and email flows", () => {
    const { rerender } = render(
      <ChangePhoneDialog open currentPhone="138****0000" onOpenChange={vi.fn()} onSendCode={vi.fn()} onSubmit={vi.fn()} onSuccess={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "修改绑定手机号" })).toBeVisible();
    expect(screen.getByText("当前绑定手机号：138****0000")).toBeVisible();

    rerender(<BindEmailDialog open onOpenChange={vi.fn()} onSend={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "绑定邮箱" })).toBeVisible();
    expect(screen.getByText("绑定邮箱后可用于接收导出完成通知等重要消息。")).toBeVisible();
  });

  it("delegates phone operations and preserves verify-refresh-success ordering", async () => {
    const order: string[] = [];
    const onSendCode = vi.fn().mockResolvedValue({ cooldownSeconds: 60 });
    const onSubmit = vi.fn().mockImplementation(async () => {
      order.push("verify");
      order.push("refresh");
    });
    const onSuccess = vi.fn(() => order.push("success"));
    render(<ChangePhoneDialog open onOpenChange={vi.fn()} onSendCode={onSendCode} onSubmit={onSubmit} onSuccess={onSuccess} />);

    await userEvent.type(screen.getByPlaceholderText("请输入中国大陆手机号"), "13800138000");
    await userEvent.click(screen.getByRole("button", { name: "获取验证码" }));
    expect(onSendCode).toHaveBeenCalledExactlyOnceWith("13800138000");
    await userEvent.type(screen.getByPlaceholderText("请输入短信验证码"), "1234");
    await userEvent.click(screen.getByRole("button", { name: "确认绑定" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ phone: "13800138000", code: "1234" });
    expect(order).toEqual(["verify", "refresh", "success"]);
  });

  it("blocks closing while submitting and resets form state after closing", async () => {
    const pending = deferred<void>();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开手机</button><ChangePhoneDialog open={open} onOpenChange={setOpen} onSendCode={vi.fn()} onSubmit={() => pending.promise} onSuccess={() => setOpen(false)} /></>;
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "打开手机" }));
    await userEvent.type(screen.getByPlaceholderText("请输入中国大陆手机号"), "13800138000");
    await userEvent.type(screen.getByPlaceholderText("请输入短信验证码"), "1234");
    await userEvent.click(screen.getByRole("button", { name: "确认绑定" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "绑定安全手机" })).toBeVisible();
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "打开手机" }));
    expect(screen.getByPlaceholderText("请输入中国大陆手机号")).toHaveValue("");
    expect(screen.getByPlaceholderText("请输入短信验证码")).toHaveValue("");
  });

  it("delegates email sending, blocks busy close, and resets on reopen", async () => {
    const pending = deferred<{ cooldownSeconds: number }>();
    const onSend = vi.fn(() => pending.promise);
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开邮箱</button><BindEmailDialog open={open} onOpenChange={setOpen} onSend={onSend} /></>;
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "打开邮箱" }));
    await userEvent.type(screen.getByPlaceholderText("请输入邮箱地址"), "user@example.com");
    await userEvent.click(screen.getByRole("button", { name: "发送验证邮件" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("user@example.com");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "绑定邮箱" })).toBeVisible();
    await act(async () => pending.resolve({ cooldownSeconds: 60 }));
    expect(await screen.findByRole("status")).toHaveTextContent("验证邮件已发送，请前往邮箱点击链接完成验证。");
    expect(screen.getByRole("button", { name: "重新发送 60s" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "打开邮箱" }));
    expect(screen.getByPlaceholderText("请输入邮箱地址")).toHaveValue("");
    expect(screen.queryByText("验证邮件已发送，请前往邮箱点击链接完成验证。")).not.toBeInTheDocument();
  });
});

describe("PassDeleteDialogController", () => {
  it.each([
    ["submitting", () => deferred<{ deleted: boolean }>().promise, false],
    ["polling", () => Promise.resolve({ deleted: true }), true],
  ] as const)("blocks Escape while %s", async (_stage, deletePass, expectPolling) => {
    const onOpenChange = vi.fn();
    render(
      <PassDeleteDialogController
        open
        onOpenChange={onOpenChange}
        passId="pass-1"
        passName="Hermes Pro"
        deletePass={deletePass}
        listMyPasses={() => new Promise(() => {})}
        onSuccess={vi.fn()}
        resolveError={(error) => String(error)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    await act(async () => Promise.resolve());
    if (expectPolling) expect(screen.getByRole("status")).toHaveTextContent("正在销毁套餐，请稍候...");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeVisible();
  });

  it("polls to success, restores focus, and reopens in a reset confirm state", async () => {
    vi.useFakeTimers();
    const listMyPasses = vi.fn().mockResolvedValue([]);
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开销毁</button><PassDeleteDialogController open={open} onOpenChange={setOpen} passId="pass-1" passName="Hermes Pro" deletePass={vi.fn().mockResolvedValue({ deleted: true })} listMyPasses={listMyPasses} onSuccess={() => setOpen(false)} resolveError={(error) => String(error)} /></>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开销毁" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    await act(async () => Promise.resolve());
    expect(screen.getByText("正在销毁套餐，请稍候...")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "确认销毁" })).toBeEnabled();
    expect(screen.queryByText("正在销毁套餐，请稍候...")).not.toBeInTheDocument();
  });

  it("shows the unchanged timeout message and clears it after close and reopen", async () => {
    vi.useFakeTimers();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开销毁</button><PassDeleteDialogController open={open} onOpenChange={setOpen} passId="pass-1" passName="Hermes Pro" deletePass={vi.fn().mockResolvedValue({ deleted: true })} listMyPasses={vi.fn().mockResolvedValue([{ pass_id: "pass-1" }])} onSuccess={vi.fn()} resolveError={(error) => String(error)} /></>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开销毁" }));
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(123000));
    expect(screen.getByRole("alert")).toHaveTextContent("销毁请求已提交，但状态确认超时。请稍后刷新页面查看结果。");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "打开销毁" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

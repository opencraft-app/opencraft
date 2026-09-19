import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvoiceDialog } from "../invoice-dialog";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>申请发票</button>
      <InvoiceDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe("InvoiceDialog", () => {
  it("uses a radio choice and clears mutually exclusive fields when switching invoice type", async () => {
    render(<InvoiceDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "申请发票" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "类型" })).toBeVisible();
    await userEvent.type(screen.getByRole("textbox", { name: "发票抬头" }), "张三");
    await userEvent.type(screen.getByRole("textbox", { name: "接收邮箱" }), "zhang@example.com");
    await userEvent.click(screen.getByRole("radio", { name: "企业" }));

    expect(screen.getByRole("textbox", { name: "企业名称" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "接收邮箱" })).toHaveValue("");
    await userEvent.type(screen.getByRole("textbox", { name: "企业名称" }), "示例企业有限公司");
    await userEvent.type(screen.getByRole("textbox", { name: "企业税号" }), "91310000123456789X");
    await userEvent.type(screen.getByRole("textbox", { name: "接收邮箱" }), "billing@example.com");
    await userEvent.click(screen.getByRole("radio", { name: "个人" }));

    expect(screen.getByRole("textbox", { name: "发票抬头" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "企业税号" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "接收邮箱" })).toHaveValue("");
  });

  it("disables invalid forms and shows the shared spinner during the one-second submission", async () => {
    const onOpenChange = vi.fn();
    render(<InvoiceDialog open onOpenChange={onOpenChange} />);
    const submit = screen.getByRole("button", { name: "提交申请" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "发票抬头" }), "张三");
    await userEvent.type(screen.getByRole("textbox", { name: "接收邮箱" }), "invalid");
    expect(submit).toBeDisabled();
    await userEvent.clear(screen.getByRole("textbox", { name: "接收邮箱" }));
    await userEvent.type(screen.getByRole("textbox", { name: "接收邮箱" }), "zhang@example.com");
    expect(submit).toBeEnabled();

    vi.useFakeTimers();
    fireEvent.click(submit);
    expect(screen.getByRole("button", { name: "提交中..." })).toBeDisabled();
    expect(document.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("restores trigger focus, resets on reopen, and cancels a pending submit timer on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "申请发票" });
    trigger.focus();
    await userEvent.click(trigger);
    await userEvent.type(screen.getByRole("textbox", { name: "发票抬头" }), "张三");
    await userEvent.type(screen.getByRole("textbox", { name: "接收邮箱" }), "zhang@example.com");
    await userEvent.click(screen.getByRole("button", { name: "提交申请" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    expect(screen.getByRole("radio", { name: "个人" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "发票抬头" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "接收邮箱" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "提交申请" })).toBeDisabled();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_050)));
    expect(screen.getByRole("dialog", { name: "申请发票" })).toBeVisible();
  });
});

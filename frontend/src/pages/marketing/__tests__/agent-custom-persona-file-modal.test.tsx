import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomPersonaFileModal } from "../agent-custom-persona-file-modal";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => text.replace(
    /\{\{\s*([\w$]+)\s*\}\}/g,
    (raw, key: string) => options?.[key] === undefined ? raw : String(options[key]),
  ),
}));

afterEach(cleanup);

const initialMarkdown = [
  "# Soul",
  "Slug: custom-upload",
  "Name: 冷静的项目搭档",
  "",
  "## Identity",
  "先给结论。",
  "",
].join("\n");

describe("CustomPersonaFileModal", () => {
  it("shows the current Soul in the existing editor style without upload or download actions", () => {
    render(
      <CustomPersonaFileModal
        open
        initialMarkdown={initialMarkdown}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "编辑人设文件" });
    expect(within(dialog).getByText("SOUL.md")).toBeInTheDocument();
    const editor = within(dialog).getByLabelText("人设内容");
    expect(editor).toHaveValue(initialMarkdown);
    expect(editor).toHaveClass(
      "mt-1.5",
      "rounded-md",
      "border-black/10",
      "font-mono",
      "focus:border-black/30",
      "focus:outline-none",
    );
    expect(within(dialog).getByText(/字节 \/ 20 KB/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存修改" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: /上传/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
  });

  it("normalizes a valid edit before saving and closes after success", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <CustomPersonaFileModal
        open
        initialMarkdown={initialMarkdown}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("人设内容"), {
      target: { value: initialMarkdown.replace("先给结论。", "先确认目标，再给结论。") },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      displayName: "冷静的项目搭档",
      markdown: expect.stringContaining("Slug: custom-upload"),
    }));
    expect(onSave.mock.calls[0]?.[0].markdown).toContain("先确认目标，再给结论。");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("disables saving for empty, control-character, and oversized edits", () => {
    render(
      <CustomPersonaFileModal
        open
        initialMarkdown={initialMarkdown}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const editor = screen.getByLabelText("人设内容");
    const save = screen.getByRole("button", { name: "保存修改" });

    fireEvent.change(editor, { target: { value: "" } });
    expect(screen.getByText("人设内容不能为空")).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(editor, { target: { value: "# Soul\u0000" } });
    expect(screen.getByText("文件包含不支持的控制字符")).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(editor, { target: { value: "a".repeat((20 * 1024) + 1) } });
    expect(screen.getByText("文件不能超过 20 KB")).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("keeps edited content and allows retry after saving fails", async () => {
    const edited = initialMarkdown.replace("先给结论。", "保持简洁。");
    const onClose = vi.fn();
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(true);
    render(
      <CustomPersonaFileModal
        open
        initialMarkdown={initialMarkdown}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("人设内容"), { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByText("保存失败，请检查网络后重试")).toBeInTheDocument();
    expect(screen.getByLabelText("人设内容")).toHaveValue(edited);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("prevents closing and duplicate saves while saving", async () => {
    let finishSave!: (saved: boolean) => void;
    const pendingSave = new Promise<boolean>((resolve) => {
      finishSave = resolve;
    });
    const onClose = vi.fn();
    const onSave = vi.fn().mockReturnValue(pendingSave);
    render(
      <CustomPersonaFileModal
        open
        initialMarkdown={initialMarkdown}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("人设内容"), {
      target: { value: initialMarkdown.replace("先给结论。", "先给结果。") },
    });
    const save = screen.getByRole("button", { name: "保存修改" });
    fireEvent.click(save);
    expect(save).toBeDisabled();
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finishSave(true));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps a newer editor open when an older save becomes stale", async () => {
    let finishOldSave!: (saved: boolean) => void;
    const oldSave = new Promise<boolean>((resolve) => {
      finishOldSave = resolve;
    });
    const onClose = vi.fn();
    const onSave = vi.fn().mockReturnValueOnce(oldSave);
    const { rerender } = render(
      <CustomPersonaFileModal
        open
        initialMarkdown={initialMarkdown}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("人设内容"), {
      target: { value: initialMarkdown.replace("先给结论。", "Agent A 正在保存。") },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    const agentBMarkdown = initialMarkdown
      .replace("Name: 冷静的项目搭档", "Name: Agent B 搭档")
      .replace("先给结论。", "Agent B 的新内容。");
    rerender(
      <CustomPersonaFileModal
        open
        initialMarkdown={agentBMarkdown}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    expect(screen.getByLabelText("人设内容")).toHaveValue(agentBMarkdown);

    await act(async () => finishOldSave(false));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "编辑人设文件" })).toBeInTheDocument();
    expect(screen.getByLabelText("人设内容")).toHaveValue(agentBMarkdown);
  });
});

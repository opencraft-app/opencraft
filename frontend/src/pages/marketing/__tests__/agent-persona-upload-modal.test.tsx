import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonaUploadModal } from "../agent-persona-upload-modal";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => text.replace(
    /\{\{\s*([\w$]+)\s*\}\}/g,
    (raw, key: string) => options?.[key] === undefined ? raw : String(options[key]),
  ),
}));

afterEach(cleanup);

const selectFile = (file: File) => {
  fireEvent.change(screen.getByLabelText("选择 Markdown 人设文件"), {
    target: { files: [file] },
  });
};

describe("PersonaUploadModal", () => {
  it("opens an empty upload state before opening the file picker", async () => {
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={vi.fn()}
      />,
    );
    const fileInput = screen.getByLabelText("选择 Markdown 人设文件");
    const inputClick = vi.spyOn(fileInput, "click");

    fireEvent.click(screen.getByRole("button", { name: "上传人设文件" }));

    const dialog = await screen.findByRole("dialog", { name: "上传人设文件" });
    expect(inputClick).not.toHaveBeenCalled();
    expect(within(dialog).queryByText(
      "上传人设文件后，你可以在此处继续编辑。",
    )).not.toBeInTheDocument();
    expect(within(dialog).getByText("选择 Markdown 人设文件，将其内容填入 SOUL.md")).toBeInTheDocument();
    expect(within(dialog).getByText("仅支持 Markdown 文件，文件名不限，扩展名须为 .md，大小不超过 20 KB。")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("人设内容")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "注入人设" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "选择文件" }));
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it("shows a local error for an unsupported file without injecting", async () => {
    const onInject = vi.fn();
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={onInject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传人设文件" }));
    const dialog = await screen.findByRole("dialog", { name: "上传人设文件" });

    selectFile(new File(["hello"], "persona.txt"));

    expect(await within(dialog).findByText("仅支持 .md 文件")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "重新上传文件" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("人设内容")).not.toBeInTheDocument();
    expect(onInject).not.toHaveBeenCalled();
  });

  it("explains how to recover from a non-UTF-8 file", async () => {
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={vi.fn()}
      />,
    );

    selectFile(new File([new Uint8Array([0xff])], "persona.md"));

    expect(await screen.findByText("文件编码需为 UTF-8，请转换后重新上传。")).toBeInTheDocument();
  });

  it("shows a recoverable error when the browser cannot read the file", async () => {
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={vi.fn()}
      />,
    );
    const file = new File(["# Soul"], "persona.md");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("read failed"));

    selectFile(file);

    expect(await screen.findByRole("dialog", { name: "上传人设文件" })).toBeInTheDocument();
    expect(await screen.findByText("无法读取文件，请重新选择")).toBeInTheDocument();
  });

  it("ignores a delayed file read after the dialog is closed", async () => {
    let finishRead!: (bytes: ArrayBuffer) => void;
    const pendingRead = new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve;
    });
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={vi.fn()}
      />,
    );
    const file = new File(["# Soul"], "persona.md");
    vi.spyOn(file, "arrayBuffer").mockReturnValue(pendingRead);

    selectFile(file);
    expect(await screen.findByText("正在读取人设文件…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await act(async () => finishRead(new TextEncoder().encode("# Soul").buffer));
    expect(screen.queryByRole("dialog", { name: "上传人设文件" })).not.toBeInTheDocument();
  });

  it("previews editable Markdown with bytes and non-blocking structure hints", async () => {
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传人设文件" }));
    const dialog = await screen.findByRole("dialog", { name: "上传人设文件" });

    selectFile(new File(["# 我的助手\n回答简洁。"], "focus.md"));

    expect(await screen.findByRole("dialog", { name: "编辑人设文件" })).toBe(dialog);
    expect(within(dialog).queryByText(
      "上传人设文件后，你可以在此处继续编辑。",
    )).not.toBeInTheDocument();
    const editor = within(dialog).getByLabelText("人设内容");
    expect(editor).toHaveValue("# 我的助手\n回答简洁。");
    expect(editor).toHaveClass(
      "mt-1.5",
      "rounded-md",
      "border-black/10",
      "focus:border-black/30",
      "focus:outline-none",
    );
    expect(editor).not.toHaveClass("focus:ring-2");
    const reselectButton = within(dialog).getByRole("button", { name: "重新上传文件" });
    const injectButton = within(dialog).getByRole("button", { name: "注入人设" });
    expect(reselectButton.parentElement).toHaveClass("justify-end");
    expect(reselectButton.nextElementSibling).toBe(injectButton);
    expect(within(dialog).getByText(/字节 \/ 20 KB/)).toBeInTheDocument();
    expect(within(dialog).getByText("人设内容建议")).toBeInTheDocument();
    expect(within(dialog).queryByText("人设完善建议")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("提示：")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/建议补充 Name 字段$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/建议补充角色定位（Identity）$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/建议补充沟通风格（Communication Style）$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/建议补充工作原则（Working Principles）$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/建议补充行为边界（Behavioral Boundaries）$/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/建议补充身份或角色说明$/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/建议补充沟通风格$/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/建议补充工作原则或优先级$/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/建议补充行为边界或禁止事项$/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/仍可继续注入/)).not.toBeInTheDocument();

    fireEvent.change(editor, {
      target: { value: "" },
    });
    expect(within(dialog).getByText("人设内容不能为空")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "注入人设" })).toBeDisabled();
  });

  it("confirms replacement without losing edits, then injects normalized Markdown", async () => {
    const onInject = vi.fn().mockResolvedValue(undefined);
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul
        onInject={onInject}
      />,
    );
    selectFile(new File(["# 自定义助手"], "focus.md"));

    const dialog = await screen.findByRole("dialog", { name: "编辑人设文件" });
    const editor = within(dialog).getByLabelText("人设内容");
    fireEvent.change(editor, { target: { value: "# 自定义助手\n保持冷静。" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "注入人设" }));

    const confirmDialog = await screen.findByRole("dialog", { name: "覆盖当前人设？" });
    expect(within(confirmDialog).getByText("旧人设会自动备份，然后注入新人设。")).toBeInTheDocument();
    expect(within(confirmDialog).queryByText("确认后会替换 Agent 当前人设，旧文件会自动备份。")).not.toBeInTheDocument();
    expect(within(confirmDialog).queryByText("当前 SOUL.md 会先保存到备份目录，再写入这份自定义人设。")).not.toBeInTheDocument();
    const backButton = within(confirmDialog).getByRole("button", { name: "返回编辑" });
    const confirmButton = within(confirmDialog).getByRole("button", { name: "覆盖并注入" });
    expect(within(confirmDialog).queryByRole("button", { name: "确认覆盖并注入" })).not.toBeInTheDocument();
    expect(backButton.parentElement).toHaveClass("justify-end");
    expect(backButton.nextElementSibling).toBe(confirmButton);
    fireEvent.click(backButton);
    expect(screen.getByLabelText("人设内容")).toHaveValue("# 自定义助手\n保持冷静。");

    fireEvent.click(screen.getByRole("button", { name: "注入人设" }));
    fireEvent.click(await screen.findByRole("button", { name: "覆盖并注入" }));

    await waitFor(() => expect(onInject).toHaveBeenCalledWith({
      displayName: "focus",
      markdown: expect.stringContaining("Slug: custom-upload"),
    }));
    expect(screen.queryByRole("dialog", { name: "覆盖当前人设？" })).not.toBeInTheDocument();
  });

  it("keeps the editor and allows retry after injection fails", async () => {
    const onInject = vi.fn()
      .mockRejectedValueOnce(new Error("sandbox unavailable"))
      .mockResolvedValueOnce(undefined);
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={onInject}
      />,
    );
    selectFile(new File(["# Soul\nName: 重试助手\n\n## Content\n保持简洁"], "retry.md"));

    fireEvent.click(await screen.findByRole("button", { name: "注入人设" }));
    expect(await screen.findByText("注入失败，请检查网络后重试")).toBeInTheDocument();
    expect(screen.getByLabelText("人设内容")).toHaveValue(
      "# Soul\nName: 重试助手\n\n## Content\n保持简洁",
    );

    fireEvent.click(screen.getByRole("button", { name: "重试注入" }));
    await waitFor(() => expect(onInject).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "上传人设文件" })).not.toBeInTheDocument();
  });

  it("rejects an edit when the normalized SOUL.md would exceed 20 KB", async () => {
    const onInject = vi.fn().mockResolvedValue(undefined);
    render(
      <PersonaUploadModal
        disabled={false}
        hasExistingSoul={false}
        onInject={onInject}
      />,
    );
    selectFile(new File(["a".repeat(20 * 1024)], "boundary.md"));

    const injectButton = await screen.findByRole("button", { name: "注入人设" });
    expect(screen.getByText("文件不能超过 20 KB")).toBeInTheDocument();
    expect(screen.getByText(/字节 \/ 20 KB/).textContent).not.toContain("20480 字节");
    expect(injectButton).toBeDisabled();
    expect(onInject).not.toHaveBeenCalled();
  });
});

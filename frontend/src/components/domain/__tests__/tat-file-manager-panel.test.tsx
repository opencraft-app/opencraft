import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TatFileManagerPanel } from "@/components/domain/tat-file-manager-panel";
import type { TsshFileInfo } from "@/lib/tencent-tssh-file-client";

const uploadFileMock = vi.fn();
const listPathMock = vi.fn<() => Promise<TsshFileInfo[]>>(async () => []);
const deleteFileMock = vi.fn();
const createFileMock = vi.fn();

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      getTerminalSession: vi.fn(async () => ({
        wsUrl: "wss://example.test/tssh",
        token: "terminal-session-token",
      })),
    },
  }),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (key: string, values?: Record<string, string>) => {
    if (!values) {
      return key;
    }
    return Object.entries(values).reduce((text, [name, value]) => text.replace(`{{${name}}}`, value), key);
  },
}));

vi.mock("@/lib/tencent-tssh-file-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tencent-tssh-file-client")>("@/lib/tencent-tssh-file-client");

  return {
    ...actual,
    TencentTsshFileClient: vi.fn().mockImplementation(function () {
      return {
        close: vi.fn(),
        connect: vi.fn(async () => undefined),
        createFile: createFileMock,
        deleteFile: deleteFileMock,
        listPath: listPathMock,
        uploadFile: uploadFileMock,
      };
    }),
  };
});

const fileWithSize = (name: string, size: number) => {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("TatFileManagerPanel upload limits", () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    deleteFileMock.mockReset();
    deleteFileMock.mockResolvedValue(undefined);
    createFileMock.mockReset();
    createFileMock.mockResolvedValue(undefined);
    listPathMock.mockReset();
    listPathMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks uploading a single file larger than 1 GB", async () => {
    const oneGigabyte = 1024 * 1024 * 1024;
    const oversizedFile = fileWithSize("oversized.tar", oneGigabyte + 1);

    const { container } = render(<TatFileManagerPanel botId="bot-upload-limit" />);
    await screen.findByText("当前目录为空。");
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeInstanceOf(HTMLInputElement);

    fireEvent.change(input as HTMLInputElement, { target: { files: [oversizedFile] } });

    expect(await screen.findByText("单个文件最大支持上传 1 GB。")).toBeInTheDocument();
    await waitFor(() => expect(uploadFileMock).not.toHaveBeenCalled());
  });

  it("allows uploading a single file equal to 1 GB", async () => {
    const oneGigabyte = 1024 * 1024 * 1024;
    const allowedFile = fileWithSize("exactly-one-gb.tar", oneGigabyte);

    const { container } = render(<TatFileManagerPanel botId="bot-upload-limit" />);
    await screen.findByText("当前目录为空。");
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeInstanceOf(HTMLInputElement);

    fireEvent.change(input as HTMLInputElement, { target: { files: [allowedFile] } });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledOnce());
    expect(uploadFileMock).toHaveBeenCalledWith("/home/agentuser/.hermes/exactly-one-gb.tar", allowedFile, expect.any(Function));
  });

  it("loads the edited current directory path on Enter", async () => {
    render(<TatFileManagerPanel botId="bot-path-edit" />);
    const pathInput = await screen.findByDisplayValue("/home/agentuser/.hermes");
    expect(screen.queryByRole("button", { name: "进入" })).not.toBeInTheDocument();

    fireEvent.change(pathInput, { target: { value: "/home/agentuser/.hermes/logs" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });

    await waitFor(() => expect(listPathMock).toHaveBeenCalledWith("/home/agentuser/.hermes/logs"));
  });

  it("keeps browsing inside the managed Hermes directory", async () => {
    render(<TatFileManagerPanel botId="bot-managed-root" />);
    const pathInput = await screen.findByDisplayValue("/home/agentuser/.hermes");
    expect(screen.getByRole("button", { name: "上级" })).toBeDisabled();
    listPathMock.mockClear();

    fireEvent.change(pathInput, { target: { value: "/home/agentuser" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });

    expect(await screen.findByText("只能访问 /home/agentuser/.hermes 目录下的文件和文件夹。")).toBeInTheDocument();
    expect(listPathMock).not.toHaveBeenCalled();
    expect(pathInput).toHaveValue("/home/agentuser/.hermes");
  });

  it("shows enter and hides hidden/refresh controls while editing the path", async () => {
    render(<TatFileManagerPanel botId="bot-path-edit-actions" />);
    const pathInput = await screen.findByDisplayValue("/home/agentuser/.hermes");

    expect(screen.getByRole("button", { name: "编辑文件路径" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示隐藏文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();

    fireEvent.focus(pathInput);

    expect(screen.getByRole("button", { name: "进入" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示隐藏文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();

    fireEvent.change(pathInput, { target: { value: "/home/agentuser/.hermes/logs" } });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    await waitFor(() => expect(listPathMock).toHaveBeenCalledWith("/home/agentuser/.hermes/logs"));
    expect(screen.queryByRole("button", { name: "进入" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示隐藏文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  });

  it("enters path editing mode from the edit path button", async () => {
    render(<TatFileManagerPanel botId="bot-path-edit-button" />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑文件路径" }));

    expect(screen.getByRole("button", { name: "进入" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑文件路径" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示隐藏文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
  });

  it("leaves path editing mode when clicking outside the path controls", async () => {
    render(<TatFileManagerPanel botId="bot-path-edit-outside" />);
    const pathInput = await screen.findByDisplayValue("/home/agentuser/.hermes");

    fireEvent.pointerDown(pathInput);
    fireEvent.click(pathInput);

    expect(screen.getByRole("button", { name: "进入" })).toBeInTheDocument();

    fireEvent.change(pathInput, { target: { value: "/home/agentuser/.hermes/logs" } });
    fireEvent.pointerDown(await screen.findByText("当前目录为空。"));

    expect(screen.queryByRole("button", { name: "进入" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示隐藏文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(pathInput).toHaveValue("/home/agentuser/.hermes");
  });

  it("translates file channel connection errors", async () => {
    listPathMock.mockRejectedValueOnce(new Error("file channel is not connected"));

    render(<TatFileManagerPanel botId="bot-file-channel-error" />);

    expect(await screen.findByText("文件通道未连接，请刷新后重试。")).toBeInTheDocument();
    expect(screen.queryByText("file channel is not connected")).not.toBeInTheDocument();
  });

  it.each([
    ["open /home/agentuser/.hermes/missing: no such file or directory", "文件或目录不存在，请刷新后重试。"],
    ["open /home/agentuser/.hermes/secret: permission denied", "权限不足，无法完成该文件操作。"],
    ["unlink /home/agentuser/.hermes/logs: directory not empty", "目录非空，无法删除。"],
    ["mkdir /home/agentuser/.hermes/app.log: not a directory", "路径中包含非目录项，请检查路径。"],
    ["TAT file request timed out", "文件操作超时，请稍后重试。"],
  ])("translates common English file errors: %s", async (rawError, translatedError) => {
    listPathMock.mockRejectedValueOnce(new Error(rawError));

    render(<TatFileManagerPanel botId={`bot-error-${translatedError}`} />);

    expect(await screen.findByText(translatedError)).toBeInTheDocument();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
  });

  it("creates a folder from an inline first-row input", async () => {
    listPathMock
      .mockResolvedValueOnce([
        {
          type: "-",
          name: "app.log",
          size: 42,
          modifyTime: 0,
          accessTime: 0,
          rights: "-rw-r--r--",
        },
      ])
      .mockResolvedValueOnce([]);

    render(<TatFileManagerPanel botId="bot-inline-create-folder" />);
    await screen.findByText("app.log");

    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));

    const folderNameInput = screen.getByPlaceholderText("请输入文件夹名");
    expect(folderNameInput).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建文件夹" })).toBeDisabled();

    fireEvent.change(folderNameInput, { target: { value: "reports" } });
    fireEvent.click(screen.getByRole("button", { name: "确认新建文件夹" }));

    await waitFor(() => expect(createFileMock).toHaveBeenCalledWith("/home/agentuser/.hermes/reports", { isDir: true, mode: 0o755 }));
  });

  it("translates duplicate folder creation errors", async () => {
    createFileMock.mockRejectedValueOnce(new Error("file exists"));

    render(<TatFileManagerPanel botId="bot-duplicate-folder" />);
    await screen.findByText("当前目录为空。");

    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    fireEvent.change(screen.getByPlaceholderText("请输入文件夹名"), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "确认新建文件夹" }));

    expect(await screen.findByText("文件已存在，请换个名称。")).toBeInTheDocument();
    expect(screen.queryByText("file exists")).not.toBeInTheDocument();
  });

  it("uses the clicked row as the operation target", async () => {
    listPathMock.mockResolvedValueOnce([
      {
        type: "-",
        name: "app.log",
        size: 42,
        modifyTime: 0,
        accessTime: 0,
        rights: "-rw-r--r--",
      },
    ]);

    render(<TatFileManagerPanel botId="bot-row-operation-target" />);
    const downloadButton = await screen.findByRole("button", { name: "下载" });
    const deleteButton = screen.getByRole("button", { name: "删除" });
    expect(downloadButton).toBeDisabled();
    expect(deleteButton).toBeDisabled();
    expect(screen.getAllByText("未选择文件").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(await screen.findByText("app.log"));

    expect(downloadButton).toBeEnabled();
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);

    await waitFor(() => expect(deleteFileMock).toHaveBeenCalledWith("/home/agentuser/.hermes/app.log", false));
  });

  it("selects a file row for download when clicking the row", async () => {
    listPathMock.mockResolvedValueOnce([
      {
        type: "-",
        name: "app.log",
        size: 42,
        modifyTime: 0,
        accessTime: 0,
        rights: "-rw-r--r--",
      },
    ]);

    render(<TatFileManagerPanel botId="bot-row-selection" />);
    const downloadButton = await screen.findByRole("button", { name: "下载" });
    expect(downloadButton).toBeDisabled();

    fireEvent.click(await screen.findByText("app.log"));

    expect(downloadButton).toBeEnabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("disables downloading a selected folder and explains why", async () => {
    listPathMock.mockResolvedValueOnce([
      {
        type: "d",
        name: "logs",
        size: 0,
        modifyTime: 0,
        accessTime: 0,
        rights: "drwxr-xr-x",
      },
    ]);

    render(<TatFileManagerPanel botId="bot-folder-download-disabled" />);
    const downloadButton = await screen.findByRole("button", { name: "下载" });
    const deleteButton = screen.getByRole("button", { name: "删除" });

    fireEvent.click(await screen.findByText("logs"));

    expect(downloadButton).toBeDisabled();
    expect(deleteButton).toBeEnabled();
    expect(screen.getByText("不支持下载文件夹")).toBeInTheDocument();
  });

  it("toggles hidden files from the path controls", async () => {
    listPathMock.mockResolvedValueOnce([
      {
        type: "-",
        name: ".env",
        size: 42,
        modifyTime: 0,
        accessTime: 0,
        rights: "-rw-r--r--",
      },
      {
        type: "-",
        name: "app.log",
        size: 42,
        modifyTime: 0,
        accessTime: 0,
        rights: "-rw-r--r--",
      },
    ]);

    render(<TatFileManagerPanel botId="bot-hidden-files" />);

    await screen.findByText("app.log");
    expect(screen.queryByText(".env")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "显示隐藏文件" }));

    expect(screen.getByText(".env")).toBeInTheDocument();
    expect(screen.getByText("app.log")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "不显示隐藏文件" })).toBeInTheDocument();
  });
});

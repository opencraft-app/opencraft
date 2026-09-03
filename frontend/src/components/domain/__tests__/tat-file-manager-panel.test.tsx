import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TatFileManagerPanel } from "@/components/domain/tat-file-manager-panel";
import type { TsshFileInfo } from "@/lib/tencent-tssh-file-client";

const uploadFileMock = vi.fn();
const listPathMock = vi.fn<() => Promise<TsshFileInfo[]>>(async () => []);
const deleteFileMock = vi.fn();
const createFileMock = vi.fn();
const execCommandMock = vi.fn();
const STORAGE_TOTAL_BYTES = 50 * 1024 * 1024 * 1024;
const STORAGE_USED_BYTES = 22 * 1024 * 1024 * 1024;
const STORAGE_AVAILABLE_BYTES = 28 * 1024 * 1024 * 1024;
const STORAGE_CAPACITY_OUTPUT_START = "__LIGHTVELA_STORAGE_CAPACITY_START__";
const STORAGE_CAPACITY_OUTPUT_END = "__LIGHTVELA_STORAGE_CAPACITY_END__";
const storageCapacityPayload = JSON.stringify({
  total_bytes: STORAGE_TOTAL_BYTES,
  used_bytes: STORAGE_USED_BYTES,
  available_bytes: STORAGE_AVAILABLE_BYTES,
});
const storageCapacityOutput = `${STORAGE_CAPACITY_OUTPUT_START}${storageCapacityPayload}${STORAGE_CAPACITY_OUTPUT_END}`;
const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const tsshFileClientInstances: Array<{ close: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn> }> = [];

const installServiceWorkerDownloadMock = () => {
  class TestMessagePort {
    peer: TestMessagePort | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    postMessage(data: unknown) {
      this.peer?.onmessage?.({ data } as MessageEvent);
    }

    close() {
      this.onmessage = null;
    }
  }

  class TestMessageChannel {
    port1: TestMessagePort;
    port2: TestMessagePort;

    constructor() {
      this.port1 = new TestMessagePort();
      this.port2 = new TestMessagePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }

  vi.stubGlobal("MessageChannel", TestMessageChannel);
  const worker = {
    state: "activated",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    postMessage: vi.fn((_message: unknown, ports?: unknown[]) => {
      const port = ports?.[0] as { postMessage?: (data: unknown) => void } | undefined;
      if (port && typeof port.postMessage === "function") {
        port.postMessage({
          type: "TAT_FILE_DOWNLOAD_READY",
          version: "tat-file-download-v6",
        });
      }
    }),
  };
  const registration = {
    active: worker,
    installing: null,
    waiting: null,
    update: vi.fn(async () => undefined),
  };
  const serviceWorker = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
  return serviceWorker;
};

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
      const client = {
        close: vi.fn(),
        connect: vi.fn(async () => undefined),
        createFile: createFileMock,
        deleteFile: deleteFileMock,
        execCommand: execCommandMock,
        isReady: vi.fn(() => true),
        listPath: listPathMock,
        uploadFile: uploadFileMock,
      };
      tsshFileClientInstances.push(client);
      return client;
    }),
  };
});

const fileWithSize = (name: string, size: number) => {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

const storageCapacityCommandCalls = () =>
  execCommandMock.mock.calls.filter(([command]) => typeof command === "string" && command.includes("statvfs"));

const renameCommandCalls = () =>
  execCommandMock.mock.calls.filter(([command]) => typeof command === "string" && command.includes("\nmv -- "));

describe("TatFileManagerPanel upload limits", () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    deleteFileMock.mockReset();
    deleteFileMock.mockResolvedValue(undefined);
    createFileMock.mockReset();
    createFileMock.mockResolvedValue(undefined);
    execCommandMock.mockReset();
    execCommandMock.mockImplementation(async (command: string) => ({
      exitCode: 0,
      output: command.includes("statvfs") ? storageCapacityOutput : "",
    }));
    listPathMock.mockReset();
    listPathMock.mockResolvedValue([]);
    tsshFileClientInstances.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalServiceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
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

  it("includes reserved space in instance storage usage", async () => {
    render(<TatFileManagerPanel botId="bot-storage-capacity" />);

    expect(await screen.findByText("存储概览")).toBeInTheDocument();
    expect(await screen.findByText("已用 22 GB / 50 GB")).toBeInTheDocument();
    expect(screen.getByText("可用 28 GB")).toBeInTheDocument();
    expect(screen.getByText("包含 Agent 运行环境、系统预留和云存储文件。")).toBeInTheDocument();

    const progressbar = screen.getByRole("progressbar", { name: "存储空间使用率" });
    expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    expect(progressbar).toHaveAttribute("aria-valuemax", "100");
    expect(progressbar).toHaveAttribute("aria-valuenow", "44");

    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(1));
    const capacityCommand = storageCapacityCommandCalls()[0]?.[0];
    expect(capacityCommand).toContain('os.statvfs("/home/agentuser")');
    expect(capacityCommand).toContain("stats.f_bavail");
    expect(capacityCommand).toContain('"used_bytes": max(0, total - available)');
    expect(capacityCommand).toContain(STORAGE_CAPACITY_OUTPUT_START);
    expect(capacityCommand).toContain(STORAGE_CAPACITY_OUTPUT_END);
    expect(capacityCommand).not.toContain("total - free");
    expect(capacityCommand).not.toContain("bot-storage-capacity");
    expect(capacityCommand).not.toContain("/home/agentuser/.hermes");
  });

  it("accepts capacity output when TAT does not report an exit code", async () => {
    execCommandMock.mockImplementation(async (command: string) => ({
      exitCode: command.includes("statvfs") ? null : 0,
      output: command.includes("statvfs") ? storageCapacityOutput : "",
    }));

    render(<TatFileManagerPanel botId="bot-storage-capacity-null-exit-code" />);

    expect(await screen.findByText("已用 22 GB / 50 GB")).toBeInTheDocument();
    expect(screen.getByText("可用 28 GB")).toBeInTheDocument();
  });

  it("extracts capacity output from surrounding PTY noise", async () => {
    execCommandMock.mockImplementation(async (command: string) => ({
      exitCode: 0,
      output: command.includes("statvfs")
        ? `${STORAGE_CAPACITY_OUTPUT_START}echoed command${STORAGE_CAPACITY_OUTPUT_END}\r\n${storageCapacityOutput}\r\nshell warning`
        : "",
    }));

    render(<TatFileManagerPanel botId="bot-storage-capacity-noisy-output" />);

    expect(await screen.findByText("已用 22 GB / 50 GB")).toBeInTheDocument();
    expect(screen.getByText("可用 28 GB")).toBeInTheDocument();
  });

  it("keeps the file list available when capacity lookup fails", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    execCommandMock.mockImplementation(async (command: string) => ({
      exitCode: command.includes("statvfs") ? 1 : 0,
      output: command.includes("statvfs") ? "python3: not found" : "",
    }));

    render(<TatFileManagerPanel botId="bot-storage-capacity-error" />);

    expect(await screen.findByText("存储容量暂不可用")).toBeInTheDocument();
    expect(await screen.findByText("app.log")).toBeInTheDocument();
    expect(screen.queryByText("python3: not found")).not.toBeInTheDocument();
    expect(consoleWarnSpy).toHaveBeenCalledWith("[storage-capacity] lookup failed", "storage capacity command failed");
  });

  it("redacts unexpected capacity lookup details from diagnostic logs", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execCommandMock.mockImplementation(async (command: string) => {
      if (command.includes("statvfs")) {
        throw new Error("request failed for wss://example.test/tssh?token=sensitive");
      }
      return { exitCode: 0, output: "" };
    });

    render(<TatFileManagerPanel botId="bot-storage-capacity-sensitive-error" />);

    expect(await screen.findByText("存储容量暂不可用")).toBeInTheDocument();
    expect(consoleWarnSpy).toHaveBeenCalledWith("[storage-capacity] lookup failed", "storage capacity request failed");
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("token=sensitive"),
    );
  });

  it("refreshes storage capacity from the existing refresh button", async () => {
    render(<TatFileManagerPanel botId="bot-storage-capacity-refresh" />);

    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(2));
  });

  it("refreshes storage capacity after a successful upload", async () => {
    const upload = fileWithSize("report.txt", 1024);
    const { container } = render(<TatFileManagerPanel botId="bot-storage-capacity-upload" />);
    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(1));
    const input = container.querySelector('input[type="file"]');

    fireEvent.change(input as HTMLInputElement, { target: { files: [upload] } });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(2));
  });

  it("refreshes storage capacity after a successful deletion", async () => {
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
    render(<TatFileManagerPanel botId="bot-storage-capacity-delete" />);
    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(1));
    fireEvent.click(await screen.findByText("app.log"));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(deleteFileMock).toHaveBeenCalledWith("/home/agentuser/.hermes/app.log", false));
    await waitFor(() => expect(storageCapacityCommandCalls()).toHaveLength(2));
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

    fireEvent.change(pathInput, { target: { value: "/home/agentuser/workspace" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });

    await waitFor(() => expect(listPathMock).toHaveBeenCalledWith("/home/agentuser/workspace"));
  });

  it("keeps browsing inside the managed agentuser home directory", async () => {
    render(<TatFileManagerPanel botId="bot-managed-root" />);
    const pathInput = await screen.findByDisplayValue("/home/agentuser/.hermes");
    expect(screen.getByRole("button", { name: "上级" })).toBeEnabled();
    listPathMock.mockClear();

    fireEvent.change(pathInput, { target: { value: "/home/agentuser" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });

    await waitFor(() => expect(listPathMock).toHaveBeenCalledWith("/home/agentuser"));
    await waitFor(() => expect(pathInput).toHaveValue("/home/agentuser"));
    expect(screen.getByRole("button", { name: "上级" })).toBeDisabled();
    expect(screen.getByText("不支持返回上一级目录")).toBeInTheDocument();
    listPathMock.mockClear();

    fireEvent.change(pathInput, { target: { value: "/home" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });

    expect(await screen.findByText("只能访问 /home/agentuser 目录下的文件和文件夹。")).toBeInTheDocument();
    expect(listPathMock).not.toHaveBeenCalled();
    expect(pathInput).toHaveValue("/home/agentuser");
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

    fireEvent.change(pathInput, { target: { value: "/home/agentuser/workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    await waitFor(() => expect(listPathMock).toHaveBeenCalledWith("/home/agentuser/workspace"));
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

    fireEvent.change(pathInput, { target: { value: "/home/agentuser/workspace" } });
    fireEvent.pointerDown(await screen.findByText("当前目录为空。"));

    expect(screen.queryByRole("button", { name: "进入" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示隐藏文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(pathInput).toHaveValue("/home/agentuser/.hermes");
  });

  it("reconnects once when the file channel is disconnected", async () => {
    listPathMock.mockRejectedValueOnce(new Error("file channel is not connected")).mockResolvedValueOnce([]);

    render(<TatFileManagerPanel botId="bot-file-channel-reconnect" />);

    expect(await screen.findByText("当前目录为空。")).toBeInTheDocument();
    await waitFor(() => expect(listPathMock).toHaveBeenCalledTimes(2));
    expect(tsshFileClientInstances).toHaveLength(2);
    expect(tsshFileClientInstances[0]?.close).toHaveBeenCalledOnce();
    expect(screen.queryByText("文件通道未连接，请刷新后重试。")).not.toBeInTheDocument();
  });

  it("translates file channel connection errors when reconnect retry fails", async () => {
    listPathMock.mockRejectedValueOnce(new Error("file channel is not connected"));
    listPathMock.mockRejectedValueOnce(new Error("file channel is not connected"));

    render(<TatFileManagerPanel botId="bot-file-channel-error" />);

    expect(await screen.findByText("文件通道未连接，请刷新后重试。")).toBeInTheDocument();
    await waitFor(() => expect(listPathMock).toHaveBeenCalledTimes(2));
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

  it("renames the selected file through a TAT exec command", async () => {
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
      .mockResolvedValueOnce([
        {
          type: "-",
          name: "server.log",
          size: 42,
          modifyTime: 0,
          accessTime: 0,
          rights: "-rw-r--r--",
        },
      ]);

    render(<TatFileManagerPanel botId="bot-rename-file" />);
    const renameButton = await screen.findByRole("button", { name: "重命名" });
    expect(renameButton).toBeDisabled();

    fireEvent.click(await screen.findByText("app.log"));
    expect(renameButton).toBeEnabled();

    fireEvent.click(renameButton);
    const renameInput = screen.getByDisplayValue("app.log");
    fireEvent.change(renameInput, { target: { value: "server.log" } });
    fireEvent.click(screen.getByRole("button", { name: "确认重命名" }));

    await waitFor(() => expect(renameCommandCalls()).toHaveLength(1));
    expect(renameCommandCalls()[0]).toEqual([
      "if [ -e '/home/agentuser/.hermes/server.log' ]; then echo 'file exists' >&2; exit 1; fi\nmv -- '/home/agentuser/.hermes/app.log' '/home/agentuser/.hermes/server.log'",
      60,
    ]);
    await waitFor(() => expect(listPathMock).toHaveBeenLastCalledWith("/home/agentuser/.hermes"));
    expect(await screen.findByText("已重命名。")).toBeInTheDocument();
  });

  it("rejects invalid rename targets before executing a command", async () => {
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

    render(<TatFileManagerPanel botId="bot-invalid-rename" />);
    fireEvent.click(await screen.findByText("logs"));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByDisplayValue("logs"), { target: { value: "../logs" } });
    fireEvent.click(screen.getByRole("button", { name: "确认重命名" }));

    expect(await screen.findByText("文件名无效，只能在 /home/agentuser 目录下重命名。")).toBeInTheDocument();
    expect(execCommandMock.mock.calls.some(([command]) => typeof command === "string" && command.includes("\nmv -- "))).toBe(false);
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

  it("removes download trigger iframes when the panel unmounts", async () => {
    installServiceWorkerDownloadMock();
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

    const { unmount } = render(<TatFileManagerPanel botId="bot-download-iframe-cleanup" />);
    const downloadButton = await screen.findByRole("button", { name: "下载" });

    fireEvent.click(await screen.findByText("app.log"));
    await waitFor(() => expect(downloadButton).toBeEnabled());
    fireEvent.click(downloadButton);

    await waitFor(() => expect(document.body.querySelectorAll("iframe")).toHaveLength(1));

    unmount();

    expect(document.body.querySelectorAll("iframe")).toHaveLength(0);
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

  it("disables downloading a file larger than 1 GB", async () => {
    listPathMock.mockResolvedValueOnce([
      {
        type: "-",
        name: "large.tar",
        size: 1024 * 1024 * 1024 + 1,
        modifyTime: 0,
        accessTime: 0,
        rights: "-rw-r--r--",
      },
    ]);

    render(<TatFileManagerPanel botId="bot-download-limit" />);
    const downloadButton = await screen.findByRole("button", { name: "下载" });
    const deleteButton = screen.getByRole("button", { name: "删除" });

    fireEvent.click(await screen.findByText("large.tar"));

    expect(downloadButton).toBeDisabled();
    expect(deleteButton).toBeEnabled();
    expect(screen.getByText("单个文件最大支持下载 1 GB。")).toBeInTheDocument();
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

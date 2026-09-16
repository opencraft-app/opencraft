import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TatFileManagerPanel } from "@/components/domain/tat-file-manager-panel";

const fixture = vi.hoisted(() => ({
  listPath: vi.fn(), deleteFile: vi.fn(), createFile: vi.fn(), execCommand: vi.fn(),
  repositories: { bots: { getTerminalSession: vi.fn(async () => ({ wsUrl: "wss://example.test", token: "fixture-token" })) } },
}));
vi.mock("@/lib/region", async (original) => ({ ...await original<typeof import("@/lib/region")>(), REGION: "global", isCN: false, isGlobal: true, DEFAULT_LOCALE: "en-US" }));
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => fixture.repositories }));
vi.mock("@/lib/tencent-tssh-file-client", async (original) => ({
  ...await original<typeof import("@/lib/tencent-tssh-file-client")>(),
  TencentTsshFileClient: vi.fn().mockImplementation(function () { return { close: vi.fn(), connect: vi.fn(async () => {}), isReady: () => true, listPath: fixture.listPath, deleteFile: fixture.deleteFile, createFile: fixture.createFile, execCommand: fixture.execCommand }; }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fixture.listPath.mockResolvedValue([".env", "global.txt"].map((name) => ({ type: "-", name, size: 12, modifyTime: 0, accessTime: 0, rights: "-rw-r--r--" })));
  fixture.deleteFile.mockResolvedValue(undefined);
  fixture.execCommand.mockResolvedValue({ exitCode: 0, output: '__LIGHTVELA_STORAGE_CAPACITY_START__{"total_bytes":1000,"used_bytes":100,"available_bytes":900}__LIGHTVELA_STORAGE_CAPACITY_END__' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("file manager real global interface", () => {
  it("uses English labels and the controlled hidden switch without changing the exact file deletion target", async () => {
    const user = userEvent.setup(); render(<TatFileManagerPanel botId="global-bot" />);
    expect(await screen.findByRole("heading", { name: "Cloud Storage" })).toBeInTheDocument();
    const entry = await screen.findByRole("button", { name: "global.txt" });
    const toggle = screen.getByRole("switch", { name: "Show hidden files" });
    act(() => toggle.focus()); await user.keyboard(" ");
    expect(toggle).toBeChecked(); expect(screen.getByRole("button", { name: ".env" })).toBeInTheDocument();
    act(() => entry.focus()); await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fixture.deleteFile).toHaveBeenCalledExactlyOnceWith("/home/agentuser/.hermes/global.txt", false));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fixture.repositories.bots.getTerminalSession).toHaveBeenCalledExactlyOnceWith("global-bot");
  });

  it("cancels English create and rename drafts with focus restored and no writes", async () => {
    const user = userEvent.setup(); render(<TatFileManagerPanel botId="global-focus-bot" />);
    await screen.findByRole("button", { name: "global.txt" });
    await user.click(screen.getByRole("button", { name: "New folder" }));
    const folderInput = screen.getByRole("textbox", { name: "Enter a folder name" });
    await waitFor(() => expect(folderInput).toHaveFocus()); await user.type(folderInput, "draft"); await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "New folder" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "global.txt" }));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const renameInput = screen.getByRole("textbox", { name: "Enter a file name" });
    await waitFor(() => expect(renameInput).toHaveFocus()); await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Rename" })).toHaveFocus();
    expect(fixture.createFile).not.toHaveBeenCalled(); expect(fixture.execCommand).toHaveBeenCalledTimes(1);
    expect(fixture.execCommand.mock.calls[0]?.[0]).toContain("statvfs");
  });
});

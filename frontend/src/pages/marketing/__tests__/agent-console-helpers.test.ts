import { afterEach, describe, expect, it, vi } from "vitest";
import { installOpenClawConsoleHelpers } from "@/pages/marketing/agent-console-helpers";

describe("installOpenClawConsoleHelpers", () => {
  const makeHost = () => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = vi.fn();
    const host = Object.assign(new EventTarget(), {
      console: { info, warn, log } as unknown as Console & Record<string, unknown>,
    }) as EventTarget & {
      console: Console & Record<string, unknown>;
      help?: unknown;
      terminal?: unknown;
      show?: unknown;
    };

    return {
      host,
      info,
      warn,
      log,
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers help() and prints the supported command list", () => {
    const { host, info } = makeHost();

    const cleanup = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/bots/bot_123/terminal",
    });

    const commands = (host.help as (() => unknown))();

    expect(commands).toEqual([
      { name: "help()", description: "输出当前页面支持的 console 命令列表" },
      { name: "terminal()", description: "输出当前 bot 的终端页面 URL" },
    ]);
    expect(info).toHaveBeenCalledWith("OpenClaw console helpers:");
    expect(info).toHaveBeenCalledWith("- help(): 输出当前页面支持的 console 命令列表");
    expect(info).toHaveBeenCalledWith("- terminal(): 输出当前 bot 的终端页面 URL");
    expect(info).toHaveBeenCalledWith("- 当前终端: /bots/bot_123/terminal");

    cleanup();
  });

  it("registers terminal() without overriding the native console", () => {
    const { host, info, log } = makeHost();
    const originalConsole = host.console;

    const cleanup = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/bots/bot_456/terminal",
    });

    const terminalPath = (host.terminal as (() => string))();
    host.console.log("hello");

    expect(host.console).toBe(originalConsole);
    expect(terminalPath).toBe("/bots/bot_456/terminal");
    expect(info).toHaveBeenCalledWith("/bots/bot_456/terminal");
    expect(log).toHaveBeenCalledWith("hello");

    cleanup();
  });

  it("warns when there is no active bot and restores globals on cleanup", () => {
    const { host, warn } = makeHost();

    const cleanup = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => null,
    });

    expect((host.terminal as (() => string))()).toBe("");
    expect(warn).toHaveBeenCalledWith("当前没有可用的 bot，无法生成终端 URL。");

    cleanup();

    expect("help" in host).toBe(false);
    expect("terminal" in host).toBe(false);
  });

  it("registers the shared show() toggle when requested", () => {
    const { host, info } = makeHost();

    const cleanup = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/bots/bot_export/terminal",
      enableShowCommand: true,
    });

    const commands = (host.help as (() => unknown))();
    const shown = (host.show as (() => boolean))();

    expect(commands).toContainEqual({ name: "show()", description: "切换当前页面的隐藏功能入口" });
    expect(shown).toBe(true);
    expect(info).toHaveBeenCalledWith("隐藏功能入口已显示。");
    expect((host.show as (() => boolean))()).toBe(false);
    expect(info).toHaveBeenCalledWith("隐藏功能入口已收起。");

    cleanup();

    expect("show" in host).toBe(false);
  });

  it("temporarily owns show() and restores a pre-existing command", () => {
    const { host } = makeHost();
    const originalShow = vi.fn();
    host.show = originalShow;

    const cleanup = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/bots/bot_export/terminal",
      enableShowCommand: true,
    });

    expect((host.show as (() => boolean))()).toBe(true);
    expect(originalShow).not.toHaveBeenCalled();

    cleanup();

    expect(host.show).toBe(originalShow);
  });

  it("shares one command across page generations and releases it after the final lease", () => {
    const { host } = makeHost();
    const disposeFirst = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/agents/terminal/",
      enableShowCommand: true,
    });
    const firstShow = host.show;
    const disposeSecond = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/agents/terminal/",
      enableShowCommand: true,
    });
    const secondShow = host.show;

    expect(secondShow).toBe(firstShow);
    disposeFirst();
    expect(host.show).toBe(secondShow);
    disposeSecond();
    expect("show" in host).toBe(false);
  });
});

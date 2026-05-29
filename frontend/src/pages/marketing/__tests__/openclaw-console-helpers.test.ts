import { afterEach, describe, expect, it, vi } from "vitest";
import { installOpenClawConsoleHelpers } from "@/pages/marketing/openclaw-console-helpers";

describe("installOpenClawConsoleHelpers", () => {
  const makeHost = () => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = vi.fn();
    const host: {
      console: Console & Record<string, unknown>;
      help?: unknown;
      show?: unknown;
      terminal?: unknown;
    } = {
      console: { info, warn, log } as unknown as Console & Record<string, unknown>,
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
      { name: "show()", description: "显示隐藏的 WebUI 和终端入口" },
      { name: "terminal()", description: "输出当前 bot 的终端页面 URL" },
    ]);
    expect(info).toHaveBeenCalledWith("OpenClaw console helpers:");
    expect(info).toHaveBeenCalledWith("- help(): 输出当前页面支持的 console 命令列表");
    expect(info).toHaveBeenCalledWith("- show(): 显示隐藏的 WebUI 和终端入口");
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

  it("registers show() to reveal hidden tools", () => {
    const { host, info } = makeHost();
    const onShowHiddenTools = vi.fn();

    const cleanup = installOpenClawConsoleHelpers({
      host,
      getTerminalPath: () => "/bots/bot_456/terminal",
      onShowHiddenTools,
    });

    expect((host.show as (() => boolean))()).toBe(true);
    expect(onShowHiddenTools).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("隐藏功能已显示。");

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
    expect("show" in host).toBe(false);
    expect("terminal" in host).toBe(false);
  });
});

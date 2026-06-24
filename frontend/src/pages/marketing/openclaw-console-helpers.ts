type ConsoleHelperHost = {
  console: Console;
  help?: unknown;
  terminal?: unknown;
  show?: unknown;
};

type HelpCommand = {
  name: string;
  description: string;
};

const HELP_COMMANDS: HelpCommand[] = [
  { name: "help()", description: "输出当前页面支持的 console 命令列表" },
  { name: "terminal()", description: "输出当前 bot 的终端页面 URL" },
];

const SHOW_EXPORT_COMMAND: HelpCommand = {
  name: "show()",
  description: "显示当前 bot 的隐藏工具入口",
};

export const installOpenClawConsoleHelpers = ({
  host,
  getTerminalPath,
  onShowHiddenTools,
}: {
  host: ConsoleHelperHost;
  getTerminalPath: () => string | null;
  onShowHiddenTools?: () => void;
}) => {
  const originalConsole = host.console;
  const originalHelp = host.help;
  const originalTerminal = host.terminal;
  const originalShow = host.show;
  const commands = onShowHiddenTools ? [...HELP_COMMANDS, SHOW_EXPORT_COMMAND] : HELP_COMMANDS;

  const helpFn = () => {
    originalConsole.info("OpenClaw console helpers:");
    for (const command of commands) {
      originalConsole.info(`- ${command.name}: ${command.description}`);
    }

    const currentPath = getTerminalPath();
    if (currentPath) {
      originalConsole.info(`- 当前终端: ${currentPath}`);
    } else {
      originalConsole.info("- 当前终端: 暂无可用 bot");
    }

    return commands;
  };

  const terminalFn = () => {
    const currentPath = getTerminalPath();
    if (!currentPath) {
      originalConsole.warn("当前没有可用的 bot，无法生成终端 URL。");
      return "";
    }

    originalConsole.info(currentPath);
    return currentPath;
  };

  const showFn = () => {
    if (typeof originalShow === "function") {
      originalShow();
    }
    onShowHiddenTools?.();
    originalConsole.info("隐藏工具入口已显示。");
    return true;
  };
  host.help = helpFn;
  host.terminal = terminalFn;
  if (onShowHiddenTools) {
    host.show = showFn;
  }

  return () => {
    if (originalHelp === undefined) {
      delete host.help;
    } else {
      host.help = originalHelp;
    }

    if (originalTerminal === undefined) {
      delete host.terminal;
    } else {
      host.terminal = originalTerminal;
    }

    if (onShowHiddenTools) {
      if (originalShow === undefined) {
        delete host.show;
      } else {
        host.show = originalShow;
      }
    }
  };
};

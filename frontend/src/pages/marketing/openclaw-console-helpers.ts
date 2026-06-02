type ConsoleHelperHost = {
  console: Console;
  help?: unknown;
  terminal?: unknown;
};

type HelpCommand = {
  name: string;
  description: string;
};

const HELP_COMMANDS: HelpCommand[] = [
  { name: "help()", description: "输出当前页面支持的 console 命令列表" },
  { name: "terminal()", description: "输出当前 bot 的终端页面 URL" },
];

export const installOpenClawConsoleHelpers = ({
  host,
  getTerminalPath,
}: {
  host: ConsoleHelperHost;
  getTerminalPath: () => string | null;
}) => {
  const originalConsole = host.console;
  const originalHelp = host.help;
  const originalTerminal = host.terminal;

  const helpFn = () => {
    originalConsole.info("OpenClaw console helpers:");
    for (const command of HELP_COMMANDS) {
      originalConsole.info(`- ${command.name}: ${command.description}`);
    }

    const currentPath = getTerminalPath();
    if (currentPath) {
      originalConsole.info(`- 当前终端: ${currentPath}`);
    } else {
      originalConsole.info("- 当前终端: 暂无可用 bot");
    }

    return HELP_COMMANDS;
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
  host.help = helpFn;
  host.terminal = terminalFn;

  return () => {
    if (originalHelp === undefined) {
      delete host.help;
    } else {
      host.help = originalHelp;
    }

    if (originalTerminal === undefined) {
      delete host.terminal;
      return;
    }

    host.terminal = originalTerminal;
  };
};

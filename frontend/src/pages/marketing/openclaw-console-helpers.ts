type ConsoleHelperHost = {
  console: Console;
  help?: unknown;
  show?: unknown;
  terminal?: unknown;
};

type HelpCommand = {
  name: string;
  description: string;
};

const HELP_COMMANDS: HelpCommand[] = [
  { name: "help()", description: "输出当前页面支持的 console 命令列表" },
  { name: "show()", description: "显示隐藏的 WebUI 和终端入口" },
  { name: "terminal()", description: "输出当前 bot 的终端页面 URL" },
];

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
  const originalShow = host.show;
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

  const showFn = () => {
    onShowHiddenTools?.();
    originalConsole.info("隐藏功能已显示。");
    return true;
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
  host.show = showFn;
  host.terminal = terminalFn;

  return () => {
    if (originalHelp === undefined) {
      delete host.help;
    } else {
      host.help = originalHelp;
    }

    if (originalShow === undefined) {
      delete host.show;
    } else {
      host.show = originalShow;
    }

    if (originalTerminal === undefined) {
      delete host.terminal;
      return;
    }

    host.terminal = originalTerminal;
  };
};

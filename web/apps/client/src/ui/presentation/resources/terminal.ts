import type {TerminalControllerState} from "@vela/client-core";

export const terminalStatusLabel: Record<
  TerminalControllerState["status"],
  string
> = {
  closed: "终端已关闭",
  connecting: "正在连接终端…",
  error: "终端连接异常",
  ready: "终端已连接",
};

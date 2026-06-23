import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import type { TencentPtyClient, TencentPtyConnectionState } from "@/lib/tencent-pty-client";

type ConnectionState = "loading" | "bootstrapping" | "authenticating" | "connected" | "closed" | "error";

const mapPtyState = (state: TencentPtyConnectionState): ConnectionState => {
  switch (state) {
    case "idle":
    case "connecting":
      return "bootstrapping";
    case "authenticating":
    case "starting":
      return "authenticating";
    case "ready":
      return "connected";
    case "closed":
      return "closed";
    case "error":
      return "error";
  }
};

export const TerminalPanel = ({ botId, botName }: { botId: string; botName: string }) => {
  const t = useT();
  const repositories = useRepositories();
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyClientRef = useRef<TencentPtyClient | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.2,
      allowProposedApi: true,
      theme: {
        background: "#16110d",
        foreground: "#f8e6d8",
        cursor: "#ffd7a8",
        black: "#221914",
        red: "#ff7f50",
        green: "#9ad76d",
        yellow: "#f2cd65",
        blue: "#72b6ff",
        magenta: "#f6a5c0",
        cyan: "#7be0d4",
        white: "#f8e6d8",
        brightBlack: "#786454",
        brightRed: "#ff9770",
        brightGreen: "#b7ef83",
        brightYellow: "#ffe288",
        brightBlue: "#8ac5ff",
        brightMagenta: "#ffc0d5",
        brightCyan: "#8ef0e0",
        brightWhite: "#fff4ea",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);
    requestAnimationFrame(() => {
      fitAddon.fit();
    });
    terminal.onData((data) => {
      ptyClientRef.current?.sendInput(data);
    });

    const handleResize = () => {
      fitAddon.fit();
      ptyClientRef.current?.resize(terminal.cols, terminal.rows);
    };

    window.addEventListener("resize", handleResize);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", handleResize);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const closeSocket = () => {
      ptyClientRef.current?.close();
      ptyClientRef.current = null;
    };

    const connect = async () => {
      try {
        setConnectionState("bootstrapping");
        setError(null);
        const bootstrap = await repositories.bots.getTerminalSession(botId);
        if (cancelled) {
          return;
        }

        terminalRef.current?.reset();
        fitAddonRef.current?.fit();

        const { TencentPtyClient } = await import("@/lib/tencent-pty-client");
        if (cancelled) {
          return;
        }
        const ptyClient = new TencentPtyClient(bootstrap, {
          getDimensions: () => ({
            cols: terminalRef.current?.cols ?? bootstrap.cols,
            rows: terminalRef.current?.rows ?? bootstrap.rows,
          }),
          onStateChange: (state) => {
            if (!cancelled) {
              setConnectionState(mapPtyState(state));
            }
          },
          onReady: () => {
            terminalRef.current?.focus();
          },
          onOutput: (output) => {
            terminalRef.current?.write(output);
          },
          onError: (message) => {
            if (!cancelled) {
              setError(message);
              terminalRef.current?.writeln(`\r\n[error] ${message}`);
            }
          },
          onDecodeError: (decodeError) => {
            terminalRef.current?.writeln(`\r\n[decode-error] ${String(decodeError)}`);
          },
          onClose: (event) => {
            if (!cancelled) {
              terminalRef.current?.writeln(`\r\n[closed] code=${event.code}`);
            }
          },
        });
        ptyClientRef.current = ptyClient;
        ptyClient.connect();
      } catch (connectError) {
        if (cancelled) {
          return;
        }
        setConnectionState("error");
        setError(connectError instanceof Error ? connectError.message : t("终端连接失败"));
      }
    };

    void connect();

    return () => {
      cancelled = true;
      closeSocket();
    };
  }, [botId, repositories.bots, t]);

  const stateLabel: Record<ConnectionState, string> = {
    loading: t("初始化..."),
    bootstrapping: t("获取会话..."),
    authenticating: t("认证中..."),
    connected: t("已连接"),
    closed: t("已断开"),
    error: t("连接失败"),
  };

  const stateColor: Record<ConnectionState, string> = {
    loading: "#999",
    bootstrapping: "#C67B1E",
    authenticating: "#C67B1E",
    connected: "#147A56",
    closed: "#999",
    error: "#cf3d4c",
  };

  return (
    <div
      className="flex min-h-[clamp(520px,calc(100vh-220px),860px)] w-full flex-col overflow-hidden rounded-lg border shadow-[0_8px_28px_rgba(15,23,42,0.06)]"
      style={{ background: "#0f0b09", borderColor: "rgba(255,255,255,0.1)" }}
    >
      <div
        className="flex items-center justify-between border-b px-5 py-3"
        style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}
      >
        <div className="flex items-center gap-3">
          <TerminalSquare className="h-4 w-4" style={{ color: "#f8e6d8" }} />
          <span className="text-sm font-semibold" style={{ color: "#f8e6d8" }}>
            {botName}
          </span>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold"
            style={{ background: `${stateColor[connectionState]}18`, color: stateColor[connectionState] }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor[connectionState] }} />
            {stateLabel[connectionState]}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-hidden p-3">
        {error && connectionState === "error" && (
          <p className="mb-2 rounded-full px-3 py-1.5 text-xs font-medium" style={{ background: "rgba(207,61,76,0.15)", color: "#ff7f50" }}>
            {error}
          </p>
        )}
        <div
          ref={terminalContainerRef}
          className="rounded-xl border p-2"
          style={{ borderColor: "rgba(255,255,255,0.08)", background: "#16110d", minHeight: "30rem", height: "calc(100vh - 300px)" }}
        />
      </div>
    </div>
  );
};

import { useEffect, useRef, useState } from "react";
import { ExternalLink, TerminalSquare } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import type { TencentPtyClient, TencentPtyConnectionState } from "@/lib/tencent-pty-client";

interface TatTerminalPanelProps {
  botId: string;
  botName: string;
}

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

const terminalTheme = {
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
};

export const TatTerminalPanel = ({ botId, botName }: TatTerminalPanelProps) => {
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
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);

    const refitTerminal = () => {
      fitAddon.fit();
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(refitTerminal);
    });
    if (document.fonts?.ready) {
      void document.fonts.ready.then(refitTerminal).catch(() => {});
    }

    terminal.onData((data) => {
      ptyClientRef.current?.sendInput(data);
    });

    let resizeTimer: number | null = null;
    const throttledResize = () => {
      if (resizeTimer !== null) {
        return;
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        refitTerminal();
        ptyClientRef.current?.resize(terminal.cols, terminal.rows);
      }, 120);
    };

    window.addEventListener("resize", throttledResize);
    const resizeObserver = new ResizeObserver(throttledResize);
    resizeObserver.observe(terminalContainerRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", throttledResize);
      resizeObserver.disconnect();
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
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
  }, [botId, botName, repositories.bots]);

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

  const openStandaloneTerminal = () => {
    window.open(`/bots/${encodeURIComponent(botId)}/terminal`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-[#0f0b09] shadow-[0_8px_28px_rgba(15,23,42,0.08)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] bg-white/[0.03] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <TerminalSquare className="size-4 flex-shrink-0 text-[#f8e6d8]" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-[#f8e6d8]">{t("终端")}</h2>
            <p className="mt-0.5 truncate text-xs text-[#a99584]">{botName}</p>
          </div>
          <span
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold"
            style={{ background: `${stateColor[connectionState]}18`, color: stateColor[connectionState] }}
            title={error ?? undefined}
          >
            <span className="size-1.5 rounded-full" style={{ background: stateColor[connectionState] }} />
            {stateLabel[connectionState]}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={openStandaloneTerminal} className="border-white/15 bg-transparent text-[#f4eadf] hover:bg-white/10 hover:text-white">
          <ExternalLink className="mr-1.5 size-3.5" />
          {t("新窗口")}
        </Button>
      </div>

      {error && connectionState === "error" && (
        <p className="mx-3 mt-3 rounded-md px-3 py-2 text-xs font-medium" style={{ background: "rgba(207,61,76,0.15)", color: "#ff7f50" }}>
          {error}
        </p>
      )}

      <div className="p-3">
        <div
          ref={terminalContainerRef}
          className="tat-terminal-host h-[clamp(560px,calc(100vh-250px),960px)] overflow-hidden rounded-md border border-white/[0.08] bg-[#16110d] p-2"
          style={{
            letterSpacing: 0,
            lineHeight: 1.2,
          }}
        />
      </div>
    </div>
  );
};

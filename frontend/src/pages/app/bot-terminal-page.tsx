import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import type { BotTerminalSession } from "@/domain/types";
import type { TencentPtyClient, TencentPtyConnectionState } from "@/lib/tencent-pty-client";
import { AGENTS_HOME_PATH } from "@/router/paths";

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

export const BotTerminalPage = () => {
  const { id } = useParams<{ id: string }>();
  const repositories = useRepositories();
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyClientRef = useRef<TencentPtyClient | null>(null);

  const [session, setSession] = useState<BotTerminalSession | null>(null);
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

    terminal.writeln("LightVela TAT terminal");
    terminal.writeln("");

    terminal.onData((data) => {
      ptyClientRef.current?.sendInput(data);
    });

    const handleResize = () => {
      refitTerminal();
      ptyClientRef.current?.resize(terminal.cols, terminal.rows);
    };

    let resizeTimer: number | null = null;
    const throttledResize = () => {
      if (resizeTimer !== null) return;
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        handleResize();
      }, 150);
    };

    window.addEventListener("resize", throttledResize);
    const resizeObserver = new ResizeObserver(throttledResize);
    resizeObserver.observe(terminalContainerRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", throttledResize);
      resizeObserver.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!id) {
      setError("缺少 Agent ID。");
      setConnectionState("error");
      return;
    }

    let cancelled = false;

    const closeSocket = () => {
      ptyClientRef.current?.close();
      ptyClientRef.current = null;
    };

    const connect = async () => {
      try {
        setConnectionState("bootstrapping");
        setError(null);
        const bootstrap = await repositories.bots.getTerminalSession(id);
        if (cancelled) {
          return;
        }
        setSession(bootstrap);

        const terminal = terminalRef.current;
        const fitAddon = fitAddonRef.current;
        terminal?.reset();
        terminal?.writeln(`Connecting Agent ${id}...`);
        fitAddon?.fit();

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
        setError(connectError instanceof Error ? connectError.message : "terminal bootstrap failed");
      }
    };

    void connect();

    return () => {
      cancelled = true;
      closeSocket();
    };
  }, [id, repositories.bots]);

  return (
    <div className="flex min-h-dvh flex-col bg-[#080706] p-2 text-[#f4eadf] sm:p-3">
      <header className="mb-2 flex shrink-0 items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 shadow-[0_20px_80px_rgba(0,0,0,0.45)] backdrop-blur sm:px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#9d8f83]">
            <span className="h-2 w-2 rounded-full bg-[#b7ef83] shadow-[0_0_18px_rgba(183,239,131,0.7)]" />
            TAT Console
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[#d7c8b9]">
            <span className="truncate">{id ?? "unknown Agent"}</span>
            <span className="text-[#6f6258]">/</span>
            <span className="truncate">{session?.sandboxId ?? "waiting sandbox"}</span>
            <span className="hidden text-[#6f6258] sm:inline">/</span>
            <span className="hidden truncate sm:inline">{session?.region ?? "region pending"}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="hidden rounded-full border border-white/10 px-3 py-1 text-xs text-[#f1dac7] sm:inline-flex"
            title={error ?? undefined}
          >
            {error ?? connectionState}
          </span>
          <Button asChild variant="outline" className="h-9 border-white/15 bg-transparent px-3 text-[#f4eadf] hover:bg-white/10 hover:text-white">
            <Link to={id ? `/bots/${id}/workspace` : AGENTS_HOME_PATH}>返回</Link>
          </Button>
          <Button asChild className="h-9 bg-[#f4eadf] px-3 text-[#14100d] hover:bg-white">
            <Link to={id ? `/bots/${id}/settings` : AGENTS_HOME_PATH}>设置</Link>
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#120d0a] p-2 shadow-[0_28px_120px_rgba(0,0,0,0.62)]">
        <div
          ref={terminalContainerRef}
          className="tat-terminal-host h-full min-h-[calc(100dvh-5.75rem)] rounded-[1rem] border border-white/[0.07] bg-[#16110d] p-2"
          style={{
            letterSpacing: 0,
            lineHeight: 1.2,
          }}
        />
      </main>
    </div>
  );
};

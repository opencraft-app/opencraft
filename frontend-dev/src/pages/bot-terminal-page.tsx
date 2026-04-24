import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { deserialize } from "bson";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GrammarPageIntro, GrammarPanel, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { useRepositories } from "@/contexts/repository-context";
import type { BotTerminalSession } from "@/domain/types";

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const encodeBase64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const decodeFrame = async (frame: string | Blob | ArrayBuffer) => {
  if (typeof frame === "string") {
    return JSON.parse(frame);
  }
  if (frame instanceof Blob) {
    return decodeFrame(await frame.arrayBuffer());
  }

  const bytes = new Uint8Array(frame);
  try {
    return deserialize(bytes);
  } catch {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
};

const extractTerminalOutput = (message: any): string => {
  const payload = message?.Data;
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidates = [payload.Output, payload.Data, payload?.Data?.Output, payload?.Data?.Data];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      try {
        return decodeBase64(candidate);
      } catch {
        return candidate;
      }
    }
    if (candidate instanceof Uint8Array) {
      return new TextDecoder().decode(candidate);
    }
    if (candidate instanceof ArrayBuffer) {
      return new TextDecoder().decode(candidate);
    }
  }
  return "";
};

type ConnectionState = "loading" | "bootstrapping" | "authenticating" | "connected" | "closed" | "error";

export const BotTerminalPage = () => {
  const { id } = useParams<{ id: string }>();
  const repositories = useRepositories();
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const authTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<BotTerminalSession | null>(null);
  const terminalReadyRef = useRef(false);

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
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
      fontSize: 13,
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
    fitAddon.fit();

    terminal.onData((data) => {
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (!terminalReadyRef.current || !activeSession || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        Type: "PtyInput",
        Data: { SessionId: activeSession.sessionId, Input: encodeBase64(data) },
      }));
    });

    const handleResize = () => {
      fitAddon.fit();
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (!terminalReadyRef.current || !activeSession || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        Type: "PtyResize",
        Data: { SessionId: activeSession.sessionId, Cols: terminal.cols, Rows: terminal.rows },
      }));
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
    if (!id) {
      setError("缺少 bot id。");
      setConnectionState("error");
      return;
    }

    let cancelled = false;

    const closeSocket = () => {
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (authTimerRef.current !== null) {
        window.clearTimeout(authTimerRef.current);
        authTimerRef.current = null;
      }
      if (activeSession && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ Type: "PtyStop", Data: { SessionId: activeSession.sessionId } }));
      }
      socket?.close();
      socketRef.current = null;
    };

    const connect = async () => {
      try {
        setConnectionState("bootstrapping");
        setError(null);
        terminalReadyRef.current = false;
        const bootstrap = await repositories.bots.getTerminalSession(id);
        if (cancelled) {
          return;
        }
        sessionRef.current = bootstrap;
        setSession(bootstrap);

        terminalRef.current?.reset();
        if (terminalRef.current) {
          terminalRef.current.options.disableStdin = true;
        }
        fitAddonRef.current?.fit();

        const socket = new WebSocket(bootstrap.wsUrl);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          setConnectionState("authenticating");
          socket.send(JSON.stringify({
            Type: "SessionAuth",
            Data: {
              Uin: bootstrap.ownerUin,
              AppId: bootstrap.appId,
              InstanceId: bootstrap.instanceId,
              SessionId: bootstrap.sessionId,
            },
          }));
          authTimerRef.current = window.setTimeout(() => {
            socket.send(JSON.stringify({
              Type: "PtyStart",
              Data: {
                SessionId: bootstrap.sessionId,
                Cols: terminalRef.current?.cols ?? bootstrap.cols,
                Rows: terminalRef.current?.rows ?? bootstrap.rows,
              },
            }));
          }, 1000);
        };

        socket.onmessage = async (event) => {
          try {
            const message = await decodeFrame(event.data);
            switch (message?.Type) {
              case "PtyReady":
                terminalReadyRef.current = true;
                if (terminalRef.current) {
                  terminalRef.current.options.disableStdin = false;
                }
                setConnectionState("connected");
                terminalRef.current?.focus();
                return;
              case "PtyOutput": {
                const output = extractTerminalOutput(message);
                if (output) {
                  terminalRef.current?.write(output);
                }
                return;
              }
              case "PtyError":
              case "Error": {
                terminalReadyRef.current = false;
                if (terminalRef.current) {
                  terminalRef.current.options.disableStdin = true;
                }
                const messageText = message?.Data?.Message || "terminal error";
                setConnectionState("error");
                setError(messageText);
                terminalRef.current?.writeln(`\r\n[error] ${messageText}`);
                return;
              }
              default: {
                const output = extractTerminalOutput(message);
                if (output) {
                  terminalRef.current?.write(output);
                }
              }
            }
          } catch (decodeError) {
            terminalRef.current?.writeln(`\r\n[decode-error] ${String(decodeError)}`);
          }
        };

        socket.onerror = () => {
          terminalReadyRef.current = false;
          if (terminalRef.current) {
            terminalRef.current.options.disableStdin = true;
          }
          setConnectionState("error");
          setError("websocket error");
          terminalRef.current?.writeln("\r\n[error] websocket error");
        };

        socket.onclose = (event) => {
          terminalReadyRef.current = false;
          if (terminalRef.current) {
            terminalRef.current.options.disableStdin = true;
          }
          if (cancelled) {
            return;
          }
          if (connectionState !== "error") {
            setConnectionState("closed");
          }
          terminalRef.current?.writeln(`\r\n[closed] code=${event.code}`);
        };
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
      terminalReadyRef.current = false;
      if (terminalRef.current) {
        terminalRef.current.options.disableStdin = true;
      }
      closeSocket();
      sessionRef.current = null;
    };
  }, [id, repositories.bots]);

  return (
    <div className="space-y-5">
      <GrammarPageIntro
        eyebrow={<Badge variant="neutral">Bot terminal</Badge>}
        title="腾讯云 TAT 终端"
        description="当前 bot 绑定的 sandbox 会先向 sandbox-api 请求 TAT session bootstrap，然后浏览器直接连腾讯云 websocket。"
        actions={(
          <>
            <Button asChild variant="outline">
              <Link to={id ? `/bots/${id}/workspace` : "/dashboard"}>返回 Workspace</Link>
            </Button>
            <Button asChild>
              <Link to={id ? `/bots/${id}/settings` : "/dashboard"}>Bot Settings</Link>
            </Button>
          </>
        )}
      />

      <div className="grid gap-4 xl:grid-cols-[0.78fr_1.22fr]">
        <GrammarPanel tone="muted" className="space-y-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
              Session
            </p>
            <h2 className="text-2xl font-semibold tracking-[-0.05em]" style={{ color: "var(--lw-fg)" }}>
              {id ?? "-"}
            </h2>
            <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
              连接状态：{connectionState}
            </p>
          </div>
          <div className="space-y-3 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
            <p><strong>Sandbox:</strong> {session?.sandboxId ?? "-"}</p>
            <p><strong>Pool:</strong> {session?.poolId ?? "-"}</p>
            <p><strong>Region:</strong> {session?.region ?? "-"}</p>
            <p><strong>Instance:</strong> {session?.instanceId ?? "-"}</p>
            <p><strong>Session ID:</strong> {session?.sessionId ?? "-"}</p>
            <p><strong>WS:</strong> <span className="break-all">{session?.wsUrl ?? "-"}</span></p>
            {error ? <p style={{ color: "var(--danger)" }}><strong>Error:</strong> {error}</p> : null}
          </div>
        </GrammarPanel>

        <GrammarSectionCard
          kicker="Live PTY"
          title="Web console"
          description="真正的 shell 流量直接走腾讯云 TAT websocket。这一页只负责 bootstrap 和终端渲染。"
        >
          <div
            className="overflow-hidden rounded-[1.6rem] border p-3 shadow-[0_28px_80px_-50px_rgba(11,11,11,0.72)]"
            style={{ borderColor: "#0f0b09", background: "#0f0b09" }}
          >
            <div
              className="mb-3 flex items-center justify-between rounded-[1rem] border px-3 py-2 text-xs"
              style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", color: "#f1dac7" }}
            >
              <span>lightclaw.tencent-tat.console</span>
              <span>{connectionState}</span>
            </div>
            <div
              ref={terminalContainerRef}
              className="min-h-[34rem] rounded-[1.1rem] border p-2"
              style={{ borderColor: "rgba(255,255,255,0.08)", background: "#16110d" }}
            />
          </div>
        </GrammarSectionCard>
      </div>
    </div>
  );
};

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { deserialize } from "bson";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import {
  GrammarCanvas,
  GrammarMiniStat,
  GrammarPageIntro,
  GrammarSectionCard,
} from "@/components/site/homepage-grammar";
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

  const candidates = [
    payload.Output,
    payload.Data,
    payload?.Data?.Output,
    payload?.Data?.Data,
  ];

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

  const [session, setSession] = useState<BotTerminalSession | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [error, setError] = useState<string | null>(null);
  const connectionStateRef = useRef<ConnectionState>("loading");

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

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

    terminal.writeln("Lightclaw TAT terminal");
    terminal.writeln("");

    terminal.onData((data) => {
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (!activeSession || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        Type: "PtyInput",
        Data: {
          SessionId: activeSession.sessionId,
          Input: encodeBase64(data),
        },
      }));
    });

    const handleResize = () => {
      refitTerminal();
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (!activeSession || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        Type: "PtyResize",
        Data: {
          SessionId: activeSession.sessionId,
          Cols: terminal.cols,
          Rows: terminal.rows,
        },
      }));
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
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", throttledResize);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
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
        socket.send(JSON.stringify({
          Type: "PtyStop",
          Data: { SessionId: activeSession.sessionId },
        }));
      }
      socket?.close();
      socketRef.current = null;
    };

    const connect = async () => {
      try {
        setConnectionState("bootstrapping");
        setError(null);
        const bootstrap = await repositories.bots.getTerminalSession(id);
        if (cancelled) {
          return;
        }
        sessionRef.current = bootstrap;
        setSession(bootstrap);

        const terminal = terminalRef.current;
        const fitAddon = fitAddonRef.current;
        terminal?.reset();
        terminal?.writeln(`Connecting bot ${id}...`);
        fitAddon?.fit();

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
          setConnectionState("error");
          setError("websocket error");
          terminalRef.current?.writeln("\r\n[error] websocket error");
        };

        socket.onclose = (event) => {
          if (cancelled) {
            return;
          }
          if (connectionStateRef.current !== "error") {
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
      closeSocket();
      sessionRef.current = null;
    };
  }, [id, repositories.bots]);

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <GrammarCanvas className="mx-auto max-w-7xl">
        <div className="space-y-8 px-6 py-6 sm:px-8 sm:py-8">
          <GrammarPageIntro
            eyebrow={<p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-tertiary)]">Bot Console</p>}
            title="腾讯云 TAT Web Console"
            description="这个页面直接为当前 bot 绑定的 sandbox 创建 TAT PTY session。先拿 sandbox terminal bootstrap，再连腾讯云 websocket，不再额外暴露实例密钥。"
            actions={(
              <>
                <Button asChild variant="outline">
                  <Link to={id ? `/bots/${id}/workspace` : "/openclaw/settings"}>返回工作台</Link>
                </Button>
                <Button asChild>
                  <Link to={id ? `/bots/${id}/settings` : "/openclaw/settings"}>查看设置</Link>
                </Button>
              </>
            )}
          />

          <div className="grid gap-6 xl:grid-cols-[0.32fr_0.68fr]">
            <GrammarSectionCard
              kicker="Session"
              title="终端会话"
              description="这里展示当前 bot 对应的 sandbox 和 TAT bootstrap。连接状态异常时，先看这里确认是不是 sandbox 还没分配。"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <GrammarMiniStat label="Bot" value={id ?? "-"} note="当前页面绑定的 bot id" />
                <GrammarMiniStat label="State" value={connectionState} note={error ?? "terminal websocket running"} />
                <GrammarMiniStat label="Region" value={session?.region ?? "-"} note="TAT websocket 所在地域" />
                <GrammarMiniStat label="Sandbox" value={session?.sandboxId ?? "-"} note="从 ctl 实例映射到 sandbox" />
              </div>
              <div className="space-y-2 text-sm leading-7 text-[var(--text-secondary)]">
                <p><strong>Instance:</strong> {session?.instanceId ?? "-"}</p>
                <p><strong>Pool:</strong> {session?.poolId ?? "-"}</p>
                <p><strong>Session ID:</strong> {session?.sessionId ?? "-"}</p>
                <p><strong>WS:</strong> <span className="break-all">{session?.wsUrl ?? "-"}</span></p>
                {error ? <p className="text-[var(--danger)]"><strong>Error:</strong> {error}</p> : null}
              </div>
            </GrammarSectionCard>

            <GrammarSectionCard
              kicker="Console"
              title="Live PTY"
              description="真正的 shell 流量直接走腾讯云 TAT websocket。这个页面只负责 bootstrap 和浏览器终端渲染。"
              className="min-h-[42rem]"
            >
              <div
                className="overflow-hidden rounded-[1.75rem] border p-3 shadow-[var(--shadow-soft)]"
                style={{
                  borderColor: "#0f0b09",
                  background: "#0f0b09",
                }}
              >
                <div
                  className="mb-3 flex items-center justify-between rounded-[1rem] border px-3 py-2 text-xs"
                  style={{
                    borderColor: "rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.03)",
                    color: "#f1dac7",
                  }}
                >
                  <span>lightclaw.tencent-tat.console</span>
                  <span>{connectionState}</span>
                </div>
                <div
                  ref={terminalContainerRef}
                  className="tat-terminal-host min-h-[34rem] rounded-[1rem] border p-2"
                  style={{
                    borderColor: "rgba(255,255,255,0.08)",
                    background: "#16110d",
                    letterSpacing: 0,
                    lineHeight: 1.2,
                  }}
                />
              </div>
            </GrammarSectionCard>
          </div>
        </div>
      </GrammarCanvas>
    </div>
  );
};

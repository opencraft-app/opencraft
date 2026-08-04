import type {
  TerminalControllerState,
  TerminalControlKey,
} from "@raft-platform/client-core";
import { useEffect, useRef, useState } from "react";

import { computeTerminalOutputPatch } from "../../terminal/terminal-output-sync";
import { raftTheme } from "../tokens";

export interface TerminalSurfaceController {
  close(): void;
  open(): Promise<void>;
  resize(cols: number, rows: number): void;
  sendControl(key: TerminalControlKey): void;
  snapshot(): TerminalControllerState;
  submitLine(value: string): void;
  subscribe(listener: (state: TerminalControllerState) => void): () => void;
  writeText(value: string): void;
}

export interface TerminalPanelProps {
  controller: TerminalSurfaceController;
  name: string;
  onClose(): void;
}

export function TerminalPanel({
  controller,
  name,
  onClose,
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [state, setState] = useState(controller.snapshot());

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let teardown = () => controller.close();
    void (async () => {
      try {
        const [{Terminal}, {FitAddon}] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/xterm/css/xterm.css"),
        ]);
        if (disposed) return;
        const terminal = new Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          ...raftTheme.terminal.xtermOptions,
          rows: raftTheme.terminal.initialRows,
          screenReaderMode: true,
          scrollback: raftTheme.terminal.scrollbackLines,
          theme: {
            background: raftTheme.terminal.surface,
            foreground: raftTheme.terminal.text,
            cursor: raftTheme.terminal.cursor,
            selectionBackground: raftTheme.terminal.selection,
          },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        terminal.focus();

        let previous: Uint8Array = new Uint8Array();
        let ready = false;
        const syncOutput = (next: Uint8Array) => {
          const patch = computeTerminalOutputPatch(previous, next);
          previous = next;
          if (patch.reset) terminal.reset();
          if (patch.data.byteLength > 0) terminal.write(patch.data);
        };
        const fitAndResize = () => {
          try {
            fit.fit();
            if (ready) controller.resize(terminal.cols, terminal.rows);
          } catch {
            // Hidden or detached hosts have no measurable terminal geometry.
          }
        };
        const unsubscribe = controller.subscribe((next) => {
          setState(next);
          ready = next.status === "ready";
          syncOutput(next.output);
          if (ready) queueMicrotask(fitAndResize);
        });
        const inputSubscription = terminal.onData((data) => {
          if (ready) controller.writeText(data);
        });
        const resizeObserver = new ResizeObserver(fitAndResize);
        resizeObserver.observe(host);
        const handleVisibility = () => {
          if (document.visibilityState === "visible") return;
          controller.close();
          onCloseRef.current();
        };
        document.addEventListener("visibilitychange", handleVisibility);
        queueMicrotask(fitAndResize);
        void controller.open();
        teardown = () => {
          document.removeEventListener("visibilitychange", handleVisibility);
          resizeObserver.disconnect();
          inputSubscription.dispose();
          unsubscribe();
          controller.close();
          terminal.dispose();
        };
      } catch (error) {
        if (disposed) return;
        setState(current => ({
          ...current,
          error:
            error instanceof Error
              ? error.message
              : "终端运行时加载失败",
          status: "error",
        }));
      }
    })();
    return () => {
      disposed = true;
      teardown();
    };
  }, [controller]);

  return (
    <section
      aria-label={`${name} 终端`}
      data-testid="computer-terminal-panel"
      style={styles.panel}
    >
      <header style={styles.header}>
        <div>
          <strong style={styles.title}>{name} / 终端</strong>
          <div aria-live="polite" style={styles.status}>
            {terminalStatusLabel[state.status]}
          </div>
        </div>
        <button
          aria-label="关闭终端"
          onClick={() => {
            controller.close();
            onClose();
          }}
          style={styles.button}
          type="button"
        >
          关闭
        </button>
      </header>
      {state.error ? (
        <div role="alert" style={styles.error}>
          {state.error}
        </div>
      ) : null}
      {state.truncated ? (
        <div style={styles.warning}>较早的终端输出已从本机内存中截断。</div>
      ) : null}
      <div
        data-testid="computer-terminal-output"
        ref={hostRef}
        style={styles.terminal}
      />
    </section>
  );
}

const terminalStatusLabel: Record<TerminalControllerState["status"], string> = {
  closed: "终端已关闭",
  connecting: "正在连接终端…",
  error: "终端连接异常",
  ready: "终端已连接",
};

const styles = {
  button: {
    background: raftTheme.semantic.color.sectionSurface,
    border: `${raftTheme.semantic.stroke.hairline}px solid ${raftTheme.semantic.color.borderControl}`,
    borderRadius: raftTheme.semantic.radius.control,
    color: raftTheme.semantic.color.textPrimary,
    cursor: "pointer",
    font: `${raftTheme.semantic.typography.button.fontWeight} ${raftTheme.semantic.typography.button.fontSize}px/${raftTheme.semantic.typography.button.lineHeight}px ${raftTheme.semantic.typography.button.fontFamily}`,
    minHeight: raftTheme.recipes.control.height,
    padding: `0 ${raftTheme.spacing.lg}px`,
  },
  error: {
    background: raftTheme.semantic.color.statusDangerSurface,
    borderRadius: raftTheme.semantic.radius.control,
    color: raftTheme.semantic.color.statusDangerText,
    font: `${raftTheme.semantic.typography.bodyCompactEmphasis.fontWeight} ${raftTheme.semantic.typography.bodyCompactEmphasis.fontSize}px/${raftTheme.semantic.typography.bodyCompactEmphasis.lineHeight}px ${raftTheme.semantic.typography.bodyCompactEmphasis.fontFamily}`,
    padding: raftTheme.spacing.md,
  },
  header: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
  },
  panel: {
    background: raftTheme.semantic.color.sectionSurface,
    border: `${raftTheme.semantic.stroke.hairline}px solid ${raftTheme.semantic.color.borderControl}`,
    borderRadius: raftTheme.semantic.radius.section,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: raftTheme.spacing.md,
    height: `calc(100dvh - ${raftTheme.recipes.terminalPanel.viewportChromeOffset}px)`,
    margin: `clamp(${raftTheme.spacing.lg}px, 2vw, ${raftTheme.spacing.xl}px)`,
    minHeight: raftTheme.recipes.terminalPanel.panelMinHeight,
    overflow: "hidden",
    padding: raftTheme.spacing.lg,
  },
  status: {
    color: raftTheme.semantic.color.textMuted,
    font: raftTheme.terminal.cssFont,
    marginTop: raftTheme.spacing.xs,
  },
  terminal: {
    background: raftTheme.terminal.surface,
    borderRadius: raftTheme.semantic.radius.control,
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    padding: raftTheme.spacing.md,
  },
  title: {
    color: raftTheme.semantic.color.textPrimary,
    font: `${raftTheme.semantic.typography.controlGlyph.fontWeight} ${raftTheme.semantic.typography.controlGlyph.fontSize}px/${raftTheme.semantic.typography.controlGlyph.lineHeight}px ${raftTheme.semantic.typography.controlGlyph.fontFamily}`,
  },
  warning: {
    background: raftTheme.semantic.color.statusWarningSurface,
    borderRadius: raftTheme.semantic.radius.control,
    color: raftTheme.semantic.color.statusWarningText,
    font: `${raftTheme.semantic.typography.bodySmallEmphasis.fontWeight} ${raftTheme.semantic.typography.bodySmallEmphasis.fontSize}px/${raftTheme.semantic.typography.bodySmallEmphasis.lineHeight}px ${raftTheme.semantic.typography.bodySmallEmphasis.fontFamily}`,
    padding: raftTheme.spacing.md,
  },
} as const;

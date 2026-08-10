import type {
  TerminalControllerState,
  TerminalControlKey,
} from "@vela/client-core";
import { useEffect, useRef, useState } from "react";

import { computeTerminalOutputPatch } from "../../terminal/terminal-output-sync";
import { velaTheme } from "../tokens";
import {terminalStatusLabel} from "../presentation/resources/terminal";

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
          ...velaTheme.terminal.xtermOptions,
          rows: velaTheme.terminal.initialRows,
          screenReaderMode: true,
          scrollback: velaTheme.terminal.scrollbackLines,
          theme: {
            background: velaTheme.terminal.surface,
            foreground: velaTheme.terminal.text,
            cursor: velaTheme.terminal.cursor,
            selectionBackground: velaTheme.terminal.selection,
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

const styles = {
  button: {
    background: velaTheme.semantic.color.sectionSurface,
    border: `${velaTheme.semantic.stroke.hairline}px solid ${velaTheme.semantic.color.borderControl}`,
    borderRadius: velaTheme.semantic.radius.control,
    color: velaTheme.semantic.color.textPrimary,
    cursor: "pointer",
    font: `${velaTheme.semantic.typography.button.fontWeight} ${velaTheme.semantic.typography.button.fontSize}px/${velaTheme.semantic.typography.button.lineHeight}px ${velaTheme.semantic.typography.button.fontFamily}`,
    minHeight: velaTheme.recipes.control.height,
    padding: `0 ${velaTheme.spacing.lg}px`,
  },
  error: {
    background: velaTheme.semantic.color.statusDangerSurface,
    borderRadius: velaTheme.semantic.radius.control,
    color: velaTheme.semantic.color.statusDangerText,
    font: `${velaTheme.semantic.typography.bodyCompactEmphasis.fontWeight} ${velaTheme.semantic.typography.bodyCompactEmphasis.fontSize}px/${velaTheme.semantic.typography.bodyCompactEmphasis.lineHeight}px ${velaTheme.semantic.typography.bodyCompactEmphasis.fontFamily}`,
    padding: velaTheme.spacing.md,
  },
  header: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
  },
  panel: {
    background: velaTheme.semantic.color.sectionSurface,
    border: `${velaTheme.semantic.stroke.hairline}px solid ${velaTheme.semantic.color.borderControl}`,
    borderRadius: velaTheme.semantic.radius.section,
    boxSizing: "border-box",
    display: "flex",
    flex: 1,
    flexDirection: "column",
    gap: velaTheme.spacing.md,
    minHeight: 0,
    overflow: "hidden",
    padding: velaTheme.spacing.lg,
  },
  status: {
    color: velaTheme.semantic.color.textMuted,
    font: velaTheme.terminal.cssFont,
    marginTop: velaTheme.spacing.xs,
  },
  terminal: {
    background: velaTheme.terminal.surface,
    borderRadius: velaTheme.semantic.radius.control,
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    padding: velaTheme.spacing.md,
  },
  title: {
    color: velaTheme.semantic.color.textPrimary,
    font: `${velaTheme.semantic.typography.controlGlyph.fontWeight} ${velaTheme.semantic.typography.controlGlyph.fontSize}px/${velaTheme.semantic.typography.controlGlyph.lineHeight}px ${velaTheme.semantic.typography.controlGlyph.fontFamily}`,
  },
  warning: {
    background: velaTheme.semantic.color.statusWarningSurface,
    borderRadius: velaTheme.semantic.radius.control,
    color: velaTheme.semantic.color.statusWarningText,
    font: `${velaTheme.semantic.typography.bodySmallEmphasis.fontWeight} ${velaTheme.semantic.typography.bodySmallEmphasis.fontSize}px/${velaTheme.semantic.typography.bodySmallEmphasis.lineHeight}px ${velaTheme.semantic.typography.bodySmallEmphasis.fontFamily}`,
    padding: velaTheme.spacing.md,
  },
} as const;

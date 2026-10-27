import { typographyRegistry, typographyRole } from "@opencraft/design-system/typography";
import type { Context } from "@deepseek-ai/cordis";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import type { ConversationPanelState } from "@opencraft/workbench-panels";
import {
  ConversationTerminalSessionRegistry as WorkbenchTerminalSessionRegistry,
  type ConversationTerminalOpenOptions,
} from "@opencraft/workbench-runtime";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export type WorkbenchTerminalOpenOptions = ConversationTerminalOpenOptions;
export { WorkbenchTerminalSessionRegistry };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return window.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function terminalTheme(element: HTMLElement) {
  const styles = window.getComputedStyle(element);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--color-background-surface", "#ffffff"),
    foreground: read("--color-text", "#202124"),
    cursor: read("--color-text", "#202124"),
    cursorAccent: read("--color-background-surface", "#ffffff"),
    selectionBackground: "rgba(108, 137, 255, 0.28)",
    black: "#1f2328",
    red: "#d1242f",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#d0d7de",
    brightBlack: "#57606a",
    brightRed: "#cf222e",
    brightGreen: "#2da44e",
    brightYellow: "#bf8700",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#f6f8fa",
  };
}

export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

export function terminalBoxIsVisible(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

export function terminalGridSizeChanged(
  previous: TerminalGridSize | null,
  next: TerminalGridSize,
): boolean {
  return previous === null || previous.cols !== next.cols || previous.rows !== next.rows;
}

export function pasteIntoActiveTerminal(
  target: Pick<import("@xterm/xterm").Terminal, "paste" | "focus"> | null,
  current: Pick<import("@xterm/xterm").Terminal, "paste" | "focus"> | null,
  text: string,
  running: boolean,
): boolean {
  if (text.length === 0 || target === null || target !== current || !running) return false;
  target.paste(text);
  target.focus();
  return true;
}

function createTerminalPanel(registry: WorkbenchTerminalSessionRegistry) {
  return function TerminalPanel({ tab }: PanelRendererProps) {
    const sessionId = tab.resource ?? "";
    const session = registry.get(sessionId);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
    const [presentationError, setPresentationError] = useState<Error | null>(null);
    const [pasteEntryOpen, setPasteEntryOpen] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const emptySnapshot = useMemo(() => Object.freeze({
      revision: 0,
      hostId: "",
      processId: sessionId,
      connectionGeneration: 0,
      phase: "failed" as const,
      output: Object.freeze([]),
      exitCode: null,
      error: new Error("Terminal session is unavailable"),
    }), [sessionId]);
    const snapshot = useSyncExternalStore(
      session === null ? () => () => undefined : session.subscribe,
      session === null ? () => emptySnapshot : session.getSnapshot,
      session === null ? () => emptySnapshot : session.getSnapshot,
    );

    useEffect(() => {
      setPasteEntryOpen(false);
      setPasteText("");
    }, [sessionId]);

    useEffect(() => {
      const host = hostRef.current;
      if (host === null || session === null) return;
      let disposed = false;
      let frameId: number | null = null;
      let removeSessionListener: () => void = () => undefined;
      let resizeObserver: ResizeObserver | null = null;
      let themeObserver: MutationObserver | null = null;
      let stopObservingFonts: (() => void) | null = null;
      let terminal: import("@xterm/xterm").Terminal | null = null;
      let lastOutputSequence = 0;
      let lastPublishedGrid: TerminalGridSize | null = null;

      const mount = async () => {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/xterm/css/xterm.css"),
        ]);
        if (disposed) return;
        terminal = new Terminal({
          allowProposedApi: false,
          convertEol: true,
          cursorBlink: true,
          cursorStyle: "bar",
          fontFamily:
            getComputedStyle(host)
              .getPropertyValue("--font-family-mono")
              .trim() ||
            typographyRegistry.families.mono.web,
          fontSize: typographyRole("terminalText", "web").fontSize,
          letterSpacing: 0,
          lineHeight: typographyRole("terminalText", "web").lineHeight / typographyRole("terminalText", "web").fontSize,
          scrollback: 10_000,
          theme: terminalTheme(host),
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        terminalRef.current = terminal;

        const writePendingOutput = () => {
          if (terminal === null) return;
          const current = session.getSnapshot();
          for (const chunk of current.output) {
            if (chunk.sequence <= lastOutputSequence) continue;
            lastOutputSequence = chunk.sequence;
            terminal.write(base64ToBytes(chunk.deltaBase64));
          }
        };
        writePendingOutput();
        removeSessionListener = session.subscribe(writePendingOutput);
        const input = terminal.onData((data) => {
          const bytes = new TextEncoder().encode(data);
          void session.write(bytesToBase64(bytes)).catch(setPresentationError);
        });

        const fitAndPublish = () => {
          frameId = null;
          if (disposed || terminal === null) return;
          if (!terminalBoxIsVisible(host.clientWidth, host.clientHeight)) return;
          fit.fit();
          const nextGrid = { cols: terminal.cols, rows: terminal.rows };
          if (!terminalGridSizeChanged(lastPublishedGrid, nextGrid)) return;
          lastPublishedGrid = nextGrid;
          void session.resize(terminal.cols, terminal.rows).catch((error) => {
            if (session.getSnapshot().phase === "running") setPresentationError(error as Error);
          });
        };
        const scheduleFit = () => {
          if (frameId === null) frameId = window.requestAnimationFrame(fitAndPublish);
        };

        const invalidateFontMeasurement = () => {
          if (disposed || terminal === null) return;
          const nextFontFamily =
            getComputedStyle(host).getPropertyValue("--font-family-mono").trim()
            || terminal.options.fontFamily;
          terminal.options.fontFamily = `${nextFontFamily} `;
          terminal.options.fontFamily = nextFontFamily;
          terminal.refresh(0, terminal.rows - 1);
          scheduleFit();
        };

        themeObserver = new MutationObserver(() => {
          if (terminal === null) return;
          terminal.options.theme = terminalTheme(host);
          invalidateFontMeasurement();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class", "data-theme", "style"],
        });

        const fontSet = document.fonts;
        const handleFontsLoaded = () => invalidateFontMeasurement();
        fontSet.addEventListener("loadingdone", handleFontsLoaded);
        void fontSet.ready.then(handleFontsLoaded);
        stopObservingFonts = () => fontSet.removeEventListener("loadingdone", handleFontsLoaded);

        resizeObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          const width = entry?.contentRect.width ?? host.clientWidth;
          const height = entry?.contentRect.height ?? host.clientHeight;
          if (terminalBoxIsVisible(width, height)) scheduleFit();
        });
        resizeObserver.observe(host);
        fitAndPublish();
        scheduleFit();
        terminal.focus();

        return () => {
          input.dispose();
        };
      };

      let cleanupInput: (() => void) | undefined;
      void mount().then((cleanup) => {
        if (disposed) cleanup?.();
        else cleanupInput = cleanup;
      }, (cause) => {
        if (!disposed) setPresentationError(cause instanceof Error ? cause : new Error(String(cause)));
      });

      return () => {
        disposed = true;
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        cleanupInput?.();
        resizeObserver?.disconnect();
        themeObserver?.disconnect();
        stopObservingFonts?.();
        removeSessionListener();
        terminalRef.current = null;
        terminal?.dispose();
      };
    }, [session]);

    const pasteIntoTerminal = (text: string, target = terminalRef.current): boolean => {
      return pasteIntoActiveTerminal(target, terminalRef.current, text, session?.getSnapshot().phase === "running");
    };

    const pasteFromClipboard = async () => {
      const target = terminalRef.current;
      const readText = navigator.clipboard?.readText;
      if (target === null || session?.getSnapshot().phase !== "running") return;
      if (readText !== undefined) {
        try {
          const text = await readText.call(navigator.clipboard);
          if (target !== terminalRef.current || session?.getSnapshot().phase !== "running") return;
          if (pasteIntoTerminal(text, target)) return;
        } catch { /* A native paste field remains available when clipboard reads are blocked. */ }
      }
      if (target === terminalRef.current && session?.getSnapshot().phase === "running") setPasteEntryOpen(true);
    };

    const sendPasteEntry = () => {
      if (!pasteIntoTerminal(pasteText)) return;
      setPasteText("");
      setPasteEntryOpen(false);
    };

    if (session === null) {
      return (
        <div className="right-panel-empty">
          <strong>Terminal session unavailable</strong>
          <p>This PTY belongs to an earlier AppServer connection.</p>
        </div>
      );
    }

    const error = presentationError ?? snapshot.error;
    return (
      <section className="terminal-panel" data-phase={snapshot.phase}>
        <div className="terminal-panel__inset" data-selection="text">
          <div className="terminal-panel__host" ref={hostRef} />
        </div>
        <div className="terminal-panel__paste-controls">
          <button disabled={snapshot.phase !== "running"} onClick={() => void pasteFromClipboard()} type="button">粘贴</button>
          {pasteEntryOpen ? (
            <div className="terminal-panel__paste-entry">
              <label htmlFor={`terminal-paste-${sessionId}`}>粘贴或输入文字</label>
              <textarea
                id={`terminal-paste-${sessionId}`}
                onChange={(event) => setPasteText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setPasteEntryOpen(false); setPasteText(""); }
                }}
                value={pasteText}
              />
              <div className="terminal-panel__paste-actions">
                <button disabled={pasteText.length === 0 || snapshot.phase !== "running"} onClick={sendPasteEntry} type="button">发送到终端</button>
                <button onClick={() => { setPasteEntryOpen(false); setPasteText(""); }} type="button">取消</button>
              </div>
            </div>
          ) : null}
        </div>
        {error !== null ? (
          <div className="terminal-panel__status" role="status">
            {error.message}
          </div>
        ) : snapshot.phase === "exited" ? (
          <div className="terminal-panel__status" role="status">
            Process exited with code {snapshot.exitCode ?? "unknown"}
          </div>
        ) : null}
      </section>
    );
  };
}

export function createTerminalWorkbenchPanelPlugin(
  registry: WorkbenchTerminalSessionRegistry,
) {
  const TerminalPanel = createTerminalPanel(registry);
  const activeTerminalSessionId = (state: ConversationPanelState): string | null => {
    for (const region of [state.right, state.bottom]) {
      const active = region.tabs.find((tab) => tab.id === region.activeTabId);
      if (active?.kind === "terminal" && active.resource !== undefined) return active.resource;
    }
    return null;
  };
  const terminalTab = (sessionId: string) => ({
    id: `terminal:${sessionId}`,
    kind: "terminal",
    region: "right" as const,
    title: "Terminal",
    icon: "terminal",
    showTabIcon: true,
    resource: sessionId,
    closable: true,
    preview: false,
  });
  return Object.assign(function TerminalWorkbenchPanelPlugin(ctx: Context) {
    const observedPanelOwners = new Map<string, () => void>();
    const syncActiveTerminal = (panelOwnerId: string) => {
      const sessionId = activeTerminalSessionId(
        ctx.workbenchPanels.getOwnerSnapshot(panelOwnerId),
      );
      if (sessionId !== null) registry.setActive(sessionId);
    };
    const observePanelOwner = (panelOwnerId: string) => {
      if (!observedPanelOwners.has(panelOwnerId)) {
        observedPanelOwners.set(panelOwnerId, ctx.workbenchPanels.subscribeOwner(
          panelOwnerId,
          () => syncActiveTerminal(panelOwnerId),
        ));
      }
      syncActiveTerminal(panelOwnerId);
    };
    const remove = [
      ctx.workbenchPanels.register<{ readonly sessionId: string }>({
        kind: "terminal",
        restoreTabs: (ownerId) => {
          observePanelOwner(ownerId);
          return registry.listForOwner(ownerId).map(terminalTab);
        },
        createTab: ({ sessionId }) => terminalTab(sessionId),
        disposeTab: (tab, _ownerId, reason) => {
          // Unmount/owner eviction/plugin replacement is not user intent to kill.
          if (reason === "close" && tab.resource !== undefined) registry.release(tab.resource);
        },
      }),
      ctx.workbenchPanelRenderers.register({
        kind: "terminal",
        Component: TerminalPanel,
      }),
      ctx.workbenchPanels.registerToolbarAction({
        id: "opencraft.terminal.new-session",
        region: "right",
        order: 200,
        label: "New terminal",
        icon: "terminal",
        creationLabel: "Terminal",
        run: (context) => {
          const sessionId = registry.open({ hostId: context.hostId, cwd: context.cwd,
            resourceOwnerId: context.resourceOwnerId });
          ctx.workbenchPanels.open(context.ownerId, "terminal", { sessionId });
          observePanelOwner(context.ownerId);
        },
      }),
    ];
    ctx.effect(() => () => {
      for (const unsubscribe of observedPanelOwners.values()) unsubscribe();
      observedPanelOwners.clear();
      remove.reverse().forEach((dispose) => dispose());
    });
  }, {
    inject: ["workbenchPanels", "workbenchPanelRenderers"],
  });
}

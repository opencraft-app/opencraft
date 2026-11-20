import { createPortal } from "react-dom";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { KeyboardIcon, PasteIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import type { IMarker } from '@xterm/xterm';
import { attachTerminalNativeSelection, hasTerminalNativeSelection } from './selection';
import { attachTerminalTouchScroll } from './touch-scroll';
import { typographyRegistry, typographyRole } from "@opencraft/design-system/typography";
import type { Context } from "@deepseek-ai/cordis";
import type { PanelRendererProps } from "@opencraft/workbench-panels-react";
import type { ConversationPanelState } from "@opencraft/workbench-panels";
import {
  ConversationTerminalSessionRegistry as WorkbenchTerminalSessionRegistry,
  TerminalRestoreUnavailableError,
  type ConversationTerminalOpenOptions,
} from "@opencraft/workbench-runtime";
import {
  useEffect,
  useLayoutEffect,
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

function createTerminalPanel(registry: WorkbenchTerminalSessionRegistry, openAnother: (ownerId: string, sessionId: string) => void) {
  return function TerminalPanel({ tab, ownerId, active = true, overviewPreview = false, touchToolbar = false, toolbarContainer = null, onPresentationReady }: PanelRendererProps) {
    const intl = useIntl();
    const sessionId = tab.resource ?? "";
    const session = registry.get(sessionId);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
    const nativeSelectionRef = useRef<ReturnType<typeof attachTerminalNativeSelection> | null>(null);
    const readingRef = useRef<{ followEnd: boolean; line: number; marker?: IMarker } | null>(null);
    const wasActive = useRef(active);
    const activeRef = useRef(active);
    activeRef.current = active;
    const previewRef = useRef(overviewPreview); previewRef.current = overviewPreview;
    const readyRef = useRef(onPresentationReady); readyRef.current = onPresentationReady;
    const toolbarRef = useRef({ touchToolbar, toolbarContainer });
    toolbarRef.current = { touchToolbar, toolbarContainer };
    const [presented, setPresented] = useState(active || overviewPreview || !!onPresentationReady);
    if ((active || overviewPreview || !!onPresentationReady) && !presented) setPresented(true);
    const revealRef = useRef<((focus?: boolean) => void) | null>(null);
    const wasOverviewPreview = useRef(overviewPreview);
    const [presentationError, setPresentationError] = useState<Error | null>(null);
    const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
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
      setClipboardNotice(null);
      setPresentationError(null);
    }, [sessionId]);

    useLayoutEffect(() => {
      const terminal = terminalRef.current;
      if (terminal) terminal.options.disableStdin = !active || snapshot.phase !== "running";
      nativeSelectionRef.current?.sync();
    }, [active, snapshot.phase, touchToolbar]);

    useLayoutEffect(() => {
      const terminal = terminalRef.current;
      if (!active && wasActive.current && terminal) {
        readingRef.current?.marker?.dispose();
        const buffer = terminal.buffer.active;
        readingRef.current = buffer.type === 'normal' ? {
          followEnd: buffer.viewportY === buffer.baseY, line: buffer.viewportY,
          marker: terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY),
        } : null;
      }
      wasActive.current = active;
      if (overviewPreview) wasOverviewPreview.current = true;
      if (active) { revealRef.current?.(!wasOverviewPreview.current); wasOverviewPreview.current = false; }
    }, [active, overviewPreview]);

    useLayoutEffect(() => {
      if (onPresentationReady) revealRef.current?.(false);
    }, [onPresentationReady, toolbarContainer, touchToolbar]);

    useLayoutEffect(() => {
      if (onPresentationReady && (session === null || presentationError !== null || snapshot.error != null)) onPresentationReady();
    }, [onPresentationReady, session, presentationError, snapshot.error]);

    useEffect(() => {
      const host = hostRef.current;
      if (host === null || session === null || !presented) return;
      let disposed = false;
      let frameId: number | null = null;
      let removeSessionListener: () => void = () => undefined;
      let resizeObserver: ResizeObserver | null = null;
      let themeObserver: MutationObserver | null = null;
      let stopObservingFonts: (() => void) | null = null;
      let terminal: import("@xterm/xterm").Terminal | null = null;
      let lastOutputSequence = 0;
      let lastPublishedGrid: TerminalGridSize | null = null;
      let nativeSelection: ReturnType<typeof attachTerminalNativeSelection> | null = null;

      const mount = async () => {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/xterm/css/xterm.css"),
          import("./selection.scss"),
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
        if (!activeRef.current) readingRef.current = { followEnd: true, line: 0 };
        const publishGesturePolicy = () => {
          if (disposed || terminal === null) return;
          // Terminal owns selection and TUI mouse reporting. Shell owns the
          // standard horizontal drawer gesture only on ordinary vertical output.
          nativeSelection?.sync();
          const policy = terminal.hasSelection() || hasTerminalNativeSelection(host) || terminal.modes.mouseTrackingMode !== 'none' ? 'ignore' : 'vertical-pan';
          if (host.dataset.sidebarGesture !== policy) host.dataset.sidebarGesture = policy;
        };
        publishGesturePolicy();
        const selection = terminal.onSelectionChange(publishGesturePolicy);
        nativeSelection = attachTerminalNativeSelection(terminal, host, () => activeRef.current, () => toolbarRef.current.touchToolbar, publishGesturePolicy);
        nativeSelectionRef.current = nativeSelection;
        const stopTouchScroll = attachTerminalTouchScroll(terminal, host, () => activeRef.current);

        const writePendingOutput = () => {
          if (terminal === null) return;
          const current = session.getSnapshot();
          terminal.options.disableStdin = !activeRef.current || current.phase !== "running";
          for (const chunk of current.output) {
            if (chunk.sequence <= lastOutputSequence) continue;
            lastOutputSequence = chunk.sequence;
            terminal.write(base64ToBytes(chunk.deltaBase64), publishGesturePolicy);
          }
        };
        writePendingOutput();
        removeSessionListener = session.subscribe(writePendingOutput);
        const input = terminal.onData((data) => {
          if (!activeRef.current || session.getSnapshot().phase !== "running") return;
          setClipboardNotice(null);
          const bytes = new TextEncoder().encode(data);
          void session.write(bytesToBase64(bytes)).catch((error) => {
            // An exit can win the race with an already submitted keystroke.
            // Its final status owns the feedback, not the rejected input.
            if (activeRef.current && session.getSnapshot().phase !== "exited") setPresentationError(error as Error);
          });
        });

        const fitAndPublish = () => {
          frameId = null;
          if (disposed || terminal === null || (!activeRef.current && !previewRef.current && !readyRef.current)) return;
          if (!terminalBoxIsVisible(host.clientWidth, host.clientHeight)) return;
          fit.fit();
          const reading = readingRef.current;
          if (reading && terminal.buffer.active.type === 'normal') {
            if (reading.followEnd) terminal.scrollToBottom();
            else terminal.scrollToLine(reading.marker && !reading.marker.isDisposed ? reading.marker.line : reading.line);
          }
          // A thumbnail/prepared scene may fit its local renderer, never its PTY.
          if (!activeRef.current) return;
          readingRef.current?.marker?.dispose(); readingRef.current = null;
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
        revealRef.current = (focus = true) => {
          // Retained handback already owns its final layout. Fit before paint,
          // rather than exposing the thumbnail grid until a later frame.
          if (frameId !== null) window.cancelAnimationFrame(frameId);
          fitAndPublish();
          if (readyRef.current && terminal) terminal.refresh(0, terminal.rows - 1);
          if (focus) terminal?.focus();
        };

        let acknowledged: (() => void) | undefined;
        const rendered = terminal.onRender(() => {
          nativeSelection?.sync();
          const ready = readyRef.current;
          if (disposed || !terminal || !ready || ready === acknowledged || (toolbarRef.current.touchToolbar && !toolbarRef.current.toolbarContainer?.isConnected)) return;
          const desired = fit.proposeDimensions();
          if (!desired || desired.cols !== terminal.cols || desired.rows !== terminal.rows) return;
          acknowledged = ready; ready();
        });

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
        if (activeRef.current) terminal.focus();

        return () => {
          input.dispose();
          selection.dispose();
          rendered.dispose();
          stopTouchScroll();
          nativeSelection?.dispose();
          delete host.dataset.sidebarGesture;
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
        revealRef.current = null;
        terminalRef.current = null;
        readingRef.current?.marker?.dispose(); readingRef.current = null;
        nativeSelectionRef.current = null;
        terminal?.dispose();
      };
    }, [session, presented]);

    const pasteIntoTerminal = (text: string, target = terminalRef.current): boolean => {
      if (target === terminalRef.current && session?.getSnapshot().phase === "running") nativeSelectionRef.current?.clear();
      return pasteIntoActiveTerminal(target, terminalRef.current, text, session?.getSnapshot().phase === "running");
    };

    const pasteFromClipboard = async () => {
      const target = terminalRef.current;
      if (target === null || !active || session?.getSnapshot().phase !== "running") return;
      setClipboardNotice(null);
      // Focus within the gesture so native system paste still targets this PTY.
      nativeSelectionRef.current?.clear();
      target.focus();
      try {
        const text = await navigator.clipboard.readText();
        if (target !== terminalRef.current || !activeRef.current || session?.getSnapshot().phase !== "running") return;
        if (pasteIntoTerminal(text, target)) return;
        setClipboardNotice(intl.formatMessage({ id: "terminal.clipboardEmpty", defaultMessage: "The clipboard has no text." }));
      } catch {
        if (target !== terminalRef.current || !activeRef.current || session?.getSnapshot().phase !== "running") return;
        setClipboardNotice(intl.formatMessage({ id: "terminal.clipboardUnavailable", defaultMessage: "Clipboard access is blocked. Use system paste in the terminal." }));
      }
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
    const needsNewTerminal = snapshot.phase === "failed";
    const keyboardLabel = intl.formatMessage({ id: "terminal.showKeyboard", defaultMessage: "Show keyboard" });
    const pasteLabel = intl.formatMessage({ id: "terminal.paste", defaultMessage: "Paste" });
    const actions = <>
      <IconButton type="button" className="panel-mobile-dock__button" aria-label={keyboardLabel} title={keyboardLabel}
        disabled={!active || snapshot.phase !== "running"}
        onClick={() => { nativeSelectionRef.current?.clear(); terminalRef.current?.focus(); }}><KeyboardIcon /></IconButton>
      <IconButton type="button" className="panel-mobile-dock__button" aria-label={pasteLabel} title={pasteLabel}
        disabled={!active || snapshot.phase !== "running"}
        onClick={() => void pasteFromClipboard()}><PasteIcon /></IconButton>
    </>;
    return (
      <section className="terminal-panel" data-phase={snapshot.phase}>
        <div className="terminal-panel__inset" data-selection="text">
          <div className="terminal-panel__host" data-retained-scroll-owner="renderer" ref={hostRef} />
        </div>
        {touchToolbar ? active && toolbarContainer !== null ? createPortal(actions, toolbarContainer) : null : (
          <div data-retained-preview-chrome className="terminal-panel__paste-controls terminal-panel__toolbar">{actions}</div>
        )}
        {clipboardNotice !== null ? (
          <div data-retained-preview-chrome className="terminal-panel__status terminal-panel__clipboard-status" data-touch-toolbar={touchToolbar || undefined} role="status">
            {clipboardNotice}
          </div>
        ) : null}
        {snapshot.phase === "exited" ? (
          <div className="terminal-panel__status" data-terminal-status="exited" data-touch-toolbar={touchToolbar || undefined} role="status">
            {snapshot.exitCode === null
              ? intl.formatMessage({ id: "terminal.exited", defaultMessage: "Terminal exited. Open a new terminal to continue." })
              : intl.formatMessage({ id: "terminal.exitedWithCode", defaultMessage: "Terminal exited (code {code}). Open a new terminal to continue." }, { code: snapshot.exitCode })}
          </div>
        ) : error !== null ? (
          <div className="terminal-panel__status terminal-panel__recovery" role="status">
            <span>{intl.formatMessage(error instanceof TerminalRestoreUnavailableError
              ? { id: "terminal.restoreUnavailable", defaultMessage: "This server cannot reconnect this terminal. Open a new terminal to continue." }
              : snapshot.phase === "disconnected"
                ? { id: "terminal.disconnected", defaultMessage: "Terminal disconnected. Waiting for the server to reconnect." }
                : { id: "terminal.unavailable", defaultMessage: "The terminal is unavailable. Try opening a new terminal." })}</span>
            {needsNewTerminal ? <Button size="sm" disabled={!active} onClick={() => {
              try { openAnother(ownerId, sessionId); }
              catch (cause) { setPresentationError(cause instanceof Error ? cause : new Error(String(cause))); }
            }}>{intl.formatMessage({ id: "terminal.new", defaultMessage: "New terminal" })}</Button> : null}
          </div>
        ) : null}
      </section>
    );
  };
}

export function createTerminalWorkbenchPanelPlugin(
  registry: WorkbenchTerminalSessionRegistry,
  resolveScope?: (ownerId: string) => { threadId?: string | null; projectId?: string | null },
  restoreOwner?: (ownerId: string) => Promise<void>,
) {
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
    const TerminalPanel = createTerminalPanel(registry, (ownerId, sessionId) => {
      const next = registry.openAnother(sessionId);
      ctx.workbenchPanels.open(ownerId, "terminal", { sessionId: next });
    });
    const observedPanelOwners = new Map<string, () => void>();
    const resourceOwners = new Map<string, string>();
    const directoryObservers = new Map<string, { rebind(): void }>();
    const resourceOwner = (panelOwner: string) => resourceOwners.get(panelOwner) ?? panelOwner;
    const bindResourceOwner = (panelOwner: string, owner: string) => {
      const existing = resourceOwners.get(panelOwner);
      if (existing !== undefined && existing !== owner) throw new Error('Terminal panel resource owner cannot change');
      if (existing === owner) return;
      resourceOwners.set(panelOwner, owner);
      directoryObservers.get(panelOwner)?.rebind();
    };
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
        tabDirectory: {
          read: ownerId => registry.listForOwner(resourceOwner(ownerId)).map(terminalTab),
          subscribe: (ownerId, changed) => {
            let stop = registry.subscribe(resourceOwner(ownerId), changed);
            const observer = { rebind() {
              stop(); stop = registry.subscribe(resourceOwner(ownerId), changed); changed();
            } };
            directoryObservers.set(ownerId, observer);
            return () => { stop(); if (directoryObservers.get(ownerId) === observer) directoryObservers.delete(ownerId); };
          },
        },
        restoreTabs: (ownerId) => {
          observePanelOwner(ownerId);
          return registry.listForOwner(resourceOwner(ownerId)).map(terminalTab);
        },
        ...(restoreOwner ? { hydrateTabs: async (ownerId: string) => {
          await restoreOwner(resourceOwner(ownerId));
          return registry.listForOwner(resourceOwner(ownerId)).map(terminalTab);
        } } : {}),
        createTab: ({ sessionId }) => terminalTab(sessionId),
        disposeTab: (tab, _ownerId, reason) => {
          // Unmount/owner eviction/plugin replacement is not user intent to kill.
          if (reason === "close" && tab.resource !== undefined) registry.release(tab.resource);
        },
      }),
      ctx.workbenchPanelRenderers.register({
        kind: "terminal",
        Component: TerminalPanel,
        presentationReadiness: "renderer",
        previewPresentation: "retained-view",
        previewFallback: "reparent-safe",
        residency: "while-tab-open",
      }),
      ctx.workbenchPanels.registerToolbarAction({
        id: "opencraft.terminal.new-session",
        region: "right",
        order: 200,
        label: "New terminal",
        icon: "terminal",
        creationLabel: "Terminal",
        isAvailable: context => registry.canOpen(context.hostId),
        run: (context) => {
          bindResourceOwner(context.ownerId, context.resourceOwnerId);
          const sessionId = registry.open({ hostId: context.hostId, cwd: context.cwd,
            threadId: context.threadId, projectId: context.projectId, resourceOwnerId: context.resourceOwnerId, ...resolveScope?.(context.resourceOwnerId) });
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

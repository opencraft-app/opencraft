import { ChevronDownIcon as ChevronDown, AddIcon as Plus } from "@opencraft/design-system-web/action-icons";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MessageIcon as MessageSquare } from "@opencraft/design-system-web/action-icons";
import {
  groupTimelineFramesByTurn,
  type TimelineSnapshot,
} from "@opencraft/chat-core";
import type { ComposerController } from "@opencraft/composer-core";
import type { BrowserTabId } from "@opencraft/browser-core";
import { useOptionalBrowserRuntime } from "../browser/browser-runtime-context";
import { useShellPresentation } from "./shell-presentation";
import {
  ConversationTurn,
  type ConversationDocumentContextValue,
} from "./conversation";
import { ConversationDocumentContext } from "./conversation/document-context";
import { shouldPresentMainComposerOverlay } from "./thread-composer-presentation-model";
import {
  ComposerWheelSwipeController,
  FloatingComposerRegistry,
  projectFloatingComposer,
  type BrowserReadiness,
} from "./floating-composer-state";

export const ComposerOverlayAnchorContext =
  createContext<HTMLDivElement | null>(null);
export const FloatingComposerRegistryContext =
  createContext<FloatingComposerRegistry | null>(null);
export const FloatingComposerScopeContext = createContext<string | null>(null);

export function FloatingComposerToggle({
  activeTabId,
}: {
  activeTabId: string;
}) {
  const registry = useContext(FloatingComposerRegistryContext);
  const scope = useContext(FloatingComposerScopeContext);
  const reduced = Boolean(useReducedMotion());
  const shell = useShellPresentation();
  if (!registry || scope === null)
    throw new Error("Missing floating composer scope");
  const store = registry.get(scope);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  if (!shell?.rightPanelFullWidth) return null;
  const shown = state.enabled && !state.collapsedTabs.has(activeTabId);
  const toggleLabel = shown ? "Hide floating composer" : "Show floating composer";
  return (
    <button
      type="button"
      className="browser-toolbar-button"
      aria-label={toggleLabel}
      title={toggleLabel}
      aria-pressed={shown}
      onClick={() => store.toggle(activeTabId, reduced)}
    >
      <MessageSquare size={14} aria-hidden="true" />
    </button>
  );
}

function relatedPopup(target: EventTarget | null, content: HTMLElement | null) {
  if (!(target instanceof Element) || !content) return false;
  return (
    content.contains(target) ||
    Boolean(
      (target.closest("[data-radix-popper-content-wrapper]") &&
        content.querySelector('[aria-haspopup][data-state="open"]')) ||
        (target.closest('[role="dialog"], [role="alertdialog"]') &&
          content.querySelector(
            '[aria-haspopup="dialog"][aria-expanded="true"]'
          ))
    )
  );
}
function windowIsFocused() {
  // Guest focus makes the host document unfocused without deactivating the OS window.
  return (window as any).opencraftDesktop?.getWindowFocused?.() ?? document.hasFocus();
}

export function ThreadComposerPresentation({
  children,
  controller,
  scopeId,
  activeTabId,
  enabled,
  timeline,
  documentContext,
  forceExpanded = false,
}: {
  children: ReactNode;
  controller: ComposerController;
  scopeId: string;
  activeTabId: string | null;
  enabled: boolean;
  timeline: TimelineSnapshot | null;
  documentContext?: ConversationDocumentContextValue;
  forceExpanded?: boolean;
}) {
  const shell = useShellPresentation();
  const shellAnchor = useContext(ComposerOverlayAnchorContext);
  const registry = useContext(FloatingComposerRegistryContext);
  const shellScope = useContext(FloatingComposerScopeContext);
  if (!registry)
    throw new Error("Floating composer requires its Shell scope owner");
  const routeScope = shellScope ?? scopeId;
  const store = useMemo(() => registry.get(routeScope), [registry, routeScope]);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  const reduced = Boolean(useReducedMotion());
  const overlay =
    enabled &&
    shouldPresentMainComposerOverlay(
      Boolean(shell?.rightPanelOpen && shell.rightPanelFullWidth),
      activeTabId
    );
  const browser = useOptionalBrowserRuntime();
  const browserTabId = activeTabId?.startsWith("browser:")
    ? (activeTabId.slice(8) as BrowserTabId)
    : null;
  const subscribeBrowser = useCallback(
    (listener: () => void) => {
      if (!browser || !browserTabId) return () => {};
      const removeTab = browser.workbench.subscribeTab(browserTabId, listener);
      const pageId = browser.workbench.getTabSnapshot(browserTabId)?.pageId;
      const removePage =
        pageId && browser.pages.has(pageId)
          ? browser.pages.subscribe(pageId, listener)
          : () => {};
      return () => {
        removeTab();
        removePage();
      };
    },
    [browser, browserTabId]
  );
  const getPage = useCallback(
    () =>
      browserTabId ? browser?.workbench.pageForTab(browserTabId) ?? null : null,
    [browser, browserTabId]
  );
  const page = useSyncExternalStore(subscribeBrowser, getPage, getPage);
  const readiness: BrowserReadiness = !browserTabId
    ? "ready"
    : !page || !page.navigation.currentUrl || page.error
    ? "unavailable"
    : page.navigation.isLoading
    ? "loading"
    : "ready";
  const floating = overlay && browserTabId !== null;
  // Browser guests use a separate body-level presentation plane. Retain that
  // stacking contract; ordinary tools share the Shell's local overlay plane.
  const overlayContainer = floating ? document.body : shellAnchor;
  const view = projectFloatingComposer(state, {
    floating,
    tabId: activeTabId,
    readiness,
    forceExpanded,
  });
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>(
    {}
  );
  const [nearBottom, setNearBottom] = useState(false);
  const [overHandle, setOverHandle] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [animateTab, setAnimateTab] = useState(false);
  const latest = useMemo(
    () =>
      timeline ? groupTimelineFramesByTurn(timeline).at(-1) ?? null : null,
    [timeline]
  );
  const previewId = useId();
  const inline = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null),
    revealHost = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null),
    latestSurface = useRef<HTMLDivElement>(null),
    preview = useRef<HTMLDivElement>(null),
    overlaySlot = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const switching = useRef(false);
  const swipe = useRef(new ComposerWheelSwipeController());
  const [composerElement] = useState(() => {
    const element = document.createElement("div");
    element.className = "floating-composer-editor-host";
    return element;
  });
  useLayoutEffect(() => {
    if (
      floating &&
      readiness === "unavailable" &&
      state.enabled &&
      state.collapsedTabs.has(activeTabId!)
    )
      store.show(activeTabId, true);
  }, [
    activeTabId,
    floating,
    readiness,
    state.enabled,
    state.collapsedTabs,
    store,
  ]);

  useLayoutEffect(() => {
    const focused = composerElement.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    switching.current = true;
    (overlay ? overlaySlot.current : inline.current)?.append(composerElement);
    if (focused && !overlay) focused.focus({ preventScroll: true });
    switching.current = false;
  }, [composerElement, overlay, overlayContainer, view.mounted]);
  useEffect(() => () => composerElement.remove(), [composerElement]);
  useEffect(() => () => registry.release(routeScope), [registry, routeScope]);
  useLayoutEffect(() => {
    switching.current = true;
    if (overlay && composerElement.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
    store.focus(null);
    store.settle();
    setExpanded(false);
    setNearBottom(false);
    setOverHandle(false);
    setHandoff(false);
    setAnimateTab(false);
    setExpanding(false);
    switching.current = false;
    return () => {
      clearTimeout(handoffTimer.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [activeTabId, overlay, composerElement, store]);
  useLayoutEffect(() => {
    if (!overlay || !shellAnchor) return;
    const element = shellAnchor;
    let scheduled: number | null = null;
    const measure = () => {
      scheduled = null;
      const rect = element.getBoundingClientRect();
      if (floating)
        for (const target of [host.current, revealHost.current])
          if (target)
            Object.assign(target.style, {
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            });
      // Ordinary tools are CSS-local to the Shell; measure bottom occlusion.
      // Content excludes both the bottom inset and the absolute latest-turn card.
      const contentRect = content.current?.getBoundingClientRect();
      const latestElement = latestSurface.current?.getClientRects().length
        ? latestSurface.current
        : null;
      const previousLatest = latestElement?.getBoundingClientRect();
      const previewHeight = preview.current?.getBoundingClientRect().height ?? 0;
      // Expanded history scrolls within the remaining tool area. Layout-viewport
      // vh alone still includes the space now occupied by the software keyboard.
      const previewSpace = Math.max(
        0,
        (previousLatest?.top ?? contentRect?.top ?? rect.bottom) -
          rect.top + previewHeight
      );
      host.current?.style.setProperty(
        "--right-panel-composer-preview-max-height",
        floating
          ? "22.5rem"
          : `max(0px, calc(${previewSpace}px - var(--min-height-workspace-tool-visible)))`
      );
      const latestRect = latestElement?.dataset.visible === "true"
        ? latestElement.getBoundingClientRect()
        : null;
      const occupiedTop = Math.min(
        contentRect?.top ?? rect.bottom,
        latestRect?.top ?? rect.bottom
      );
      element.style.setProperty(
        "--right-panel-composer-overlay-height",
        `${contentRect?.height ?? 102}px`
      );
      element.style.setProperty(
        "--right-panel-composer-overlay-reserve",
        floating ? "0px" : `${Math.max(0, rect.bottom - occupiedTop)}px`
      );
    };
    const schedule = () => {
      scheduled ??= requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    if (latestSurface.current) observer.observe(latestSurface.current);
    const viewport = floating ? window.visualViewport : null;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (scheduled !== null) cancelAnimationFrame(scheduled);
      element.style.removeProperty("--right-panel-composer-overlay-height");
      element.style.removeProperty("--right-panel-composer-overlay-reserve");
    };
  }, [overlay, shellAnchor, floating, view.mounted, view.handles, Boolean(latest && documentContext)]);
  useEffect(() => {
    if (!overlay || !view.peeked || !page) return;
    return browser?.surfaces.trackPointerNearBottom?.(
      page.id,
      48,
      setNearBottom
    );
  }, [browser, overlay, page?.id, view.peeked]);
  useEffect(() => {
    if (!overlay || !view.peeked || !shellAnchor) return;
    const onMove = (event: PointerEvent) => {
      const r = shellAnchor.getBoundingClientRect();
      setNearBottom(
        event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.bottom - 48 &&
          event.clientY <= r.bottom
      );
    };
    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, [overlay, shellAnchor, view.peeked]);

  const hide = useCallback(
    (keyboard = false) => {
      setExpanded(false);
      store.hide(activeTabId, reduced || keyboard);
      if (composerElement.contains(document.activeElement))
        (document.activeElement as HTMLElement).blur();
      setHandoff(true);
      clearTimeout(handoffTimer.current);
      handoffTimer.current = setTimeout(() => setHandoff(false), 150);
    },
    [activeTabId, composerElement, reduced, store]
  );
  const reveal = useCallback(
    (keyboard = false) => {
      clearTimeout(handoffTimer.current);
      setHandoff(false);
      setNearBottom(false);
      setOverHandle(false);
      store.show(activeTabId, reduced || keyboard);
      store.focus(activeTabId);
      setAnimateTab(true);
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        controller.focus();
      });
    },
    [activeTabId, controller, reduced, store]
  );
  const onFocus = useCallback(() => {
    if (!floating || view.peeked) return;
    setAnimateTab(true);
    if (view.density === "compact" && !reduced) setExpanding(true);
    store.focus(activeTabId);
  }, [activeTabId, floating, reduced, store, view.density, view.peeked]);
  const blur = useCallback(
    (target: EventTarget | null) => {
      if (switching.current || relatedPopup(target, content.current)) return;
      if (target === null) {
        if (!windowIsFocused()) return;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (
            windowIsFocused() &&
            !relatedPopup(document.activeElement, content.current)
          ) {
            store.focus(null);
            setExpanded(false);
          }
        });
      } else {
        store.focus(null);
        setExpanded(false);
      }
    },
    [store]
  );
  // React portal events follow their React owner, not a moved DOM ancestor.
  useEffect(() => {
    if (!overlay) return;
    const onBlur = (event: FocusEvent) => blur(event.relatedTarget);
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(':disabled, [aria-disabled="true"]')) event.preventDefault();
    };
    composerElement.addEventListener("focusin", onFocus);
    composerElement.addEventListener("focusout", onBlur);
    composerElement.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      composerElement.removeEventListener("focusin", onFocus);
      composerElement.removeEventListener("focusout", onBlur);
      composerElement.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [blur, composerElement, onFocus, overlay]);
  useEffect(() => {
    if (!overlay || !view.interactive) return;
    const outside = (event: PointerEvent) => {
      if (!relatedPopup(event.target, content.current)) { setExpanded(false); store.focus(null); }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [overlay, view.interactive, store]);
  useEffect(() => {
    if (!floating || !view.interactive) return;
    const wheel = (event: WheelEvent) => {
      if (
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        !(event.target instanceof Element) ||
        !content.current?.contains(event.target) ||
        preview.current?.contains(event.target)
      )
        return;
      const editor = composerElement.querySelector<HTMLElement>(
        ".opencraft-composer-editor"
      );
      if (!editor) return;
      if (view.density === "compact") {
        if (event.deltaY > 0) {
          event.preventDefault();
          event.stopPropagation();
          swipe.current.beginSwipe(event, "composer");
          editor.focus();
        }
        return;
      }
      if (swipe.current.isContinuation(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        state.focusedTab === activeTabId &&
        editor.scrollHeight <= editor.clientHeight &&
        latest
      ) {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(event.deltaY > 0);
      }
    };
    document.addEventListener("wheel", wheel, {
      capture: true,
      passive: false,
    });
    return () => document.removeEventListener("wheel", wheel, true);
  }, [
    floating,
    view.interactive,
    view.density,
    composerElement,
    state.focusedTab,
    activeTabId,
    latest,
  ]);
  useEffect(() => {
    let count = controller.getSnapshot().draft.attachments.length;
    return controller.subscribe(() => {
      const next = controller.getSnapshot().draft.attachments.length;
      if (overlay && next > count) {
        store.show(activeTabId, true);
        store.focus(activeTabId);
        controller.focus();
      }
      count = next;
    });
  }, [activeTabId, controller, overlay, store]);

  const popup =
    overlay && view.mounted && overlayContainer
      ? createPortal(
          <>
            <div
              ref={host}
              className="thread-composer-overlay-host"
              data-anchor={floating ? "viewport" : "shell"}
              data-testid="right-panel-composer-overlay-host"
            >
              <div
                className="thread-composer-overlay"
                data-presentation={floating ? "floating" : "default"}
            data-transition-state={view.phase}
            data-active-tab={activeTabId}
            data-browser-readiness={readiness}
            data-collapse-reason={activeTabId ? state.collapsedTabs.get(activeTabId) : undefined}
                data-composer-peeked={view.peeked}
              >
                <div className="thread-composer-overlay__padding">
                  <div
                    ref={content}
                    className="thread-composer-overlay__content"
                    data-density={view.density}
                    data-animate={animateTab && !reduced}
                    data-expanding={expanding}
                    data-peeked={view.peeked}
                    onTransitionEnd={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        event.propertyName === "max-width"
                      )
                        setExpanding(false);
                    }}
                  >
                    <div
                      className="thread-composer-overlay__interactive"
                      inert={!view.interactive || undefined}
                      aria-hidden={!view.interactive || undefined}
                      onFocusCapture={onFocus}
                      onBlurCapture={(event) => blur(event.relatedTarget)}
                      onPointerDownCapture={(event) => {
                        if (
                          (event.target as Element).closest(
                            ":disabled,[aria-disabled=true]"
                          )
                        )
                          event.preventDefault();
                      }}
                    >
                      {latest && documentContext ? (
                        <div
                          ref={latestSurface}
                          className="thread-composer-overlay__latest"
                          data-visible={
                            !floating || view.density === "expanded"
                          }
                          inert={
                            (floating && view.density !== "expanded") ||
                            undefined
                          }
                          aria-hidden={
                            (floating && view.density !== "expanded") ||
                            undefined
                          }
                        >
                          <button
                            type="button"
                            className="thread-composer-overlay__summary"
                            aria-expanded={expanded}
                            aria-controls={previewId}
                            onClick={() => setExpanded((value) => !value)}
                            onWheel={(event) => {
                              if (
                                floating &&
                                Math.abs(event.deltaY) > Math.abs(event.deltaX)
                              ) {
                                event.stopPropagation();
                                setExpanded(event.deltaY > 0);
                              }
                            }}
                          >
                            <span>
                              {latest.status === "streaming"
                                ? "Working"
                                : "Latest turn"}
                            </span>
                            <ChevronDown size={14} aria-hidden="true" />
                          </button>
                          <AnimatePresence initial={false}>
                            {expanded ? (
                              <motion.div
                                key="latest"
                                id={previewId}
                                ref={preview}
                                className="thread-composer-overlay__response-motion"
                                initial={{ maxHeight: 0, opacity: 0 }}
                                animate={{ maxHeight: "22.5rem", opacity: 1 }}
                                exit={{
                                  maxHeight: 0,
                                  opacity: 0,
                                  pointerEvents: "none",
                                }}
                                transition={{ duration: reduced ? 0 : 0.15 }}
                              >
                                <div className="thread-composer-overlay__response">
                                  <ConversationDocumentContext.Provider
                                    value={documentContext}
                                  >
                                    <ConversationTurn
                                      turn={latest}
                                      startAfterTurnIntro
                                      isMostRecentTurn
                                      threadDetailLevel="STEPS_COMMANDS"
                                      activityCollapsedById={collapsed}
                                      onActivityCollapsedChange={(id, value) =>
                                        setCollapsed((previous) => ({
                                          ...previous,
                                          [id]: value,
                                        }))
                                      }
                                    />
                                  </ConversationDocumentContext.Provider>
                                </div>
                              </motion.div>
                            ) : null}
                          </AnimatePresence>
                        </div>
                      ) : null}
                      <div
                        ref={overlaySlot}
                        className="thread-composer-overlay__editor-slot"
                      />
                    </div>
                    {view.handles ? (
                      <button
                        type="button"
                        className="thread-composer-overlay__hide"
                        aria-label="Hide chat input"
                        title="Hide chat input"
                        inert={!view.interactive || undefined}
                        aria-hidden={!view.interactive || undefined}
                        onClick={(event) => hide(event.detail === 0)}
                        onWheel={(event) => {
                          if (
                            event.deltaY < 0 &&
                            Math.abs(event.deltaY) > Math.abs(event.deltaX)
                          ) {
                            event.stopPropagation();
                            hide();
                          }
                        }}
                      >
                        <ChevronDown size={12} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
            {view.handles ? (
              <div ref={revealHost} className="thread-composer-reveal-host" data-anchor="viewport">
                <div className="thread-composer-reveal-zone">
                  <button
                    type="button"
                    className="thread-composer-overlay__reveal"
                    data-testid="floating-composer-reveal-handle"
                    data-active={nearBottom || overHandle || handoff}
                    data-visible={view.peeked}
                    inert={!view.peeked || undefined}
                    aria-hidden={!view.peeked || undefined}
                    aria-label="Show chat input"
                    title="Show chat input"
                    onPointerEnter={(event) => {
                      if (event.pointerType !== "mouse") return;
                      clearTimeout(handoffTimer.current);
                      setHandoff(false);
                      setOverHandle(true);
                    }}
                    onPointerLeave={() => setOverHandle(false)}
                    onClick={(event) => reveal(event.detail === 0)}
                    onWheel={(event) => {
                      if (
                        event.deltaY > 0 &&
                        Math.abs(event.deltaY) > Math.abs(event.deltaX)
                      ) {
                        event.stopPropagation();
                        swipe.current.beginSwipe(event.nativeEvent, "peek");
                        reveal();
                      }
                    }}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ) : null}
          </>,
          overlayContainer
        )
      : null;
  return (
    <>
      <div ref={inline} className="thread-composer-inline-host" />
      {createPortal(children, composerElement)}
      {popup}
    </>
  );
}

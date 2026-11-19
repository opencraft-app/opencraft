import {
  cancelRetainedScrollRestore,
  queueRetainedScrollRestore,
  restoreRetainedScroll,
  type RetainedScrollPosition,
} from "./retained-preview-scroll";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { WorkbenchPresentationActivityProvider } from "./workbench-presentation-activity";
import {
  canMoveRetainedView,
  canFloatRetainedView,
  moveRetainedView,
  floatRetainedView,
  retainedPreviewLayoutEvent,
  retainedPreviewFrame,
  getPreviewFlightProjection,
  type PreviewAnchor,
} from "./retained-preview-placement";
import "./retained-view-preview.scss";

interface ViewSize {
  width: number;
  height: number;
}
interface ViewSource {
  mount(target: HTMLElement): (() => void) | undefined;
}

/** Shell-scoped physical views. No conversation, process, or resource ownership. */
class RetainedViewRegistry {
  private sources = new Map<string, ViewSource>();
  private overviews = new Set<symbol>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get(key: string) {
    return this.sources.get(key) ?? null;
  }
  overviewActive = () => this.overviews.size > 0;
  enterOverview() {
    const owner = Symbol("overview");
    this.overviews.add(owner);
    this.emit();
    return () => {
      if (this.overviews.delete(owner)) this.emit();
    };
  }
  register(key: string, source: ViewSource) {
    this.sources.set(key, source);
    this.emit();
    return () => {
      if (this.sources.get(key) === source) {
        this.sources.delete(key);
        this.emit();
      }
    };
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
}
const RegistryContext = createContext<RetainedViewRegistry | null>(null);
const subscribeNothing = () => () => {};
const readFalse = () => false;
export const primaryChatViewKey = (owner: string) => JSON.stringify(["primary-chat", owner]);
export const isPrimaryChatViewKey = (key: string) => key.startsWith('["primary-chat",');
export const panelViewKey = (owner: string, tab: string) => JSON.stringify(["panel", owner, tab]);

export function RetainedViewPreviewProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new RetainedViewRegistry());
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

const prepareHomeEvent = "retained-preview-prepare-home";
/** Handback synchronously consumes the latest home, including a resize delivered
 * after readiness. It never sizes a resource from the thumbnail aperture. */
export function prepareRetainedPreviewLayout(frame: HTMLElement) {
  for (const target of frame.querySelectorAll<HTMLElement>(".retained-view-preview"))
    target.dispatchEvent(new Event(prepareHomeEvent));
}

/** A moving preview frame explicitly invalidates its borrowed view's geometry. */
export function refreshRetainedPreviewLayout(frame: HTMLElement) {
  for (const target of frame.querySelectorAll<HTMLElement>(".retained-view-preview"))
    target.dispatchEvent(new Event(retainedPreviewLayoutEvent));
}

export function useRetainedOverview(active: boolean) {
  const registry = useContext(RegistryContext);
  useLayoutEffect(() => (active ? registry?.enterOverview() : undefined), [registry, active]);
}

/** A stable portal target moves between the normal slot and a read-only thumbnail.
 * React, DOM, canvas, selection and scroll owners remain the same instances. */
export function RetainedPreviewSource({
  viewKey,
  className,
  allowLegacyMove = false,
  previewAnchor = "start",
  preparing = false,
  children,
}: {
  viewKey: string;
  className?: string;
  allowLegacyMove?: boolean;
  previewAnchor?: PreviewAnchor;
  preparing?: boolean;
  children: ReactNode | ((previewing: boolean, overviewActive: boolean) => ReactNode);
}) {
  const registry = useContext(RegistryContext);
  const home = useRef<HTMLDivElement>(null);
  const [root] = useState(() => Object.assign(document.createElement("div"), { className: "retained-preview-view" }));
  const [previewing, setPreviewing] = useState(false);
  const preparingRef = useRef(preparing);
  preparingRef.current = preparing;
  const prepareBorrowedLayout = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (preparing) prepareBorrowedLayout.current?.();
  }, [preparing]);
  const restoreReading = useRef<RetainedScrollPosition[] | null>(null);
  const overviewActive = useSyncExternalStore(
    registry?.subscribe ?? subscribeNothing,
    registry?.overviewActive ?? readFalse,
  );
  // Physical attachment belongs to the portal lifetime, not its registry key.
  // Rebinding a conversation must not reload iframe documents or invalidate
  // the connected layout that child effects are restoring in this commit.
  useLayoutEffect(() => {
    home.current!.append(root);
    return () => {
      cancelRetainedScrollRestore(root);
      root.remove();
    };
  }, [root]);
  useLayoutEffect(() => {
    if (!previewing && !overviewActive && restoreReading.current) {
      queueRetainedScrollRestore(root, restoreReading.current);
      restoreReading.current = null;
    }
    root.inert = previewing || overviewActive;
    if (previewing || overviewActive) root.setAttribute("aria-hidden", "true");
    else root.removeAttribute("aria-hidden");
  }, [root, previewing, overviewActive]);
  useLayoutEffect(() => {
    const slot = home.current!;
    root.dataset.retainedView = isPrimaryChatViewKey(viewKey) ? "primary-chat" : "panel";
    let size: ViewSize | null = null,
      release: (() => void) | undefined;
    const pending = new Set<() => void>();
    const rememberSize = () => {
      if (release) {
        if (preparingRef.current) prepareBorrowedLayout.current?.();
        return;
      }
      if (slot.clientWidth > 0 && slot.clientHeight > 0) size = { width: slot.clientWidth, height: slot.clientHeight };
    };
    rememberSize();
    const homeObserver = new ResizeObserver(rememberSize);
    homeObserver.observe(slot);
    const source: ViewSource = {
      mount(target) {
        if (release) return undefined;
        target.dataset.retainedPreviewState = "pending";
        const atomic = canMoveRetainedView(target),
          floating = canFloatRetainedView(root);
        // Older engines may move a canvas viewer, but must never reload live chat frames.
        if (!atomic && !floating && !allowLegacyMove) {
          target.dataset.retainedPreviewState = "unavailable";
          return undefined;
        }
        rememberSize();
        // A tab restored but never presented may not yet have physical geometry.
        // Use its existing panel viewport, never fabricate a different terminal grid.
        const panel = slot.closest<HTMLElement>(".right-panel-view");
        const bounds =
          size ??
          (panel?.clientWidth && panel.clientHeight ? { width: panel.clientWidth, height: panel.clientHeight } : null);
        if (!bounds) {
          let mounted: (() => void) | undefined;
          const stopWaiting = () => {
            observer.disconnect();
            pending.delete(cancel);
          };
          const cancel = () => {
            stopWaiting();
            mounted?.();
            delete target.dataset.retainedPreviewState;
          };
          const observer = new ResizeObserver(() => {
            rememberSize();
            if (!slot.isConnected || !target.isConnected) {
              cancel();
              return;
            }
            if (size || (panel?.clientWidth && panel.clientHeight)) {
              stopWaiting();
              mounted = source.mount(target);
            }
          });
          observer.observe(slot);
          if (panel) observer.observe(panel);
          pending.add(cancel);
          return cancel;
        }
        const pendingReading = cancelRetainedScrollRestore(root) ?? restoreReading.current;
        // A cancelled preview may be borrowed again before overview closes.
        // Apply its pending reading intent before capturing a new lease.
        if (pendingReading) restoreRetainedScroll(pendingReading);
        restoreReading.current = null;
        const previousFocus = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
        const scrollPositions = [root, ...root.querySelectorAll<HTMLElement>("*")]
          .filter((node) => !node.closest('[data-retained-scroll-owner="renderer"]'))
          .filter(
            (node) =>
              node instanceof HTMLElement &&
              (node.scrollHeight > node.clientHeight ||
                node.scrollWidth > node.clientWidth ||
                /auto|scroll/.test(getComputedStyle(node).overflowY)),
          )
          .map((node) => ({
            node,
            top: node.scrollTop,
            left: node.scrollLeft,
            followEnd: node.scrollHeight - node.clientHeight - node.scrollTop <= 2,
          }));
        const restoreScroll = () => restoreRetainedScroll(scrollPositions);
        const selection = window.getSelection();
        const selected =
          selection?.anchorNode &&
          selection.focusNode &&
          root.contains(selection.anchorNode) &&
          root.contains(selection.focusNode)
            ? {
                anchor: selection.anchorNode,
                anchorOffset: selection.anchorOffset,
                focus: selection.focusNode,
                focusOffset: selection.focusOffset,
              }
            : null;
        previousFocus?.blur();
        root.inert = true;
        root.setAttribute("aria-hidden", "true");
        root.style.width = `${bounds.width}px`;
        root.style.height = `${bounds.height}px`;
        root.dataset.retainedPreview = "true";
        let contentEndDirty = true,
          measuredContentEnd: number | undefined;
        const contentEnd = () => {
          if (!contentEndDirty) return measuredContentEnd;
          contentEndDirty = false;
          if (previewAnchor !== "end") return undefined;
          const last = root.querySelectorAll<HTMLElement>("[data-retained-preview-content]");
          const content = last.item(last.length - 1);
          const box = root.getBoundingClientRect();
          return (measuredContentEnd =
            content && box.width > 0
              ? ((content.getBoundingClientRect().bottom - box.top) * bounds.width) / box.width
              : undefined);
        };
        // Capture the source context before a physical move can invalidate
        // descendant-dependent Shell styles (for example reading safe areas).
        const inheritedStyle = atomic || !floating ? getComputedStyle(slot) : null;
        const inheritedProperties = inheritedStyle
          ? [...inheritedStyle]
              .filter((name) => name.startsWith("--"))
              .map((name) => [name, inheritedStyle.getPropertyValue(name)] as const)
          : [];
        const moved = atomic && moveRetainedView(target, root);
        const stopFloating =
          !moved && floating ? floatRetainedView(root, target, bounds, previewAnchor, contentEnd) : undefined;
        if (!moved && !stopFloating && !allowLegacyMove) {
          root.inert = registry?.overviewActive() ?? false;
          if (root.inert) root.setAttribute("aria-hidden", "true");
          else root.removeAttribute("aria-hidden");
          root.removeAttribute("style");
          delete root.dataset.retainedPreview;
          target.dataset.retainedPreviewState = "unavailable";
          restoreScroll();
          return undefined;
        }
        if (moved || !stopFloating) {
          const destination = getComputedStyle(target);
          for (const [name, value] of inheritedProperties)
            if (value !== destination.getPropertyValue(name)) root.style.setProperty(name, value);
          if (!moved) target.append(root);
        }
        target.dataset.retainedPreviewState = "borrowed";
        restoreScroll();
        const scale = () => {
          if (stopFloating) return;
          const rect = getPreviewFlightProjection(target)?.content ?? {
            width: target.clientWidth,
            height: target.clientHeight,
          };
          if (!rect.width || !rect.height) return;
          const { scale: ratio, y } = retainedPreviewFrame(bounds, rect, previewAnchor, contentEnd());
          root.style.top = `${y}px`;
          root.style.transform = `scale(${ratio})`;
          root.style.left = `${(rect.width - bounds.width * ratio) / 2}px`;
          root.dataset.retainedPreviewScale = String(ratio);
        };
        // A selected renderer may prepare its existing viewer before the flight.
        // Read the allocated home, not the thumbnail aperture. No resource/input
        // owner moves until the normal scene commit.
        const prepareLayout = () => {
          if (!preparingRef.current || !slot.clientWidth || !slot.clientHeight) return;
          contentEndDirty = true;
          bounds.width = slot.clientWidth;
          bounds.height = slot.clientHeight;
          root.style.width = bounds.width + "px";
          root.style.height = bounds.height + "px";
          const inherited = getComputedStyle(slot),
            destination = getComputedStyle(target);
          for (const name of [...root.style]) if (name.startsWith("--")) root.style.removeProperty(name);
          for (const name of inherited)
            if (name.startsWith("--") && inherited.getPropertyValue(name) !== destination.getPropertyValue(name))
              root.style.setProperty(name, inherited.getPropertyValue(name));
          // Reflowed to the destination width: keep a followed tail at the end.
          for (const value of scrollPositions)
            if (value.followEnd) value.node.scrollTop = value.node.scrollHeight - value.node.clientHeight;
          scale();
          target.dispatchEvent(new Event(retainedPreviewLayoutEvent));
        };
        prepareBorrowedLayout.current = prepareLayout;
        if (preparingRef.current) prepareLayout();
        else scale();
        target.addEventListener(retainedPreviewLayoutEvent, scale);
        target.addEventListener(prepareHomeEvent, prepareLayout);
        const observer = new ResizeObserver(scale);
        observer.observe(target);
        const refreshContent = () => {
          contentEndDirty = true;
          target.dispatchEvent(new Event(retainedPreviewLayoutEvent));
        };
        if (previewAnchor === "end") root.addEventListener("scroll", refreshContent, true);
        const contentObserver = previewAnchor === "end" ? new ResizeObserver(refreshContent) : null;
        let observedContent = new Set<Element>();
        const watchContent = () => {
          if (!contentObserver) return;
          const entries = new Set(root.querySelectorAll("[data-retained-preview-content]"));
          // Earlier streamed turns/images can move the last turn without changing
          // its own height. Observe content, never our animated frame/styles.
          for (const entry of observedContent) if (!entries.has(entry)) contentObserver.unobserve(entry);
          for (const entry of entries) if (!observedContent.has(entry)) contentObserver.observe(entry);
          observedContent = entries;
          refreshContent();
        };
        const contentMutation = contentObserver ? new MutationObserver(watchContent) : null;
        contentMutation?.observe(root, { childList: true, characterData: true, subtree: true });
        watchContent();
        setPreviewing(true);
        const restore = () => {
          if (release !== restore) return;
          root.removeEventListener("scroll", refreshContent, true);
          release = undefined;
          prepareBorrowedLayout.current = null;
          observer.disconnect();
          contentObserver?.disconnect();
          contentMutation?.disconnect();
          target.removeEventListener(retainedPreviewLayoutEvent, scale);
          target.removeEventListener(prepareHomeEvent, prepareLayout);
          stopFloating?.();
          if (!stopFloating && !moveRetainedView(slot, root)) slot.append(root);
          root.inert = registry?.overviewActive() ?? false;
          if (root.inert) root.setAttribute("aria-hidden", "true");
          else root.removeAttribute("aria-hidden");
          root.removeAttribute("style");
          delete root.dataset.retainedPreview;
          delete root.dataset.retainedPreviewScale;
          delete target.dataset.retainedPreviewState;
          if (
            selected &&
            window.getSelection()?.isCollapsed &&
            root.contains(selected.anchor) &&
            root.contains(selected.focus)
          ) {
            const offset = (node: Node, value: number) =>
              Math.min(
                value,
                node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length,
              );
            window
              .getSelection()
              ?.setBaseAndExtent(
                selected.anchor,
                offset(selected.anchor, selected.anchorOffset),
                selected.focus,
                offset(selected.focus, selected.focusOffset),
              );
          }
          restoreReading.current = scrollPositions;
          setPreviewing(false);
        };
        release = restore;
        return restore;
      },
    };
    const unregister = registry?.register(viewKey, source);
    return () => {
      for (const cancel of pending) cancel();
      release?.();
      cancelRetainedScrollRestore(root);
      restoreReading.current = null;
      unregister?.();
      homeObserver.disconnect();
    };
  }, [registry, root, viewKey, allowLegacyMove, previewAnchor]);
  return (
    <>
      <div ref={home} className={["retained-preview-home", className].filter(Boolean).join(" ")} />
      {createPortal(
        <WorkbenchPresentationActivityProvider active={!previewing && !overviewActive}>
          {typeof children === "function" ? children(previewing, overviewActive) : children}
        </WorkbenchPresentationActivityProvider>,
        root,
      )}
    </>
  );
}

/** Borrows a single existing view; opening an overview never mounts a second tool. */
export function RetainedViewPreview({
  viewKey,
  fallback = null,
  active = true,
}: {
  viewKey: string;
  fallback?: ReactNode;
  active?: boolean;
}) {
  const registry = useContext(RegistryContext);
  const subscribe = useMemo(() => registry?.subscribe ?? (() => () => {}), [registry]);
  const source = useSyncExternalStore(subscribe, () => registry?.get(viewKey) ?? null);
  const target = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(true);
  useLayoutEffect(() => {
    const release = active ? source?.mount(target.current!) : undefined;
    setAvailable(!source || !!release);
    return release;
  }, [source, active]);
  return (
    <div ref={target} className="retained-view-preview" data-view-key={viewKey} aria-hidden="true">
      {source && available ? null : fallback}
    </div>
  );
}

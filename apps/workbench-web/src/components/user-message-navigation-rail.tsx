import { RefreshIcon } from "@opencraft/design-system-web/action-icons";
import { AvatarImage, IdentityAvatarContext } from "@opencraft/extension-react";
import { PersonIcon as UserRound } from "@opencraft/design-system-web/action-icons";
import type {
  ConversationNavigationAnchor,
  ConversationNavigationPreview,
  ConversationNavigationSource,
  PreparedConversationNavigationTarget,
} from "@opencraft/chat-navigation";
import { conversationNavigationTargetVersion } from "@opencraft/chat-navigation";
import type { VirtualizedTurnListApi } from "@opencraft/timeline-virtualizer";
import { createPortal } from "react-dom";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const PREVIEW_DELAY_MS = 150;
const MINIMUM_ITEM_COUNT = 4;
// Keep the existing hit target; the Web inset comes from the shared title/rail axis.
const NAVIGATION_HIT_WIDTH_PX = 36;
const USER_MESSAGE_NAVIGATION_TOP_INSET_PX = 16;
const EMPTY_NAVIGATION_ANCHORS: readonly ConversationNavigationAnchor[] = [];
const TURN_OBSERVATION_SELECTOR = "[data-turn-key], [data-content-search-turn-key]";

function equalStringSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function navigationObservationKey(items: readonly ConversationNavigationAnchor[]): string {
  return items.map((item) => `${item.id}\u001f${item.itemId ?? ""}`).join("\u0000");
}

function mutationsChangeMountedTurns(records: readonly MutationRecord[]): boolean {
  return records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) =>
    node instanceof HTMLElement
    && (node.matches(TURN_OBSERVATION_SELECTOR) || node.querySelector(TURN_OBSERVATION_SELECTOR) !== null)
  ));
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape !== undefined
    ? CSS.escape(value)
    : value.replaceAll('"', '\\"');
}

function anchorSelector(itemId: string): string {
  return `[data-content-search-unit-key="${cssEscape(itemId)}"]`;
}

function findAnchorButton(
  items: readonly ConversationNavigationAnchor[],
  rail: HTMLElement,
  target: Element | null,
): { anchor: ConversationNavigationAnchor; button: HTMLButtonElement } | null {
  const button = target?.closest<HTMLButtonElement>("[data-thread-user-message-navigation-item-id]");
  if (button == null || !rail.contains(button)) return null;
  const id = button.dataset.threadUserMessageNavigationItemId;
  const anchor = items.find((candidate) => candidate.id === id);
  return anchor === undefined ? null : { anchor, button };
}

function highlightTarget(target: Element | null, reducedMotion: boolean): void {
  const element = target?.querySelector<HTMLElement>("[data-user-message-bubble]")
    ?? (target instanceof HTMLElement ? target : null);
  element?.animate?.([
    { backgroundColor: "color-mix(in srgb, var(--color-text) 14%, transparent)" },
    { backgroundColor: "color-mix(in srgb, var(--color-text) 14%, transparent)", offset: 0.35 },
    { backgroundColor: "color-mix(in srgb, var(--color-text) 5%, transparent)" },
  ], {
    duration: reducedMotion ? 0 : 1_400,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  });
}

interface TooltipState {
  readonly anchorId: string;
  readonly button: HTMLButtonElement;
  readonly preview: ConversationNavigationPreview;
}

export interface UserMessageNavigationRailProps {
  readonly source: ConversationNavigationSource;
  readonly getScrollElement: () => HTMLDivElement | null;
  readonly virtualizedTurnListApi: VirtualizedTurnListApi;
  readonly onNavigationClick?: () => void;
}

export function UserMessageNavigationRail({
  source,
  getScrollElement,
  virtualizedTurnListApi,
  onNavigationClick,
}: UserMessageNavigationRailProps) {
  const avatars = useContext(IdentityAvatarContext);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const [isPrepared, setIsPrepared] = useState(false);
  const [hasClearance, setHasClearance] = useState(false);
  const [railHost, setRailHost] = useState<HTMLElement | null>(null);
  const [visibleItemIds, setVisibleItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [scrubTargetId, setScrubTargetId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const scrubRef = useRef<{
    pointerId: number;
    anchorId: string;
    pointerCaptureTarget: HTMLButtonElement;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const navigationAbortRef = useRef<AbortController | null>(null);
  const navigationLeaseRef = useRef<{
    readonly source: ConversationNavigationSource;
    readonly target: PreparedConversationNavigationTarget;
  } | null>(null);
  const tooltipId = useId();
  const reducedMotion = useMemo(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setIsPrepared(false);
    const prepare = () => {
      void source.prepare().finally(() => {
        if (!cancelled) setIsPrepared(true);
      });
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(prepare, { timeout: 2_000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(handle);
      };
    }
    const handle = window.setTimeout(prepare, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [source]);

  const items =
    isPrepared && snapshot.completeness === "complete"
      ? snapshot.anchors
      : EMPTY_NAVIGATION_ANCHORS;
  const observationKey = useMemo(() => navigationObservationKey(items), [items]);

  useEffect(() => {
    const scrollElement = getScrollElement();
    const content = scrollElement?.querySelector<HTMLElement>("[data-thread-user-message-navigation-content]") ?? null;
    if (scrollElement === null || content === null) {
      setHasClearance(false);
      setRailHost(null);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollRect = scrollElement.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const scale = scrollElement.offsetWidth > 0 ? scrollRect.width / scrollElement.offsetWidth : 1;
        const nextRailHost = scrollElement.parentElement;
        setRailHost((current) => current === nextRailHost ? current : nextRailHost);
        const webInset = Number.parseFloat(getComputedStyle(scrollElement).getPropertyValue("--thread-navigation-web-inset")) || 36;
        setHasClearance((contentRect.left - scrollRect.left) / Math.max(scale, 0.0001) >= webInset + NAVIGATION_HIT_WIDTH_PX);
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(scrollElement);
    resize.observe(content);
    const mutation = new MutationObserver(update);
    mutation.observe(scrollElement.firstElementChild ?? scrollElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("resize", update);
    update();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [getScrollElement]);

  useEffect(() => {
    const scrollElement = getScrollElement();
    if (scrollElement === null || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const observed = new Map<Element, string>();
    const publishVisibleRange = () => {
      const firstVisibleIndex = items.findIndex(
        (item) => item.itemId !== null && visible.has(item.itemId),
      );
      if (firstVisibleIndex < 0) return;
      let lastVisibleIndex = firstVisibleIndex;
      for (let index = items.length - 1; index > firstVisibleIndex; index -= 1) {
        const item = items[index];
        if (item?.itemId !== null && item?.itemId !== undefined && visible.has(item.itemId)) {
          lastVisibleIndex = index;
          break;
        }
      }
      const next = new Set(
        items.slice(firstVisibleIndex, lastVisibleIndex + 1).flatMap((item) =>
          item.itemId === null ? [] : [item.itemId]
        ),
      );
      setVisibleItemIds((current) => equalStringSets(current, next) ? current : next);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const itemId = observed.get(entry.target);
        if (itemId === undefined) continue;
        if (entry.isIntersecting) visible.add(itemId);
        else visible.delete(itemId);
      }
      publishVisibleRange();
    }, { root: scrollElement, rootMargin: "-16px 0px 0px 0px" });
    const reconcile = () => {
      const expected = new Map<Element, string>();
      const claimedTurns = new Set<Element>();
      for (const item of items) {
        if (item.itemId === null) continue;
        const unit = scrollElement.querySelector(anchorSelector(item.itemId));
        if (unit === null) continue;
        const turn = unit.closest(TURN_OBSERVATION_SELECTOR);
        const observationTarget = turn === null || claimedTurns.has(turn) ? unit : turn;
        claimedTurns.add(observationTarget);
        expected.set(observationTarget, item.itemId);
      }
      for (const [element, itemId] of observed) {
        if (expected.has(element)) continue;
        visible.delete(itemId);
        observed.delete(element);
        observer.unobserve(element);
      }
      for (const [element, itemId] of expected) {
        if (observed.has(element)) continue;
        observed.set(element, itemId);
        observer.observe(element);
      }
      publishVisibleRange();
    };
    const mutation = new MutationObserver((records) => {
      if (mutationsChangeMountedTurns(records)) reconcile();
    });
    mutation.observe(scrollElement, { childList: true, subtree: true });
    reconcile();
    return () => {
      mutation.disconnect();
      observer.disconnect();
    };
  }, [getScrollElement, observationKey]);

  const activeIds = useMemo(() => {
    const visible = new Set(items
      .filter((item) => item.itemId !== null && visibleItemIds.has(item.itemId))
      .map((item) => item.id));
    if (visible.size === 0) {
      const latest = items.at(-1);
      if (latest !== undefined) visible.add(latest.id);
    }
    return visible;
  }, [items, visibleItemIds]);
  const activeId = items.find((item) => activeIds.has(item.id))?.id ?? null;

  useLayoutEffect(() => {
    const list = railRef.current;
    if (list === null || activeId === null || scrubTargetId !== null) return;
    const button = list.querySelector<HTMLElement>(`[data-thread-user-message-navigation-item-id="${cssEscape(activeId)}"]`);
    if (button === null) return;
    if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight + 1;
    }
  }, [activeId, scrubTargetId]);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current === null) return;
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
  }, []);

  const requestPreview = useCallback((anchor: ConversationNavigationAnchor, button: HTMLButtonElement) => {
    clearPreviewTimer();
    const requestId = ++previewRequestRef.current;
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      void source.loadPreview(anchor.id).then((preview) => {
        if (preview !== null && requestId === previewRequestRef.current) {
          setTooltip({ anchorId: anchor.id, button, preview });
        }
      }).catch(() => undefined);
    }, PREVIEW_DELAY_MS);
  }, [clearPreviewTimer, source]);

  const closeTooltip = useCallback(() => {
    clearPreviewTimer();
    previewRequestRef.current += 1;
    setTooltip(null);
  }, [clearPreviewTimer]);

  useEffect(() => closeTooltip, [closeTooltip]);
  useEffect(() => () => {
    navigationAbortRef.current?.abort();
    navigationAbortRef.current = null;
    navigationLeaseRef.current = null;
  }, [source, virtualizedTurnListApi]);

  useEffect(() => {
    const lease = navigationLeaseRef.current;
    if (lease === null || lease.source !== source) return;
    const current = snapshot.anchors.find((candidate) => candidate.id === lease.target.anchorId);
    if (
      snapshot.generation !== lease.target.generation
      || current === undefined
      || conversationNavigationTargetVersion(current) !== lease.target.targetVersion
    ) {
      navigationAbortRef.current?.abort();
      navigationAbortRef.current = null;
      navigationLeaseRef.current = null;
    }
  }, [snapshot.generation, snapshot.revision, source]);

  const navigate = useCallback(async (
    anchor: ConversationNavigationAnchor,
    behavior: "smooth" | "instant",
  ) => {
    navigationAbortRef.current?.abort();
    navigationAbortRef.current = null;
    navigationLeaseRef.current = null;
    if (behavior === "instant" && !anchor.isLoaded) return;
    const scrollElement = getScrollElement();
    if (scrollElement === null) return;
    // Smooth scrolling is safe only when the exact target was already mounted.
    // A newly hydrated target is mounted offscreen and measured first, then
    // placed once with an instant final commit so virtualization cannot expose
    // an empty intermediate window.
    const canAnimateExistingTarget = behavior === "smooth"
      && anchor.itemId !== null
      && scrollElement.querySelector(anchorSelector(anchor.itemId)) !== null;
    const controller = new AbortController();
    navigationAbortRef.current = controller;
    try {
      const target = await source.prepareTarget(anchor.id, { signal: controller.signal });
      if (target === null || controller.signal.aborted) return;
      navigationLeaseRef.current = { source, target };
      const result = await virtualizedTurnListApi.positionTarget({
        turnKey: target.turnKey,
        align: "top",
        behavior: canAnimateExistingTarget && !reducedMotion ? "smooth" : "instant",
        minimumTimelineRevision: target.projectionRevision,
        targetKey: target.itemId ?? undefined,
        topAlignmentInsetPx: USER_MESSAGE_NAVIGATION_TOP_INSET_PX,
        signal: controller.signal,
      });
      const currentAnchor = source.getSnapshot().anchors.find(
        (candidate) => candidate.id === target.anchorId,
      );
      if (
        result !== "positioned"
        || controller.signal.aborted
        || source.getSnapshot().generation !== target.generation
        || currentAnchor === undefined
        || conversationNavigationTargetVersion(currentAnchor) !== target.targetVersion
      ) return;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const positioned = target.itemId === null
        ? null
        : scrollElement.querySelector(anchorSelector(target.itemId));
      highlightTarget(positioned, reducedMotion);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
      // Source snapshots own navigation transport/projection failures.
    } finally {
      if (navigationAbortRef.current === controller) {
        navigationAbortRef.current = null;
        navigationLeaseRef.current = null;
      }
    }
  }, [getScrollElement, reducedMotion, source, virtualizedTurnListApi]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !event.altKey
        || event.shiftKey
        || event.ctrlKey
        || event.metaKey
        || (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        || items.length === 0
      ) return;
      const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId));
      const targetIndex = event.key === "ArrowUp"
        ? Math.max(0, activeIndex - 1)
        : Math.min(items.length - 1, activeIndex + 1);
      const target = items[targetIndex];
      if (target === undefined || targetIndex === activeIndex) return;
      event.preventDefault();
      void navigate(target, "smooth");
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeId, items, navigate]);

  if (!hasClearance || railHost === null || items.length < MINIMUM_ITEM_COUNT) return null;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = findAnchorButton(items, event.currentTarget, event.target instanceof Element ? event.target : null);
    if (target === null) return;
    closeTooltip();
    suppressClickRef.current = false;
    scrubRef.current = {
      pointerId: event.pointerId,
      anchorId: target.anchor.id,
      // Capturing on the list retargets the synthesized click away from the
      pointerCaptureTarget: target.button,
    };
    setScrubTargetId(target.anchor.id);
    target.button.setPointerCapture?.(event.pointerId);
  };
  const finishScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const scrub = scrubRef.current;
    if (scrub?.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    setScrubTargetId(null);
    if (scrub.pointerCaptureTarget.hasPointerCapture?.(event.pointerId)) {
      scrub.pointerCaptureTarget.releasePointerCapture?.(event.pointerId);
    }
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const tooltipRect = tooltip?.button.getBoundingClientRect();
  return (
    <>
      {createPortal(<nav className="conversation-navigation-rail" aria-label="User messages">
        <div
          className="conversation-navigation-rail__list"
          data-scrubbing={scrubTargetId !== null || undefined}
          onLostPointerCapture={finishScrub}
          onPointerCancel={finishScrub}
          onPointerDown={handlePointerDown}
          onPointerLeave={() => {
            if (scrubRef.current === null) {
              closeTooltip();
            }
          }}
          onPointerMove={(event) => {
            const scrub = scrubRef.current;
            if (scrub === null || scrub.pointerId !== event.pointerId) return;
            if ((event.buttons & 1) === 0) {
              finishScrub(event);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const element = document.elementFromPoint(
              rect.left + rect.width / 2,
              Math.max(rect.top, Math.min(event.clientY, rect.bottom - 1)),
            );
            const target = findAnchorButton(items, event.currentTarget, element);
            if (target === null || target.anchor.id === scrub.anchorId) return;
            scrubRef.current = { ...scrub, anchorId: target.anchor.id };
            suppressClickRef.current = true;
            setScrubTargetId(target.anchor.id);
            if (target.anchor.isLoaded) void navigate(target.anchor, "instant");
          }}
          onPointerUp={finishScrub}
          ref={railRef}
        >
          <div className="conversation-navigation-rail__items">
            {items.map((item, index) => (
              <button
                aria-current={activeIds.has(item.id) ? "true" : undefined}
                aria-describedby={tooltip?.anchorId === item.id ? tooltipId : undefined}
                aria-label={`Jump to user message ${index + 1}`}
                className="conversation-navigation-rail__item"
                data-scrub-target={scrubTargetId === item.id || undefined}
                data-thread-user-message-navigation-item-id={item.id}
                key={item.id}
                onClick={() => {
                  if (scrubRef.current !== null || suppressClickRef.current) return;
                  onNavigationClick?.();
                  void navigate(item, "smooth");
                }}
                onBlur={closeTooltip}
                onFocus={(event) => {
                  if (event.currentTarget.ownerDocument.documentElement.dataset.pointerFocus) return;
                  requestPreview(item, event.currentTarget);
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "mouse") return;
                  requestPreview(item, event.currentTarget);
                }}
                type="button"
              >
                <span className="conversation-navigation-rail__marker-track">
                  <span className="conversation-navigation-rail__marker" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </nav>, railHost)}
      {tooltip !== null && tooltipRect !== undefined ? createPortal(
        <div
          className="conversation-navigation-tooltip"
          id={tooltipId}
          role="tooltip"
          style={{ left: tooltipRect.right, top: tooltipRect.top + tooltipRect.height / 2 }}
        >
          <div className="conversation-navigation-tooltip__label">
            {tooltip.preview.sender ? <span className="conversation-navigation-tooltip__avatar" role="img" aria-label={tooltip.preview.sender.loginName} title={tooltip.preview.sender.loginName}>
              <AvatarImage src={avatars?.resolve(tooltip.preview.sender.kind, tooltip.preview.sender.loginName) ?? null} fallback={<UserRound size={12} />} />
            </span> : null}
            {items.find((item) => item.id === tooltip.anchorId)?.isHeartbeat ? <RefreshIcon size={12} /> : null}
            <span>{tooltip.preview.label || "(No content)"}</span>
          </div>
          {tooltip.preview.response.trim().length > 0 ? (
            <div className="conversation-navigation-tooltip__response">{tooltip.preview.response}</div>
          ) : null}
          {tooltip.preview.outputs.length > 0 ? (
            <div className="conversation-navigation-tooltip__outputs">
              {tooltip.preview.outputs.slice(0, 2).map((output, index) => (
                <span key={`${output.kind}:${output.label ?? index}`}>{output.label ?? output.kind}</span>
              ))}
              {tooltip.preview.outputs.length > 2 ? <span>+{tooltip.preview.outputs.length - 2}</span> : null}
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

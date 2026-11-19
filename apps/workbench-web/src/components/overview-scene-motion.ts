import { leasePreviewComposition } from "./retained-preview-composition";
import { animateOverviewProgress as animate } from "./overview-playback";
import { flushSync } from "react-dom";
import type { SceneTransition } from "./scene-transition";
import {
  canFloatRetainedView,
  liftPreviewFrame,
  measurePreviewClip,
  setPreviewFlightClip,
  setPreviewFlightProjection,
} from "./retained-preview-placement";
import { mix, motionValue, useReducedMotion, type MotionValue } from "motion/react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { PANEL_CONTINUOUS_SPRING_TRANSITION } from "./use-panel-animation";
import { prepareRetainedPreviewLayout, refreshRetainedPreviewLayout } from "./retained-view-preview";
import {
  projectOverviewHeading,
  type OverviewHeadingGeometry,
  type OverviewHeadingMetrics,
} from "./overview-heading-geometry";

// Zero endpoint derivatives avoid a velocity corner when geometry yields to compositing.
export function overviewGeometry(progress: number): number {
  const p = Math.max(0, Math.min(1, (progress - 0.06) / 0.94));
  return p * p * (3 - 2 * p);
}
export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface PaintedScene {
  frame: SceneRect;
  content: SceneRect;
  clip: SceneRect;
  heading?: OverviewHeadingGeometry;
}
interface SceneFlight {
  stop(): void;
  cancel(): void;
  finish(): void;
  rollback?(): void;
  key: string | null;
  progress?: MotionValue<number>;
  cardness?: number;
  velocity?(): number;
  snapshot?(): PaintedScene | undefined;
  retire?(): void;
  paintShared?(): void;
}
export interface OverviewOrigin {
  key: string;
  rect: SceneRect | null;
}
export const validSceneRect = (rect: SceneRect | null | undefined): rect is SceneRect =>
  !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
export function interpolateSceneRect(from: SceneRect, to: SceneRect, progress: number): SceneRect {
  const p = Math.max(0, Math.min(1, progress));
  return {
    x: from.x + (to.x - from.x) * p,
    y: from.y + (to.y - from.y) * p,
    width: from.width + (to.width - from.width) * p,
    height: from.height + (to.height - from.height) * p,
  };
}

function measureHeading(
  heading: HTMLElement | null,
  frame: SceneRect,
  content: SceneRect,
): OverviewHeadingMetrics | null {
  if (!heading) return null;
  const rect = heading.getBoundingClientRect();
  const ink: DOMRect[] = [...heading.querySelectorAll("svg, img")].map((node) => node.getBoundingClientRect());
  const text = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    ink.push(...range.getClientRects());
  }
  const visible = ink.filter((rect) => rect.width > 0 && rect.height > 0);
  if (!visible.length) return null;
  return {
    rect: { x: rect.x - frame.x, y: rect.y - frame.y, width: rect.width, height: rect.height },
    inkTop: Math.min(...visible.map((box) => box.top)) - rect.y,
    inkBottom: Math.max(...visible.map((box) => box.bottom)) - rect.y,
    bandHeight: content.y - frame.y,
    frameWidth: frame.width,
  };
}

/** One cancellable presentation transaction. Navigation and resource ownership stay
 * with their existing owners. A native top-layer frame moves without reparenting
 * React/iframe/canvas DOM; unsupported platforms settle directly. */
export function useOverviewSceneMotion({
  root,
  origin,
  destination,
  onDismiss,
  registerDismiss,
  chromeOpacity,
  prepareDismiss,
  finishScene,
}: {
  root: RefObject<HTMLDivElement | null>;
  origin?: OverviewOrigin | null;
  destination(key: string): SceneRect | null;
  onDismiss(): void;
  chromeOpacity?: MotionValue<number>;
  finishScene?(commit: () => void, playback: { stop(): void }): void;
  prepareDismiss?(signal: AbortSignal): SceneTransition | null;
  registerDismiss?(dismiss: () => void): () => void;
}) {
  const reduced = useReducedMotion();
  const running = useRef<SceneFlight | null>(null);
  const retiring = useRef(new Map<string, SceneFlight>());
  const sharedOpacity = useRef(1);
  const latest = useRef({ origin, destination, onDismiss, reduced, prepareDismiss });
  latest.current = { origin, destination, onDismiss, reduced, prepareDismiss };
  const start = (
    key: string | null,
    entering: boolean,
    complete: () => void,
    prepare?: (signal: AbortSignal) => SceneTransition | null,
    rollback?: () => void,
  ) => {
    const layout = root.current;
    const preview = [...(layout?.querySelectorAll<HTMLElement>("[data-overview-view]") ?? [])].find(
      (node) => node.dataset.overviewView === key,
    );
    const frame = preview?.closest<HTMLElement>(".panel-overview-card");
    // Old geometry returns while the latest target prepares and expands. Only
    // the foreground transaction writes backdrop and chrome.
    const old = running.current;
    const sharedStart = old ? sharedOpacity.current : 1;
    if (old && old.key !== key && old.retire) {
      old.retire();
      running.current = null;
    }
    const returningFlight = key ? retiring.current.get(key) : undefined;
    if (returningFlight) {
      retiring.current.delete(key!);
      running.current = returningFlight;
    }
    // Stop the previous writer before reading the current physical start.
    running.current?.stop();
    const inheritedProgress = running.current?.key === key ? running.current.progress : undefined;
    const inheritedVelocity = running.current?.velocity?.() ?? inheritedProgress?.getVelocity() ?? 0;
    const inheritedPicture = running.current?.snapshot?.();
    const initialChrome = chromeOpacity?.get() ?? 1;

    const previous = running.current;
    previous?.cancel();
    previous?.rollback?.();
    let lease: SceneTransition | null = null;
    const commit = (handoff: () => void) => (lease ? lease.commit(handoff) : (handoff(), true));
    const settle = () => {
      const abort = new AbortController();
      const transaction = {
        stop() {},
        cancel() {
          abort.abort();
          if (running.current === transaction) running.current = null;
        },
        finish() {},
        rollback,
        key,
      };
      running.current = transaction;
      const finish = () => {
        if (abort.signal.aborted || running.current !== transaction) return;
        if (
          !commit(() => {
            running.current = null;
            chromeOpacity?.set(entering ? 0 : 1);
            complete();
            abort.abort();
          })
        )
          transaction.cancel();
      };
      lease = prepare?.(abort.signal) ?? null;
      if (lease)
        void lease.ready.then(
          () => flushSync(finish),
          () => {
            if (abort.signal.aborted) return;
            transaction.cancel();
            rollback?.();
            chromeOpacity?.set(0);
          },
        );
      else finish();
    };
    if (!layout || !frame || !preview || latest.current.reduced || !canFloatRetainedView(frame)) {
      settle();
      return;
    }
    let card: SceneRect = frame.getBoundingClientRect();
    let cardClip = measurePreviewClip(frame);
    let previewBounds: SceneRect = preview.getBoundingClientRect();
    const heading = frame.querySelector<HTMLElement>(".panel-overview-card__heading");
    let headingMetrics = measureHeading(heading, card, previewBounds);
    const previewStyle = preview.getAttribute("style");
    const headingStyle = heading?.getAttribute("style");
    const initialScene = entering ? latest.current.origin?.rect : key ? latest.current.destination(key) : null;
    const scrollport = layout.querySelector<HTMLElement>(".panel-overview__scroll");
    let cardAperture: SceneRect = measurePreviewClip(scrollport ?? layout);
    const scroll = scrollport?.getBoundingClientRect();
    if (
      !validSceneRect(card) ||
      !validSceneRect(initialScene) ||
      (scroll && (card.y + card.height <= scroll.top || card.y >= scroll.bottom))
    ) {
      settle();
      return;
    }
    let scene: SceneRect = initialScene;
    const savedStyle = frame.getAttribute("style");
    const surface = layout.closest<HTMLElement>(".panel-mobile-sheet--tabs");
    const scrim =
      surface?.previousElementSibling instanceof HTMLElement &&
      surface.previousElementSibling.classList.contains("modal-surface__scrim")
        ? surface.previousElementSibling
        : null;
    const surfaceComposition = surface ? leasePreviewComposition(surface, "--overview-surface-opacity") : undefined;
    const savedScrimOpacity = scrim?.style.opacity ?? "";
    const framePaint = getComputedStyle(frame);
    // Preserve the theme's shadow list; only its optical contribution morphs.
    const decoration = frame.querySelector<HTMLElement>(".retained-preview-decoration");
    const cardShadow = decoration ? getComputedStyle(decoration).boxShadow : framePaint.boxShadow;
    const shadow = mix(cardShadow.replace(/(?:rgba?|color)\([^)]*\)/g, "rgba(0, 0, 0, 0)"), cardShadow);
    let radius = Number.parseFloat(framePaint.borderTopLeftRadius) || 0;
    let contentRadius = Number.parseFloat(getComputedStyle(preview).borderTopLeftRadius) || 0;
    let contentBottomRadius = Number.parseFloat(getComputedStyle(preview).borderBottomLeftRadius) || 0;
    // A wrapper can exist while a cold source has no drawable allocation.
    const raster = !preview.querySelector('.retained-view-preview[data-retained-preview-state="borrowed"]');
    const siblings = [...layout.children]
      .filter((node) => !node.contains(frame))
      .concat([...layout.querySelectorAll(".panel-overview-card")])
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== frame);
    const opacity = siblings.map((node) => [node, leasePreviewComposition(node)] as const);
    let live = true,
      prepared = !prepare,
      handedBack = false,
      returning = false;
    let reflowFrame: number | undefined;
    const abort = new AbortController();
    let stop: (() => void) | undefined;
    let playbackVelocity = () => inheritedVelocity;
    let lowerFrame: (() => void) | undefined;
    let slotObserver: ResizeObserver | undefined;
    let stopLeaseListener: (() => void) | undefined;
    const restoreShared = () => {
      for (const [, composition] of opacity) composition.release();
      surfaceComposition?.release();
      if (scrim) scrim.style.opacity = savedScrimOpacity;
    };
    const clean = (keepDriver = false) => {
      if (!live) return;
      live = false;
      stopLeaseListener?.();
      if (!keepDriver) stop?.();
      abort.abort();
      if (reflowFrame !== undefined) cancelAnimationFrame(reflowFrame);
      slotObserver?.disconnect();
      window.removeEventListener("resize", rebaseFromEvent);
      window.visualViewport?.removeEventListener("resize", rebaseFromEvent);
      window.visualViewport?.removeEventListener("scroll", rebaseFromEvent);
      scrollport?.removeEventListener("scroll", rebaseFromEvent);
      preview.dispatchEvent(new CustomEvent("overview-preview-lock", { detail: false }));
      setPreviewFlightProjection(frame, null);
      setPreviewFlightClip(frame, null);
      setPreviewFlightClip(preview, null);
      if (previewStyle === null) preview.removeAttribute("style");
      else preview.setAttribute("style", previewStyle);
      if (heading) {
        if (headingStyle == null) heading.removeAttribute("style");
        else heading.setAttribute("style", headingStyle);
      }
      lowerFrame?.();
      frame.removeAttribute("data-overview-flight");
      if (savedStyle === null) frame.removeAttribute("style");
      else frame.setAttribute("style", savedStyle);
      if (!returning) {
        restoreShared();
        delete layout.dataset.overviewPhase;
      }
      if (key && retiring.current.get(key) === transaction) retiring.current.delete(key);
      // During handback the entire overview is about to unmount in this commit.
      // Do not remeasure/re-raise a thumbnail immediately before releasing it.
      if (!handedBack) refreshRetainedPreviewLayout(frame);
      if (running.current === transaction) running.current = null;
      else running.current?.paintShared?.();
    };
    const finish = () => {
      if (!live) return;
      if (!prepared) return;
      if (
        !commit(() => {
          chromeOpacity?.set(entering ? 0 : 1);
          clean();
          complete();
        })
      )
        clean();
    };
    // Remeasure the flow slot, not the lifted card. Keep the currently painted
    // rectangle as a correction that decays towards the new endpoint.
    let correction:
      | {
          at: number;
          frame: SceneRect;
          content: SceneRect;
          clip: SceneRect;
          heading?: SceneRect;
          headingOpacity?: number;
        }
      | undefined;
    let painted: PaintedScene | undefined = inheritedPicture;
    const anchor = () => {
      if (!painted) return;
      const g = overviewGeometry(transaction.cardness);
      const delta = (a: SceneRect, b: SceneRect): SceneRect => ({
        x: a.x - b.x,
        y: a.y - b.y,
        width: a.width - b.width,
        height: a.height - b.height,
      });
      correction = {
        at: g,
        frame: delta(painted.frame, interpolateSceneRect(scene, card, g)),
        content: delta(painted.content, interpolateSceneRect(scene, previewBounds, g)),
        clip: delta(painted.clip, interpolateSceneRect(scene, cardClip, g)),
      };
      if (painted.heading && headingMetrics) {
        // Frame/content corrections already preserve their painted positions.
        // Anchor only the remaining change in measured title metrics.
        const next = projectOverviewHeading(painted.frame, painted.content, headingMetrics, g);
        correction.heading = delta(painted.heading.rect, next.rect);
        correction.headingOpacity = painted.heading.opacity - next.opacity;
      }
    };
    const rebaseFromEvent = () => {
      if (reflowFrame !== undefined) return;
      reflowFrame = requestAnimationFrame(() => {
        reflowFrame = undefined;
        if (!live) return;
        const slot = frame.previousElementSibling;
        const nextCard =
          slot instanceof HTMLElement && slot.hasAttribute("data-overview-flight-slot")
            ? slot.getBoundingClientRect()
            : null;
        const nextScene = key ? latest.current.destination(key) : null;
        if (!validSceneRect(nextCard) || !validSceneRect(nextScene)) return;
        card = nextCard;
        scene = nextScene;
        cardClip = measurePreviewClip(slot as HTMLElement);
        cardAperture = measurePreviewClip(scrollport ?? layout);
        const headingSlot = slot!.querySelector<HTMLElement>("[data-flight-heading-slot]");
        const contentSlot = slot!.querySelector<HTMLElement>("[data-flight-content-slot]");
        if (contentSlot) previewBounds = contentSlot.getBoundingClientRect();
        headingMetrics = measureHeading(headingSlot, card, previewBounds);
        radius = Number.parseFloat(getComputedStyle(slot as HTMLElement).borderTopLeftRadius) || 0;
        if (contentSlot) {
          contentRadius = Number.parseFloat(getComputedStyle(contentSlot).borderTopLeftRadius) || 0;
          contentBottomRadius = Number.parseFloat(getComputedStyle(contentSlot).borderBottomLeftRadius) || 0;
        }
        anchor();
        paint(transaction.cardness);
      });
    };
    const progress = inheritedProgress ?? motionValue(entering ? 0 : 1);
    const handback = raster ? 0.015 : 0.06;
    const transaction: SceneFlight & { cardness: number } = {
      progress,
      velocity: () => playbackVelocity(),
      snapshot: () => painted,
      paintShared: () => paintShared(),
      retire() {
        if (returning) return;
        stop?.();
        const velocity = playbackVelocity();
        returning = true;
        anchor();
        stopLeaseListener?.();
        abort.abort();
        rollback?.();
        restoreShared();
        if (key) retiring.current.set(key, transaction);
        const playback = animate(progress, 1, {
          ...PANEL_CONTINUOUS_SPRING_TRANSITION,
          velocity,
          onUpdate: paint,
          onComplete: () => flushSync(() => clean()),
        });
        stop = () => playback.stop();
        playbackVelocity = () => playback.velocity;
      },
      stop: () => stop?.(),
      cancel: clean,
      finish,
      rollback,
      key,
      cardness: Math.max(0, Math.min(1, progress.get())),
    };
    const sharedInitialGeometry = overviewGeometry(transaction.cardness);
    const paintShared = () => {
      if (returning || !live) return;
      const geometry = overviewGeometry(transaction.cardness);
      const alpha = Math.max(
        0,
        Math.min(
          1,
          entering
            ? inheritedPicture
              ? sharedStart +
                ((1 - sharedStart) * (geometry - sharedInitialGeometry)) / Math.max(0.001, 1 - sharedInitialGeometry)
              : geometry
            : (sharedStart * geometry) / Math.max(0.001, sharedInitialGeometry),
        ),
      );
      sharedOpacity.current = alpha;
      for (const [node, composition] of opacity) if (!node.hasAttribute("data-overview-flight")) composition.set(alpha);
      surfaceComposition?.set(alpha);
      if (scrim) scrim.style.opacity = String(alpha);
    };
    running.current = transaction;
    const paint = (value: number) => {
      // Geometry, clipping and compositing must use the same bounded progress.
      const cardness = Math.max(0, Math.min(1, value));
      transaction.cardness = cardness;
      const geometry = overviewGeometry(cardness);
      // A final allocation change can arrive after readiness but before its
      // ResizeObserver callback. Validate the same home synchronously before
      // painting/committing the endpoint; handback cannot resize the source.
      if (!entering && !returning && !handedBack && live && prepared && cardness <= handback && key) {
        prepareRetainedPreviewLayout(frame);
        const endpoint = latest.current.destination(key);
        if (!validSceneRect(endpoint)) {
          clean();
          rollback?.();
          chromeOpacity?.set(0);
          return;
        }
        scene = endpoint;
      }
      if (handedBack) {
        chromeOpacity?.set(1 - Math.min(1, cardness / handback));
        return;
      }
      if (!live) return;
      if (!frame.isConnected) {
        clean();
        rollback?.();
        chromeOpacity?.set(0);
        return;
      }
      // Fade outgoing controls before overview controls acquire visible space.
      // Incoming controls belong to the final handback phase, after this cover.
      if (!returning) chromeOpacity?.set(entering ? initialChrome * (1 - Math.min(1, cardness / 0.06)) : 0);
      const towardsCard = entering || returning;
      const correctionAmount = !correction
        ? 0
        : towardsCard
          ? (1 - geometry) / Math.max(0.001, 1 - correction.at)
          : geometry / Math.max(0.001, correction.at);
      const corrected = (rect: SceneRect, delta?: SceneRect) =>
        !delta
          ? rect
          : {
              x: rect.x + delta.x * correctionAmount,
              y: rect.y + delta.y * correctionAmount,
              width: rect.width + delta.width * correctionAmount,
              height: rect.height + delta.height * correctionAmount,
            };
      const rect = corrected(interpolateSceneRect(scene, card, geometry), correction?.frame);
      // Border paint follows geometry without changing the native content's
      // containing block. Fractional CSS borders snap to device pixels and
      // cannot be used as a continuous layout inset.
      frame.style.setProperty("--overview-frame-border-opacity", String(geometry));
      frame.style.setProperty("--overview-frame-shadow", shadow(geometry));
      Object.assign(frame.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        borderRadius: `${radius * geometry}px`,
      });
      const clip = corrected(interpolateSceneRect(scene, cardClip, geometry), correction?.clip);
      setPreviewFlightClip(
        frame,
        { ...clip, radius: radius * geometry },
        rect,
        interpolateSceneRect(scene, cardAperture, geometry),
      );
      const contentRect = corrected(interpolateSceneRect(scene, previewBounds, geometry), correction?.content);
      painted = { frame: rect, content: contentRect, clip };
      Object.assign(preview.style, {
        position: "absolute",
        margin: "0",
        minHeight: "0",
        left: `${contentRect.x - rect.x}px`,
        top: `${contentRect.y - rect.y}px`,
        width: `${contentRect.width}px`,
        height: `${contentRect.height}px`,
        borderRadius: `${contentRadius * geometry}px ${contentRadius * geometry}px ${contentBottomRadius * geometry}px ${contentBottomRadius * geometry}px`,
      });
      const content = contentRect;
      const left = Math.max(content.x, clip.x),
        top = Math.max(content.y, clip.y);
      const contentClip = {
        x: left,
        y: top,
        width: Math.max(0, Math.min(content.x + content.width, clip.x + clip.width) - left),
        height: Math.max(0, Math.min(content.y + content.height, clip.y + clip.height) - top),
        radius: contentRadius * geometry,
        bottomRadius: contentBottomRadius * geometry,
      };
      setPreviewFlightClip(preview, contentClip, contentRect);
      if (heading && headingMetrics) {
        const title = projectOverviewHeading(rect, contentRect, headingMetrics, geometry);
        title.rect = corrected(title.rect, correction?.heading);
        title.opacity = Math.max(0, Math.min(1, title.opacity + (correction?.headingOpacity ?? 0) * correctionAmount));
        painted.heading = title;
        Object.assign(heading.style, {
          position: "absolute",
          left: `${title.rect.x - rect.x}px`,
          top: `${title.rect.y - rect.y}px`,
          width: `${title.rect.width}px`,
          height: `${title.rect.height}px`,
          minHeight: "0",
          boxSizing: "border-box",
          opacity: String(title.opacity),
          transform: "none",
          clipPath: "none",
        });
      }
      paintShared();
      // A frozen raster is a transition cover, not the live destination. Dissolve
      // near the scene endpoint, after prepare acknowledged a drawable surface.
      frame.style.opacity = String(
        returning
          ? sharedOpacity.current
          : raster
            ? Math.min(1, Math.max(0, (cardness - handback) / (0.06 - handback)))
            : 1,
      );
      setPreviewFlightProjection(frame, {
        content: contentRect,
        clip: contentClip,
        opacity: Number(frame.style.opacity),
        frame: rect,
        radius: radius * geometry,
        shadow: shadow(geometry),
      });
      refreshRetainedPreviewLayout(frame);
      if (!entering && !returning && prepared && cardness <= handback && finishScene) {
        flushSync(() => {
          const accepted = commit(() => {
            handedBack = true;
            for (const flight of [...retiring.current.values()]) flight.cancel();
            finishScene(
              () => {
                clean(true);
                complete();
              },
              { stop: () => stop?.() },
            );
          });
          if (accepted) chromeOpacity?.set(1 - Math.min(1, cardness / handback));
          else clean();
        });
      }
      // The spring's numerical tail can outlive visible motion by hundreds of
      // milliseconds. Restore the real card's hit testing once every painted
      // edge is within half a device pixel and compositing within one alpha step.
      // Navigation readiness still owns destination handback.
      if (
        (entering || returning) &&
        geometry >= 1 - 1 / 255 &&
        (!entering || Math.abs(1 - sharedOpacity.current) <= 1 / 255)
      ) {
        const tolerance = 0.5 / Math.max(1, window.devicePixelRatio);
        const distance = (a: SceneRect, b: SceneRect) =>
          Math.max(
            Math.abs(a.x - b.x),
            Math.abs(a.y - b.y),
            Math.abs(a.x + a.width - b.x - b.width),
            Math.abs(a.y + a.height - b.y - b.height),
          );
        const targetHeading = headingMetrics ? projectOverviewHeading(card, previewBounds, headingMetrics, 1) : null;
        if (
          Math.max(
            distance(rect, card),
            distance(contentRect, previewBounds),
            distance(clip, cardClip),
            radius * (1 - geometry),
            targetHeading && painted.heading ? distance(painted.heading.rect, targetHeading.rect) : 0,
          ) <= tolerance &&
          (!targetHeading || !painted.heading || Math.abs(painted.heading.opacity - targetHeading.opacity) <= 1 / 255)
        ) {
          flushSync(returning ? () => clean() : finish);
        }
      }
    };
    frame.setAttribute("data-overview-flight", "");
    layout.dataset.overviewPhase = prepare ? "preparing" : entering ? "entering" : "exiting";
    lowerFrame = liftPreviewFrame(frame);
    if (!lowerFrame) {
      clean();
      settle();
      return;
    }
    if (frame.previousElementSibling) {
      slotObserver = new ResizeObserver(rebaseFromEvent);
      slotObserver.observe(frame.previousElementSibling);
      const headingSlot = frame.previousElementSibling.querySelector("[data-flight-heading-slot]");
      if (headingSlot) slotObserver.observe(headingSlot);
    }
    preview.dispatchEvent(new CustomEvent("overview-preview-lock", { detail: true }));
    anchor();
    paint(transaction.cardness);
    if (!live) return;
    // Bounds changing mid-flight invalidates the geometry, never the navigation.
    window.addEventListener("resize", rebaseFromEvent);
    window.visualViewport?.addEventListener("resize", rebaseFromEvent);
    window.visualViewport?.addEventListener("scroll", rebaseFromEvent);
    scrollport?.addEventListener("scroll", rebaseFromEvent);
    const play = () => {
      if (!live || abort.signal.aborted || running.current !== transaction) return;
      // Preparation can change the Shell allocation without resizing the card
      // slot (parked tools, split/fullscreen changes). Animate to the prepared
      // destination, never the pre-transaction rectangle. This contract is the
      // same for retained views and raster covers.
      if (!entering && key) {
        const endpoint = latest.current.destination(key);
        if (!validSceneRect(endpoint)) {
          clean();
          rollback?.();
          chromeOpacity?.set(0);
          return;
        }
        scene = endpoint;
        anchor();
      }
      prepared = true;
      if (latest.current.reduced) {
        flushSync(finish);
        return;
      }
      layout.dataset.overviewPhase = entering ? "entering" : "exiting";
      paint(transaction.cardness);
      if (!live && !handedBack) return;
      // Both directions start at their first presentation frame, not during
      // React allocation. The shared clock carries the same physical spring.
      const playback = animate(progress, entering ? 1 : 0, {
        ...PANEL_CONTINUOUS_SPRING_TRANSITION,
        velocity: inheritedVelocity,
        onUpdate: paint,
        onComplete: () => {
          if (handedBack) chromeOpacity?.set(1);
          else flushSync(finish);
        },
      });
      stop = () => playback.stop();
      playbackVelocity = () => playback.velocity;
    };
    lease = prepare?.(abort.signal) ?? null;
    if (lease) {
      const abandoned = () => {
        if (!live) return;
        clean();
        rollback?.();
        chromeOpacity?.set(0);
      };
      const signal = lease.signal;
      const stopLayout = lease.subscribeLayout(rebaseFromEvent);
      signal.addEventListener("abort", abandoned, { once: true });
      stopLeaseListener = () => {
        stopLayout();
        signal.removeEventListener("abort", abandoned);
      };
      if (signal.aborted) abandoned();
      else void lease.ready.then(play, abandoned);
    } else play();
  };
  const startRef = useRef(start);
  startRef.current = start;
  useLayoutEffect(() => {
    if (origin) startRef.current(origin.key, true, () => {});
    return () => {
      running.current?.cancel();
      for (const flight of [...retiring.current.values()]) flight.cancel();
    };
  }, []);
  useLayoutEffect(
    () =>
      registerDismiss?.(() =>
        startRef.current(
          latest.current.origin?.key ?? null,
          false,
          latest.current.onDismiss,
          latest.current.prepareDismiss,
        ),
      ),
    [registerDismiss],
  );
  useLayoutEffect(() => {
    if (!reduced) return;
    // Retiring flights no longer own navigation. End all of them immediately;
    // the active flight still waits for its destination readiness before commit.
    for (const flight of [...retiring.current.values()]) flight.cancel();
    running.current?.finish();
  }, [reduced]);
  return {
    cancel() {
      for (const flight of [...retiring.current.values()]) flight.cancel();
      const previous = running.current;
      previous?.cancel();
      previous?.rollback?.();
      chromeOpacity?.set(0);
    },
    select(
      key: string,
      navigate: () => void,
      prepare?: (signal: AbortSignal) => SceneTransition | null,
      rollback?: () => void,
    ) {
      startRef.current(key, false, navigate, prepare, rollback);
    },
    dismiss() {
      startRef.current(
        latest.current.origin?.key ?? null,
        false,
        latest.current.onDismiss,
        latest.current.prepareDismiss,
      );
    },
  };
}

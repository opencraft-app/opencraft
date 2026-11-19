import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { PagedMotionPlane, usePagedMotion } from "@opencraft/design-system-web/paged-motion";
import { transformImage, wheelPixels } from "./image-transform";
import imageStyles from "./zoomable-image.scss?inline";

import type { ImagePreviewNavigation, ZoomableImageProps } from "./zoomable-image";

type TrackpadGestureEvent = Event & { scale: number; rotation: number; clientX: number; clientY: number };
interface TrackpadRotationPort {
  onTrackpadRotate?: (listener: (degrees: number) => void) => () => void;
}

type Point = { x: number; y: number };
type Transform = Point & { scale: number; rotation: number };
const fitted: Transform = { x: 0, y: 0, scale: 1, rotation: 0 };

/** Transient image manipulation; the surrounding preview retains navigation and focus. */
export const ZoomableImageView = forwardRef<ImagePreviewNavigation, ZoomableImageProps>(function ZoomableImage(
  { previousImage, nextImage, imageKey, ...props },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const viewKey = JSON.stringify([imageKey, props.src]);
  const pages = usePagedMotion(root, viewKey);
  const previous = () => {
    if (props.onPreviousImage) pages.settle(1, props.onPreviousImage);
  };
  const next = () => {
    if (props.onNextImage) pages.settle(-1, props.onNextImage);
  };
  useImperativeHandle(ref, () => ({ previous, next }));
  return (
    <div className="opencraft-zoomable-image" ref={root}>
      <style data-opencraft-zoomable-image-styles>{imageStyles}</style>
      <ImageViewport
        key={viewKey}
        {...props}
        frame={root}
        onPreviousImage={props.onPreviousImage ? previous : undefined}
        onNextImage={props.onNextImage ? next : undefined}
        onSwipeStart={pages.beginDrag}
        onSwipeOffset={pages.drag}
        onSwipeCancel={() => pages.settle(0)}
        onSwipeReset={pages.reset}
        renderImage={(image) => (
          <>
            {previousImage ? (
              <PagedMotionPlane page="previous" className="opencraft-gallery-plane" offset={pages.previous}>
                {previousImage}
              </PagedMotionPlane>
            ) : null}
            <PagedMotionPlane
              ref={pages.currentPlane}
              page="current"
              className="opencraft-gallery-plane"
              offset={pages.current}
            >
              {image}
            </PagedMotionPlane>
            {nextImage ? (
              <PagedMotionPlane page="next" className="opencraft-gallery-plane" offset={pages.next}>
                {nextImage}
              </PagedMotionPlane>
            ) : null}
          </>
        )}
      />
    </div>
  );
});

function ImageViewport({
  fitToContainer = false,
  onBackgroundClick,
  onPreviousImage,
  onNextImage,
  frame,
  renderImage,
  onSwipeStart,
  onSwipeOffset,
  onSwipeCancel,
  onSwipeReset,
  ...props
}: Omit<ZoomableImageProps, "imageKey" | "previousImage" | "nextImage"> & {
  frame: RefObject<HTMLDivElement | null>;
  renderImage(image: ReactNode): ReactNode;
  onSwipeStart(): number;
  onSwipeOffset(offset: number): void;
  onSwipeCancel(): void;
  onSwipeReset(): void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const current = useRef(fitted);
  const tap = useRef<(Point & { time: number; background: boolean }) | null>(null);
  const lastTap = useRef<(Point & { time: number }) | null>(null);
  const snappedRotation = useRef<number | null>(null);
  const backgroundPress = useRef<Point | null>(null);
  const gesture = useRef<{
    center: Point;
    distance: number;
    angle: number;
    rotationDelta: number;
    transform: Transform;
  } | null>(null);
  const trackpad = useRef<{ center: Point; scale: number; rotation: number; transform: Transform } | null>(null);
  const [transform, setTransform] = useState(fitted);
  const [viewportHeight, setViewportHeight] = useState(0);
  const swipe = useRef<{ id: number; x: number; y: number; offset: number; horizontal: boolean } | null>(null);

  const measure = () => {
    const points = [...pointers.current.values()].slice(0, 2);
    const first = points[0];
    if (!first) return null;
    const second = points[1];
    const box = frame.current!.getBoundingClientRect();
    return {
      center: {
        x: (first.x + (second?.x ?? first.x)) / 2 - box.left - box.width / 2,
        y: (first.y + (second?.y ?? first.y)) / 2 - box.top - box.height / 2,
      },
      distance: second ? Math.hypot(second.x - first.x, second.y - first.y) : 0,
      angle: second ? Math.atan2(second.y - first.y, second.x - first.x) : 0,
    };
  };
  const rebase = () => {
    const measured = measure();
    gesture.current = measured ? { ...measured, rotationDelta: 0, transform: current.current } : null;
  };
  const apply = (start: Transform, from: Point, to: Point, scale: number, delta: number) => {
    const element = viewport.current,
      content = image.current;
    if (!element || !content) return;
    current.current = transformImage(start, from, to, scale, delta, {
      width: content.offsetWidth,
      height: content.offsetHeight,
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
    });
    setTransform(current.current);
  };
  const constrain = (next: Transform): Transform => {
    if (!image.current || !viewport.current) return next;
    const cosine = Math.abs(Math.cos(next.rotation)),
      sine = Math.abs(Math.sin(next.rotation));
    const width = image.current.offsetWidth,
      height = image.current.offsetHeight;
    const limitX = Math.max(0, ((cosine * width + sine * height) * next.scale - viewport.current.clientWidth) / 2);
    const limitY = Math.max(0, ((sine * width + cosine * height) * next.scale - viewport.current.clientHeight) / 2);
    return { ...next, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
  };
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    let width = element.clientWidth,
      height = element.clientHeight;
    setViewportHeight(height);
    const observer = new ResizeObserver(() => {
      const changed = width !== element.clientWidth || height !== element.clientHeight;
      width = element.clientWidth;
      height = element.clientHeight;
      setViewportHeight(element.clientHeight);
      // The initial delivery is not a resize. It may arrive during the first
      // contact immediately after switching images and must not revoke it.
      if (!changed) return;
      backgroundPress.current = null;
      tap.current = lastTap.current = null;
      snappedRotation.current = null;
      pointers.current.clear();
      gesture.current = null;
      trackpad.current = null;
      swipe.current = null;
      current.current = fitted;
      setTransform(fitted);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const center = (x: number, y: number): Point => {
      const box = element.getBoundingClientRect();
      return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      backgroundPress.current = null;
      tap.current = lastTap.current = null;
      snappedRotation.current = null;
      if (trackpad.current || pointers.current.size) return;
      if (swipe.current) {
        onSwipeReset();
        swipe.current = null;
      }
      const start = current.current;
      const dx = wheelPixels(event.deltaX, event.deltaMode, element.clientWidth);
      const dy = wheelPixels(event.deltaY, event.deltaMode, element.clientHeight);
      if (event.ctrlKey || event.metaKey) {
        const anchor = center(event.clientX, event.clientY);
        apply(start, anchor, anchor, start.scale * Math.exp(Math.max(-1, Math.min(1, -dy * 0.01))), 0);
      } else apply(start, { x: 0, y: 0 }, { x: -dx, y: -dy }, start.scale, 0);
    };
    const begin = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      backgroundPress.current = null;
      tap.current = lastTap.current = null;
      snappedRotation.current = null;
      const next = event as TrackpadGestureEvent;
      if (
        pointers.current.size > 1 ||
        !Number.isFinite(next.scale) ||
        next.scale <= 0 ||
        !Number.isFinite(next.rotation)
      )
        return;
      trackpad.current = {
        center: center(next.clientX, next.clientY),
        scale: next.scale,
        rotation: next.rotation,
        transform: current.current,
      };
    };
    const change = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const start = trackpad.current,
        next = event as TrackpadGestureEvent;
      if (!start || pointers.current.size > 1) return;
      apply(
        start.transform,
        start.center,
        center(next.clientX, next.clientY),
        (start.transform.scale * next.scale) / start.scale,
        ((next.rotation - start.rotation) * Math.PI) / 180,
      );
    };
    const end = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      trackpad.current = null;
    };
    // Safari exposes cumulative gesture scale/rotation. Chromium exposes pinch
    // through ctrl-wheel; Electron forwards AppKit rotation as degree deltas.
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", begin, { passive: false });
    element.addEventListener("gesturechange", change, { passive: false });
    element.addEventListener("gestureend", end, { passive: false });
    const desktop = (globalThis as typeof globalThis & { opencraftDesktop?: TrackpadRotationPort }).opencraftDesktop;
    const unsubscribe = desktop?.onTrackpadRotate?.((degrees) => {
      if (
        !Number.isFinite(degrees) ||
        degrees === 0 ||
        !element.matches(":hover") ||
        trackpad.current ||
        pointers.current.size
      )
        return;
      backgroundPress.current = null;
      tap.current = lastTap.current = null;
      snappedRotation.current = null;
      apply(current.current, { x: 0, y: 0 }, { x: 0, y: 0 }, current.current.scale, (-degrees * Math.PI) / 180);
    });
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", begin);
      element.removeEventListener("gesturechange", change);
      element.removeEventListener("gestureend", end);
      unsubscribe?.();
      trackpad.current = null;
    };
  }, []);

  const isBackground = (event: PointerEvent<HTMLDivElement>) =>
    ![...event.currentTarget.querySelectorAll("img")].some((element) => {
      const box = element.getBoundingClientRect();
      return (
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      );
    });
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    event.stopPropagation();
    const slide = swipe.current;
    swipe.current = null;
    if (slide?.horizontal && event.type === "pointerup" && pointers.current.size === 0) {
      const distance = slide.offset + event.clientX - slide.x;
      const threshold = Math.min(80, Math.max(40, (viewport.current?.clientWidth ?? 390) * 0.18));
      const navigate = distance < 0 ? onNextImage : onPreviousImage;
      if (navigate && Math.abs(distance) >= threshold) {
        tap.current = lastTap.current = backgroundPress.current = null;
        gesture.current = null;
        navigate();
        return;
      }
    }
    if (slide) onSwipeCancel();
    const candidate = tap.current;
    tap.current = null;
    if (event.type === "pointerup" && candidate && event.timeStamp - candidate.time < 300) {
      if (candidate.background) {
        lastTap.current = null;
      } else {
        const previous = lastTap.current;
        if (
          previous &&
          event.timeStamp - previous.time < 300 &&
          Math.hypot(candidate.x - previous.x, candidate.y - previous.y) < 24
        ) {
          const box = frame.current!.getBoundingClientRect();
          const anchor = { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
          const before = current.current;
          const scale = before.scale > 1 ? 1 : 3;
          const ratio = scale / before.scale;
          current.current = constrain({
            ...before,
            scale,
            x: anchor.x - (anchor.x - before.x) * ratio,
            y: anchor.y - (anchor.y - before.y) * ratio,
          });
          setTransform(current.current);
          lastTap.current = null;
        } else lastTap.current = { x: candidate.x, y: candidate.y, time: event.timeStamp };
      }
    } else lastTap.current = null;
    rebase();
  };
  return (
    <div
      className="opencraft-image-viewport"
      ref={viewport}
      data-zoomed={transform.scale !== 1 || transform.rotation !== 0 || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (
          pointers.current.size === 1 &&
          event.pointerType !== "mouse" &&
          (onPreviousImage || onNextImage) &&
          Math.abs(current.current.scale - 1) < 0.001 &&
          Math.abs(Math.atan2(Math.sin(current.current.rotation), Math.cos(current.current.rotation))) < 0.001
        ) {
          swipe.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            offset: onSwipeStart(),
            horizontal: false,
          };
        } else {
          if (swipe.current || pointers.current.size > 1) onSwipeReset();
          swipe.current = null;
        }
        tap.current =
          pointers.current.size === 1
            ? { x: event.clientX, y: event.clientY, time: event.timeStamp, background: isBackground(event) }
            : null;
        if (pointers.current.size > 1) lastTap.current = null;
        snappedRotation.current = null;
        backgroundPress.current =
          pointers.current.size === 1 && isBackground(event) ? { x: event.clientX, y: event.clientY } : null;
        event.currentTarget.setPointerCapture(event.pointerId);
        rebase();
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        event.stopPropagation();
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (tap.current && Math.hypot(event.clientX - tap.current.x, event.clientY - tap.current.y) > 6) {
          tap.current = lastTap.current = null;
        }
        // Small finger jitter still belongs to the tap; do not pan under its anchor.
        if (tap.current) return;
        if (
          backgroundPress.current &&
          Math.hypot(event.clientX - backgroundPress.current.x, event.clientY - backgroundPress.current.y) > 6
        )
          backgroundPress.current = null;
        const slide = swipe.current;
        if (slide && slide.id === event.pointerId && pointers.current.size === 1) {
          const dx = event.clientX - slide.x,
            dy = event.clientY - slide.y;
          if (!slide.horizontal && Math.abs(dy) > Math.max(8, Math.abs(dx) * 1.35)) {
            swipe.current = null;
            onSwipeCancel();
          } else if (slide.horizontal || Math.abs(dx) > Math.max(8, Math.abs(dy) * 1.35)) {
            slide.horizontal = true;
            const available = dx < 0 ? onNextImage : onPreviousImage;
            onSwipeOffset(slide.offset + dx * (available ? 1 : 0.15));
            return;
          }
        }
        const start = gesture.current;
        const next = measure();
        if (!start || !next || !image.current || !viewport.current) return;
        const scale = Math.min(
          5,
          Math.max(
            0.2,
            start.distance > 0 ? (start.transform.scale * next.distance) / start.distance : start.transform.scale,
          ),
        );
        const ratio = scale / start.transform.scale;
        if (start.distance > 0) {
          const step = next.angle - start.angle;
          start.rotationDelta += Math.atan2(Math.sin(step), Math.cos(step));
          start.angle = next.angle;
        }
        const rawRotation = start.transform.rotation + start.rotationDelta;
        const nearest = Math.round(rawRotation / (Math.PI / 2)) * (Math.PI / 2);
        // A wider release threshold keeps the image steady near an upright angle.
        const held = snappedRotation.current;
        const rotation =
          start.distance === 0
            ? start.transform.rotation
            : held !== null && Math.abs(rawRotation - held) <= (Math.PI * 8) / 180
              ? held
              : Math.abs(rawRotation - nearest) <= (Math.PI * 5) / 180
                ? nearest
                : rawRotation;
        snappedRotation.current = rotation === nearest ? nearest : null;
        const anchorX = start.center.x - start.transform.x,
          anchorY = start.center.y - start.transform.y;
        const appliedDelta = rotation - start.transform.rotation;
        const c = Math.cos(appliedDelta),
          s = Math.sin(appliedDelta);
        current.current = constrain({
          scale,
          rotation,
          x: next.center.x - (c * anchorX - s * anchorY) * ratio,
          y: next.center.y - (s * anchorX + c * anchorY) * ratio,
        });
        setTransform(current.current);
      }}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        backgroundPress.current = null;
        finish(event);
      }}
      onLostPointerCapture={finish}
      onClick={() => {
        if (backgroundPress.current) onBackgroundClick?.();
        backgroundPress.current = null;
      }}
    >
      {renderImage(
        <img
          {...props}
          draggable={false}
          ref={image}
          style={{
            maxHeight: fitToContainer && viewportHeight > 0 ? viewportHeight : undefined,
            transform: `translate(${transform.x}px, ${transform.y}px) rotate(${transform.rotation}rad) scale(${transform.scale})`,
          }}
        />,
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ImgHTMLAttributes, type PointerEvent } from "react";
import "./zoomable-image.scss";

type Point = { x: number; y: number };
type Transform = Point & { scale: number; rotation: number };
type ImageProps = Pick<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "title" | "onError" | "onLoad"> & {
  readonly fitToContainer?: boolean;
  readonly onBackgroundClick?: () => void;
};
const fitted: Transform = { x: 0, y: 0, scale: 1, rotation: 0 };

/** Transient image manipulation; the surrounding preview retains navigation and focus. */
export function ZoomableImage(props: ImageProps) {
  return <ImageViewport key={props.src} {...props} />;
}

function ImageViewport({ fitToContainer = false, onBackgroundClick, ...props }: ImageProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const current = useRef(fitted);
  const backgroundPress = useRef<Point | null>(null);
  const gesture = useRef<{ center: Point; distance: number; angle: number; transform: Transform } | null>(null);
  const [transform, setTransform] = useState(fitted);
  const [viewportHeight, setViewportHeight] = useState(0);

  const measure = () => {
    const points = [...pointers.current.values()].slice(0, 2);
    const first = points[0];
    if (!first) return null;
    const second = points[1];
    const box = viewport.current!.getBoundingClientRect();
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
    gesture.current = measured ? { ...measured, transform: current.current } : null;
  };
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight);
      backgroundPress.current = null;
      pointers.current.clear();
      gesture.current = null;
      current.current = fitted;
      setTransform(fitted);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    event.stopPropagation();
    rebase();
  };
  return <div className="opencraft-zoomable-image" ref={viewport} data-zoomed={transform.scale !== 1 || transform.rotation !== 0 || undefined}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      backgroundPress.current = pointers.current.size === 1 && event.target === event.currentTarget
        ? { x: event.clientX, y: event.clientY } : null;
      event.currentTarget.setPointerCapture(event.pointerId);
      rebase();
    }}
    onPointerMove={event => {
      if (!pointers.current.has(event.pointerId)) return;
      event.stopPropagation();
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (backgroundPress.current && Math.hypot(event.clientX - backgroundPress.current.x, event.clientY - backgroundPress.current.y) > 6) backgroundPress.current = null;
      const start = gesture.current;
      const next = measure();
      if (!start || !next || !image.current || !viewport.current) return;
      const scale = Math.min(5, Math.max(0.2, start.distance > 0
        ? start.transform.scale * next.distance / start.distance : start.transform.scale));
      const ratio = scale / start.transform.scale;
      const angle = start.distance > 0 ? next.angle - start.angle : 0;
      const delta = Math.atan2(Math.sin(angle), Math.cos(angle));
      const rotation = start.transform.rotation + delta;
      const cosine = Math.cos(rotation), sine = Math.sin(rotation);
      const width = image.current.offsetWidth, height = image.current.offsetHeight;
      const limitX = Math.max(0, ((Math.abs(cosine) * width + Math.abs(sine) * height) * scale - viewport.current.clientWidth) / 2);
      const limitY = Math.max(0, ((Math.abs(sine) * width + Math.abs(cosine) * height) * scale - viewport.current.clientHeight) / 2);
      const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
      const anchorX = start.center.x - start.transform.x, anchorY = start.center.y - start.transform.y;
      const c = Math.cos(delta), s = Math.sin(delta);
      current.current = {
        scale, rotation,
        x: clamp(next.center.x - (c * anchorX - s * anchorY) * ratio, limitX),
        y: clamp(next.center.y - (s * anchorX + c * anchorY) * ratio, limitY),
      };
      setTransform(current.current);
    }}
    onPointerUp={finish} onPointerCancel={event => { backgroundPress.current = null; finish(event); }} onLostPointerCapture={finish}
    onClick={() => { if (backgroundPress.current) onBackgroundClick?.(); backgroundPress.current = null; }}>
    <img {...props} draggable={false} ref={image}
      style={{
        maxHeight: fitToContainer && viewportHeight > 0 ? viewportHeight : undefined,
        transform: `translate(${transform.x}px, ${transform.y}px) rotate(${transform.rotation}rad) scale(${transform.scale})`,
      }} />
  </div>;
}

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export type ComposerFooterDensity = "full" | "compact" | "tight" | "minimal";

export interface ComposerFooterMeasurements {
  readonly availableWidth: number;
  readonly fixedWidth: number;
  readonly hostWidth: number;
  readonly intelligenceWidth: number;
  readonly permissionWidth: number;
}

/**
 * Resolves progressive disclosure from measured control widths. This is kept
 * pure so Web tests can exercise the same thresholds without a browser.
 */
export function resolveComposerFooterDensity({
  availableWidth,
  fixedWidth,
  hostWidth,
  intelligenceWidth,
  permissionWidth,
}: ComposerFooterMeasurements): ComposerFooterDensity {
  const gaps = 14;
  if (
    availableWidth >=
    fixedWidth + hostWidth + intelligenceWidth + permissionWidth + gaps
  ) {
    return "full";
  }
  if (
    availableWidth >=
    fixedWidth + intelligenceWidth + Math.min(permissionWidth, 34) + gaps
  ) {
    return "compact";
  }
  if (
    availableWidth >=
    fixedWidth +
      Math.min(intelligenceWidth, 118) +
      Math.min(permissionWidth, 34) +
      gaps
  ) {
    return "tight";
  }
  return "minimal";
}

export interface MeasuredComposerFooterLayout {
  readonly density: ComposerFooterDensity;
  readonly footerRef: RefObject<HTMLDivElement | null>;
  readonly attachmentRef: RefObject<HTMLDivElement | null>;
  readonly controlsRef: RefObject<HTMLDivElement | null>;
  readonly endRef: RefObject<HTMLDivElement | null>;
}

export function useMeasuredComposerFooterLayout(): MeasuredComposerFooterLayout {
  const footerRef = useRef<HTMLDivElement>(null);
  const attachmentRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const intrinsic = useRef({ host: 0, intelligence: 0, permission: 0 });
  const [density, setDensity] = useState<ComposerFooterDensity>("full");

  useLayoutEffect(() => {
    const footer = footerRef.current;
    const attachment = attachmentRef.current;
    const controls = controlsRef.current;
    const end = endRef.current;
    if (
      footer === null ||
      attachment === null ||
      controls === null ||
      end === null
    )
      return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const host = controls.querySelector<HTMLElement>(
        ".opencraft-composer-mode--static",
      );
      const intelligence = controls.querySelector<HTMLElement>(
        ".opencraft-composer-mode--intelligence, .opencraft-composer-mode--inherited",
      );
      const permission = controls.querySelector<HTMLElement>(
        ".opencraft-composer-mode--permissions",
      );
      intrinsic.current.host = Math.max(
        intrinsic.current.host,
        host?.scrollWidth ?? 0,
      );
      intrinsic.current.intelligence = Math.max(
        intrinsic.current.intelligence,
        intelligence?.scrollWidth ?? 0,
      );
      intrinsic.current.permission = Math.max(
        intrinsic.current.permission,
        permission?.scrollWidth ?? 0,
      );
      const style = window.getComputedStyle(footer);
      const padding =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight);
      const columnGap = Number.parseFloat(style.columnGap) || 0;
      const next = resolveComposerFooterDensity({
        // A one-line touch composer lets footer children participate in the
        // shell grid without reparenting the editor or remounting controls.
        availableWidth: Math.max(0, (style.display === "contents"
          ? footer.parentElement?.clientWidth ?? 0 : footer.clientWidth) - padding),
        fixedWidth: attachment.offsetWidth + end.offsetWidth + columnGap * 2,
        hostWidth: intrinsic.current.host,
        intelligenceWidth: intrinsic.current.intelligence,
        permissionWidth: intrinsic.current.permission,
      });
      setDensity((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(footer);
    if (footer.parentElement) observer?.observe(footer.parentElement);
    observer?.observe(attachment);
    observer?.observe(controls);
    observer?.observe(end);
    schedule();
    return () => {
      observer?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return { density, footerRef, attachmentRef, controlsRef, endRef };
}

import { useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useMotionValue } from "motion/react";
import type { PlatformNavigationStackProps } from "@opencraft/extension-react";
import {
  RouteStackMotion,
  RouteStackGestureContext,
  RouteStackFocusContext,
  type RouteStackGesturePresentation,
} from "./route-stack-motion";
import { useMobileSidebarGesture } from "./use-mobile-sidebar-gesture";

function PageFocus({
  current,
  children,
  focusTarget,
}: {
  current: string;
  children: ReactNode;
  focusTarget?: RefObject<HTMLElement | null>;
}) {
  const root = useRef<HTMLDivElement>(null),
    request = useContext(RouteStackFocusContext);
  const focused = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const saved = focused.current.get(current);
    if (root.current) request?.(focusTarget?.current ?? (saved?.isConnected ? saved : root.current));
  }, [current, request, focusTarget]);
  return (
    <div
      onFocusCapture={(event) => focused.current.set(current, event.target as HTMLElement)}
      ref={root}
      tabIndex={-1}
      className="nested-navigation__content"
    >
      {children}
    </div>
  );
}

/** Same snapshot, spring and contact arbitration as route navigation, scoped to
 * the modal aperture. No router entries, domain mutations or resource copies. */
export function AppShellNestedNavigation({
  path,
  onBack,
  disabled,
  children,
  focusTarget,
}: PlatformNavigationStackProps) {
  const root = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLElement | null>(null);
  const presentation = useRef<RouteStackGesturePresentation | null>(null);
  const width = useMotionValue(0),
    pageX = useMotionValue(0),
    current = path.at(-1) ?? "root";
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => width.set(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  const gesture = useMobileSidebarGesture({
    enabled: path.length > 1 && !disabled,
    open: false,
    root,
    overlay,
    foreground: root,
    width,
    intent: "back",
    scopeKey: current,
    presentation,
    withinModal: true,
    onOpenChange: (back) => {
      if (back && !disabled) {
        onBack();
        return true;
      }
      return false;
    },
  });
  return (
    <div ref={root} className="nested-navigation">
      <RouteStackGestureContext.Provider value={gesture.progress}>
        <RouteStackMotion current={current} path={path} pageX={pageX} overlay={null} gesturePresentation={presentation}>
          <PageFocus current={current} focusTarget={focusTarget}>
            {children}
          </PageFocus>
        </RouteStackMotion>
      </RouteStackGestureContext.Provider>
    </div>
  );
}

import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { StandardPageTitle, type PlatformMasterDetailProps } from "@opencraft/extension-react";
import { resolveShellSpace } from "@opencraft/workbench-runtime";
import { frame } from "@opencraft/design-system/tokens";
import { AppShellRouteHeaderRegion } from "./app-shell-route-regions";
import "./app-shell-master-detail.scss";
import { AppShellPageHeaderContext } from "./app-shell-standard-page";
import { RouteStackFocusContext } from "./route-stack-motion";

const widthKey = "opencraft.inbox.listWidth";
const minList = 240, maxList = 440, minChat = 520;
function readWidth() {
  try {
    const value = Number(localStorage.getItem(widthKey));
    return Number.isFinite(value) && value >= minList && value <= maxList ? value : null;
  } catch { return null; }
}
const SplitContext = createContext(false);
/** Only Header chrome changes owner: the conversation/editor subtree never moves. */
function MasterDetailHeader({ children }: { readonly children: ReactNode }) {
  return <AppShellRouteHeaderRegion suppressReturn={useContext(SplitContext)}>{children}</AppShellRouteHeaderRegion>;
}

/** Collection composition over the existing Shell capacity engine. Width is the
 * actual route aperture, after Shell sidecars/tools, not window or input mode. */
export function AppShellMasterDetailRegion({ master, masterLabel, detailSelected, detail }: PlatformMasterDetailProps) {
  const root = useRef<HTMLDivElement>(null), masterRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preferred, setPreferred] = useState<number | null>(readWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ x: number; width: number; direction: number } | null>(null);
  const limit = Math.max(minList, Math.min(maxList, width - minChat));
  const clamp = (value: number) => Math.max(minList, Math.min(limit, Math.round(value)));
  const defaultWidth = Math.min(360, Math.max(280, Math.round((root.current?.ownerDocument.documentElement.clientWidth ?? width) * 0.23)));
  const listWidth = clamp(preview ?? preferred ?? defaultWidth);
  const save = (value: number | null) => {
    setPreferred(value);
    try {
      if (value === null) localStorage.removeItem(widthKey);
      else localStorage.setItem(widthKey, String(value));
    } catch { /* Keep the preference for this session. */ }
  };
  const previousLevel = useRef<number | undefined>(undefined);
  const space = resolveShellSpace({ width, navigationOpen: false, navigationDetent: "hidden", navigationWidth: 0,
    contextOpen: true, contextWidth: frame.collectionNavigationWidth, rightOpen: false, rightFullWidth: false,
    previousLevel: previousLevel.current });
  const split = width >= minList + minChat && space.contextOpen;
  const masterVisible = split || !detailSelected, detailVisible = split || detailSelected;
  const mode = split ? "split" : detailSelected ? "detail" : "master";
  const lastMasterFocus = useRef<HTMLElement | null>(null);
  const focusedPane = useRef<"master" | "detail" | null>(null);
  const requestFocus = useContext(RouteStackFocusContext);
  useLayoutEffect(() => { previousLevel.current = space.level; }, [space.level]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    // Hiding a pane can reset activeElement before layout effects run. Capture
    // the focused pane during input, and hand transfer to the motion owner.
    const from = focusedPane.current;
    const target = from === "master" && !masterVisible ? detailRef.current
      : from === "detail" && !detailVisible
        ? (lastMasterFocus.current?.isConnected ? lastMasterFocus.current : masterRef.current) : null;
    if (target) {
      focusedPane.current = from === "master" ? "detail" : "master";
      if (requestFocus) requestFocus(target); else target.focus({ preventScroll: true });
    }
  }, [masterVisible, detailVisible, requestFocus]);
  return <SplitContext.Provider value={split}>{!detailSelected ? <AppShellRouteHeaderRegion suppressReturn={split}><StandardPageTitle>{masterLabel}</StandardPageTitle></AppShellRouteHeaderRegion> : null}<div ref={root} className="app-shell-master-detail" data-presentation={mode} data-route-stack-presentation={split ? "in-place" : "page"}
    style={{ "--master-detail-navigation-width": `${listWidth}px` } as CSSProperties}>
    <aside onFocusCapture={event => { focusedPane.current = "master"; lastMasterFocus.current = event.target as HTMLElement; }} ref={masterRef} className="app-shell-master-detail__master" aria-label={masterLabel} tabIndex={-1}
      data-visible={masterVisible} inert={!masterVisible} aria-hidden={!masterVisible || undefined}><AppShellPageHeaderContext.Provider value={false}>{master}</AppShellPageHeaderContext.Provider></aside>
    {split && <div className="app-shell-master-detail__resize" role="separator" aria-orientation="vertical"
      aria-label={masterLabel} aria-valuemin={minList} aria-valuemax={limit} aria-valuenow={listWidth} tabIndex={0}
      onDoubleClick={() => save(null)}
      onKeyDown={event => {
        const direction = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        save(clamp(listWidth + (event.key === "ArrowRight" ? 8 : -8) * direction));
      }}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: listWidth, direction: getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1 };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start && event.currentTarget.hasPointerCapture(event.pointerId))
          setPreview(clamp(start.width + (event.clientX - start.x) * start.direction));
      }}
      onPointerUp={event => {
        const start = drag.current;
        if (start && event.currentTarget.hasPointerCapture(event.pointerId) && event.clientX !== start.x)
          save(clamp(start.width + (event.clientX - start.x) * start.direction));
      }}
      onLostPointerCapture={() => { drag.current = null; setPreview(null); }}
    />}
    <div onFocusCapture={() => { focusedPane.current = "detail"; }} ref={detailRef} className="app-shell-master-detail__detail" tabIndex={-1}
      data-visible={detailVisible} inert={!detailVisible} aria-hidden={!detailVisible || undefined}>
      {detail({ mode, Header: MasterDetailHeader })}
    </div>
  </div></SplitContext.Provider>;
}

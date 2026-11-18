import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PlatformMasterDetailProps } from "@opencraft/extension-react";
import { resolveShellSpace } from "@opencraft/workbench-runtime";
import { frame } from "@opencraft/design-system/tokens";
import { AppShellRouteHeaderRegion } from "./app-shell-route-regions";
import "./app-shell-master-detail.scss";
import { RouteStackFocusContext } from "./route-stack-motion";

const SplitContext = createContext(false);
/** Only Header chrome changes owner: the conversation/editor subtree never moves. */
function MasterDetailHeader({ children }: { readonly children: ReactNode }) {
  return useContext(SplitContext) ? <header>{children}</header> : <AppShellRouteHeaderRegion>{children}</AppShellRouteHeaderRegion>;
}

/** Collection composition over the existing Shell capacity engine. Width is the
 * actual route aperture, after Shell sidecars/tools, not window or input mode. */
export function AppShellMasterDetailRegion({ master, masterLabel, detailSelected, detail }: PlatformMasterDetailProps) {
  const root = useRef<HTMLDivElement>(null), masterRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const previousLevel = useRef<number | undefined>(undefined);
  const space = resolveShellSpace({ width, navigationOpen: false, navigationDetent: "hidden", navigationWidth: 0,
    contextOpen: true, contextWidth: frame.collectionNavigationWidth, rightOpen: false, rightFullWidth: false,
    previousLevel: previousLevel.current });
  const split = width > 0 && space.contextOpen;
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
  return <SplitContext.Provider value={split}>{split ? <AppShellRouteHeaderRegion suppressReturn>{null}</AppShellRouteHeaderRegion> : null}<div ref={root} className="app-shell-master-detail" data-presentation={mode} data-route-stack-presentation={split ? "in-place" : "page"}
    style={{ "--master-detail-navigation-width": `${frame.collectionNavigationWidth}px` } as CSSProperties}>
    <aside onFocusCapture={event => { focusedPane.current = "master"; lastMasterFocus.current = event.target as HTMLElement; }} ref={masterRef} className="app-shell-master-detail__master" aria-label={masterLabel} tabIndex={-1}
      data-visible={masterVisible} inert={!masterVisible} aria-hidden={!masterVisible || undefined}>{master}</aside>
    <div onFocusCapture={() => { focusedPane.current = "detail"; }} ref={detailRef} className="app-shell-master-detail__detail" tabIndex={-1}
      data-visible={detailVisible} inert={!detailVisible} aria-hidden={!detailVisible || undefined}>
      {detail({ mode, Header: MasterDetailHeader })}
    </div>
  </div></SplitContext.Provider>;
}

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { applicationDesktopMotion } from "@opencraft/design-system/tokens";
import { useIntl } from "@opencraft/i18n/react";
import type { MiniAppContribution } from "@opencraft/extension-contract";
import type { ApplicationNavigation, ApplicationRoute } from "../runtime/workbench-navigation";
import { OVERHOME_VIEW_ID } from "../runtime/mini-apps";
import "./application-desktop-motion.scss";

export interface MiniAppLaunch {
  readonly app: MiniAppContribution;
  readonly left: number; readonly top: number;
  readonly width: number; readonly height: number;
  readonly frameWidth: number; readonly frameHeight: number;
}
const DesktopMotion = createContext<{
  readonly launch: MiniAppLaunch | null;
  start(app: MiniAppContribution, icon: HTMLElement, navigate: () => void): void;
  openChat(): void;
  openDesktop(): void;
} | null>(null);

/** Transient presentation geometry only. ApplicationNavigation still owns every route. */
export function ApplicationDesktopProvider({ navigation, children }: {
  readonly navigation: Pick<ApplicationNavigation, "openChat" | "openExtensionView">;
  readonly children: ReactNode;
}) {
  const [launch, setLaunch] = useState<MiniAppLaunch | null>(null);
  const value = useMemo(() => ({ launch,
    start(app: MiniAppContribution, icon: HTMLElement, navigate: () => void) {
      const tile = icon.getBoundingClientRect();
      const frame = icon.closest("[data-application-stage]")?.getBoundingClientRect() ?? tile;
      flushSync(() => setLaunch({ app, left: tile.left - frame.left, top: tile.top - frame.top,
        width: tile.width, height: tile.height, frameWidth: frame.width, frameHeight: frame.height }));
      navigate();
    },
    openChat: navigation.openChat,
    openDesktop: () => navigation.openExtensionView(OVERHOME_VIEW_ID),
  }), [launch, navigation]);
  return <DesktopMotion.Provider value={value}>{children}</DesktopMotion.Provider>;
}
export const useApplicationDesktop = () => useContext(DesktopMotion);
const isDesktop = (route: ApplicationRoute) => route.kind === "extension-view" && route.viewId === OVERHOME_VIEW_ID;
const ownsRoute = (launch: MiniAppLaunch | null, route: ApplicationRoute) => launch !== null && (
  launch.app.target.kind === "settings" ? route.kind === "settings" && route.slug === launch.app.target.pageId
    : route.kind === "extension-view" && route.viewId === launch.app.target.viewId);
type SceneTransition = { readonly closing: MiniAppLaunch | null; readonly launching: boolean; readonly reduced: boolean };
const closedWindow = (launch: MiniAppLaunch) => ({ x: launch.left, y: launch.top,
  scaleX: launch.width / launch.frameWidth, scaleY: launch.height / launch.frameHeight,
  borderRadius: Math.min(launch.frameWidth, launch.frameHeight) * applicationDesktopMotion.closedRadiusRatio, opacity: 0 });

/** Exiting surfaces are inert; only presentation survives until the spring settles. */
function ApplicationScene({ kind, children, origin, entering, onReturned }: {
  readonly kind: "desktop" | "app" | "other"; readonly children: ReactNode;
  readonly origin: MiniAppLaunch | null; readonly entering: boolean; readonly onReturned: () => void;
}) {
  const present = useIsPresent(), reduced = useReducedMotion(), desktop = useApplicationDesktop(), intl = useIntl();
  const windowInitial = !reduced && entering && origin ? { ...closedWindow(origin), opacity: 1 } : false;
  return <motion.section className={`application-route-scene application-route-scene--${kind}`}
    data-application-scene={kind} data-scene-present={present} inert={!present || undefined}
    aria-hidden={!present || undefined} style={{ transformOrigin: kind === "desktop" ? "50% 50%" : "0 0" }}
    initial={kind === "app" ? windowInitial : !reduced && kind === "desktop" ? { opacity: 0, scale: applicationDesktopMotion.sceneEntryScale } : false}
    animate={{ x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, borderRadius: 0, opacity: 1 }}
    exit="exit" variants={{ exit: (transition: SceneTransition = { closing: null, launching: false, reduced: false }) => transition.reduced ? { opacity: 0, transition: { duration: 0 } }
      : kind === "app" && transition.closing ? closedWindow(transition.closing)
      : kind === "desktop" && transition.launching ? { opacity: 0, scale: applicationDesktopMotion.desktopRestScale }
      : { opacity: 0, transition: { duration: .12 } } }}
    transition={reduced ? { duration: 0 } : applicationDesktopMotion.window}
    onAnimationComplete={() => { if (present && kind === "desktop") onReturned(); }}>
    <motion.div className="application-route-scene__content" initial={!reduced && entering && kind === "app" ? { opacity: 0 } : false}
      animate={{ opacity: 1 }} transition={reduced ? { duration: 0 } : applicationDesktopMotion.content}>
      {children}
    </motion.div>
    {kind === "app" && desktop ? <button type="button" className="application-route-scene__home"
      aria-label={intl.formatMessage({ id: "navigation.applications", defaultMessage: "Applications" })}
      onClick={desktop.openDesktop}><span aria-hidden="true" /></button> : null}
  </motion.section>;
}

/** One route plane for Host and zero-Host shells; Chat remains mounted outside it. */
export function ApplicationRouteMotion({ route, children, includeConversation = false }: { readonly route: ApplicationRoute; readonly children: ReactNode; readonly includeConversation?: boolean }) {
  const desktop = useApplicationDesktop(), reduced = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null), previous = useRef(route);
  const closingOrigin = useRef<MiniAppLaunch | null>(null);
  const launch = desktop?.launch ?? null;
  const home = isDesktop(route), app = ownsRoute(launch, route);
  const bounds = frame.current?.getBoundingClientRect();
  const origin = launch && bounds && Math.abs(bounds.width - launch.frameWidth) < 1 && Math.abs(bounds.height - launch.frameHeight) < 1 ? launch : null;
  const entering = app && isDesktop(previous.current);
  const closing = home ? (ownsRoute(launch, previous.current) ? origin : closingOrigin.current) : null;
  useLayoutEffect(() => { previous.current = route; closingOrigin.current = closing; }, [route, closing]);
  const restoreFocus = () => {
    if (isDesktop(previous.current) && launch && (document.activeElement === document.body || !document.activeElement?.isConnected)) {
      [...(frame.current?.querySelectorAll<HTMLButtonElement>("[data-miniapp-id]") ?? [])]
        .find(button => button.dataset.miniappId === launch.app.id)?.focus({ preventScroll: true });
    }
  };
  return <div className="application-route-stage" data-application-stage ref={frame}>
    <AnimatePresence initial={false} onExitComplete={restoreFocus} custom={{ closing, launching: app, reduced: !!reduced } satisfies SceneTransition}>
      {route.kind !== "conversation" || includeConversation ? <ApplicationScene key={home ? "desktop" : app ? launch!.app.id : "route"}
        kind={home ? "desktop" : app ? "app" : "other"} origin={origin} entering={entering} onReturned={restoreFocus}>{children}</ApplicationScene> : null}
    </AnimatePresence>
  </div>;
}

/** The desktop remains behind a window launched from it, including reverse motion. */
export function useApplicationDesktopBackdrop(route: ApplicationRoute): boolean {
  const desktop = useApplicationDesktop();
  return isDesktop(route) || ownsRoute(desktop?.launch ?? null, route);
}

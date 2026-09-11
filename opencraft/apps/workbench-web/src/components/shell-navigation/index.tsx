import * as Dialog from "@radix-ui/react-dialog";
import { Blocks } from "lucide-react";
import {
  motion,
  useTransform,
  type MotionStyle,
  type MotionValue,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  createShellNavigationState, projectShellNavigation, reduceShellNavigation,
  resolveShellNavigationWidth, shellNavigationMetrics,
  type ShellNavigationRailDetent,
} from "@opencraft/workbench-runtime";
import { AccountAvatar, NavigationContent, type ShellNavigationConfig } from "./navigation-content";
import { NavigationIcon } from "./navigation-action";

export type { ShellNavigationConfig } from "./navigation-content";
const preferenceKey = "opencraft.shell-navigation.v2";
// v2 stored the old 260px default as an untyped number, so it cannot be
// distinguished from a deliberate resize. Start the narrower geometry cleanly.
const widthPreferenceKey = "opencraft.shell-navigation.width.v3";
const surfaces = ["applications", "account"] as const;
const labels = { applications: "Applications", account: "Account" };

function readPreferences() {
  try { return createShellNavigationState(JSON.parse(localStorage.getItem(preferenceKey) ?? "null")); }
  catch { return createShellNavigationState(); }
}

/** Web storage/layout adapter; no route, Host or Thread state is owned here. */
export function useShellNavigation(input: {
  viewportWidth: number;
  contextWidth: number;
  contextAvailable: boolean;
  sidecarOpen: boolean;
  enabled: boolean;
  allowDock?: boolean;
}) {
  const [state, dispatch] = useReducer(reduceShellNavigation, undefined, readPreferences);
  const [width, setWidth] = useState(() => {
    try { return resolveShellNavigationWidth(JSON.parse(localStorage.getItem(widthPreferenceKey) ?? "null")); }
    catch { return shellNavigationMetrics.columnWidth; }
  });
  const commitWidth = useCallback((next: number) => {
    const resolved = resolveShellNavigationWidth(next);
    setWidth(resolved);
    try { localStorage.setItem(widthPreferenceKey, JSON.stringify(resolved)); } catch { /* Storage denied. */ }
  }, []);
  const [previouslyAvailable, setPreviouslyAvailable] = useState<boolean>();
  const projection = projectShellNavigation({ ...input, state, previouslyAvailable, navigationWidth: width,
    allowDock: input.enabled && input.allowDock !== false });
  useLayoutEffect(() => setPreviouslyAvailable(projection.dockAvailable), [projection.dockAvailable]);
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({
        ...state.pinned,
        railDetent: state.railDetent,
        lastVisibleRailDetent: state.lastVisibleRailDetent,
      }));
    } catch { /* Private/storage-denied mode. */ }
  }, [state.pinned, state.railDetent, state.lastVisibleRailDetent]);
  // A peek absorbed into its dock must not reappear on a later resize.
  useEffect(() => {
    if (state.peek && projection.docked[state.peek]) dispatch({ type: "dismiss", surface: state.peek });
  }, [state.peek, projection.docked.applications, projection.docked.account]);
  const commitRailDetent = useCallback((detent: ShellNavigationRailDetent) => {
    dispatch({ type: "set-rail-detent", detent });
  }, []);
  return { state, projection, dispatch, width, commitWidth, commitRailDetent };
}
export type ShellNavigationController = ReturnType<typeof useShellNavigation>;

interface ShellNavigationMotionStyle extends MotionStyle {
  "--shell-navigation-content-gap": MotionValue<string>;
  "--shell-navigation-heading-height": MotionValue<string>;
  "--shell-navigation-heading-opacity": MotionValue<number>;
  "--shell-navigation-heading-y": MotionValue<string>;
  "--shell-navigation-icon-scale": MotionValue<number>;
  "--shell-navigation-label-opacity": MotionValue<number>;
  "--shell-navigation-label-x": MotionValue<string>;
  "--shell-navigation-row-gap": MotionValue<string>;
  "--shell-navigation-row-padding": MotionValue<string>;
  "--shell-navigation-row-inset": MotionValue<string>;
  "--shell-navigation-row-width": MotionValue<string>;
}

function ShellNavigationMotionFrame({ children, expandedWidth, frameWidth }: {
  readonly children: ReactNode;
  readonly expandedWidth: MotionValue<number>;
  readonly frameWidth: MotionValue<number>;
}) {
  const progress = useTransform(
    [frameWidth, expandedWidth],
    ([currentFrameWidth, currentExpandedWidth]) => {
      const span = Math.max(1, Number(currentExpandedWidth) - shellNavigationMetrics.compactWidth);
      return Math.max(0, Math.min(1,
        (Number(currentFrameWidth) - shellNavigationMetrics.compactWidth) / span));
    },
  );
  const labelOpacity = useTransform(progress, [0.38, 0.82], [0, 1], { clamp: true });
  const headingProgress = useTransform(progress, [0.22, 0.86], [0, 1], { clamp: true });
  const style: ShellNavigationMotionStyle = {
    "--shell-navigation-content-gap": useTransform(progress, value => `${8 + value * 16}px`),
    "--shell-navigation-heading-height": useTransform(headingProgress, value => `${value * 34}px`),
    "--shell-navigation-heading-opacity": headingProgress,
    "--shell-navigation-heading-y": useTransform(headingProgress, value => `${(1 - value) * -5}px`),
    "--shell-navigation-icon-scale": useTransform(progress, value => 1 + (1 - value) * 0.04),
    "--shell-navigation-label-opacity": labelOpacity,
    "--shell-navigation-label-x": useTransform(labelOpacity, value => `${(1 - value) * -6}px`),
    "--shell-navigation-row-gap": useTransform(progress, value => `${value * 9}px`),
    "--shell-navigation-row-padding": useTransform(progress, value => `${10 - value * 2}px`),
    "--shell-navigation-row-inset": useTransform(progress, value => {
      const compactInset = (shellNavigationMetrics.compactWidth - shellNavigationMetrics.compactActionSize) / 2;
      return `${compactInset + value * (12 - compactInset)}px`;
    }),
    "--shell-navigation-row-width": useTransform(
      [progress, expandedWidth],
      ([currentProgress, currentExpandedWidth]) => {
        const compactRowWidth = shellNavigationMetrics.compactActionSize;
        const expandedRowWidth = Math.max(compactRowWidth, Number(currentExpandedWidth) - 24);
        return `${compactRowWidth + Number(currentProgress) * (expandedRowWidth - compactRowWidth)}px`;
      },
    ),
  };
  return <motion.div className="shell-navigation__dock-content"
    data-shell-navigation-motion="geometry" style={style}>{children}</motion.div>;
}

export function ShellNavigationDock({ config, controller, expandedWidth, frameWidth, transient = false }: {
  config: ShellNavigationConfig; controller: ShellNavigationController;
  expandedWidth?: MotionValue<number>; frameWidth?: MotionValue<number>; transient?: boolean;
}) {
  const compact = !transient && controller.projection.railDetent === "compact";
  const content = surfaces.filter(surface => transient ? surface === "applications" : controller.projection.docked[surface]).map(surface => <section key={surface}>
      <div className="shell-navigation__heading"><strong>{labels[surface]}</strong></div>
      <NavigationContent compact={compact} config={config} surface={surface} onInvoke={action => action()} />
    </section>);
  if (expandedWidth !== undefined && frameWidth !== undefined) {
    return <ShellNavigationMotionFrame expandedWidth={expandedWidth} frameWidth={frameWidth}>
      {content}
    </ShellNavigationMotionFrame>;
  }
  return <div className="shell-navigation__dock-content">{content}</div>;
}

/** Stable footer of the Sidecar, never a window-wide bottom bar. */
export function ShellNavigationFooter({ config, controller, visible = true, entranceId = "shell-entrance", onTogglePrimaryNavigation, onPin }: {
  config: ShellNavigationConfig; controller: ShellNavigationController; visible?: boolean; entranceId?: string;
  onTogglePrimaryNavigation?: () => void; onPin?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { projection, state, dispatch } = controller;
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current && !visible && state.peek) dispatch({ type: "dismiss", surface: state.peek });
    wasVisible.current = visible;
  }, [visible, state.peek, dispatch]);
  const style: CSSProperties = { ...projection.footer };
  return <div ref={root} className="shell-navigation__footer" style={style} aria-label="Application entrances">
    {surfaces.map(surface => <Dialog.Root key={surface} modal={false}
      open={visible && projection.peek === surface}
      onOpenChange={open => {
        if (open && surface === "applications" && projection.primaryNavigation && onTogglePrimaryNavigation) onTogglePrimaryNavigation();
        else if (open && surface === "applications" && projection.dockAvailable && !projection.footerVisible && onPin) {
          dispatch({ type: "pin", surface, pinned: true });
          onPin();
        }
        else if (open) dispatch({ type: "toggle", surface, dockAvailable: projection.dockAvailable && projection.footerVisible });
        else dispatch({ type: "dismiss", surface });
      }}>
      <Dialog.Trigger asChild>
        <button id={`${entranceId}-${surface}`} type="button"
          className="shell-navigation__entrance" aria-label={labels[surface]}
          data-surface={surface}
          aria-pressed={surface === "applications" ? projection.docked.applications || projection.peek === "applications" : state.pinned[surface]}
          aria-expanded={surface === "applications" ? projection.docked.applications || projection.peek === "applications" : undefined}
          data-pinned={surface === "applications" && projection.primaryNavigation ? visible : state.pinned[surface]}
          title={surface === "applications" && projection.primaryNavigation ? "Applications" : `${labels[surface]}${state.pinned[surface] ? " · Pinned" : ""}`}>
          {surface === "applications" ? <span className="shell-navigation__icons" aria-hidden="true">
            {config.actions.length ? config.actions.slice(0, 2).map(action => <span key={action.id}>
              <NavigationIcon name={action.icon} size={16} />
            </span>) : <span><Blocks size={16} /></span>}
          </span> : <><AccountAvatar account={config.account} /><span className="shell-navigation__name">{config.account?.snapshot.name || "Account"}</span></>}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={root.current}>
        <Dialog.Content className={surface === "applications" ? "shell-navigation__drawer" : "shell-navigation__peek"} aria-describedby={undefined}>
          <div className={surface === "applications" ? "shell-navigation__dock-content" : undefined}>
          <div className="shell-navigation__heading"><Dialog.Title>{labels[surface]}</Dialog.Title></div>
          <NavigationContent compact={false} config={config} surface={surface} onInvoke={action => {
            dispatch({ type: "dismiss", surface }); action();
          }} />
          {surface === "account" ? <div className="shell-navigation__items shell-navigation__placement">
            <button type="button" aria-label={`${state.pinned[surface] ? "Unpin" : "Pin"} ${labels[surface]}`}
              onClick={() => {
                dispatch({ type: "pin", surface, pinned: !state.pinned[surface] });
                if (!state.pinned[surface]) onPin?.();
              }}>
              {state.pinned[surface] ? "Unpin from sidebar" : "Keep in sidebar"}
            </button>
          </div> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>)}
  </div>;
}

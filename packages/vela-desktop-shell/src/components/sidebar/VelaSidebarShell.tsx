import type {
  CSSProperties,
  HTMLAttributes,
  LiHTMLAttributes,
  MouseEvent,
  PointerEvent,
  ReactNode,
  SVGProps,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesktopHostBridge } from "../../host";
import { browserDesktopHostBridge } from "../../host";
import { SidebarResizeHandle } from "./resize/SidebarResizeHandle";

interface SidebarContextValue {
  open: boolean;
  state: "expanded" | "collapsed";
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

interface VelaSidebarShellProps {
  children: ReactNode;
  sidebar: ReactNode;
  host?: DesktopHostBridge;
  className?: string;
  isSidebarVisible: boolean;
  sidebarPresentation?: "auto" | "docked" | "overlay";
  sidebarWidthPx?: number;
  onToggleSidebar?: () => void;
  onSidebarVisibilityChange?: (isVisible: boolean) => void;
  onSidebarResizeStart?: () => void;
  onSidebarWidthPreview?: (widthPx: number) => void;
  onSidebarWidthChange?: (widthPx: number) => void;
  onCreateSession?: () => void;
}

interface SidebarProviderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  sidebarWidthPx?: number;
  sidebarIconWidthPx?: number;
}

interface SidebarProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

interface SidebarBodyProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

interface SidebarMenuButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean;
  size?: "default" | "compact";
}

interface WindowToolbarButtonModel {
  id: string;
  icon: (props: SVGProps<SVGSVGElement>) => ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  tone?: "default" | "muted";
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used inside SidebarProvider");
  return context;
}

export function SidebarProvider({
  children,
  open: controlledOpen,
  onOpenChange,
  sidebarWidthPx = 300,
  sidebarIconWidthPx = 56,
  className,
  style,
  ...props
}: SidebarProviderProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(true);
  const open = controlledOpen ?? uncontrolledOpen;
  const state: SidebarContextValue["state"] = open ? "expanded" : "collapsed";
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      onOpenChange?.(nextOpen);
      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );
  const toggleSidebar = useCallback(() => setOpen(!open), [open, setOpen]);
  const contextValue = useMemo(
    () => ({ open, setOpen, state, toggleSidebar }),
    [open, setOpen, state, toggleSidebar],
  );
  const providerStyle = {
    "--vela-sidebar-width": `${sidebarWidthPx}px`,
    "--vela-sidebar-width-icon": `${sidebarIconWidthPx}px`,
    ...style,
  } as CSSProperties;

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={["vela-sidebar-provider", className].filter(Boolean).join(" ")}
        data-state={state}
        data-slot="sidebar-wrapper"
        style={providerStyle}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function VelaSidebarShell({
  children,
  sidebar,
  host = browserDesktopHostBridge,
  className = "app-shell vela-tri-pane-shell",
  isSidebarVisible,
  sidebarPresentation = "docked",
  sidebarWidthPx = 300,
  onToggleSidebar,
  onSidebarVisibilityChange,
  onSidebarResizeStart,
  onSidebarWidthPreview,
  onSidebarWidthChange,
  onCreateSession,
}: VelaSidebarShellProps) {
  const [autoOverlayMode, setAutoOverlayMode] = useState(false);
  const sidebarWrapperRef = useRef<HTMLDivElement | null>(null);
  const overlayCloseTimerRef = useRef<number | null>(null);
  const sidebarState = isSidebarVisible ? "expanded" : "collapsed";
  const effectiveSidebarPresentation =
    sidebarPresentation === "auto"
      ? autoOverlayMode
        ? "overlay"
        : "docked"
      : sidebarPresentation;
  const isTransientOverlayOpen =
    sidebarPresentation === "auto" && autoOverlayMode && isSidebarVisible;
  const cancelOverlayClose = useCallback(() => {
    if (overlayCloseTimerRef.current === null) return;
    window.clearTimeout(overlayCloseTimerRef.current);
    overlayCloseTimerRef.current = null;
  }, []);
  const closeOverlaySidebar = useCallback(() => {
    cancelOverlayClose();
    if (isTransientOverlayOpen) {
      onToggleSidebar?.();
    }
  }, [cancelOverlayClose, isTransientOverlayOpen, onToggleSidebar]);
  const scheduleOverlayClose = useCallback(() => {
    if (!isTransientOverlayOpen) return;
    cancelOverlayClose();
    overlayCloseTimerRef.current = window.setTimeout(() => {
      overlayCloseTimerRef.current = null;
      const wrapper = sidebarWrapperRef.current;
      if (wrapper?.matches(":hover") || wrapper?.contains(document.activeElement)) return;
      closeOverlaySidebar();
    }, 180);
  }, [cancelOverlayClose, closeOverlaySidebar, isTransientOverlayOpen]);
  const handleToggleSidebar = useCallback(() => {
    if (sidebarPresentation === "auto") {
      setAutoOverlayMode(false);
      cancelOverlayClose();
    }
    onToggleSidebar?.();
  }, [cancelOverlayClose, onToggleSidebar, sidebarPresentation]);
  const openOverlaySidebar = useCallback(() => {
    if (sidebarPresentation === "auto" && !isSidebarVisible) {
      cancelOverlayClose();
      setAutoOverlayMode(true);
      onToggleSidebar?.();
    }
  }, [cancelOverlayClose, isSidebarVisible, onToggleSidebar, sidebarPresentation]);
  const handleOverlayTriggerPointerEnter = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        openOverlaySidebar();
      }
    },
    [openOverlaySidebar],
  );
  const handleSidebarActionClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!isTransientOverlayOpen) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("button,a,[role='button']")) return;
      window.setTimeout(closeOverlaySidebar, 0);
    },
    [closeOverlaySidebar, isTransientOverlayOpen],
  );
  const shouldShowOverlayTrigger =
    sidebarPresentation === "auto" && !isSidebarVisible;

  useEffect(() => {
    if (!isTransientOverlayOpen) return undefined;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const wrapper = sidebarWrapperRef.current;
      if (event.target instanceof Node && wrapper?.contains(event.target)) return;
      scheduleOverlayClose();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const wrapper = sidebarWrapperRef.current;
      if (event.target instanceof Node && wrapper?.contains(event.target)) return;
      scheduleOverlayClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      cancelOverlayClose();
    };
  }, [cancelOverlayClose, isTransientOverlayOpen, scheduleOverlayClose]);

  return (
    <SidebarProvider
      open={isSidebarVisible}
      onOpenChange={handleToggleSidebar}
      sidebarWidthPx={sidebarWidthPx}
    >
      <div
        className={["vela-desktop-shell", className].filter(Boolean).join(" ")}
        data-platform={host.platform}
        data-sidebar-presentation={effectiveSidebarPresentation}
        data-slot="sidebar-shell"
        data-state={sidebarState}
      >
        <VelaWindowChrome host={host} />
        <VelaSidebarWindowControls
          onCreateSession={onCreateSession}
          onToggleSidebar={handleToggleSidebar}
        />
        {shouldShowOverlayTrigger ? (
          <button
            type="button"
            className="vela-sidebar-overlay-trigger"
            aria-label="Show sidebar"
            onClick={openOverlaySidebar}
            onPointerEnter={handleOverlayTriggerPointerEnter}
          />
        ) : null}
        <div
          ref={sidebarWrapperRef}
          className="vela-sidebar-wrapper"
          data-slot="sidebar-wrapper"
          data-state={sidebarState}
          aria-hidden={isSidebarVisible ? undefined : "true"}
          onClickCapture={handleSidebarActionClick}
          onPointerEnter={cancelOverlayClose}
          onPointerLeave={scheduleOverlayClose}
        >
          <div className="vela-sidebar-panel" data-slot="sidebar-panel">
            {sidebar}
          </div>
        </div>
        {isSidebarVisible && effectiveSidebarPresentation === "docked" && onSidebarWidthChange ? (
          <SidebarResizeHandle
            sidebarWidthPx={sidebarWidthPx}
            onSidebarResizeStart={onSidebarResizeStart}
            onSidebarVisibilityChange={onSidebarVisibilityChange}
            onSidebarWidthPreview={onSidebarWidthPreview}
            onSidebarWidthChange={onSidebarWidthChange}
          />
        ) : null}
        <main className="vela-sidebar-inset vela-main-inset" data-sidebar-inset="main">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}

export function VelaWindowChrome({
  host = browserDesktopHostBridge,
}: {
  host?: DesktopHostBridge;
}) {
  return (
    <div className="vela-window-chrome" data-slot="window-chrome">
      <div
        className="vela-window-drag-layer"
        data-slot="window-drag-layer"
        data-window-drag-region="true"
        aria-hidden="true"
      />
      {host.chrome.showTrafficLights ? (
        <div className="vela-window-traffic-lights" aria-hidden="true">
          <span className="vela-traffic-light close" />
          <span className="vela-traffic-light minimize" />
          <span className="vela-traffic-light zoom" />
        </div>
      ) : null}
    </div>
  );
}

export function VelaSidebarChrome({
  showTrafficLights: _showTrafficLights = false,
}: {
  showTrafficLights?: boolean;
}) {
  return (
    <div
      className="vela-sidebar-topbar"
      data-slot="sidebar-header"
    >
      <div className="vela-sidebar-toolbar-spacer" aria-hidden="true" />
      <div className="vela-sidebar-nav" aria-hidden="true" />
        <div
          className="vela-sidebar-drag-fill"
          aria-hidden="true"
          data-window-drag-region="true"
        />
    </div>
  );
}

export function Sidebar({ children, className, ...props }: SidebarProps) {
  const context = useContext(SidebarContext);
  const state = context?.state ?? "expanded";
  return (
    <aside
      className={["vela-session-sidebar", className].filter(Boolean).join(" ")}
      data-sidebar="sidebar"
      data-slot="sidebar"
      data-state={state}
      {...props}
    >
      {children}
    </aside>
  );
}

export function SidebarContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={["vela-sidebar-content", className].filter(Boolean).join(" ")}
      data-sidebar="content"
      data-slot="sidebar-content"
      {...props}
    />
  );
}

export function SidebarBody({ className, ...props }: SidebarBodyProps) {
  return (
    <div
      className={["vela-sidebar-body", className].filter(Boolean).join(" ")}
      data-sidebar="body"
      data-slot="sidebar-body"
      {...props}
    />
  );
}

export function SidebarBodyFixed({ className, ...props }: SidebarBodyProps) {
  return (
    <div
      className={["vela-sidebar-body-fixed", className].filter(Boolean).join(" ")}
      data-sidebar="body-fixed"
      data-slot="sidebar-body-fixed"
      {...props}
    />
  );
}

export function SidebarBodyScroll({ className, ...props }: SidebarBodyProps) {
  return (
    <div
      className={["vela-sidebar-body-scroll", className].filter(Boolean).join(" ")}
      data-sidebar="body-scroll"
      data-slot="sidebar-body-scroll"
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={["vela-sidebar-footer", className].filter(Boolean).join(" ")}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
  return (
    <ul
      className={["vela-sidebar-menu", className].filter(Boolean).join(" ")}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: LiHTMLAttributes<HTMLLIElement>) {
  return (
    <li
      className={["vela-sidebar-menu-item", className].filter(Boolean).join(" ")}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

export function SidebarMenuButton({
  children,
  className,
  isActive = false,
  size = "default",
  ...props
}: SidebarMenuButtonProps) {
  return (
    <button
      className={["vela-sidebar-menu-button", className].filter(Boolean).join(" ")}
      data-active={isActive ? "true" : undefined}
      data-sidebar="menu-button"
      data-size={size}
      data-slot="sidebar-menu-button"
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

function VelaSidebarWindowControls({
  onToggleSidebar,
  onCreateSession,
}: {
  onToggleSidebar?: () => void;
  onCreateSession?: () => void;
}) {
  const buttons: WindowToolbarButtonModel[] = [
    {
      id: "toggle-sidebar",
      icon: ToolbarSidebarIcon,
      label: "Toggle sidebar",
      onClick: onToggleSidebar,
    },
    {
      id: "new-thread",
      icon: ToolbarNewThreadIcon,
      label: "New thread",
      onClick: onCreateSession,
    },
  ].filter((button) => button.onClick);
  if (buttons.length === 0) return null;
  return (
    <div
      className="vela-sidebar-window-controls"
      data-slot="sidebar-window-controls"
      data-window-drag-region="false"
    >
      {buttons.map((button) => (
        <WindowToolbarButton key={button.id} button={button} />
      ))}
    </div>
  );
}

function WindowToolbarButton({ button }: { button: WindowToolbarButtonModel }) {
  const Icon = button.icon;
  const stopToolbarPointerEvent = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const stopToolbarMouseEvent = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    button.onClick?.();
  };

  return (
    <button
      className="vela-sidebar-window-control-button"
      data-toolbar-button={button.id}
      data-tone={button.tone ?? "default"}
      data-window-drag-region="false"
      disabled={button.disabled}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      type="button"
      aria-label={button.label}
      onPointerDown={stopToolbarPointerEvent}
      onMouseDown={stopToolbarMouseEvent}
      onClick={handleClick}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function ToolbarSidebarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="4" y="4" width="16" height="16" rx="3.4" />
      <path d="M12 4.8v14.4" />
    </svg>
  );
}

function ToolbarNewThreadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M12 5.7v12.6" />
      <path d="M5.7 12h12.6" />
    </svg>
  );
}

import type {
  CSSProperties,
  HTMLAttributes,
  LiHTMLAttributes,
  ReactNode,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ChevronLeft, ChevronRight, Download, PanelLeft, Plus } from "lucide-react";
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

interface SidebarMenuButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean;
  size?: "default" | "compact";
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
  sidebarWidthPx = 300,
  onToggleSidebar,
  onSidebarVisibilityChange,
  onSidebarResizeStart,
  onSidebarWidthPreview,
  onSidebarWidthChange,
  onCreateSession,
}: VelaSidebarShellProps) {
  const sidebarState = isSidebarVisible ? "expanded" : "collapsed";

  return (
    <SidebarProvider
      open={isSidebarVisible}
      onOpenChange={() => onToggleSidebar?.()}
      sidebarWidthPx={sidebarWidthPx}
    >
      <div
        className={["vela-desktop-shell", className].filter(Boolean).join(" ")}
        data-platform={host.platform}
        data-slot="sidebar-shell"
        data-state={sidebarState}
      >
        <VelaSidebarWindowControls
          onCreateSession={onCreateSession}
          onToggleSidebar={onToggleSidebar}
        />
        <div
          className="vela-sidebar-wrapper"
          data-slot="sidebar-wrapper"
          data-state={sidebarState}
          aria-hidden={isSidebarVisible ? undefined : "true"}
        >
          <div className="vela-sidebar-panel" data-slot="sidebar-panel">
            {sidebar}
          </div>
        </div>
        {isSidebarVisible && onSidebarWidthChange ? (
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

export function VelaSidebarChrome({
  showTrafficLights = false,
}: {
  showTrafficLights?: boolean;
}) {
  return (
    <div
      className="vela-sidebar-topbar"
      data-slot="sidebar-header"
      data-window-drag-region="true"
    >
      <div className="vela-sidebar-traffic-zone" aria-hidden="true">
        {showTrafficLights ? (
          <div className="vela-traffic-lights" aria-hidden="true">
            <span className="vela-traffic-light close" />
            <span className="vela-traffic-light minimize" />
            <span className="vela-traffic-light zoom" />
          </div>
        ) : null}
      </div>
      <div className="vela-sidebar-nav" aria-label="Sidebar navigation">
        <button
          className="vela-sidebar-chrome-button"
          type="button"
          aria-label="Back"
          disabled
        >
          <ChevronLeft size={17} aria-hidden />
        </button>
        <button
          className="vela-sidebar-chrome-button"
          type="button"
          aria-label="Forward"
          disabled
        >
          <ChevronRight size={17} aria-hidden />
        </button>
        <button
          className="vela-sidebar-chrome-button sync"
          type="button"
          aria-label="Sync workspace"
          disabled
        >
          <Download size={16} aria-hidden />
        </button>
      </div>
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
  if (!onToggleSidebar && !onCreateSession) return null;
  return (
    <div className="vela-sidebar-window-controls" data-slot="sidebar-window-controls">
      {onToggleSidebar ? (
        <button
          className="vela-sidebar-window-control-button"
          type="button"
          aria-label="Toggle sidebar"
          onClick={onToggleSidebar}
        >
          <PanelLeft size={15} aria-hidden />
        </button>
      ) : null}
      {onCreateSession ? (
        <button
          className="vela-sidebar-window-control-button"
          type="button"
          aria-label="New thread"
          onClick={onCreateSession}
        >
          <Plus size={16} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

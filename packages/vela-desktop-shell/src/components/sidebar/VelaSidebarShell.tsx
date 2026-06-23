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
  useMemo,
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
        <VelaWindowChrome host={host} />
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
      disabled={button.disabled}
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

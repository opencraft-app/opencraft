import type { CSSProperties } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CircleUserRound,
  Settings,
  Trash2,
} from "lucide-react";

export interface SidebarSettingsMenuProps {
  canClearSessions?: boolean;
  defaultOpen?: boolean;
  onClearSessions?: () => void;
  onOpenSettings?: () => void;
}

export function SidebarSettingsMenu({
  canClearSessions = false,
  defaultOpen = false,
  onClearSessions,
  onOpenSettings,
}: SidebarSettingsMenuProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setIsOpen(false), []);
  const openSettings = useCallback(() => {
    close();
    onOpenSettings?.();
  }, [close, onOpenSettings]);
  const clearSessions = useCallback(() => {
    close();
    onClearSessions?.();
  }, [close, onClearSessions]);
  const canClear = canClearSessions && Boolean(onClearSessions);
  const canPortal = canUseDocument();

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      const popover = popoverRef.current;
      const target = event.target;
      if (root && target instanceof Node && root.contains(target)) return;
      if (popover && target instanceof Node && popover.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !canPortal) {
      setPopoverStyle(null);
      return;
    }

    const updatePosition = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setPopoverStyle({
        bottom: `${window.innerHeight - rect.top + 10}px`,
        left: `${rect.left}px`,
        position: "fixed",
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [canPortal, isOpen]);

  const menu = useMemo(
    () => (
      <div
        className="vela-popover-surface vela-settings-popover vela-motion-popover"
        role="menu"
        aria-label="Settings menu"
        data-layer={canPortal ? "portal" : "inline"}
        data-state="open"
        ref={popoverRef}
        style={popoverStyle ?? undefined}
      >
        <div className="vela-popover-menu vela-settings-menu">
          <button
            className="vela-popover-menu-item vela-settings-menu-item"
            type="button"
            role="menuitem"
            onClick={openSettings}
          >
            <CircleUserRound size={14} aria-hidden />
            <span>Personal profile</span>
          </button>
          <button
            className="vela-popover-menu-item vela-settings-menu-item"
            type="button"
            role="menuitem"
            onClick={openSettings}
          >
            <Settings size={14} aria-hidden />
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </button>

          {canClear ? (
            <>
              <div className="vela-popover-menu-separator vela-settings-menu-separator" role="none" />
              <button
                className="vela-popover-menu-item vela-settings-menu-item"
                type="button"
                role="menuitem"
                onClick={clearSessions}
              >
                <Trash2 size={14} aria-hidden />
                <span>Clear chats</span>
              </button>
            </>
          ) : null}
        </div>
      </div>
    ),
    [
      canClear,
      canPortal,
      clearSessions,
      openSettings,
      popoverStyle,
    ],
  );

  return (
    <div className="vela-settings-menu-root" ref={rootRef}>
      <button
        className="sidebar-footer-btn vela-settings-menu-trigger"
        type="button"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-native-tooltip="Settings"
        onClick={() => setIsOpen((open) => !open)}
      >
        <Settings size={16} aria-hidden />
        <span>Settings</span>
      </button>

      {isOpen ? (canPortal ? createPortal(menu, document.body) : menu) : null}
    </div>
  );
}

function canUseDocument() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

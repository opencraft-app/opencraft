import { MessageSquareText, Plus, Search } from "lucide-react";
import type { SessionListItemWire } from "../../../../vela-chat-client/src";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSettingsMenu,
  VelaSidebarChrome,
} from "../sidebar";
import { SessionItem } from "./SessionItem";

export interface SessionSidebarProps {
  sessions: SessionListItemWire[];
  currentSessionId: string | null;
  searchQuery?: string;
  showTrafficLights?: boolean;
  accountLabel?: string;
  accountPlanLabel?: string;
  canClearSessions?: boolean;
  canCreateSession?: boolean;
  defaultSettingsMenuOpen?: boolean;
  onCreateSession: () => void;
  onClearSessions?: () => void;
  onOpenSettings?: () => void;
  onSearch?: (query: string) => void;
  onSelectSession: (sessionId: string) => void;
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  searchQuery = "",
  showTrafficLights = false,
  accountLabel,
  accountPlanLabel,
  canClearSessions,
  canCreateSession = true,
  defaultSettingsMenuOpen = false,
  onCreateSession,
  onClearSessions,
  onOpenSettings,
  onSearch,
  onSelectSession,
}: SessionSidebarProps) {
  return (
    <Sidebar>
      <VelaSidebarChrome showTrafficLights={showTrafficLights} />
      <SidebarContent>
        <div className="vela-sidebar-fixed-controls">
          <div className="new-session-row">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="new-session-btn"
                  disabled={!canCreateSession}
                  onClick={onCreateSession}
                  aria-label="New chat"
                  size="compact"
                >
                  <Plus size={18} />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>

          <label className="search-box">
            <Search size={16} aria-hidden />
            <input
              value={searchQuery}
              onChange={(event) => onSearch?.(event.target.value)}
              placeholder="Search sessions"
            />
          </label>
        </div>

        <div className="stable-session-list">
          <div className="sidebar-section-heading vela-threads-heading">
            <MessageSquareText size={14} aria-hidden />
            Chats
          </div>

          <SidebarMenu className="session-list">
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === currentSessionId}
                onSelect={() => onSelectSession(session.id)}
              />
            ))}
          </SidebarMenu>
        </div>
      </SidebarContent>
      <SidebarFooter>
        <SidebarSettingsMenu
          accountLabel={accountLabel}
          accountPlanLabel={accountPlanLabel}
          canClearSessions={canClearSessions ?? sessions.length > 0}
          defaultOpen={defaultSettingsMenuOpen}
          onClearSessions={onClearSessions}
          onOpenSettings={onOpenSettings}
        />
      </SidebarFooter>
    </Sidebar>
  );
}

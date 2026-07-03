import { MessageSquareText, Plus, Search } from "lucide-react";
import type { SessionListItemWire } from "../../../../vela-chat-client/src";
import {
  SessionListSurface,
  type SessionDragPreviewInput,
} from "../../../../vela-chat-web/src/surfaces/SessionListSurface";
import {
  Sidebar,
  SidebarChromeArea,
  SidebarContent,
  SidebarContentFade,
  SidebarFixedFooter,
  SidebarMaterialFrame,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarScrollRegion,
  SidebarSettingsMenu,
  VelaSidebarChrome,
} from "../sidebar";

export interface SessionSidebarProps {
  sessions: SessionListItemWire[];
  currentSessionId: string | null;
  searchQuery?: string;
  showTrafficLights?: boolean;
  canClearSessions?: boolean;
  canCreateSession?: boolean;
  defaultSettingsMenuOpen?: boolean;
  onCreateSession: () => void;
  onArchiveSession?: (sessionId: string) => void | Promise<void>;
  onClearSessions?: () => void;
  onSessionDragPreviewEnd?: () => void;
  onSessionDragPreviewMove?: (input: SessionDragPreviewInput) => void;
  onSessionDragPreviewStart?: (input: SessionDragPreviewInput) => void;
  onOpenSettings?: () => void;
  onSearch?: (query: string) => void;
  onSelectSession: (sessionId: string) => void;
}

/**
 * Desktop-only sidebar composition.
 *
 * This component includes desktop shell chrome, material framing, fixed footer
 * behavior, and desktop sidebar CSS contracts. Web/cloud/mobile hosts should
 * compose their own host sidebar and embed `SessionListSurface` directly
 * instead of importing `SessionSidebar`.
 */
export function SessionSidebar({
  sessions,
  currentSessionId,
  searchQuery = "",
  showTrafficLights = false,
  canClearSessions,
  canCreateSession = true,
  defaultSettingsMenuOpen = false,
  onCreateSession,
  onArchiveSession,
  onClearSessions,
  onSessionDragPreviewEnd,
  onSessionDragPreviewMove,
  onSessionDragPreviewStart,
  onOpenSettings,
  onSearch,
  onSelectSession,
}: SessionSidebarProps) {
  return (
    <Sidebar>
      <SidebarMaterialFrame>
        <VelaSidebarChrome showTrafficLights={showTrafficLights} />
        <SidebarContent>
          <SidebarChromeArea>
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
          </SidebarChromeArea>
          <SidebarScrollRegion>
            <div className="sidebar-section-heading vela-threads-heading">
              <MessageSquareText size={14} aria-hidden />
              Chats
            </div>

            <SessionListSurface
              currentSessionId={currentSessionId}
              sessions={sessions}
              onArchiveSession={onArchiveSession}
              onSessionDragPreviewEnd={onSessionDragPreviewEnd}
              onSessionDragPreviewMove={onSessionDragPreviewMove}
              onSessionDragPreviewStart={onSessionDragPreviewStart}
              onSelectSession={onSelectSession}
            />
          </SidebarScrollRegion>
        </SidebarContent>
        <SidebarFixedFooter>
          <SidebarSettingsMenu
            canClearSessions={canClearSessions ?? sessions.length > 0}
            defaultOpen={defaultSettingsMenuOpen}
            onClearSessions={onClearSessions}
            onOpenSettings={onOpenSettings}
          />
        </SidebarFixedFooter>
      </SidebarMaterialFrame>
    </Sidebar>
  );
}

import type {
  Account,
  AcceptedResource,
  ActiveConversation,
  Agent,
  AttachmentSource,
  Channel,
  ComposerDraft,
  ConversationSummary,
  CreateChannelInput,
  DirectConversation,
  Member,
  Message,
  MessageQuote,
  MessageThread,
  Server,
  UpdateChannelInput,
} from "@vela/client-core";
import {
  isEveryoneChannel,
  memberCanManageServer,
} from "@vela/client-core";
import {
  useEffect,
  useState,
  type ReactElement,
} from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {useUnistyles} from "react-native-unistyles";
import {styles} from "./workspace-shell.styles";
import {
  conversationPageModel,
  type ConversationFormMode,
  type ConversationSemanticState,
} from "./workspace-shell-model";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import AtSign from "lucide-react-native/icons/at-sign";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Hash from "lucide-react-native/icons/hash";
import LogOut from "lucide-react-native/icons/log-out";
import Menu from "lucide-react-native/icons/menu";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import Search from "lucide-react-native/icons/search";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";
import Ellipsis from "lucide-react-native/icons/ellipsis";

import {
  MessageComposer,
  type MentionableMember,
} from "../components/message-composer";
import { MessageList } from "../components/message-list";
import type {
  ConversationCapabilities,
  ConversationSurfaceMode,
  MessageParticipant,
} from "../components/message-presentation";
import type {OperationStatusItem} from "../components/operation-status-list";
import {OperationStatusIsland} from "../components/operation-status-island";
import { ThreadPanel } from "../components/thread-panel";
import {
  ClearableSearchField,
  SearchEmptyCard,
} from "../components/clearable-search-field";
import { UserPicker } from "../components/user-picker";
import {
  CollectionIdentityMark,
  InlineEmptyState,
  ManagementField,
  ManagementTextInput,
} from "../components/management-workspace";
import {SystemButton, SystemIconButton} from "../primitives/system-button";
import {SystemSegmentedControl} from "../primitives/system-segmented-control";
import {SystemSourceListRow} from "../primitives/system-source-list-row";
import {SystemFeedback} from "../primitives/system-feedback";
import {SystemDialog} from "../primitives/system-dialog";
import {SystemFloatingHeader} from "../primitives/system-floating-header";
import {
  memberIdentityLabel,
  memberKindLabel,
  visibleMemberHandle,
} from "../member-identity";
import { workspaceLayoutMode } from "../workspace-layout-mode";
import { velaTheme } from "../tokens";
import {
  ConversationPresentation,
  type ConversationPageModel,
} from "../presentation";
import {
  channelDirectoryRow,
  conversationDirectory,
  directDirectoryRow,
  directIdentitySummary,
  draftLabel,
} from "./conversation-directory";
import {
  conversationScope,
  type ConversationScope,
} from "./conversation-scope";
import {
  HumanAccountIdentity,
  MobileBottomNavigation,
  PlatformFrame,
} from "./app-frame";
import { MaybeLink } from "./navigation-link";
import {
  useRegisterCompactNavigation,
  useWorkspaceChromeHost,
  workspaceSectionBody,
} from "./workspace-chrome";
import type { WorkspaceImStatus, WorkspaceSection } from "./workspace-section";

const channelMessageCapabilities: ConversationCapabilities = {
  deliveryReceipt: "none",
  tasks: true,
  threads: true,
};

const directMessageCapabilities: ConversationCapabilities = {
  deliveryReceipt: "direct",
  tasks: false,
  threads: false,
};

function channelMessageParticipants(
  agents: readonly Agent[],
  members: readonly MentionableMember[],
): MessageParticipant[] {
  const participants = new Map<string, MessageParticipant>();
  for (const member of members) {
    participants.set(member.imUserId, {
      displayName: member.displayName,
      imUserId: member.imUserId,
      kind: member.kind,
    });
  }
  for (const agent of agents) {
    if (!agent.imUserId) continue;
    participants.set(agent.imUserId, {
      displayName: agent.displayName,
      imUserId: agent.imUserId,
      kind: "agent",
    });
  }
  return [...participants.values()];
}

export interface WorkspaceShellProps {
  account?: Account | null;
  activeConversation?: ActiveConversation | null;
  activeSection?: WorkspaceSection;
  /**
   * When false, render chat body only. Parent WorkspaceChrome owns the shared
   * rail / bottom bar; compact chat registers its picker-aware bar there.
   * Defaults to false under WorkspaceChrome, true when standing alone.
   */
  framed?: boolean;
  activeThread?: MessageThread | null;
  agents: Agent[];
  canManageChannels?: boolean;
  channelMembers?: Member[];
  channels: Channel[];
  conversationDrafts?: Record<string, ComposerDraft>;
  conversationSummaries?: ConversationSummary[];
  channelHref?(channel: Channel): string;
  currentChannelId: string | null;
  currentImUserId?: string;
  currentServerId: string | null;
  directConversations?: DirectConversation[];
  directHref?(peerUserId: string): string;
  directConversationSync?: "complete" | "idle" | "pending";
  error?: string | null;
  historyCompleted?: boolean;
  initializingMessages?: boolean;
  imStatus: WorkspaceImStatus;
  imStatusMessage?: string;
  loadingOlder?: boolean;
  members?: Member[];
  messages: Message[];
  mentionMembers?: MentionableMember[];
  messageFocusRequest?: { messageId: string; revision: number } | null;
  onAddChannelMember?(memberId: string): void | Promise<void>;
  onAttachFile?(): AttachmentSource | null | Promise<AttachmentSource | null>;
  onAttachImage?(): AttachmentSource | null | Promise<AttachmentSource | null>;
  onAttachLocalPath?(input: {
    kind: "file" | "image";
    path: string;
  }): void | Promise<void>;
  onClearQuote?(): void | Promise<void>;
  onClearMessageSearch?(): void;
  onCloseThread?(): void | Promise<void>;
  onCreateTaskFromMessage?(messageId: string): void | Promise<void>;
  onCreateChannel?(
    input: CreateChannelInput,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onLoadMoreSearchResults?(): void | Promise<void>;
  onLocateSearchResult?(messageId: string): void | Promise<void>;
  onContinueOperation?(operationId: string): void | Promise<void>;
  onLoadMoreThreadReplies?(): void | Promise<void>;
  onDraftChange?(draft: ComposerDraft): void;
  onLogout?(): void | Promise<void>;
  onNavigateSection?(section: WorkspaceSection): void;
  onLoadOlder?(): void | Promise<void>;
  onOpenChannelManagement?(): void | Promise<void>;
  onOpenThread?(messageId: string): void | Promise<void>;
  onRemoveChannelMember?(memberId: string): void | Promise<void>;
  onQuoteMessage?(messageId: string): void | Promise<void>;
  onReconnect?(): void | Promise<void>;
  onRevokeMessage?(messageId: string): void | Promise<void>;
  onRetryMessage?(messageId: string): void | Promise<void>;
  onRetryThreadReplyIndex?(messageId: string): void | Promise<void>;
  onSearchMessages?(query: string): void | Promise<void>;
  onSelectChannel(channelId: string): void | Promise<void>;
  onSelectDirect?(peerUserId: string): void | Promise<void>;
  onSelectServer(serverId: string): void | Promise<void>;
  onSend(draft: ComposerDraft): void | Promise<void>;
  onSendThreadReply?(input: {
    mentionedUserIds: string[];
    text: string;
  }): void | Promise<void>;
  onUpdateChannel?(
    channelId: string,
    input: UpdateChannelInput,
  ): void | Promise<void>;
  onToggleReaction?(
    messageId: string,
    reactionId: string,
  ): void | Promise<void>;
  pendingAction?: string | null;
  operations?: OperationStatusItem[];
  sectionHref?(section: WorkspaceSection): string;
  pendingThreadIndexMessageIds?: string[];
  searchCompleted?: boolean;
  searchError?: string | null;
  searchLocateError?: string | null;
  locatingSearchResultId?: string | null;
  searchQuery?: string;
  searchResults?: Message[];
  searchingMessages?: boolean;
  selectedQuote?: MessageQuote | null;
  sending?: boolean;
  sendingThreadReply?: boolean;
  serverAgents?: Agent[];
  servers: Server[];
  serverHref?(server: Server): string;
  threadCompleted?: boolean;
  threadLoading?: boolean;
  threadMessages?: Message[];
  threadRootMessage?: Message | null;
  viewportWidth?: number;
}
export function WorkspaceShell(props: WorkspaceShellProps) {
  const [formMode, setFormMode] = useState<ConversationFormMode>(null);
  const [formValue, setFormValue] = useState("");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const semantic: ConversationSemanticState = {
    closeForm() {
      setFormMode(null);
      setFormValue("");
      setFormValues({});
    },
    formMode,
    formValue,
    formValues,
    openForm(mode, value = "", values = {}) {
      setFormValue(value);
      setFormValues(values);
      setFormMode(mode);
    },
    setFormField(id, value) {
      setFormValues((current) => ({ ...current, [id]: value }));
    },
    setFormValue,
  };
  const scope = conversationScope(props);
  return (
    <ConversationPresentation
      model={() => conversationPageModel(props, semantic, scope)}
    >
      {(pageModel) => (
        <GraphicalWorkspaceShell
          {...props}
          pageModel={pageModel}
          scope={scope}
        />
      )}
    </ConversationPresentation>
  );
}

function GraphicalWorkspaceShell({
  account = null,
  activeThread = null,
  agents,
  canManageChannels = false,
  framed,
  channelMembers = [],
  channels,
  conversationDrafts = {},
  conversationSummaries = [],
  channelHref,
  currentChannelId,
  currentImUserId,
  currentServerId,
  directConversations = [],
  directHref,
  directConversationSync = "idle",
  historyCompleted = true,
  initializingMessages = false,
  imStatus,
  imStatusMessage,
  loadingOlder = false,
  locatingSearchResultId = null,
  members = [],
  messageFocusRequest = null,
  messages,
  mentionMembers = [],
  onAddChannelMember = () => undefined,
  onAttachFile = () => null,
  onAttachImage = () => null,
  onClearMessageSearch = () => undefined,
  onClearQuote = () => undefined,
  onCloseThread = () => undefined,
  onCreateTaskFromMessage = () => undefined,
  onCreateChannel = () => null,
  onContinueOperation = () => undefined,
  onDraftChange = () => undefined,
  onLoadMoreSearchResults = () => undefined,
  onLocateSearchResult = () => undefined,
  onLoadMoreThreadReplies = () => undefined,
  onLoadOlder = () => undefined,
  onLogout,
  onNavigateSection = () => undefined,
  onOpenChannelManagement = () => undefined,
  onOpenThread = () => undefined,
  onRemoveChannelMember = () => undefined,
  onQuoteMessage = () => undefined,
  onReconnect,
  onRevokeMessage = () => undefined,
  onRetryMessage = () => undefined,
  onRetryThreadReplyIndex = () => undefined,
  onSearchMessages = () => undefined,
  onSelectChannel,
  onSelectDirect = () => undefined,
  onSelectServer,
  onSend,
  onSendThreadReply = () => undefined,
  onToggleReaction = () => undefined,
  onUpdateChannel = () => undefined,
  operations = [],
  pendingAction = null,
  pendingThreadIndexMessageIds = [],
  searchCompleted = true,
  searchError = null,
  searchLocateError = null,
  searchQuery = "",
  searchResults = [],
  searchingMessages = false,
  selectedQuote = null,
  sending = false,
  sendingThreadReply = false,
  serverAgents = agents,
  sectionHref,
  servers,
  serverHref,
  threadCompleted = true,
  threadLoading = false,
  threadMessages = [],
  threadRootMessage = null,
  pageModel,
  scope,
  viewportWidth,
}: WorkspaceShellProps & {
  pageModel: ConversationPageModel;
  scope: ConversationScope;
}) {
  const window = useWindowDimensions();
  const mode = workspaceLayoutMode(viewportWidth ?? window.width);
  const activeSection = pageModel.shell.activeSection;
  const error = pageModel.error ?? null;
  const [conversationPickerOpen, setConversationPickerOpen] = useState(false);
  const [channelManagementMode, setChannelManagementMode] = useState<
    "create" | "edit" | "members" | null
  >(null);
  const [directPickerOpen, setDirectPickerOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  useEffect(() => {
    if (messageFocusRequest) setMessageSearchOpen(false);
  }, [messageFocusRequest]);
  const {
    activeConversation,
    activeDirectConversation,
    activeDirectMember,
    activeDraft,
    canJoinCurrentChannel,
    capabilities,
    currentChannel,
    currentMember,
    currentServer,
    directCandidates,
    joiningCurrentChannel,
  } = scope;
  function changeMessageSearchOpen(open: boolean): void {
    setMessageSearchOpen(open);
    if (!open) onClearMessageSearch();
  }
  const joinCurrentChannel =
    canJoinCurrentChannel && currentMember
      ? () => onAddChannelMember(currentMember.id)
      : undefined;
  const canManageServer = memberCanManageServer(currentMember);
  const chromeHosted = useWorkspaceChromeHost();
  const ownsFrame = framed ?? !chromeHosted;
  const renderCompactNavigation = () =>
    messageSearchOpen ? null : (
      <MobileBottomNavigation
        activeSection={activeSection}
        canManageServer={canManageServer}
        navigationOpen={conversationPickerOpen}
        onNavigateSection={onNavigateSection}
        onToggle={() =>
          channelManagementMode
            ? setChannelManagementMode(null)
            : setConversationPickerOpen((current) => !current)
        }
        sectionHref={sectionHref}
      />
    );
  useRegisterCompactNavigation(
    ownsFrame
      ? undefined
      : mode === "compact"
        ? renderCompactNavigation
        : null,
  );

  if (mode === "compact") {
    const compactBody = (
      <>
        {channelManagementMode || directPickerOpen ? null : (
          <CompactHeader
            activeDirectConversation={activeDirectConversation}
            activeDirectMember={activeDirectMember}
            channelMemberCount={channelMembers.length}
            channel={currentChannel}
            imStatus={imStatus}
            navigationOpen={conversationPickerOpen}
            canSearch={capabilities.search}
            onOpenChannelMembers={async () => {
              await onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("members");
            }}
            onOpenNavigation={() =>
              setConversationPickerOpen((current) => !current)
            }
            onSearch={() => changeMessageSearchOpen(!messageSearchOpen)}
            searchOpen={messageSearchOpen}
            server={currentServer}
          />
        )}
        {channelManagementMode ? (
          <ChannelManagementPanel
            canManageMembers={canManageChannels}
            channel={currentChannel}
            channelMembers={channelMembers}
            compact
            currentImUserId={currentImUserId}
            disabled={pendingAction !== null}
            key={`${channelManagementMode}:${currentChannel?.id ?? "new"}`}
            members={members}
            mode={channelManagementMode}
            onAddMember={onAddChannelMember}
            onClose={() => setChannelManagementMode(null)}
            onCreate={onCreateChannel}
            onRemoveMember={onRemoveChannelMember}
            onUpdate={onUpdateChannel}
          />
        ) : conversationPickerOpen ? (
          <CompactConversationPicker
            account={account}
            activeConversation={activeConversation}
            canManageChannels={canManageChannels}
            channels={channels}
            channelHref={channelHref}
            conversationDrafts={conversationDrafts}
            conversationSummaries={conversationSummaries}
            currentChannel={currentChannel}
            currentChannelId={currentChannelId}
            currentServerId={currentServerId}
            directConversations={directConversations}
            directHref={directHref}
            directConversationSync={directConversationSync}
            directCandidates={directCandidates}
            imStatus={imStatus}
            members={members}
            onCreateChannel={() => {
              void onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("create");
            }}
            onEditChannel={() => {
              void onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("edit");
            }}
            onManageMembers={() => {
              void onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("members");
            }}
            onLogout={onLogout}
            onNewDirect={() => {
              setConversationPickerOpen(false);
              setDirectPickerOpen(true);
            }}
            onSelectChannel={(channelId) => {
              setConversationPickerOpen(false);
              return onSelectChannel(channelId);
            }}
            onSelectDirect={(peerUserId) => {
              setConversationPickerOpen(false);
              return onSelectDirect(peerUserId);
            }}
            onSelectServer={onSelectServer}
            serverHref={serverHref}
            servers={servers}
          />
        ) : directPickerOpen ? (
          <DirectConversationPicker
            directHref={directHref}
            members={directCandidates}
            onClose={() => setDirectPickerOpen(false)}
            onNavigateMembers={() => {
              setDirectPickerOpen(false);
              onNavigateSection("members");
            }}
            onSelect={(peerUserId) => {
              setDirectPickerOpen(false);
              setConversationPickerOpen(false);
              return onSelectDirect(peerUserId);
            }}
          />
        ) : activeConversation?.kind === "channel" &&
          activeThread &&
          threadRootMessage ? (
          <ThreadPanel
            agents={agents}
            compact
            completed={threadCompleted}
            currentUserId={currentImUserId}
            loading={threadLoading}
            messages={threadMessages}
            onClose={onCloseThread}
            onLoadMore={onLoadMoreThreadReplies}
            onRetry={onRetryMessage}
            onRetryIndex={onRetryThreadReplyIndex}
            onSend={onSendThreadReply}
            pendingIndexMessageIds={pendingThreadIndexMessageIds}
            participants={channelMessageParticipants(agents, mentionMembers)}
            rootMessage={threadRootMessage}
            sending={sendingThreadReply}
            surfaceMode={Platform.OS === "web" ? "compact" : "native"}
            thread={activeThread}
          />
        ) : (
          <MessageStage
            agents={capabilities.mentions ? agents : []}
            channel={currentChannel}
            compact
            currentUserId={currentImUserId}
            directConversation={activeDirectConversation}
            directMember={activeDirectMember}
            draft={activeDraft}
            error={error}
            historyCompleted={historyCompleted}
            initializingMessages={initializingMessages}
            imStatus={imStatus}
            imStatusMessage={imStatusMessage}
            loadingOlder={loadingOlder}
            messages={messages}
            mentionMembers={
              capabilities.mentions ? mentionMembers : []
            }
            messageFocusRequest={messageFocusRequest}
            onAttachFile={onAttachFile}
            onAttachImage={onAttachImage}
            onClearQuote={onClearQuote}
            onDraftChange={onDraftChange}
            onCreateTaskFromMessage={
              capabilities.tasks ? onCreateTaskFromMessage : undefined
            }
            onContinueOperation={onContinueOperation}
            onLoadMoreSearchResults={onLoadMoreSearchResults}
            onLocateSearchResult={onLocateSearchResult}
            onLoadOlder={onLoadOlder}
            channelMemberCount={channelMembers.length}
            joiningChannel={joiningCurrentChannel}
            onJoinChannel={joinCurrentChannel}
            onOpenChannelMembers={async () => {
              await onOpenChannelManagement();
              setChannelManagementMode("members");
            }}
            onOpenThread={
              capabilities.threads ? onOpenThread : undefined
            }
            onQuoteMessage={onQuoteMessage}
            onReconnect={onReconnect}
            onRevokeMessage={onRevokeMessage}
            onRetryMessage={onRetryMessage}
            onSearchMessages={onSearchMessages}
            onSend={onSend}
            onToggleReaction={onToggleReaction}
            operations={operations}
            searchCompleted={searchCompleted}
            searchError={searchError}
            searchLocateError={searchLocateError}
            locatingSearchResultId={locatingSearchResultId}
            searchOpen={messageSearchOpen}
            searchQuery={searchQuery}
            searchResults={searchResults}
            searchingMessages={searchingMessages}
            onSearchOpenChange={changeMessageSearchOpen}
            selectedQuote={selectedQuote}
            sending={sending}
            viewportWidth={viewportWidth}
          />
        )}
      </>
    );
    if (!ownsFrame) return compactBody;
    return (
      <PlatformFrame
        account={account}
        activeSection={activeSection}
        canManageServer={canManageServer}
        currentServerId={currentServerId}
        imStatus={imStatus}
        navigation={null}
        onLogout={onLogout}
        onNavigateSection={onNavigateSection}
        onSelectServer={onSelectServer}
        renderCompactNavigation={renderCompactNavigation}
        sectionHref={sectionHref}
        serverHref={serverHref}
        servers={servers}
        viewportWidth={viewportWidth}
      >
        {compactBody}
      </PlatformFrame>
    );
  }

  const conversationSidebar = (
        <ConversationSidebar
          activeConversation={activeConversation}
          agents={serverAgents}
          canManageChannels={canManageChannels}
          channels={channels}
          channelHref={channelHref}
          conversationDrafts={conversationDrafts}
          conversationSummaries={conversationSummaries}
          currentChannel={currentChannel}
          currentChannelId={currentChannelId}
          currentServer={currentServer}
          currentServerHref={
            currentServer ? serverHref?.(currentServer) : undefined
          }
          directConversations={directConversations}
          directHref={directHref}
          directPickerOpen={directPickerOpen}
          directCandidates={directCandidates}
          members={members}
          memberCount={members.length}
          onCreateChannel={() => {
            void onOpenChannelManagement();
            setChannelManagementMode("create");
          }}
          onEditChannel={() => {
            void onOpenChannelManagement();
            setChannelManagementMode("edit");
          }}
          onManageMembers={() => {
            void onOpenChannelManagement();
            setChannelManagementMode("members");
          }}
          onNavigateMembers={() => {
            setDirectPickerOpen(false);
            onNavigateSection("members");
          }}
          onNewDirect={() => setDirectPickerOpen((current) => !current)}
          onSelectChannel={onSelectChannel}
          onSelectDirect={(peerUserId) => {
            setDirectPickerOpen(false);
            return onSelectDirect(peerUserId);
          }}
          onSelectServer={() => {
            if (currentServer) return onSelectServer(currentServer.id);
            return undefined;
          }}
        />
  );
  const desktopStage = (
      <>
      <MessageStage
        agents={capabilities.mentions ? agents : []}
        channel={currentChannel}
        currentUserId={currentImUserId}
        directConversation={activeDirectConversation}
        directMember={activeDirectMember}
        draft={activeDraft}
        error={error}
        historyCompleted={historyCompleted}
        initializingMessages={initializingMessages}
        imStatus={imStatus}
        imStatusMessage={imStatusMessage}
        loadingOlder={loadingOlder}
        messages={messages}
        mentionMembers={
          capabilities.mentions ? mentionMembers : []
        }
        messageFocusRequest={messageFocusRequest}
        onAttachFile={onAttachFile}
        onAttachImage={onAttachImage}
        onClearQuote={onClearQuote}
        onDraftChange={onDraftChange}
        onCreateTaskFromMessage={
          capabilities.tasks ? onCreateTaskFromMessage : undefined
        }
        onContinueOperation={onContinueOperation}
        onLoadMoreSearchResults={onLoadMoreSearchResults}
        onLocateSearchResult={onLocateSearchResult}
        onLoadOlder={onLoadOlder}
        channelMemberCount={channelMembers.length}
        joiningChannel={joiningCurrentChannel}
        onJoinChannel={joinCurrentChannel}
        onOpenChannelMembers={async () => {
          await onOpenChannelManagement();
          setChannelManagementMode("members");
        }}
        onOpenThread={
          capabilities.threads ? onOpenThread : undefined
        }
        onQuoteMessage={onQuoteMessage}
        onReconnect={onReconnect}
        onRevokeMessage={onRevokeMessage}
        onRetryMessage={onRetryMessage}
        onSearchMessages={onSearchMessages}
        onSend={onSend}
        onToggleReaction={onToggleReaction}
        operations={operations}
        searchCompleted={searchCompleted}
        searchError={searchError}
        searchLocateError={searchLocateError}
        locatingSearchResultId={locatingSearchResultId}
        searchOpen={messageSearchOpen}
        searchQuery={searchQuery}
        searchResults={searchResults}
        searchingMessages={searchingMessages}
        onSearchOpenChange={changeMessageSearchOpen}
        selectedQuote={selectedQuote}
        sending={sending}
        viewportWidth={viewportWidth}
      />
      {activeConversation?.kind === "channel" &&
      activeThread &&
      threadRootMessage ? (
        <ThreadPanel
          agents={agents}
          completed={threadCompleted}
          currentUserId={currentImUserId}
          loading={threadLoading}
          messages={threadMessages}
          onClose={onCloseThread}
          onLoadMore={onLoadMoreThreadReplies}
          onRetry={onRetryMessage}
          onRetryIndex={onRetryThreadReplyIndex}
          onSend={onSendThreadReply}
          pendingIndexMessageIds={pendingThreadIndexMessageIds}
          participants={channelMessageParticipants(agents, mentionMembers)}
          rootMessage={threadRootMessage}
          sending={sendingThreadReply}
          surfaceMode={Platform.OS === "web" ? "compact" : "native"}
          thread={activeThread}
        />
      ) : null}
      {channelManagementMode ? (
        <ChannelManagementPanel
          canManageMembers={canManageChannels}
          channel={currentChannel}
          channelMembers={channelMembers}
          currentImUserId={currentImUserId}
          disabled={pendingAction !== null}
          key={`${channelManagementMode}:${currentChannel?.id ?? "new"}`}
          members={members}
          mode={channelManagementMode}
          onAddMember={onAddChannelMember}
          onClose={() => setChannelManagementMode(null)}
          onCreate={onCreateChannel}
          onRemoveMember={onRemoveChannelMember}
          onUpdate={onUpdateChannel}
        />
      ) : null}
      </>
  );
  if (!ownsFrame) {
    return workspaceSectionBody(conversationSidebar, desktopStage);
  }
  return (
    <PlatformFrame
      account={account}
      activeSection={activeSection}
      canManageServer={canManageServer}
      currentServerId={currentServerId}
      imStatus={imStatus}
      onLogout={onLogout}
      onNavigateSection={onNavigateSection}
      onSelectServer={onSelectServer}
      sectionHref={sectionHref}
      serverHref={serverHref}
      servers={servers}
      viewportWidth={viewportWidth}
      navigation={conversationSidebar}
    >
      {desktopStage}
    </PlatformFrame>
  );
}

function ConversationSidebar({
  activeConversation,
  agents,
  canManageChannels,
  channelHref,
  channels,
  conversationDrafts,
  conversationSummaries,
  currentChannel,
  currentChannelId,
  currentServer,
  currentServerHref,
  directCandidates,
  directConversations,
  directHref,
  directPickerOpen,
  members,
  memberCount,
  onCreateChannel,
  onEditChannel,
  onManageMembers,
  onNavigateMembers,
  onNewDirect,
  onSelectChannel,
  onSelectDirect,
  onSelectServer,
}: {
  activeConversation: ActiveConversation | null;
  agents: Agent[];
  canManageChannels: boolean;
  channelHref?: WorkspaceShellProps["channelHref"];
  channels: Channel[];
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  currentChannel: Channel | undefined;
  currentChannelId: string | null;
  currentServer: Server | undefined;
  currentServerHref?: string;
  directCandidates: Member[];
  directConversations: DirectConversation[];
  directHref?: WorkspaceShellProps["directHref"];
  directPickerOpen: boolean;
  members: Member[];
  memberCount: number;
  onCreateChannel(): void;
  onEditChannel(): void;
  onManageMembers(): void;
  onNavigateMembers(): void;
  onNewDirect(): void;
  onSelectChannel(channelId: string): void | Promise<void>;
  onSelectDirect(peerUserId: string): void | Promise<void>;
  onSelectServer(): void | Promise<void>;
}) {
  const {theme} = useUnistyles();
  const [filter, setFilter] = useState("");
  const {
    channels: visibleChannels,
    directConversations: visibleDirectConversations,
    matched: hasSearchMatches,
    members: visibleMembers,
    searching: normalizedFilter,
  } = conversationDirectory({
    channels,
    conversationDrafts,
    conversationSummaries,
    directCandidates,
    directConversations,
    filter,
    members,
  });
  return (
    <View style={styles.conversationSidebar} testID="conversation-sidebar">
      <MaybeLink href={currentServerHref}>
        <Pressable
          accessibilityLabel={
            currentServer ? `打开 Server ${currentServer.name}` : "选择 Server"
          }
          accessibilityRole={currentServerHref ? "link" : "button"}
          disabled={!currentServer}
          onPress={currentServerHref ? undefined : onSelectServer}
          style={styles.sidebarHeader}
        >
          <View style={styles.sidebarHeaderIcon}>
            <Text style={styles.sidebarHeaderIconText}>
              {(currentServer?.name ?? "S").slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={styles.sidebarHeaderCopy}>
            <Text numberOfLines={1} style={styles.sidebarTitle}>
              {currentServer?.name ?? "选择 Server"}
            </Text>
            <Text numberOfLines={1} style={styles.sidebarSubtitle}>
              {memberCount} 位成员 · {agents.length} 个 Agent
            </Text>
          </View>
          <Ellipsis
            color={theme.semantic.color.iconMuted}
            size={theme.semantic.icon.size.small}
            strokeWidth={theme.semantic.icon.stroke.regular}
          />
        </Pressable>
      </MaybeLink>
      {!directPickerOpen ? (
        <ClearableSearchField
          accessibilityLabel="搜索频道、私信与成员"
          clearAccessibilityLabel="清除会话搜索"
          onChangeText={setFilter}
          placeholder="搜索频道、私信与成员"
          style={styles.sidebarSearch}
          value={filter}
        />
      ) : null}
      {!directPickerOpen &&
      (!normalizedFilter || visibleChannels.length > 0) ? (
        <>
          <View style={styles.sidebarSectionHeader}>
            <Text style={styles.sectionLabel}>频道</Text>
            <View style={styles.sidebarSectionActions}>
              <Text style={styles.sidebarCount}>{visibleChannels.length}</Text>
              {!normalizedFilter && canManageChannels ? (
                <>
                  <SystemIconButton
                    accessibilityLabel="新建 Channel"
                    icon={Plus}
                    onPress={onCreateChannel}
                    testID="channel-create-action"
                  />
                  {currentChannel && !isEveryoneChannel(currentChannel) ? (
                    <>
                      <SystemIconButton
                        accessibilityLabel={`编辑 Channel ${currentChannel.name}`}
                        icon={Pencil}
                        onPress={onEditChannel}
                        testID="channel-edit-action"
                      />
                      <SystemIconButton
                        accessibilityLabel={`管理 Channel ${currentChannel.name} 的成员`}
                        icon={UsersRound}
                        onPress={onManageMembers}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </View>
          </View>
          <ChannelList
            channelHref={channelHref}
            channels={visibleChannels}
            conversationDrafts={conversationDrafts}
            conversationSummaries={conversationSummaries}
            currentChannelId={currentChannelId}
            onSelectChannel={onSelectChannel}
          />
        </>
      ) : null}
      {!directPickerOpen &&
      (!normalizedFilter || visibleDirectConversations.length > 0) ? (
        <View style={styles.sidebarSectionHeader}>
          <Text style={styles.sectionLabel}>私信</Text>
          {!normalizedFilter ? (
            <SystemIconButton
              accessibilityLabel="新建私信"
              icon={Plus}
              onPress={onNewDirect}
            />
          ) : null}
        </View>
      ) : null}
      {directPickerOpen ? (
        <DirectConversationPicker
          directHref={directHref}
          embedded
          members={directCandidates}
          onClose={onNewDirect}
          onNavigateMembers={onNavigateMembers}
          onSelect={onSelectDirect}
        />
      ) : (
        <>
          {!normalizedFilter || visibleDirectConversations.length > 0 ? (
            <DirectConversationList
              activeConversation={activeConversation}
              conversations={visibleDirectConversations}
              conversationDrafts={conversationDrafts}
              directHref={directHref}
              emptyLabel="还没有私信。"
              members={members}
              onSelect={onSelectDirect}
            />
          ) : null}
          {normalizedFilter && visibleMembers.length > 0 ? (
            <>
              <View style={styles.sidebarSectionHeader}>
                <Text style={styles.sectionLabel}>成员</Text>
                <Text style={styles.sidebarCount}>{visibleMembers.length}</Text>
              </View>
              <DirectMemberList
                directHref={directHref}
                members={visibleMembers}
                onSelect={(peerUserId) => {
                  setFilter("");
                  return onSelectDirect(peerUserId);
                }}
              />
            </>
          ) : null}
          {normalizedFilter && !hasSearchMatches ? (
            <View style={styles.sidebarSearchEmpty}>
              <SearchEmptyCard
                description="换个关键词试试。"
                title="没有匹配的会话。"
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function DirectConversationList({
  activeConversation,
  conversations,
  conversationDrafts,
  directHref,
  emptyLabel,
  members,
  onSelect,
}: {
  activeConversation: ActiveConversation | null;
  conversations: DirectConversation[];
  conversationDrafts: Record<string, ComposerDraft>;
  directHref?: WorkspaceShellProps["directHref"];
  emptyLabel: string;
  members: Member[];
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.directList}
      style={styles.directScroller}
    >
      {conversations.length === 0 ? (
        <Text style={[styles.empty, styles.directEmpty]}>{emptyLabel}</Text>
      ) : null}
      {conversations.map((conversation) => {
        const row = directDirectoryRow(conversation, {
          activeConversation,
          conversationDrafts,
          directHref,
          members,
        });
        const action = row.href
          ? {href: row.href, kind: "link" as const}
          : {
              kind: "button" as const,
              onPress: () => onSelect(conversation.peerUserId),
            };
        return (
          <SystemSourceListRow
            {...action}
            accessibilityLabel={row.accessibilityLabel}
            key={conversation.conversationId}
            rowId={`direct-${conversation.conversationId}`}
            selected={row.selected}
            testID={`direct-row-${conversation.conversationId}`}
          >
            <CollectionIdentityMark
              identityKind={row.identityKind}
              monogram={row.monogram}
            />
            <View style={styles.channelButtonCopy}>
              <View style={styles.directHeader}>
                <Text
                  numberOfLines={1}
                  style={[styles.channelName, styles.directDisplayName]}
                >
                  {conversation.peerDisplayName}
                </Text>
                {row.identitySummary ? (
                  <Text numberOfLines={1} style={styles.directHandle}>
                    {row.identitySummary}
                  </Text>
                ) : null}
                {row.lastMessageTime ? (
                  <Text style={styles.directTime}>{row.lastMessageTime}</Text>
                ) : null}
              </View>
              <View style={styles.directFooter}>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.channelMeta,
                    styles.directPreview,
                    row.draftPreview ? styles.draftMeta : null,
                  ]}
                >
                  {row.preview}
                </Text>
                {row.unread ? (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>{row.unread}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </SystemSourceListRow>
        );
      })}
    </ScrollView>
  );
}

function DirectMemberList({
  directHref,
  members,
  onSelect,
}: {
  directHref?: WorkspaceShellProps["directHref"];
  members: Member[];
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.directList}
      style={styles.directScroller}
    >
      {members.map((member) => (
        <DirectMemberRow
          directHref={directHref}
          key={member.id}
          member={member}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

function DirectMemberRow({
  directHref,
  member,
  onSelect,
}: {
  directHref?: WorkspaceShellProps["directHref"];
  member: Member;
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  const href = member.imUserId ? directHref?.(member.imUserId) : undefined;
  const identitySummary = directIdentitySummary(member);
  const identityLabel = memberIdentityLabel(member);
  const action = href
    ? {href, kind: "link" as const}
    : {
        kind: "button" as const,
        onPress: () => member.imUserId && onSelect(member.imUserId),
      };
  return (
    <SystemSourceListRow
      {...action}
      accessibilityLabel={`私信 ${member.displayName}${identityLabel ? ` ${identityLabel}` : ""}`}
      rowId={`direct-member-${member.id}`}
    >
      <CollectionIdentityMark
        identityKind={member.kind}
        monogram={member.displayName.slice(0, 1)}
      />
      <View style={styles.channelButtonCopy}>
        <Text style={styles.channelName}>{member.displayName}</Text>
        <Text style={styles.channelMeta}>{identitySummary}</Text>
      </View>
    </SystemSourceListRow>
  );
}

function ChannelList({
  channelHref,
  channels,
  conversationDrafts,
  conversationSummaries,
  currentChannelId,
  emptyLabel = "这个 Server 还没有 Channel。",
  onSelectChannel,
}: Pick<
  WorkspaceShellProps,
  "channelHref" | "channels" | "currentChannelId" | "onSelectChannel"
> & {
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  emptyLabel?: string;
}) {
  const {theme} = useUnistyles();
  return (
    <ScrollView
      contentContainerStyle={styles.channelList}
      style={styles.channelScroller}
      testID="channel-scroller"
    >
      {channels.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : null}
      {channels.map((channel) => {
        const row = channelDirectoryRow(channel, {
          channelHref,
          conversationDrafts,
          conversationSummaries,
          currentChannelId,
        });
        const action = row.href
          ? {href: row.href, kind: "link" as const}
          : {
              kind: "button" as const,
              onPress: () => onSelectChannel(channel.id),
            };
        return (
          <SystemSourceListRow
            {...action}
            accessibilityLabel={row.accessibilityLabel}
            key={channel.id}
            rowId={`channel-${channel.id}`}
            selected={row.selected}
            testID={`channel-row-${channel.id}`}
          >
            <View
              style={[
                styles.channelIcon,
                row.selected && styles.channelIconSelected,
              ]}
            >
              <Hash
                color={
                  row.selected
                    ? theme.semantic.color.iconAccent
                    : theme.semantic.color.iconMuted
                }
                size={theme.semantic.icon.size.compact}
                strokeWidth={theme.semantic.icon.stroke.emphasis}
              />
            </View>
            <View style={styles.channelButtonCopy}>
              <View style={styles.directHeader}>
                <View style={styles.channelNameRow}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.channelName,
                      styles.channelNameInRow,
                      row.selected && styles.channelNameSelected,
                    ]}
                  >
                    {channel.name}
                  </Text>
                  <ChannelKindBadge channel={channel} />
                </View>
                {row.lastMessageTime ? (
                  <Text style={styles.directTime}>{row.lastMessageTime}</Text>
                ) : null}
              </View>
              <View style={styles.directFooter}>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.channelMeta,
                    styles.directPreview,
                    row.draftPreview ? styles.draftMeta : null,
                  ]}
                >
                  {row.preview}
                </Text>
                {!row.selected && row.unread ? (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>{row.unread}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </SystemSourceListRow>
        );
      })}
    </ScrollView>
  );
}

function ChannelKindBadge({ channel }: { channel: Channel }) {
  const label =
    isEveryoneChannel(channel)
      ? "系统"
      : channel.visibility === "private"
        ? "私密"
        : "公开";
  return (
    <View
      accessibilityLabel={channelKindLongLabel(channel)}
      style={[
        styles.channelKindBadge,
        channel.visibility === "private" && styles.channelKindBadgePrivate,
        isEveryoneChannel(channel) && styles.channelKindBadgeSystem,
      ]}
    >
      <Text style={styles.channelKindBadgeText}>{label}</Text>
    </View>
  );
}

function channelKindLongLabel(channel: Channel): string {
  if (isEveryoneChannel(channel)) return "所有成员自动加入";
  return channel.visibility === "private" ? "私密频道" : "公开频道";
}

function ChatActionErrorToast({
  compact,
  message,
}: {
  compact: boolean;
  message: string;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(
      () => setVisible(false),
      velaTheme.semantic.motion.dismissal.toast,
    );
    return () => clearTimeout(timer);
  }, [message]);

  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.chatErrorToastLayer,
        compact && styles.chatErrorToastLayerCompact,
      ]}
      testID="chat-error-toast-layer"
    >
      <SystemFeedback
        action={{
          accessibilityLabel: "关闭错误提示",
          label: "关闭",
          onPress: () => setVisible(false),
        }}
        kind="toast"
        message={message}
        testID="chat-error-toast"
        tone="danger"
      />
    </View>
  );
}

function MessageStage({
  agents,
  channel,
  channelMemberCount,
  compact = false,
  currentUserId,
  directConversation,
  directMember,
  draft,
  error,
  historyCompleted,
  initializingMessages,
  imStatus,
  imStatusMessage,
  loadingOlder,
  joiningChannel,
  locatingSearchResultId,
  messages,
  mentionMembers = [],
  messageFocusRequest,
  onAttachFile,
  onAttachImage,
  onClearQuote,
  onDraftChange,
  onCreateTaskFromMessage,
  onContinueOperation,
  onLoadMoreSearchResults,
  onLocateSearchResult,
  onLoadOlder,
  onJoinChannel,
  onOpenChannelMembers,
  onOpenThread,
  onQuoteMessage,
  onReconnect,
  onRevokeMessage,
  onRetryMessage,
  onSearchMessages,
  onSearchOpenChange,
  onSend,
  onToggleReaction,
  operations,
  searchCompleted,
  searchError,
  searchLocateError,
  searchOpen,
  searchQuery,
  searchResults,
  searchingMessages,
  selectedQuote,
  sending,
  viewportWidth,
}: {
  agents: Agent[];
  channel: Channel | undefined;
  channelMemberCount: number;
  compact?: boolean;
  currentUserId?: string;
  directConversation?: DirectConversation;
  directMember?: Member;
  draft: ComposerDraft;
  error?: string | null;
  historyCompleted: boolean;
  initializingMessages: boolean;
  imStatus: WorkspaceImStatus;
  imStatusMessage?: string;
  loadingOlder: boolean;
  joiningChannel: boolean;
  locatingSearchResultId: string | null;
  messages: Message[];
  mentionMembers?: MentionableMember[];
  messageFocusRequest: { messageId: string; revision: number } | null;
  onAttachFile: NonNullable<WorkspaceShellProps["onAttachFile"]>;
  onAttachImage: NonNullable<WorkspaceShellProps["onAttachImage"]>;
  onClearQuote: NonNullable<WorkspaceShellProps["onClearQuote"]>;
  onDraftChange: NonNullable<WorkspaceShellProps["onDraftChange"]>;
  onCreateTaskFromMessage?: WorkspaceShellProps["onCreateTaskFromMessage"];
  onContinueOperation: NonNullable<WorkspaceShellProps["onContinueOperation"]>;
  onLoadMoreSearchResults: NonNullable<
    WorkspaceShellProps["onLoadMoreSearchResults"]
  >;
  onLocateSearchResult: NonNullable<
    WorkspaceShellProps["onLocateSearchResult"]
  >;
  onLoadOlder: NonNullable<WorkspaceShellProps["onLoadOlder"]>;
  onJoinChannel?: () => void | Promise<void>;
  onOpenChannelMembers(): void | Promise<void>;
  onOpenThread?: WorkspaceShellProps["onOpenThread"];
  onQuoteMessage: NonNullable<WorkspaceShellProps["onQuoteMessage"]>;
  onReconnect?: WorkspaceShellProps["onReconnect"];
  onRevokeMessage: NonNullable<WorkspaceShellProps["onRevokeMessage"]>;
  onRetryMessage: NonNullable<WorkspaceShellProps["onRetryMessage"]>;
  onSearchMessages: NonNullable<WorkspaceShellProps["onSearchMessages"]>;
  onSearchOpenChange(open: boolean): void;
  onSend: WorkspaceShellProps["onSend"];
  onToggleReaction: NonNullable<WorkspaceShellProps["onToggleReaction"]>;
  operations: OperationStatusItem[];
  searchCompleted: boolean;
  searchError: string | null;
  searchLocateError: string | null;
  searchOpen: boolean;
  searchQuery: string;
  searchResults: Message[];
  searchingMessages: boolean;
  selectedQuote: MessageQuote | null;
  sending: boolean;
  viewportWidth?: number;
}) {
  const {theme} = useUnistyles();
  const direct = directConversation !== undefined;
  const capabilities = direct
    ? directMessageCapabilities
    : channelMessageCapabilities;
  const participants: MessageParticipant[] = directMember?.imUserId
    ? [
        {
          displayName: directMember.displayName,
          imUserId: directMember.imUserId,
          kind: directMember.kind,
        },
      ]
    : channelMessageParticipants(agents, mentionMembers);
  const surfaceMode: ConversationSurfaceMode =
    Platform.OS === "web" ? (compact ? "compact" : "desktop") : "native";
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(
    velaTheme.recipes.conversationWorkspace.composerSurfaceMetrics.desktop
      .surfaceMinHeight +
      velaTheme.recipes.desktopWorkspace.composerVerticalPadding,
  );
  const needsMembership =
    !direct &&
    channel !== undefined &&
    !channel.joined &&
    !isEveryoneChannel(channel);
  const repairingMembership =
    !direct && channel !== undefined && channel.joined && joiningChannel;
  const hasConversation = direct || channel !== undefined;
  const conversationTitle = direct
    ? directConversation.peerDisplayName
    : channel
      ? channel.name
      : "选择一个会话";
  const conversationDescription = direct
    ? directConversationDescription(directMember)
    : channel
      ? `${channelKindLongLabel(channel)} · ${channel.description || "Human 与 Agent 的日常协作"}`
      : "Human 与 Agent 的日常协作";
  const onlineAgentCount = agents.filter(
    (agent) => agent.observedState === "running",
  ).length;
  const hasAgents = agents.length > 0;
  const hasOnlineAgents = onlineAgentCount > 0;
  const conversationLabel = direct
    ? directConversation.peerDisplayName
    : undefined;
  const conversationKey = directConversation
    ? `direct:${directConversation.peerUserId}`
    : channel
      ? `channel:${channel.id}`
      : "conversation:none";
  const [searchDraft, setSearchDraft] = useState(searchQuery);
  const [openActionMessageId, setOpenActionMessageId] = useState<string | null>(
    null,
  );
  useEffect(() => setSearchDraft(searchQuery), [searchQuery]);
  useEffect(() => setOpenActionMessageId(null), [conversationKey]);
  const messageSearchPanel = searchOpen ? (
    <MessageSearchPanel
      compact={compact}
      completed={searchCompleted}
      draft={searchDraft}
      error={searchError}
      locateError={searchLocateError}
      locatingResultId={locatingSearchResultId}
      loading={searchingMessages}
      onChangeDraft={setSearchDraft}
      onClose={() => onSearchOpenChange(false)}
      onLoadMore={onLoadMoreSearchResults}
      onLocate={onLocateSearchResult}
      onSearch={() => onSearchMessages(searchDraft.trim())}
      query={searchQuery}
      results={searchResults}
    />
  ) : null;

  if (compact && searchOpen) {
    return (
      <View style={styles.messageStage} testID="message-stage">
        {messageSearchPanel}
      </View>
    );
  }

  return (
    <View style={styles.messageStage} testID="message-stage">
      {compact ? null : (
        <SystemFloatingHeader
          layoutMode="wide"
          testID="conversation-primary-header"
        >
          <View style={styles.messageHeader}>
            <View style={styles.messageHeaderIdentity}>
              <View style={styles.messageHeaderIcon}>
                {direct ? (
                  <AtSign
                    color={theme.semantic.color.iconSecondary}
                    size={theme.semantic.icon.size.medium}
                    strokeWidth={theme.semantic.icon.stroke.regular}
                  />
                ) : (
                  <Hash
                    color={theme.semantic.color.iconSecondary}
                    size={theme.semantic.icon.size.medium}
                    strokeWidth={theme.semantic.icon.stroke.regular}
                  />
                )}
              </View>
              <View style={styles.messageHeaderCopy}>
                <Text numberOfLines={1} style={styles.messageTitle}>
                  {conversationTitle}
                </Text>
                <Text numberOfLines={1} style={styles.messageSubtitle}>
                  {conversationDescription}
                </Text>
              </View>
            </View>
            <View style={styles.messageHeaderActions}>
              {!direct ? (
                <View
                  style={[
                    styles.onlineAgentsBadge,
                    !hasOnlineAgents && styles.onlineAgentsBadgeEmpty,
                  ]}
                  testID="online-agents-badge"
                >
                  <View
                    style={[
                      styles.onlineAgentsDot,
                      !hasOnlineAgents && styles.onlineAgentsDotEmpty,
                    ]}
                    testID="online-agents-dot"
                  />
                  <Text
                    style={[
                      styles.onlineAgentsText,
                      !hasOnlineAgents && styles.onlineAgentsTextEmpty,
                    ]}
                  >
                    {hasAgents
                      ? `${onlineAgentCount} 个 Agent 在线`
                      : "暂无在线 Agent"}
                  </Text>
                </View>
              ) : null}
              <Pressable
                accessibilityLabel={direct ? "搜索当前私信" : "搜索当前 Channel"}
                accessibilityRole="button"
                disabled={
                  !hasConversation || needsMembership || repairingMembership
                }
                onPress={() => onSearchOpenChange(!searchOpen)}
                style={styles.headerActionButton}
              >
                <Search
                  color={theme.semantic.color.iconSecondary}
                  size={theme.semantic.icon.size.medium}
                  strokeWidth={theme.semantic.icon.stroke.regular}
                />
              </Pressable>
              {!direct ? (
                <SystemButton
                  accessibilityLabel={`查看 Channel ${channel?.name ?? ""} 的 ${channelMemberCount} 位成员`}
                  align="center"
                  disabled={!channel}
                  icon={UsersRound}
                  variant="toolbar"
                  label={`${channelMemberCount} 位成员`}
                  onPress={onOpenChannelMembers}
                />
              ) : null}
              {imStatus === "ready" ? null : (
                <ConnectionBadge status={imStatus} />
              )}
            </View>
          </View>
        </SystemFloatingHeader>
      )}

      {messageSearchPanel}

      {error ? (
        <ChatActionErrorToast compact={compact} message={error} />
      ) : null}
      {!direct && operations.length > 0 ? (
        <OperationStatusIsland
          items={operations}
          onContinue={onContinueOperation}
          testID="conversation-operation-status-island"
          topInset={compact
            ? theme.spacing.md
            : theme.recipes.conversationWorkspace.stageTopOverlayInset}
        />
      ) : null}
      {isRecoverableImStatus(imStatus) && onReconnect ? (
        <View accessibilityRole="alert" style={styles.reconnectNotice}>
          <Text style={styles.reconnectNoticeText}>
            {imStatusMessage ?? "消息连接已中断，请重新连接"}
          </Text>
          <SystemButton
            accessibilityLabel="重新连接聊天"
            align="center"
            variant="standard"
            label="重新连接"
            onPress={onReconnect}
          />
        </View>
      ) : null}
      {repairingMembership ? (
        <View
          style={styles.channelJoinStage}
          testID="channel-membership-repair-state"
        >
          <InlineEmptyState
            description="正在重新同步当前账号的频道成员资格，完成后会自动恢复消息。"
            icon={Hash}
            title={`正在重新连接 #${channel.name}`}
          />
        </View>
      ) : needsMembership ? (
        <View style={styles.channelJoinStage}>
          <InlineEmptyState
            actionAccessibilityLabel={`加入 #${channel.name}`}
            actionBusy={joiningChannel}
            actionDisabled={joiningChannel}
            actionLabel={
              onJoinChannel
                ? joiningChannel
                  ? "正在加入…"
                  : `加入 #${channel.name}`
                : undefined
            }
            description={
              channel.visibility === "public"
                ? "加入后即可查看历史消息、发送消息，并与频道里的 Human 和 Agent 协作。"
                : "请联系频道管理员邀请你加入。"
            }
            icon={Hash}
            onAction={onJoinChannel}
            testID="channel-join-empty-state"
            title={
              channel.visibility === "public"
                ? "这是一个公开频道"
                : "你还不是这个私密频道的成员"
            }
          />
        </View>
      ) : (
        <>
          <MessageList
            bottomInset={
              surfaceMode === "desktop"
                ? composerOverlayHeight + velaTheme.spacing.sm
                : undefined
            }
            capabilities={capabilities}
            conversationKey={conversationKey}
            currentUserId={currentUserId}
            historyCompleted={historyCompleted}
            initializing={initializingMessages}
            focusRequest={messageFocusRequest}
            emptyDescription={
              direct || hasAgents
                ? "发送第一条消息，或 @Agent 分配一项工作。"
                : "发送第一条消息，开始与成员协作。"
            }
            loadingOlder={loadingOlder}
            messages={messages}
            onCreateTask={onCreateTaskFromMessage}
            onLoadOlder={onLoadOlder}
            onOpenActionMessageIdChange={setOpenActionMessageId}
            onOpenThread={onOpenThread}
            onQuote={onQuoteMessage}
            onRevoke={onRevokeMessage}
            onRetry={onRetryMessage}
            onToggleReaction={onToggleReaction}
            openActionMessageId={openActionMessageId}
            participants={participants}
            surfaceMode={surfaceMode}
            viewportWidth={viewportWidth}
          />

          <MessageComposer
            members={mentionMembers}
            channelName={channel?.name ?? "channel"}
            conversationLabel={conversationLabel}
            disabled={
              !hasConversation ||
              imStatus !== "ready" ||
              initializingMessages ||
              sending
            }
            draft={draft}
            key={
              directConversation
                ? `direct:${directConversation.peerUserId}`
                : channel
                  ? `channel:${channel.id}`
                  : "conversation:none"
            }
            onAttachFile={onAttachFile}
            onAttachImage={onAttachImage}
            onClearQuote={onClearQuote}
            onDraftChange={onDraftChange}
            onFocus={() => setOpenActionMessageId(null)}
            onHeightChange={
              surfaceMode === "desktop" ? setComposerOverlayHeight : undefined
            }
            onSend={onSend}
            quote={selectedQuote}
            surfaceMode={surfaceMode}
          />
        </>
      )}
    </View>
  );
}

function MessageSearchPanel({
  compact = false,
  completed,
  draft,
  error,
  locateError,
  locatingResultId,
  loading,
  onChangeDraft,
  onClose,
  onLoadMore,
  onLocate,
  onSearch,
  query,
  results,
}: {
  compact?: boolean;
  completed: boolean;
  draft: string;
  error: string | null;
  locateError: string | null;
  locatingResultId: string | null;
  loading: boolean;
  onChangeDraft(value: string): void;
  onClose(): void;
  onLoadMore(): void | Promise<void>;
  onLocate(messageId: string): void | Promise<void>;
  onSearch(): void | Promise<void>;
  query: string;
  results: Message[];
}) {
  const {theme} = useUnistyles();
  return (
    <View
      style={[styles.searchPanel, compact && styles.searchPanelCompact]}
      testID="message-search-panel"
    >
      <View style={styles.searchControls}>
        <TextInput
          autoFocus
          onChangeText={onChangeDraft}
          onSubmitEditing={onSearch}
          placeholder="搜索消息"
          returnKeyType="search"
          style={styles.searchInput}
          value={draft}
          {...({dataSet: {velaField: "form"}} as object)}
        />
        <SystemButton
          accessibilityLabel="执行消息搜索"
          align="center"
          busy={loading}
          disabled={loading || draft.trim().length === 0}
          variant="standard"
          label={loading ? "搜索中…" : "搜索"}
          onPress={onSearch}
        />
        <SystemIconButton
          accessibilityLabel="关闭消息搜索"
          icon={X}
          iconTestID="message-search-close-icon"
          onPress={onClose}
        />
      </View>
      {error ? (
        <View accessibilityRole="alert" style={styles.searchPanelError}>
          <Text style={styles.searchPanelErrorTitle}>搜索暂不可用</Text>
          <Text style={styles.searchPanelErrorText}>{error}</Text>
          <Text style={styles.searchPanelErrorHint}>
            可以修改关键词后重新搜索。
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.searchResults}
          style={compact ? styles.searchResultsViewport : undefined}
        >
          {locateError ? (
            <View
              accessibilityRole="alert"
              accessible
              style={styles.searchLocateError}
            >
              <Text style={styles.searchLocateErrorText}>{locateError}</Text>
              <Text style={styles.searchLocateErrorHint}>
                搜索结果仍保留，可以稍后重试。
              </Text>
            </View>
          ) : null}
          {results.length === 0 && !loading ? (
            <Text style={styles.searchEmpty}>
              {query.trim().length > 0
                ? `没有找到与「${query.trim()}」相关的消息。`
                : "输入关键词，搜索历史消息。"}
            </Text>
          ) : null}
          {results.map((message) => {
            const locating = locatingResultId === message.id;
            return (
              <Pressable
                accessibilityLabel={`定位到消息 ${message.text}`}
                accessibilityRole="button"
                aria-busy={locating}
                disabled={locatingResultId !== null}
                key={message.id}
                onPress={() => onLocate(message.id)}
                style={({ pressed }) => [
                  styles.searchResult,
                  pressed && styles.searchResultPressed,
                  locatingResultId !== null && styles.searchResultDisabled,
                ]}
              >
                <View style={styles.searchResultBody}>
                  <View style={styles.searchResultMeta}>
                    <Text style={styles.searchResultSender}>
                      {message.senderName}
                    </Text>
                    <Text style={styles.searchResultTime}>
                      {new Date(message.createdAt).toLocaleString("zh-CN")}
                    </Text>
                  </View>
                  <Text numberOfLines={3} style={styles.searchResultText}>
                    {message.text}
                  </Text>
                </View>
                <View style={styles.searchResultAction}>
                  <Text style={styles.searchResultActionText}>
                    {locating ? "定位中…" : "定位"}
                  </Text>
                  {locating ? null : (
                    <ArrowRight
                      color={theme.semantic.color.iconAccent}
                      size={theme.semantic.icon.size.compact}
                      strokeWidth={theme.semantic.icon.stroke.emphasis}
                    />
                  )}
                </View>
              </Pressable>
            );
          })}
          {!completed ? (
            <SystemButton
              accessibilityLabel="加载更多搜索结果"
              busy={loading}
              disabled={loading}
              variant="standard"
              label={loading ? "加载中…" : "加载更多"}
              onPress={onLoadMore}
            />
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const connectionStatusLabels: Record<WorkspaceImStatus, string | null> = {
  error: "连接异常",
  issuing_session: "连接中",
  kicked_out: "连接已断开",
  logging_in: "连接中",
  not_ready: "连接中断",
  ready: null,
  signed_out: "未连接",
  waiting_sdk_ready: "连接中",
};

function connectionStatusLabel(status: WorkspaceImStatus): string | null {
  return connectionStatusLabels[status];
}

function ConnectionBadge({ status }: { status: WorkspaceImStatus }) {
  const label = connectionStatusLabel(status);

  if (!label) {
    return null;
  }

  return (
    <View style={styles.connectionBadge}>
      <View
        style={[
          styles.connectionDot,
          status === "ready"
            ? styles.connectionDotReady
            : styles.connectionDotWaiting,
        ]}
      />
      <Text style={styles.connectionText}>{label}</Text>
    </View>
  );
}

function isRecoverableImStatus(status: WorkspaceImStatus): boolean {
  return (
    status === "not_ready" || status === "kicked_out" || status === "error"
  );
}


function directConversationDescription(member: Member | undefined): string {
  if (!member) {
    return "与你的私密协作会话";
  }

  const actor = memberKindLabel[member.kind];
  const handle = memberIdentityLabel(member);
  return handle ? `${actor} 私信 · ${handle}` : `${actor} 私信`;
}

function CompactHeader({
  activeDirectConversation,
  activeDirectMember,
  channelMemberCount,
  canSearch,
  channel,
  imStatus,
  navigationOpen,
  onOpenChannelMembers,
  onOpenNavigation,
  onSearch,
  searchOpen,
  server,
}: {
  activeDirectConversation: DirectConversation | undefined;
  activeDirectMember: Member | undefined;
  channelMemberCount: number;
  canSearch: boolean;
  channel: Channel | undefined;
  imStatus: WorkspaceImStatus;
  navigationOpen: boolean;
  onOpenChannelMembers(): void | Promise<void>;
  onOpenNavigation(): void;
  onSearch(): void;
  searchOpen: boolean;
  server: Server | undefined;
}) {
  const {theme} = useUnistyles();
  const connectionLabel = connectionStatusLabel(imStatus);
  return (
    <SystemFloatingHeader
      layoutMode="compact"
      testID="compact-primary-header"
    >
      <View style={styles.compactHeader}>
        {searchOpen ? null : (
          <Pressable
            accessibilityLabel={
              navigationOpen ? "关闭会话选择" : "打开 Server 与 Channel"
            }
            accessibilityRole="button"
            aria-expanded={navigationOpen}
            onPress={onOpenNavigation}
            style={({ pressed }) => [
              styles.compactPickerButton,
              styles.compactHeaderNavigationButton,
              pressed && styles.railItemPressed,
            ]}
          >
            <View testID="compact-header-menu-icon">
              {navigationOpen ? (
                <X
                  color={theme.semantic.color.iconAccent}
                  size={theme.semantic.icon.size.large}
                  strokeWidth={theme.semantic.icon.stroke.emphasis}
                />
              ) : (
                <Menu
                  color={theme.semantic.color.iconAccent}
                  size={theme.semantic.icon.size.large}
                  strokeWidth={theme.semantic.icon.stroke.emphasis}
                />
              )}
            </View>
          </Pressable>
        )}
        <View style={styles.compactHeaderCopy}>
          <Text numberOfLines={1} style={styles.compactEyebrow}>
            {activeDirectConversation
              ? directConversationDescription(activeDirectMember)
              : `${server?.name ?? "VELA"}${channel ? ` · ${channelKindLongLabel(channel)}` : ""}${connectionLabel ? ` · ${connectionLabel}` : ""}`}
          </Text>
          <Text numberOfLines={1} style={styles.compactTitle}>
            {navigationOpen
              ? "选择会话"
              : activeDirectConversation
                ? activeDirectConversation.peerDisplayName
                : channel
                  ? `# ${channel.name}`
                  : "选择会话"}
          </Text>
        </View>
        {navigationOpen || searchOpen ? null : (
          <SystemIconButton
            accessibilityLabel={
              activeDirectConversation ? "搜索当前私信" : "搜索当前 Channel"
            }
            disabled={!canSearch}
            icon={Search}
            iconTestID="compact-header-search-icon"
            onPress={onSearch}
          />
        )}
        {!activeDirectConversation &&
        channel &&
        !navigationOpen &&
        !searchOpen ? (
          <SystemButton
            accessibilityLabel={`查看 Channel ${channel.name} 的 ${channelMemberCount} 位成员`}
            align="center"
            disabled={!channel}
            icon={UsersRound}
            variant="toolbar"
            label={String(channelMemberCount)}
            onPress={onOpenChannelMembers}
          />
        ) : null}
      </View>
    </SystemFloatingHeader>
  );
}

function ChannelManagementPanel({
  canManageMembers,
  channel,
  channelMembers,
  compact = false,
  currentImUserId,
  disabled,
  members,
  mode,
  onAddMember,
  onClose,
  onCreate,
  onRemoveMember,
  onUpdate,
}: {
  canManageMembers: boolean;
  channel: Channel | undefined;
  channelMembers: Member[];
  compact?: boolean;
  currentImUserId?: string;
  disabled: boolean;
  members: Member[];
  mode: "create" | "edit" | "members";
  onAddMember(memberId: string): void | Promise<void>;
  onClose(): void;
  onCreate(
    input: CreateChannelInput,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onRemoveMember(memberId: string): void | Promise<void>;
  onUpdate(channelId: string, input: UpdateChannelInput): void | Promise<void>;
}) {
  const [description, setDescription] = useState(
    mode === "edit" ? (channel?.description ?? "") : "",
  );
  const [name, setName] = useState(
    mode === "edit" ? (channel?.name ?? "") : "",
  );
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  const [visibility, setVisibility] = useState<Channel["visibility"]>("public");
  const memberIds = new Set(channelMembers.map((item) => item.id));
  const humanCount = channelMembers.filter(
    (member) => member.kind === "human",
  ).length;
  const agentCount = channelMembers.length - humanCount;
  const availableAgents = members.filter(
    (member) => member.kind === "agent" && !memberIds.has(member.id),
  );
  const availableHumans = members.filter(
    (member) => member.kind === "human" && !memberIds.has(member.id),
  );
  const pendingRemovalHandle = pendingRemoval
    ? visibleMemberHandle(pendingRemoval)
    : null;
  const pendingRemovalIdentity = pendingRemoval
    ? pendingRemovalHandle
      ? `${pendingRemoval.displayName}（@${pendingRemovalHandle}）`
      : pendingRemoval.displayName
    : "";
  function renderMember(member: Member, joined: boolean): ReactElement {
    const visibleHandle = visibleMemberHandle(member);
    const memberKind = memberKindLabel[member.kind];
    const isCurrentMember =
      joined && Boolean(currentImUserId) && member.imUserId === currentImUserId;
    const canChangeMembership =
      !isEveryoneChannel(channel) &&
      (joined ? isCurrentMember || canManageMembers : canManageMembers);
    const actionLabel = joined ? (isCurrentMember ? "退出" : "移出") : "添加";
    const actionIdentity =
      !isCurrentMember && visibleHandle
        ? `${member.displayName} @${visibleHandle}`
        : member.displayName;
    return (
      <View key={member.id} style={styles.channelMemberRow}>
        <CollectionIdentityMark
          identityKind={member.kind}
          monogram={member.displayName.slice(0, 1)}
        />
        <View style={styles.channelMemberIdentity}>
          <Text numberOfLines={1} style={styles.channelMemberName}>
            {member.displayName}
          </Text>
          <View style={styles.channelMemberMetaRow}>
            {visibleHandle ? (
              <Text numberOfLines={1} style={styles.channelMemberMeta}>
                @{visibleHandle}
              </Text>
            ) : null}
            <Text style={styles.channelMemberKind}>{memberKind}</Text>
          </View>
        </View>
        {canChangeMembership ? (
          <SystemButton
            accessibilityLabel={`${joined ? actionLabel : "添加"} Channel ${actionIdentity}`}
            disabled={disabled}
            label={actionLabel}
            onPress={() =>
              joined ? setPendingRemoval(member) : onAddMember(member.id)
            }
            variant={joined ? "destructive" : "standard"}
          />
        ) : joined ? (
          <Text style={styles.channelMemberJoined}>已加入</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.channelManagementPanel,
        compact && styles.channelManagementPanelCompact,
      ]}
      testID="channel-management-panel"
    >
      <View style={styles.channelPanelHeader}>
        <View style={styles.channelPanelHeaderCopy}>
          <Text style={styles.messageEyebrow}>频道设置</Text>
          <Text style={styles.channelPanelTitle}>
            {mode === "create"
              ? "新建 Channel"
              : mode === "members"
                ? `#${channel?.name ?? ""} · ${channelMembers.length} 位成员`
                : `编辑 #${channel?.name ?? ""}`}
          </Text>
          {mode === "members" ? (
            <Text style={styles.channelPanelSummary}>
              {channel ? `${channelKindLongLabel(channel)} · ` : ""}
              {humanCount} 位自然人 · {agentCount} 个 Agent
            </Text>
          ) : null}
        </View>
        <SystemIconButton
          accessibilityLabel="关闭 Channel 管理"
          icon={X}
          iconTestID="channel-management-close-icon"
          onPress={onClose}
        />
      </View>
      {mode === "members" ? (
        <ScrollView contentContainerStyle={styles.channelMemberList}>
          {isEveryoneChannel(channel) ? null : (
            <View style={styles.channelMembershipContext}>
              <Text style={styles.channelMembershipContextText}>
                {channel?.visibility === "public"
                  ? "Server 成员可发现并自助加入；成员名单仍只属于这个 Channel。"
                  : "仅被添加的 Server 成员可以进入；成员名单只属于这个 Channel。"}
              </Text>
            </View>
          )}
          <UserPicker
            accessibilityLabel="搜索 Channel 成员"
            emptyDescription="换个关键词试试。"
            emptyTitle="没有匹配的成员或 Agent。"
            getItemKey={(member) => member.id}
            getSearchValues={(member) => [
              member.displayName,
              visibleMemberHandle(member) ?? "",
            ]}
            placeholder="搜索成员或 @handle"
            renderItem={(member, sectionId) =>
              renderMember(member, sectionId === "current")
            }
            sections={[
              {
                emptyText: "这个 Channel 还没有成员。",
                id: "current",
                items: channelMembers,
                title: "当前成员",
              },
              ...(canManageMembers && !isEveryoneChannel(channel)
                ? [
                    {
                      emptyText: "Server 中的 Agent 都已加入这个 Channel。",
                      id: "agents",
                      items: availableAgents,
                      title: "添加 Agent",
                    },
                    {
                      hideWhenEmpty: true,
                      id: "humans",
                      items: availableHumans,
                      title: "添加成员",
                    },
                  ]
                : []),
            ]}
          />
        </ScrollView>
      ) : (
        <View style={styles.channelForm} testID="channel-form">
          <ManagementField label="Channel 名称">
            <ManagementTextInput
              accessibilityLabel={
                mode === "create" ? "Channel 名称" : "编辑 Channel 名称"
              }
              editable={!disabled}
              onChangeText={setName}
              placeholder="例如：delivery"
              value={name}
            />
          </ManagementField>
          <ManagementField label="Channel 描述">
            <ManagementTextInput
              accessibilityLabel={
                mode === "create" ? "Channel 描述" : "编辑 Channel 描述"
              }
              editable={!disabled}
              multiline
              onChangeText={setDescription}
              placeholder="这个 Channel 用来做什么？"
              value={description}
            />
          </ManagementField>
          {mode === "create" ? (
            <ManagementField
              hint={
                visibility === "public"
                  ? "Server 成员可以发现并自助加入。"
                  : "仅被添加的 Server 成员可以进入。"
              }
              label="可见性"
            >
              <SystemSegmentedControl<"public" | "private">
                accessibilityLabel="Channel 可见性"
                disabled={disabled}
                onChange={setVisibility}
                options={[
                  {
                    accessibilityLabel: "设为公开 Channel",
                    label: "公开",
                    value: "public",
                  },
                  {
                    accessibilityLabel: "设为私密 Channel",
                    label: "私密",
                    value: "private",
                  },
                ]}
                value={visibility}
              />
            </ManagementField>
          ) : (
            <Text style={styles.channelVisibilityNotice}>
              可见性在创建后不可修改：
              {channel?.visibility === "private" ? "私密" : "公开"}
            </Text>
          )}
          <SystemButton
            accessibilityLabel={
              mode === "create" ? "创建 Channel" : "保存 Channel"
            }
            align="stretch"
            disabled={disabled || name.trim().length === 0}
            variant="standard"
            label={mode === "create" ? "创建 Channel" : "保存 Channel"}
            onPress={async () => {
              if (mode === "create") {
                await onCreate({
                  description: description.trim() || undefined,
                  name: name.trim(),
                  visibility,
                });
              } else if (channel) {
                await onUpdate(channel.id, {
                  description: description.trim(),
                  name: name.trim(),
                });
              }
              onClose();
            }}
          />
        </View>
      )}
      {pendingRemoval ? (
        <SystemDialog
          actions={[
            {
              id: "cancel",
              intent: "standard",
              kind: "cancel",
              label: pendingRemoval.imUserId === currentImUserId
                ? "继续留在 Channel"
                : "取消",
            },
            {
              disabled,
              id: "confirm",
              intent: "destructive",
              kind: "action",
              label: pendingRemoval.imUserId === currentImUserId
                ? "确认退出"
                : "确认移出",
            },
          ]}
          busy={disabled}
          description={pendingRemoval.imUserId === currentImUserId
            ? `退出后，你将无法继续收发 #${channel?.name ?? ""} 的消息。之后可由管理员重新添加。`
            : `移出后，${pendingRemovalIdentity}将无法继续收发 #${channel?.name ?? ""} 的消息。之后仍可重新添加。`}
          dialogId="channel-member-removal-confirmation"
          onAction={id => {
            if (id === "confirm") void onRemoveMember(pendingRemoval.id);
          }}
          onOpenChange={() => setPendingRemoval(null)}
          open
          title={pendingRemoval.imUserId === currentImUserId
            ? `退出 #${channel?.name ?? ""}？`
            : `移出 ${pendingRemovalIdentity}？`}
        />
      ) : null}
    </View>
  );
}

function CompactConversationPicker({
  account,
  activeConversation,
  canManageChannels,
  channelHref,
  channels,
  conversationDrafts,
  conversationSummaries,
  currentChannel,
  currentChannelId,
  currentServerId,
  directCandidates,
  directConversations,
  directHref,
  directConversationSync,
  imStatus,
  members,
  onCreateChannel,
  onEditChannel,
  onManageMembers,
  onLogout,
  onNewDirect,
  onSelectChannel,
  onSelectDirect,
  onSelectServer,
  serverHref,
  servers,
}: Pick<
  WorkspaceShellProps,
  | "channelHref"
  | "channels"
  | "currentChannelId"
  | "currentServerId"
  | "onSelectChannel"
  | "onSelectServer"
  | "serverHref"
  | "servers"
> & {
  account?: Account | null;
  activeConversation: ActiveConversation | null;
  canManageChannels: boolean;
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  currentChannel: Channel | undefined;
  directCandidates: Member[];
  directConversations: DirectConversation[];
  directHref?: WorkspaceShellProps["directHref"];
  directConversationSync: "complete" | "idle" | "pending";
  imStatus: WorkspaceImStatus;
  members: Member[];
  onCreateChannel(): void;
  onEditChannel(): void;
  onManageMembers(): void;
  onLogout?: (() => void | Promise<void>) | undefined;
  onNewDirect(): void;
  onSelectDirect(peerUserId: string): void | Promise<void>;
}) {
  const {theme} = useUnistyles();
  const [filter, setFilter] = useState("");
  const {
    channels: visibleChannels,
    directConversations: visibleDirectConversations,
    matched,
    members: visibleMembers,
    searching: normalizedFilter,
  } = conversationDirectory({
    channels,
    conversationDrafts,
    conversationSummaries,
    directCandidates,
    directConversations,
    filter,
    members,
  });
  const noMatches = !matched;
  return (
    <ScrollView
      contentContainerStyle={styles.compactPicker}
      testID="compact-conversation-picker"
    >
      {account ? (
        <View
          style={styles.compactAccountSummary}
          testID="compact-account-summary"
        >
          <HumanAccountIdentity account={account} imStatus={imStatus} />
        </View>
      ) : null}
      <Text style={styles.sectionLabel}>SERVERS</Text>
      <View style={styles.compactServerList}>
        {servers.map((server) => {
          const selected = server.id === currentServerId;
          const href = serverHref?.(server);
          return (
            <MaybeLink href={href} key={server.id}>
              <Pressable
                accessibilityLabel={`打开 Server ${server.name}`}
                accessibilityRole={href ? "link" : "button"}
                accessibilityState={{ selected }}
                aria-current={selected ? "page" : undefined}
                onPress={href ? undefined : () => onSelectServer(server.id)}
                style={[
                  styles.compactServerButton,
                  selected && styles.compactServerButtonSelected,
                ]}
              >
                <Text style={styles.compactServerInitial}>
                  {server.name.slice(0, 1).toUpperCase()}
                </Text>
                <Text style={styles.compactServerName}>{server.name}</Text>
              </Pressable>
            </MaybeLink>
          );
        })}
      </View>
      <ClearableSearchField
        accessibilityLabel="搜索频道、私信与成员"
        clearAccessibilityLabel="清除会话搜索"
        onChangeText={setFilter}
        placeholder="搜索频道、私信与成员"
        value={filter}
      />
      {noMatches ? (
        <SearchEmptyCard
          description="换个关键词试试。"
          title="没有匹配的会话。"
        />
      ) : null}
      {!noMatches && (!normalizedFilter || visibleChannels.length > 0) ? (
        <Text style={styles.sectionLabel}>频道</Text>
      ) : null}
      {!noMatches && !normalizedFilter && canManageChannels ? (
        <View style={styles.compactChannelActions}>
          <View style={styles.compactChannelActionSlot}>
            <SystemButton
              accessibilityLabel="新建 Channel"
              align="stretch"
              icon={Plus}
              iconTestID="compact-channel-create-icon"
              variant="standard"
              label="新建"
              onPress={onCreateChannel}
            />
          </View>
          {currentChannel && !isEveryoneChannel(currentChannel) ? (
            <>
              <View style={styles.compactChannelActionSlot}>
                <SystemButton
                  accessibilityLabel={`编辑 Channel ${currentChannel.name}`}
                  align="stretch"
                  icon={Pencil}
                  variant="standard"
                  label="编辑"
                  onPress={onEditChannel}
                />
              </View>
              <View style={styles.compactChannelActionSlot}>
                <SystemButton
                  accessibilityLabel={`管理 Channel ${currentChannel.name} 的成员`}
                  align="stretch"
                  icon={UsersRound}
                  variant="standard"
                  label="成员"
                  onPress={onManageMembers}
                />
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      {!noMatches && (!normalizedFilter || visibleChannels.length > 0) ? (
        <View style={styles.compactChannelList}>
          {visibleChannels.map((channel) => {
            const row = channelDirectoryRow(channel, {
              channelHref,
              conversationDrafts,
              conversationSummaries,
              currentChannelId,
            });
            const action = row.href
              ? {href: row.href, kind: "link" as const}
              : {
                  kind: "button" as const,
                  onPress: () => onSelectChannel(channel.id),
                };
            return (
              <SystemSourceListRow
                {...action}
                accessibilityLabel={row.accessibilityLabel}
                key={channel.id}
                rowId={`compact-channel-${channel.id}`}
                selected={row.selected}
              >
                <View style={styles.compactChannelIdentity}>
                  <Hash
                    color={
                      row.selected
                        ? theme.semantic.color.iconAccent
                        : theme.semantic.color.iconMuted
                    }
                    size={theme.semantic.icon.size.small}
                    strokeWidth={theme.semantic.icon.stroke.regular}
                  />
                  <View style={styles.channelButtonCopy}>
                    <View style={styles.channelNameRow}>
                      <Text
                        numberOfLines={1}
                        style={[styles.channelName, styles.channelNameInRow]}
                      >
                        {channel.name}
                      </Text>
                      <ChannelKindBadge channel={channel} />
                    </View>
                    <Text
                      numberOfLines={1}
                      style={
                        row.draftPreview
                          ? styles.draftMeta
                          : styles.channelMeta
                      }
                    >
                      {row.preview}
                    </Text>
                  </View>
                </View>
                {!row.selected && row.unread ? (
                  <Text style={styles.channelArrow}>{row.unread}</Text>
                ) : (
                  <View testID={`compact-channel-chevron-${channel.name}`}>
                    <ChevronRight
                      color={theme.semantic.color.iconMuted}
                      size={theme.semantic.icon.size.medium}
                      strokeWidth={theme.semantic.icon.stroke.regular}
                    />
                  </View>
                )}
              </SystemSourceListRow>
            );
          })}
        </View>
      ) : null}
      {!noMatches &&
      (!normalizedFilter || visibleDirectConversations.length > 0) ? (
        <View style={styles.compactSectionRow}>
          <Text style={styles.sectionLabel}>私信</Text>
          <Text style={styles.sidebarCount}>
            {directConversationSync === "pending"
              ? "SYNC"
              : directConversations.length}
          </Text>
        </View>
      ) : null}
      {!noMatches && !normalizedFilter ? (
        <SystemButton
          align="stretch"
          icon={Plus}
          variant="standard"
          label="新建私信"
          onPress={onNewDirect}
        />
      ) : null}
      {!noMatches &&
      (!normalizedFilter || visibleDirectConversations.length > 0) ? (
        <View style={styles.compactChannelList}>
          {visibleDirectConversations.map((conversation) => {
            const row = directDirectoryRow(conversation, {
              activeConversation,
              conversationDrafts,
              directHref,
              members,
            });
            const action = row.href
              ? {href: row.href, kind: "link" as const}
              : {
                  kind: "button" as const,
                  onPress: () => onSelectDirect(conversation.peerUserId),
                };
            return (
              <SystemSourceListRow
                {...action}
                accessibilityLabel={row.accessibilityLabel}
                key={conversation.conversationId}
                rowId={`compact-direct-${conversation.conversationId}`}
                selected={row.selected}
              >
                <CollectionIdentityMark
                  identityKind={row.identityKind}
                  monogram={row.monogram}
                />
                <View style={styles.channelButtonCopy}>
                  <View style={styles.directHeader}>
                    <Text
                      numberOfLines={1}
                      style={[styles.channelName, styles.directDisplayName]}
                    >
                      {conversation.peerDisplayName}
                    </Text>
                    {row.identitySummary ? (
                      <Text numberOfLines={1} style={styles.directHandle}>
                        {row.identitySummary}
                      </Text>
                    ) : null}
                  </View>
                  {draftLabel(row.draftPreview) ? (
                    <Text numberOfLines={1} style={styles.draftMeta}>
                      {draftLabel(row.draftPreview)}
                    </Text>
                  ) : null}
                </View>
                {row.unread ? (
                  <Text style={styles.channelArrow}>{row.unread}</Text>
                ) : (
                  <ChevronRight
                    color={theme.semantic.color.iconMuted}
                    size={theme.semantic.icon.size.medium}
                    strokeWidth={theme.semantic.icon.stroke.regular}
                  />
                )}
              </SystemSourceListRow>
            );
          })}
        </View>
      ) : null}
      {normalizedFilter && visibleMembers.length > 0 ? (
        <>
          <View style={styles.compactSectionRow}>
            <Text style={styles.sectionLabel}>成员</Text>
            <Text style={styles.sidebarCount}>
              {visibleMembers.length}
            </Text>
          </View>
          <View style={styles.compactChannelList}>
            {visibleMembers.map((member) => (
              <DirectMemberRow
                directHref={directHref}
                key={member.id}
                member={member}
                onSelect={onSelectDirect}
              />
            ))}
          </View>
        </>
      ) : null}
      {onLogout ? (
        <SystemButton
          align="stretch"
          icon={LogOut}
          variant="standard"
          label="退出当前账号"
          onPress={onLogout}
        />
      ) : null}
    </ScrollView>
  );
}


function DirectConversationPicker({
  directHref,
  embedded = false,
  members,
  onClose,
  onNavigateMembers,
  onSelect,
}: {
  directHref?: WorkspaceShellProps["directHref"];
  embedded?: boolean;
  members: Member[];
  onClose(): void;
  onNavigateMembers(): void;
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  return (
    <View
      style={[styles.compactPicker, embedded && styles.directPickerEmbedded]}
    >
      <View style={styles.directPickerHeader}>
        <Text style={styles.compactPickerTitle}>新建私信</Text>
        <SystemIconButton
          accessibilityLabel="关闭新建私信"
          icon={X}
          onPress={onClose}
        />
      </View>
      {members.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.directPickerScrollerContent}
          keyboardShouldPersistTaps="handled"
          style={styles.directScroller}
        >
          <UserPicker
            accessibilityLabel="搜索私信对象"
            clearAccessibilityLabel="清除私信对象搜索"
            emptyContent={<DirectPickerSearchEmptyState />}
            emptyDescription="试试输入名称或 @handle"
            emptyTitle="没有找到匹配的私信对象"
            getItemKey={(member) => member.id}
            getSearchValues={(member) => [
              member.displayName,
              visibleMemberHandle(member) ?? "",
            ]}
            placeholder="搜索成员或 @handle"
            renderItem={(member) => (
              <DirectMemberRow
                directHref={directHref}
                member={member}
                onSelect={onSelect}
              />
            )}
            sections={[
              {
                id: "direct",
                items: members,
                title: "可私信",
              },
            ]}
          />
        </ScrollView>
      ) : (
        <DirectPickerEmptyState onNavigateMembers={onNavigateMembers} />
      )}
    </View>
  );
}

function DirectPickerSearchEmptyState() {
  const {theme} = useUnistyles();
  return (
    <View style={styles.directPickerSearchEmpty}>
      <View style={styles.directPickerEmptyIcon}>
        <Search
          color={theme.semantic.color.iconAccent}
          size={theme.semantic.icon.size.large}
          strokeWidth={theme.semantic.icon.stroke.regular}
        />
      </View>
      <Text style={styles.directPickerEmptyTitle}>没有找到匹配的私信对象</Text>
      <Text style={styles.directPickerEmptyDescription}>
        试试输入名称或 @handle
      </Text>
    </View>
  );
}

function DirectPickerEmptyState({
  onNavigateMembers,
}: {
  onNavigateMembers(): void;
}) {
  const {theme} = useUnistyles();
  return (
    <View style={styles.directPickerEmpty}>
      <View style={styles.directPickerEmptyIcon}>
        <UsersRound
          color={theme.semantic.color.iconAccent}
          size={theme.semantic.icon.size.large}
          strokeWidth={theme.semantic.icon.stroke.regular}
        />
      </View>
      <Text style={styles.directPickerEmptyTitle}>暂无新的私信对象</Text>
      <Text style={styles.directPickerEmptyDescription}>
        已有私信可从会话列表继续。也可以前往成员页查看或邀请新成员。
      </Text>
      <SystemButton
        accessibilityLabel="前往成员页"
        align="center"
        variant="standard"
        label="查看成员"
        onPress={onNavigateMembers}
      />
    </View>
  );
}

import {selectCurrentHumanMember} from "@vela/client-core";

import type {AppStoreState} from "./app-store";

/**
 * State owned by the active chat surface. Keeping this projection free of
 * management resources prevents Computer/Task refreshes from invalidating the
 * conversation tree.
 */
export function selectConversationScreenState(state: AppStoreState) {
  return {
    account: state.account,
    activeConversation: state.activeConversation,
    activeThread: state.activeThread,
    agents: state.agents,
    authStatus: state.authStatus,
    channelMembers: state.channelMembers,
    channels: state.channels,
    conversationDrafts: state.conversationDrafts,
    conversationSummaries: state.conversationSummaries,
    currentChannelId: state.currentChannelId,
    currentServerId: state.currentServerId,
    directConversations: state.directConversations,
    directConversationSync: state.directConversationSync,
    error: state.error,
    historyCompleted: state.historyCompleted,
    imState: state.imState,
    loadingChannel: state.loadingChannel,
    loadingOlderMessages: state.loadingOlderMessages,
    locatingSearchResultId: state.locatingSearchResultId,
    members: state.members,
    messageFocusRequest: state.messageFocusRequest,
    messages: state.messages,
    operationsById: state.operationsById,
    pendingAction: state.pendingAction,
    pendingThreadIndexMessageIds: state.pendingThreadIndexMessageIds,
    searchCompleted: state.searchCompleted,
    searchError: state.searchError,
    searchLocateError: state.searchLocateError,
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    searchingMessages: state.searchingMessages,
    selectedQuote: state.selectedQuote,
    sendingMessage: state.sendingMessage,
    sendingThreadReply: state.sendingThreadReply,
    serverContextStatus: state.serverContextStatus,
    servers: state.servers,
    threadCompleted: state.threadCompleted,
    threadLoading: state.threadLoading,
    threadMessages: state.threadMessages,
    threadRootMessage: state.threadRootMessage,
  };
}

export type ManagementStateSection =
  | "agents"
  | "computers"
  | "members"
  | "settings"
  | "tasks";

const emptyAgents: AppStoreState["agents"] = [];
const emptyAgentProfileCapabilities: AppStoreState["agentProfileCapabilitiesById"] = {};
const emptyChannels: AppStoreState["channels"] = [];
const emptyComputers: AppStoreState["computers"] = [];
const emptyInbox: AppStoreState["inbox"] = [];
const emptyInvites: AppStoreState["invites"] = [];
const emptyMembers: AppStoreState["members"] = [];
const emptyOperations: AppStoreState["operationsById"] = {};
const emptyReminders: AppStoreState["reminders"] = [];
const emptyTasks: AppStoreState["tasks"] = [];

/**
 * State for one management route. Unused resources resolve to stable empty
 * values so Task polling cannot invalidate Computer, and vice versa.
 */
export function selectManagementState(
  state: AppStoreState,
  section: ManagementStateSection,
) {
  const usesAgents =
    section === "agents" || section === "computers" || section === "tasks";
  const usesComputers = section === "agents" || section === "computers";
  const usesOrganization = section === "members" || section === "settings";
  return {
    account: state.account,
    agents: usesAgents ? state.agents : emptyAgents,
    agentProfileCapabilitiesById:
      section === "agents"
        ? state.agentProfileCapabilitiesById
        : emptyAgentProfileCapabilities,
    channels:
      section === "agents" || usesOrganization
        ? state.channels
        : emptyChannels,
    computers: usesComputers ? state.computers : emptyComputers,
    currentMember: selectCurrentHumanMember(state.members, {
      accountId: state.account?.id,
      imUserId: state.account?.imUserId,
    }),
    currentServerId: state.currentServerId,
    error: state.error,
    imState: state.imState,
    inbox: section === "tasks" ? state.inbox : emptyInbox,
    invites: usesOrganization ? state.invites : emptyInvites,
    loadingAgents: usesAgents ? state.loadingAgents : false,
    loadingComputers: usesComputers ? state.loadingComputers : false,
    loadingOrganization: usesOrganization
      ? state.loadingOrganization
      : false,
    loadingReminders: section === "tasks" ? state.loadingReminders : false,
    loadingWork: section === "tasks" ? state.loadingWork : false,
    members: usesOrganization ? state.members : emptyMembers,
    operationsById:
      section === "agents" || usesOrganization
        ? state.operationsById
        : emptyOperations,
    pendingAction: state.pendingAction,
    reminders: section === "tasks" ? state.reminders : emptyReminders,
    servers: state.servers,
    tasks: section === "tasks" ? state.tasks : emptyTasks,
  };
}

/** Minimal state required by the Expo navigation adapter around management. */
export function selectManagementNavigationState(state: AppStoreState) {
  return {
    currentChannelId: state.currentChannelId,
    servers: state.servers,
  };
}

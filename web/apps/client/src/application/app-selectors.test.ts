import {shallow} from "zustand/vanilla/shallow";

import type {AppStoreState} from "./app-store";
import {
  selectConversationScreenState,
  selectManagementNavigationState,
  selectManagementState,
} from "./app-selectors";

function state(overrides: Partial<AppStoreState> = {}): AppStoreState {
  return {
    account: null,
    activeConversation: null,
    activeThread: null,
    agents: [],
    authStatus: "signed_in",
    channelMembers: [],
    channels: [],
    computers: [],
    conversationDrafts: {},
    conversationSummaries: [],
    currentChannelId: null,
    currentServerId: "server-1",
    directConversations: [],
    directConversationSync: "complete",
    error: null,
    historyCompleted: true,
    imState: {status: "ready"},
    inbox: [],
    invites: [],
    loadingAgents: false,
    loadingChannel: false,
    loadingComputers: false,
    loadingOlderMessages: false,
    loadingOrganization: false,
    loadingReminders: false,
    loadingWork: false,
    locatingSearchResultId: null,
    members: [],
    messageFocusRequest: null,
    messages: [],
    operationsById: {},
    pendingAction: null,
    pendingThreadIndexMessageIds: [],
    reminders: [],
    searchCompleted: true,
    searchError: null,
    searchLocateError: null,
    searchQuery: "",
    searchResults: [],
    searchingMessages: false,
    selectedQuote: null,
    sendingMessage: false,
    sendingThreadReply: false,
    serverContextStatus: "ready",
    servers: [],
    tasks: [],
    threadCompleted: true,
    threadLoading: false,
    threadMessages: [],
    threadRootMessage: null,
    ...overrides,
  } as unknown as AppStoreState;
}

describe("route state projections", () => {
  it("keeps the conversation projection stable for management-only updates", () => {
    const before = state();
    const after = {...before, computers: [{id: "computer-1"}]} as AppStoreState;

    expect(
      shallow(
        selectConversationScreenState(before),
        selectConversationScreenState(after),
      ),
    ).toBe(true);
  });

  it("keeps management projections stable for chat-only updates", () => {
    const before = state();
    const after = {
      ...before,
      conversationDrafts: {"channel:one": "草稿"},
      messages: [{id: "message-1"}],
      searchQuery: "聊天内容",
    } as unknown as AppStoreState;

    expect(
      shallow(
        selectManagementState(before, "agents"),
        selectManagementState(after, "agents"),
      ),
    ).toBe(true);
    expect(
      shallow(
        selectManagementNavigationState(before),
        selectManagementNavigationState(after),
      ),
    ).toBe(true);
  });

  it("keeps each management section stable for another section's resources", () => {
    const before = state();
    const taskUpdate = {
      ...before,
      tasks: [{id: "task-1"}],
    } as unknown as AppStoreState;
    const computerUpdate = {
      ...before,
      computers: [{id: "computer-1"}],
    } as unknown as AppStoreState;

    expect(
      shallow(
        selectManagementState(before, "computers"),
        selectManagementState(taskUpdate, "computers"),
      ),
    ).toBe(true);
    expect(
      shallow(
        selectManagementState(before, "tasks"),
        selectManagementState(computerUpdate, "tasks"),
      ),
    ).toBe(true);
  });
});

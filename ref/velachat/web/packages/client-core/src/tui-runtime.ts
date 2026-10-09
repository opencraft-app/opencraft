// ReactVaxis runtime entry. Keep this surface deliberately free of platform
// HTTP clients, terminal transports, Tencent SDKs and other environment APIs.
export {
  agentMentionEligibility,
  resolveAgent,
  resolveChannel,
  resolveServer,
} from "./domain/resources.js";
export {channelAddress, directAddress} from "./messaging/conversation.js";
export {mergeMessages} from "./messaging/model.js";
export {PlatformError} from "./platform/errors.js";

export type {
  ConversationSummary,
  ConversationSummarySnapshot,
  MessagePage,
  MessageSearchPage,
  MessagingLifecycleEvent,
  MessagingPort,
  MessagingScope,
  SearchMessagesInput,
  SendAttachmentInput,
  SendTaskInput,
  SendTextInput,
  Unsubscribe,
} from "./messaging/port.js";
export type {AttachmentSource} from "./messaging/port.js";
export type {ConversationAddress} from "./messaging/conversation.js";
export type {DirectConversation} from "./messaging/direct-conversation.js";
export type {Message, MessageReference} from "./messaging/model.js";
export type {
  Account,
  AcceptedResource,
  ActivityItem,
  Agent,
  Channel,
  Computer,
  CreateAgentInput,
  CreateChannelInput,
  CreateComputerInput,
  CreateInviteInput,
  CreateReminderInput,
  CreateServerInput,
  CreateServerResult,
  CreateTaskInput,
  HumanImSession,
  InboxItem,
  InviteSecret,
  Member,
  Operation,
  RegisterInput,
  RegistrationScript,
  Reminder,
  Server,
  Task,
  UpdateAgentInput,
  UpdateMemberInput,
  UpdateReminderInput,
  UpdateTaskInput,
} from "./platform/api.js";
export type {StableErrorCode} from "./platform/errors.js";

import type {Message} from "@vela/client-core";

export type ConversationSurfaceMode = "compact" | "desktop" | "native";

export interface ConversationCapabilities {
  deliveryReceipt: "direct" | "none";
  tasks: boolean;
  threads: boolean;
}

export interface MessageParticipant {
  displayName: string;
  imUserId: string;
  kind: "agent" | "human";
}

export type MessageActorIdentity =
  | {kind: "agent"; label: string}
  | {kind: "human"; label: string}
  | {kind: "self"; label: "我"}
  | {kind: "unknown"; label: string};

export type MessageStatusPresentation =
  | {kind: "failed"; label: string; retry: "delivery" | null}
  | {kind: "hidden"}
  | {kind: "indexPending"; label: "等待收录"; retry: "index" | null}
  | {kind: "receipt"; label: "已读" | "未读" | "已发送"}
  | {kind: "sending"; label: "发送中"}
  | {kind: "uploading"; label: string};

export function participantDirectory(
  participants: readonly MessageParticipant[],
): ReadonlyMap<string, MessageParticipant> {
  return new Map(participants.map((participant) => [participant.imUserId, participant]));
}

export function resolveMessageActor(
  message: Message,
  currentUserId: string | undefined,
  participants: ReadonlyMap<string, MessageParticipant>,
): MessageActorIdentity {
  if (currentUserId && message.senderId === currentUserId) {
    return {kind: "self", label: "我"};
  }
  const participant = participants.get(message.senderId);
  if (participant?.kind === "agent") {
    return {kind: "agent", label: message.senderName || participant.displayName};
  }
  if (participant?.kind === "human") {
    return {kind: "human", label: message.senderName || participant.displayName};
  }
  return {kind: "unknown", label: message.senderName || "未知成员"};
}

export function messagesShareGroup(
  left: Message | undefined,
  right: Message | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.createdAt.slice(0, 10) === right.createdAt.slice(0, 10) &&
    left.senderId === right.senderId &&
    millisecondsBetween(left.createdAt, right.createdAt) <= 5 * 60 * 1_000
  );
}

export function messageStatusPresentation(input: {
  canRetryDelivery: boolean;
  canRetryIndex: boolean;
  indexPending: boolean;
  isGroupTail: boolean;
  message: Message;
  receiptPolicy: ConversationCapabilities["deliveryReceipt"];
}): MessageStatusPresentation {
  const {message} = input;
  if (message.delivery.state === "failed") {
    return {
      kind: "failed",
      label: `发送失败 · ${message.delivery.error}`,
      retry: message.delivery.retryable && input.canRetryDelivery ? "delivery" : null,
    };
  }
  if (message.delivery.state === "uploading") {
    return {
      kind: "uploading",
      label: `上传 ${Math.round(message.delivery.progress * 100)}%`,
    };
  }
  if (message.delivery.state === "sending") {
    return {kind: "sending", label: "发送中"};
  }
  if (input.indexPending && message.direction === "outgoing") {
    return {
      kind: "indexPending",
      label: "等待收录",
      retry: input.canRetryIndex ? "index" : null,
    };
  }
  if (
    message.direction !== "outgoing" ||
    input.receiptPolicy !== "direct" ||
    !input.isGroupTail
  ) {
    return {kind: "hidden"};
  }
  return {
    kind: "receipt",
    label:
      message.read.state === "read"
        ? "已读"
        : message.read.state === "unread"
          ? "未读"
          : "已发送",
  };
}

function millisecondsBetween(left: string, right: string): number {
  return Math.abs(Date.parse(right) - Date.parse(left));
}

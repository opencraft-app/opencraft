import {
  composerDocumentMentions,
  composerDocumentText,
  type Agent,
  type Message,
  type MessageThread,
} from "@vela/client-core";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { MessageComposer } from "./message-composer";
import { ConversationMessageRow, MessageList } from "./message-list";
import {
  messageStatusPresentation,
  participantDirectory,
  resolveMessageActor,
  type ConversationCapabilities,
  type ConversationSurfaceMode,
  type MessageParticipant,
} from "./message-presentation";

const threadMessageCapabilities: ConversationCapabilities = {
  deliveryReceipt: "none",
  tasks: false,
  threads: false,
};
const emptyParticipants: MessageParticipant[] = [];
const emptyPendingIndexMessageIds: string[] = [];

export interface ThreadPanelProps {
  agents: Agent[];
  compact?: boolean;
  completed: boolean;
  currentUserId?: string;
  loading?: boolean;
  messages: Message[];
  onClose(): void;
  onLoadMore(): void | Promise<void>;
  onRetry(messageId: string): void | Promise<void>;
  onRetryIndex?(messageId: string): void | Promise<void>;
  onSend(input: {
    mentionedUserIds: string[];
    text: string;
  }): void | Promise<void>;
  rootMessage: Message;
  pendingIndexMessageIds?: string[];
  participants?: MessageParticipant[];
  sending?: boolean;
  surfaceMode: ConversationSurfaceMode;
  thread: MessageThread;
}

export function ThreadPanel({
  agents,
  compact = false,
  completed,
  currentUserId,
  loading = false,
  messages,
  onClose,
  onLoadMore,
  onRetry,
  onRetryIndex,
  onSend,
  pendingIndexMessageIds = emptyPendingIndexMessageIds,
  participants = emptyParticipants,
  rootMessage,
  sending = false,
  surfaceMode,
  thread,
}: ThreadPanelProps) {
  const conversationKey = `thread:${thread.id}`;
  const [openActionMessageId, setOpenActionMessageId] = useState<string | null>(
    null,
  );
  const actors = useMemo(() => participantDirectory(participants), [participants]);
  const rootActor = resolveMessageActor(rootMessage, currentUserId, actors);
  const rootStatus = messageStatusPresentation({
    canRetryDelivery: true,
    canRetryIndex: false,
    indexPending: false,
    isGroupTail: true,
    message: rootMessage,
    receiptPolicy: threadMessageCapabilities.deliveryReceipt,
  });
  useEffect(() => setOpenActionMessageId(null), [conversationKey]);
  return (
    <View
      style={[styles.panel, compact && styles.panelCompact]}
      testID="thread-panel"
    >
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>话题</Text>
          <Text style={styles.title}>{thread.replyCount} 条回复</Text>
        </View>
        <Pressable
          accessibilityLabel="关闭 Thread"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.close}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>
      <View style={styles.root}>
        <Text style={styles.rootLabel}>回复的开头</Text>
        <ConversationMessageRow
          actionsEnabled={false}
          actionsOpen={false}
          actor={rootActor}
          compactLayout
          focused={false}
          grouped={false}
          message={rootMessage}
          narrowActions={false}
          onActionsOpenChange={() => undefined}
          onQuote={() => undefined}
          onRetry={() => onRetry(rootMessage.id)}
          onToggleReaction={() => undefined}
          pointerActions={false}
          status={rootStatus}
        />
      </View>
      <MessageList
        capabilities={threadMessageCapabilities}
        conversationKey={conversationKey}
        currentUserId={currentUserId}
        historyCompleted={completed}
        loadingOlder={loading}
        messages={messages}
        onLoadOlder={onLoadMore}
        onOpenActionMessageIdChange={setOpenActionMessageId}
        onQuote={() => undefined}
        onRetry={onRetry}
        onRetryIndex={onRetryIndex}
        openActionMessageId={openActionMessageId}
        participants={participants}
        pendingIndexMessageIds={pendingIndexMessageIds}
        surfaceMode={surfaceMode}
      />
      <MessageComposer
        channelName="Thread"
        disabled={sending}
        members={agents.map((agent) => ({
          displayName: agent.displayName,
          handle: agent.handle,
          id: agent.id,
          imUserId: agent.imUserId,
          kind: "agent" as const,
        }))}
        onFocus={() => setOpenActionMessageId(null)}
        onSend={(draft) =>
          onSend({
            mentionedUserIds: composerDocumentMentions(draft.document).map(
              (mention) => mention.imUserId,
            ),
            text: composerDocumentText(draft.document).trim(),
          })
        }
        showAttachments={false}
        surfaceMode={surfaceMode}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  close: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.control.height,
    justifyContent: "center",
    width: theme.recipes.control.squareSize,
  },
  closeText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.controlGlyph,
  },
  eyebrow: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.navigationLabel,
  },
  header: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.desktopWorkspace.headerHeight,
    paddingHorizontal: theme.spacing.md,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  panel: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderLeftColor: theme.semantic.color.separator,
    borderLeftWidth: theme.semantic.stroke.hairline,
    minWidth: theme.recipes.overlay.threadPanelMinWidth,
    width: theme.recipes.overlay.threadPanelWidth,
  },
  panelCompact: {
    borderLeftWidth: 0,
    flex: 1,
    minWidth: 0,
    width: "100%",
  },
  root: {
    backgroundColor: theme.semantic.color.surfaceMuted,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
  },
  rootLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.controlGlyph,
  },
}));

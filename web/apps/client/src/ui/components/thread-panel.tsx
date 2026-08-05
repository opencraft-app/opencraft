import {
  composerDocumentMentions,
  composerDocumentText,
  type Agent,
  type Message,
  type MessageThread,
} from "@vela/client-core";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";

export interface ThreadPanelProps {
  agents: Agent[];
  compact?: boolean;
  completed: boolean;
  loading?: boolean;
  messages: Message[];
  onClose(): void;
  onLoadMore(): void | Promise<void>;
  onRetryIndex?(messageId: string): void | Promise<void>;
  onSend(input: {
    mentionedUserIds: string[];
    text: string;
  }): void | Promise<void>;
  rootMessage: Message;
  pendingIndexMessageIds?: string[];
  sending?: boolean;
  thread: MessageThread;
}

export function ThreadPanel({
  agents,
  compact = false,
  completed,
  loading = false,
  messages,
  onClose,
  onLoadMore,
  onRetryIndex,
  onSend,
  pendingIndexMessageIds = [],
  rootMessage,
  sending = false,
  thread,
}: ThreadPanelProps) {
  const conversationKey = `thread:${thread.id}`;
  const [openActionMessageId, setOpenActionMessageId] = useState<string | null>(
    null,
  );
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
        <View style={styles.rootMeta}>
          <Text style={styles.rootSender}>{rootMessage.senderName}</Text>
          <Text style={styles.rootLabel}>回复的开头</Text>
        </View>
        <Text style={styles.rootText}>{rootMessage.text}</Text>
      </View>
      <MessageList
        conversationKey={conversationKey}
        historyCompleted={completed}
        loadingOlder={loading}
        messages={messages}
        onLoadOlder={onLoadMore}
        onOpenActionMessageIdChange={setOpenActionMessageId}
        onQuote={() => undefined}
        onRetry={() => undefined}
        openActionMessageId={openActionMessageId}
      />
      {pendingIndexMessageIds.length > 0 ? (
        <View style={styles.indexWarning}>
          <View style={styles.indexWarningCopy}>
            <Text style={styles.indexWarningTitle}>已发送，等待收录</Text>
            <Text style={styles.indexWarningText}>
              腾讯 IM 已收到消息；平台暂时还不能从其他设备定位这些回复。
            </Text>
          </View>
          {pendingIndexMessageIds.map((messageId) => (
            <Pressable
              accessibilityLabel="重新收录 Thread 回复"
              accessibilityRole="button"
              key={messageId}
              onPress={() => onRetryIndex?.(messageId)}
              style={styles.indexRetry}
            >
              <Text style={styles.indexRetryText}>重新收录</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
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
  indexRetry: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.sm,
  },
  indexRetryText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.captionEmphasis,
  },
  indexWarning: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.statusWarningSurface,
    borderTopColor: theme.semantic.color.statusWarningDivider,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
  },
  indexWarningCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  indexWarningText: {
    color: theme.semantic.color.statusWarningText,
    ...theme.semantic.typography.navigationLabel,
  },
  indexWarningTitle: {
    color: theme.semantic.color.statusWarningText,
    ...theme.semantic.typography.captionEmphasis,
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
  rootMeta: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  rootSender: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  rootText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.body,
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.controlGlyph,
  },
}));

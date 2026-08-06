import type { Message } from "@vela/client-core";
import {useEffect, useRef, useState} from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import ListTodo from "lucide-react-native/icons/list-todo";
import MessageCircleReply from "lucide-react-native/icons/message-circle-reply";
import MoreHorizontal from "lucide-react-native/icons/ellipsis";
import Quote from "lucide-react-native/icons/quote";
import SmilePlus from "lucide-react-native/icons/smile-plus";
import Undo2 from "lucide-react-native/icons/undo-2";
import X from "lucide-react-native/icons/x";

import {MessageViewport} from "./message-viewport/message-viewport";
import {breakpoints, velaTheme} from "../theme";

export interface MessageListProps {
  conversationKey: string;
  emptyDescription?: string;
  focusRequest?: {messageId: string; revision: number} | null;
  historyCompleted: boolean;
  initializing?: boolean;
  loadingOlder?: boolean;
  messages: Message[];
  onCreateTask?(messageId: string): void | Promise<void>;
  onLoadOlder(): void | Promise<void>;
  onOpenThread?(messageId: string): void | Promise<void>;
  onOpenActionMessageIdChange?(messageId: string | null): void;
  onQuote(messageId: string): void | Promise<void>;
  onRevoke?(messageId: string): void | Promise<void>;
  onRetry(messageId: string): void | Promise<void>;
  onToggleReaction?(
    messageId: string,
    reactionId: string,
  ): void | Promise<void>;
  openActionMessageId?: string | null;
  viewportWidth?: number;
}

export function MessageList({
  conversationKey,
  emptyDescription = "发送第一条消息，或 @Agent 分配一项工作。",
  focusRequest = null,
  historyCompleted,
  initializing = false,
  loadingOlder = false,
  messages,
  onCreateTask,
  onLoadOlder,
  onOpenActionMessageIdChange,
  onOpenThread,
  onQuote,
  onRevoke,
  onRetry,
  onToggleReaction = () => undefined,
  openActionMessageId: controlledOpenActionMessageId,
  viewportWidth,
}: MessageListProps) {
  const {theme} = useUnistyles();
  const window = useWindowDimensions();
  const layoutWidth = viewportWidth ?? window.width;
  const compactLayout = layoutWidth < breakpoints.medium;
  const narrowActions = layoutWidth <= breakpoints.narrow;
  const pointerActions =
    Platform.OS === "web" && layoutWidth >= breakpoints.medium;
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [localOpenActionMessageId, setLocalOpenActionMessageId] = useState<
    string | null
  >(null);
  const previousConversationKey = useRef(conversationKey);
  const openActionMessageId =
    controlledOpenActionMessageId === undefined
      ? localOpenActionMessageId
      : controlledOpenActionMessageId;
  const changeOpenActionMessage = (messageId: string | null) => {
    if (controlledOpenActionMessageId === undefined) {
      setLocalOpenActionMessageId(messageId);
    }
    onOpenActionMessageIdChange?.(messageId);
  };
  useEffect(() => {
    if (!focusRequest) return;
    setFocusedMessageId(focusRequest.messageId);
    const timeout = setTimeout(
      () => setFocusedMessageId(null),
      theme.semantic.motion.dismissal.focusHighlight,
    );
    return () => clearTimeout(timeout);
  }, [focusRequest, theme.semantic.motion.dismissal.focusHighlight]);
  useEffect(() => {
    if (previousConversationKey.current === conversationKey) return;
    previousConversationKey.current = conversationKey;
    if (controlledOpenActionMessageId === undefined) {
      setLocalOpenActionMessageId(null);
    }
    onOpenActionMessageIdChange?.(null);
  }, [
    controlledOpenActionMessageId,
    conversationKey,
    onOpenActionMessageIdChange,
  ]);

  return (
    <MessageViewport
      conversationKey={conversationKey}
      contentContainerStyle={[
        styles.messages,
        compactLayout && styles.messagesCompact,
      ]}
      data={messages}
      focusRequest={
        focusRequest
          ? {key: focusRequest.messageId, revision: focusRequest.revision}
          : null
      }
      empty={
        initializing ? (
          <View
            accessibilityLabel="正在加载消息历史"
            accessibilityRole="progressbar"
            style={styles.historyLoading}
          >
            <View style={styles.historyLoadingIndicator}>
              <ActivityIndicator color={theme.semantic.color.iconAccent} size="small" />
            </View>
            <Text style={styles.historyLoadingTitle}>正在同步消息</Text>
            <Text style={styles.historyLoadingHint}>历史记录马上就好</Text>
          </View>
        ) : (
          <View style={styles.emptyConversation}>
            <View style={styles.emptyOrbit}>
              <View style={styles.emptyOrbitRing} />
              <View style={styles.emptyOrbitCore} />
            </View>
            <Text style={styles.emptyTitle}>从这里开始协作</Text>
            <Text style={styles.empty}>{emptyDescription}</Text>
          </View>
        )
      }
      header={(loadOlder) =>
        !historyCompleted ? (
          <Pressable
            accessibilityLabel="加载更早消息"
            accessibilityRole="button"
            disabled={loadingOlder}
            onPress={loadOlder}
            style={({ pressed }) => [
              styles.loadOlderButton,
              pressed && styles.loadOlderButtonPressed,
            ]}
          >
            <Text style={styles.loadOlderText}>
              {loadingOlder ? "正在加载…" : "↑ 加载更早消息"}
            </Text>
          </Pressable>
        ) : null
      }
      keyExtractor={(message) => message.id}
      loadingOlder={loadingOlder}
      onLoadOlder={onLoadOlder}
      renderItem={({item: message, index}) => {
        const previous = messages[index - 1];
        const dateKey = message.createdAt.slice(0, 10);
        const previousDateKey = previous?.createdAt.slice(0, 10);
        const showDate = dateKey !== previousDateKey;
        const grouped =
          !showDate &&
          previous?.senderId === message.senderId &&
          millisecondsBetween(previous.createdAt, message.createdAt) <=
            5 * 60 * 1_000;
        const alignOutgoing =
          conversationKey.startsWith("direct:") &&
          message.direction === "outgoing";
        return (
          <View>
            {showDate ? (
              <DateSeparator dateKey={dateKey} />
            ) : null}
            <MessageRow
              actionsOpen={openActionMessageId === message.id}
              alignOutgoing={alignOutgoing}
              compactLayout={compactLayout}
              focused={focusedMessageId === message.id}
              grouped={grouped}
              message={message}
              onCreateTask={
                onCreateTask
                  ? () => onCreateTask(message.id)
                  : undefined
              }
              onActionsOpenChange={(open) =>
                changeOpenActionMessage(open ? message.id : null)
              }
              onOpenThread={
                onOpenThread
                  ? () => onOpenThread(message.id)
                  : undefined
              }
              onQuote={() => onQuote(message.id)}
              onRevoke={
                onRevoke && message.direction === "outgoing"
                  ? () => onRevoke(message.id)
                  : undefined
              }
              onRetry={() => onRetry(message.id)}
              onToggleReaction={(reactionId) =>
                onToggleReaction(message.id, reactionId)
              }
              narrowActions={narrowActions}
              pointerActions={pointerActions}
            />
          </View>
        );
      }}
      style={styles.scroller}
    />
  );
}

function DateSeparator({ dateKey }: { dateKey: string }) {
  return (
    <View style={styles.dateSeparator} testID={`date-${dateKey}`}>
      <View style={styles.dateLine} />
      <Text style={styles.dateText}>{formatDateLabel(dateKey)}</Text>
      <View style={styles.dateLine} />
    </View>
  );
}

function MessageRow({
  actionsOpen,
  alignOutgoing,
  compactLayout,
  focused,
  grouped,
  message,
  onCreateTask,
  onActionsOpenChange,
  onOpenThread,
  onQuote,
  onRevoke,
  onRetry,
  onToggleReaction,
  narrowActions,
  pointerActions,
}: {
  actionsOpen: boolean;
  alignOutgoing: boolean;
  compactLayout: boolean;
  focused: boolean;
  grouped: boolean;
  message: Message;
  onActionsOpenChange(open: boolean): void;
  onCreateTask?: (() => void | Promise<void>) | undefined;
  onOpenThread?: (() => void | Promise<void>) | undefined;
  onQuote(): void | Promise<void>;
  onRevoke?: (() => void | Promise<void>) | undefined;
  onRetry(): void | Promise<void>;
  onToggleReaction(reactionId: string): void | Promise<void>;
  narrowActions: boolean;
  pointerActions: boolean;
}) {
  const {theme} = useUnistyles();
  const [actionFocused, setActionFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const actionable =
    message.rawType !== "VELA_MESSAGE_UNAVAILABLE" &&
    message.rawType !== "TIMRevokedElem" &&
    message.delivery.state === "sent";
  const actionVisible = hovered || actionFocused || actionsOpen;
  const tone = avatarTone(message.senderId);
  const completeAction = (action: () => void | Promise<void>) => {
    onActionsOpenChange(false);
    return action();
  };
  const moreActionButton = actionable && (pointerActions || compactLayout) ? (
    <Pressable
      accessibilityHint={compactLayout ? "也可以长按消息打开操作" : undefined}
      accessibilityLabel={`更多消息操作 ${message.text}`}
      accessibilityRole="button"
      aria-expanded={actionsOpen}
      onBlur={() => setActionFocused(false)}
      onFocus={() => setActionFocused(true)}
      onPress={() => onActionsOpenChange(!actionsOpen)}
      style={({pressed}) => [
        styles.moreActionButton,
        pointerActions
          ? styles.moreActionButtonPointer
          : styles.moreActionButtonCompact,
        pointerActions && actionVisible && styles.moreActionButtonVisible,
        actionsOpen && styles.moreActionButtonOpen,
        pressed && styles.moreActionButtonPressed,
      ]}
    >
      <MoreHorizontal
        color={theme.semantic.color.iconMuted}
        size={pointerActions ? theme.semantic.icon.size.small : theme.semantic.icon.size.medium}
        strokeWidth={theme.semantic.icon.stroke.regular}
      />
    </Pressable>
  ) : null;
  return (
    <Pressable
      accessible={false}
      delayLongPress={velaTheme.semantic.interaction.longPressDelay}
      onLongPress={
        !pointerActions && actionable
          ? () => onActionsOpenChange(!actionsOpen)
          : undefined
      }
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        styles.message,
        compactLayout && styles.messageCompact,
        alignOutgoing && styles.messageOutgoing,
        grouped && styles.messageGrouped,
        focused && styles.messageFocused,
      ]}
      testID={`message-${message.id}`}
    >
      {grouped ? (
        <View
          style={[
            styles.avatarSpacer,
            compactLayout && styles.avatarSpacerCompact,
          ]}
        />
      ) : (
        <View
          style={[
            styles.avatar,
            compactLayout && styles.avatarCompact,
            tone === 0 && styles.avatarViolet,
            tone === 1 && styles.avatarGreen,
            tone === 2 && styles.avatarOrange,
          ]}
          testID={`message-avatar-${message.id}`}
        >
          <Text
            style={[
              styles.avatarText,
              tone === 0 && styles.avatarTextViolet,
              tone === 1 && styles.avatarTextGreen,
              tone === 2 && styles.avatarTextOrange,
            ]}
          >
            {message.senderName.slice(0, 1)}
          </Text>
        </View>
      )}
      <View
        style={[
          styles.messageBody,
          alignOutgoing && styles.messageBodyOutgoing,
        ]}
        testID={`message-body-${message.id}`}
      >
        {!grouped ? (
          <View
            style={[
              styles.metaRow,
              alignOutgoing && styles.metaRowOutgoing,
            ]}
          >
            <Text style={styles.sender}>{message.senderName}</Text>
            <Text
              style={styles.timestamp}
              testID={`message-timestamp-${message.id}`}
            >
              {formatTime(message.createdAt)}
            </Text>
            {compactLayout ? moreActionButton : null}
          </View>
        ) : null}
        <View
          style={[
            styles.messageContentRow,
            alignOutgoing && styles.messageContentRowOutgoing,
          ]}
          testID={`message-content-row-${message.id}`}
        >
          <View style={styles.messageContentGrow}>
            <MessageContent compactLayout={compactLayout} message={message} />
          </View>
          {pointerActions || (compactLayout && grouped)
            ? moreActionButton
            : null}
        </View>
        {message.rawType !== "VELA_MESSAGE_UNAVAILABLE" ? (
          <>
            {message.direction === "outgoing" &&
            message.delivery.state === "sent" &&
            !actionsOpen ? (
              <View
                style={[
                  styles.deliveryStandalone,
                  !alignOutgoing && styles.deliveryStandaloneChannel,
                ]}
              >
                <DeliveryState message={message} onRetry={onRetry} />
              </View>
            ) : null}
            {message.delivery.state !== "sent" || actionsOpen ? (
              <View
                style={[
                  styles.actionRow,
                  actionsOpen && styles.actionRowOpen,
                  actionsOpen && narrowActions && styles.actionRowNarrow,
                  actionsOpen &&
                    narrowActions &&
                    message.reactions.length === 0 &&
                    styles.actionRowNarrowFixed,
                ]}
                testID={
                  actionsOpen ? `message-actions-${message.id}` : undefined
                }
              >
                <DeliveryState message={message} onRetry={onRetry} />
                {actionsOpen ? (
              <>
                {message.reactions.map((reaction) => (
                  <Pressable
                    accessibilityLabel={`Reaction ${reaction.reactionId} ${reaction.count}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: reaction.reactedByMe }}
                    aria-pressed={reaction.reactedByMe}
                    key={reaction.reactionId}
                    onPress={() =>
                      completeAction(() =>
                        onToggleReaction(reaction.reactionId),
                      )
                    }
                    style={[
                      styles.reaction,
                      reaction.reactedByMe && styles.reactionActive,
                    ]}
                  >
                    <Text style={styles.reactionText}>
                      {reaction.reactionId} {reaction.count}
                    </Text>
                  </Pressable>
                ))}
                {message.reactions.length === 0 ? (
                  <Pressable
                    accessibilityLabel="添加 Reaction 👍"
                    accessibilityRole="button"
                    onPress={() =>
                      completeAction(() => onToggleReaction("👍"))
                    }
                    style={[
                      styles.actionButton,
                      narrowActions && styles.actionButtonNarrow,
                    ]}
                  >
                    <SmilePlus color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.small} strokeWidth={theme.semantic.icon.stroke.regular} />
                    <Text style={styles.actionText}>表情</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityLabel={`引用消息 ${message.text}`}
                  accessibilityRole="button"
                  onPress={() => completeAction(onQuote)}
                  style={[
                    styles.actionButton,
                    narrowActions && styles.actionButtonNarrow,
                  ]}
                >
                  <Quote color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.small} strokeWidth={theme.semantic.icon.stroke.regular} />
                  <Text style={styles.actionText}>引用</Text>
                </Pressable>
                {onRevoke ? (
                  <Pressable
                    accessibilityLabel={`撤回消息 ${message.text}`}
                    accessibilityRole="button"
                    onPress={() => completeAction(onRevoke)}
                    style={[
                      styles.actionButton,
                      narrowActions && styles.actionButtonNarrow,
                    ]}
                  >
                    <Undo2 color={theme.semantic.color.statusDanger} size={theme.semantic.icon.size.small} strokeWidth={theme.semantic.icon.stroke.regular} />
                    <Text style={styles.actionText}>撤回</Text>
                  </Pressable>
                ) : null}
                {onOpenThread ? (
                  <Pressable
                    accessibilityLabel={`在 Thread 回复 ${message.text}`}
                    accessibilityRole="button"
                    onPress={() => completeAction(onOpenThread)}
                    style={[
                      styles.actionButton,
                      narrowActions && styles.actionButtonNarrow,
                    ]}
                  >
                    <MessageCircleReply
                      color={theme.semantic.color.iconMuted}
                      size={theme.semantic.icon.size.small}
                      strokeWidth={theme.semantic.icon.stroke.regular}
                    />
                    <Text style={styles.actionText}>回复</Text>
                  </Pressable>
                ) : null}
                {message.content.kind !== "task" && onCreateTask ? (
                  <Pressable
                    accessibilityLabel={`将消息转为 Task ${message.text}`}
                    accessibilityRole="button"
                    onPress={() => completeAction(onCreateTask)}
                    style={[
                      styles.actionButton,
                      narrowActions && styles.actionButtonNarrow,
                    ]}
                  >
                    <ListTodo color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.small} strokeWidth={theme.semantic.icon.stroke.regular} />
                    <Text style={styles.actionText}>转任务</Text>
                  </Pressable>
                ) : null}
                  </>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

function MessageContent({
  compactLayout,
  message,
}: {
  compactLayout: boolean;
  message: Message;
}) {
  const content = message.content;
  const fileUrl =
    content.kind === "file"
      ? openableAttachmentUrl(content.url)
      : undefined;
  return (
    <View style={styles.content}>
      {message.quote ? (
        <View style={styles.quote}>
          <Text style={styles.quoteText}>
            {message.quote.senderName} · {message.quote.preview}
          </Text>
        </View>
      ) : null}
      {content.kind === "text" || content.kind === "system" ? (
        <Text style={styles.messageText}>{content.text}</Text>
      ) : null}
      {content.kind === "image" ? (
        <ImageAttachment compactLayout={compactLayout} content={content} />
      ) : null}
      {content.kind === "file" ? (
        fileUrl ? (
          <Pressable
            accessibilityLabel={`打开文件 ${content.name}`}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(fileUrl)}
            style={({pressed}) => [
              styles.attachment,
              compactLayout && styles.attachmentCompact,
              styles.attachmentOpen,
              pressed && styles.attachmentPressed,
            ]}
          >
            <AttachmentMeta
              kind="FILE"
              name={content.name}
              size={content.size}
            />
            <Text style={styles.attachmentAction}>打开 ↗</Text>
          </Pressable>
        ) : (
          <View
            style={[
              styles.attachment,
              compactLayout && styles.attachmentCompact,
            ]}
          >
            <AttachmentMeta
              kind="FILE"
              name={content.name}
              size={content.size}
            />
          </View>
        )
      ) : null}
      {content.kind === "audio" ? (
        <Text style={styles.messageText}>
          语音
          {content.durationSeconds !== undefined
            ? ` · ${content.durationSeconds}s`
            : ""}
        </Text>
      ) : null}
      {content.kind === "video" ? (
        <Text style={styles.messageText}>
          视频
          {content.durationSeconds !== undefined
            ? ` · ${content.durationSeconds}s`
            : ""}
        </Text>
      ) : null}
      {content.kind === "task" ? (
        <View
          style={[styles.taskCard, compactLayout && styles.taskCardCompact]}
          testID={`message-task-card-${message.id}`}
        >
          <Text style={styles.taskEyebrow}>TASK · {content.status}</Text>
          <Text style={styles.taskTitle}>{content.title}</Text>
        </View>
      ) : null}
      {content.kind === "custom" ||
      content.kind === "merged" ||
      content.kind === "unsupported" ? (
        <Text style={styles.messageText}>{message.text}</Text>
      ) : null}
    </View>
  );
}

function ImageAttachment({
  compactLayout,
  content,
}: {
  compactLayout: boolean;
  content: Extract<Message["content"], {kind: "image"}>;
}) {
  const {theme} = useUnistyles();
  const [previewOpen, setPreviewOpen] = useState(false);
  const name = content.name ?? "图片";
  const thumbnailUri = content.thumbnailUrl ?? content.url;
  const previewUri = content.url ?? content.thumbnailUrl;
  const closePreview = () => setPreviewOpen(false);

  return (
    <View
      style={[
        styles.attachment,
        compactLayout && styles.attachmentCompact,
      ]}
    >
      {thumbnailUri ? (
        <>
          <Pressable
            accessibilityHint="打开全屏图片预览"
            accessibilityLabel={`预览图片 ${name}`}
            accessibilityRole="button"
            onPress={() => setPreviewOpen(true)}
            style={({pressed}) => [
              styles.imagePreviewTrigger,
              pressed && styles.imagePreviewTriggerPressed,
            ]}
          >
            <Image
              accessibilityLabel={`图片 ${name}`}
              resizeMode="cover"
              source={{uri: thumbnailUri}}
              style={[
                styles.image,
                content.width && content.height
                  ? {aspectRatio: content.width / content.height}
                  : null,
              ]}
            />
          </Pressable>
          {previewUri ? (
            <Modal
              animationType="fade"
              onRequestClose={closePreview}
              presentationStyle="overFullScreen"
              statusBarTranslucent
              testID="image-preview-modal"
              transparent
              visible={previewOpen}
            >
              <View
                accessibilityLabel="图片预览"
                accessibilityViewIsModal
                style={styles.imagePreviewModal}
              >
                <Pressable
                  accessible={false}
                  onPress={closePreview}
                  style={styles.imagePreviewBackdrop}
                />
                <Image
                  accessibilityLabel={`图片预览 ${name}`}
                  resizeMode="contain"
                  source={{uri: previewUri}}
                  style={styles.imagePreviewImage}
                />
                <Pressable
                  accessibilityLabel="关闭图片预览"
                  accessibilityRole="button"
                  onPress={closePreview}
                  style={({pressed}) => [
                    styles.imagePreviewClose,
                    pressed && styles.imagePreviewClosePressed,
                  ]}
                >
                  <X color={theme.semantic.color.iconPrimary} size={theme.semantic.icon.size.large} strokeWidth={theme.semantic.icon.stroke.emphasis} />
                </Pressable>
              </View>
            </Modal>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function AttachmentMeta({
  kind,
  name,
  size,
}: {
  kind: string;
  name: string;
  size?: number;
}) {
  return (
    <View style={styles.attachmentCopy}>
      <Text style={styles.attachmentKind}>{kind}</Text>
      <Text style={styles.attachmentName}>{name}</Text>
      {size !== undefined ? (
        <Text style={styles.attachmentSize}>{formatFileSize(size)}</Text>
      ) : null}
    </View>
  );
}

function DeliveryState({
  message,
  onRetry,
}: {
  message: Message;
  onRetry(): void | Promise<void>;
}) {
  const delivery = message.delivery;
  if (delivery.state === "uploading") {
    return (
      <Text style={styles.delivery}>
        上传 {Math.round(delivery.progress * 100)}%
      </Text>
    );
  }
  if (delivery.state === "sending") {
    return <Text style={styles.delivery}>发送中</Text>;
  }
  if (delivery.state === "failed") {
    return (
      <View style={styles.failure}>
        <Text style={styles.failureText}>
          发送失败 · {delivery.error}
        </Text>
        {delivery.retryable ? (
          <Pressable
            accessibilityLabel={`重试消息 ${message.text}`}
            accessibilityRole="button"
            onPress={onRetry}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (message.direction === "outgoing") {
    return (
      <Text style={styles.delivery}>
        {message.read.state === "read"
          ? "已读"
          : message.read.state === "unread"
            ? "未读"
            : "已发送"}
      </Text>
    );
  }
  return null;
}

function millisecondsBetween(left: string, right: string): number {
  return Math.abs(Date.parse(right) - Date.parse(left));
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateLabel(dateKey: string): string {
  const value = new Date(`${dateKey}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDifference = Math.round(
    (today.getTime() - value.getTime()) / 86_400_000,
  );
  const calendarLabel = `${value.getMonth() + 1}月${value.getDate()}日`;
  if (dayDifference === 0) return `今天 · ${calendarLabel}`;
  if (dayDifference === 1) return `昨天 · ${calendarLabel}`;
  if (value.getFullYear() === today.getFullYear()) return calendarLabel;
  return `${value.getFullYear()}年${calendarLabel}`;
}

function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function openableAttachmentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function avatarTone(value: string): 0 | 1 | 2 {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return (hash % 3) as 0 | 1 | 2;
}

const styles = StyleSheet.create((theme) => ({
  actionButton: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.sm,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    minWidth: theme.recipes.control.squareSize,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xxs,
  },
  actionButtonNarrow: {
    gap: theme.recipes.conversationWorkspace.compactActionGap,
    paddingHorizontal: theme.spacing.xs,
  },
  actionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
    minHeight: theme.recipes.control.height,
  },
  actionRowOpen: {
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    marginTop: theme.spacing.sm,
    paddingHorizontal:
      theme.recipes.conversationWorkspace.messageActionHorizontalPadding,
    shadowColor: theme.shadows.floatingControl.color,
    shadowOffset: {height: theme.shadows.floatingControl.offsetY, width: 0},
    shadowOpacity: theme.shadows.floatingControl.opacity,
    shadowRadius: theme.shadows.floatingControl.radius,
  },
  actionRowNarrow: {
    gap: theme.spacing.xxs,
    paddingHorizontal: theme.spacing.xs,
  },
  actionRowNarrowFixed: {
    flexWrap: "nowrap",
  },
  actionText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.label,
  },
  attachment: {
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    maxWidth: theme.recipes.contentMeasure.compactMaxWidth,
    minWidth: theme.recipes.messageTimeline.attachmentMinWidth,
    overflow: "hidden",
    ...theme.semantic.motion.transition.control,
  },
  attachmentAction: {
    color: theme.semantic.color.textLink,
    ...theme.semantic.typography.label,
    marginRight: theme.spacing.md,
  },
  attachmentCompact: {
    minWidth: 0,
  },
  attachmentCopy: {
    padding: theme.spacing.sm,
  },
  attachmentKind: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.eyebrow,
  },
  attachmentName: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
    marginTop: theme.spacing.xs,
  },
  attachmentOpen: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  attachmentPressed: {
    opacity: theme.semantic.opacity.contentMuted,
    ...theme.semantic.motion.transition.control,
  },
  attachmentSize: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
    marginTop: theme.spacing.xxs,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.avatarCompactSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarCompactSize,
  },
  avatarCompact: {
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.avatarRowSize,
    width: theme.recipes.identity.avatarRowSize,
  },
  avatarGreen: {
    backgroundColor: theme.semantic.color.avatarHumanGreenSurface,
    borderColor: theme.semantic.color.avatarHumanGreenBorder,
  },
  avatarOrange: {
    backgroundColor: theme.semantic.color.avatarHumanOrangeSurface,
    borderColor: theme.semantic.color.avatarHumanOrangeBorder,
  },
  avatarViolet: {
    backgroundColor: theme.semantic.color.avatarHumanVioletSurface,
    borderColor: theme.semantic.color.avatarHumanVioletBorder,
  },
  avatarSpacer: {
    width: theme.recipes.identity.avatarCompactSize,
  },
  avatarSpacerCompact: {
    width: theme.recipes.identity.avatarRowSize,
  },
  avatarText: {
    ...theme.semantic.typography.sectionTitle,
  },
  avatarTextGreen: {
    color: theme.semantic.color.avatarHumanGreenText,
  },
  avatarTextOrange: {
    color: theme.semantic.color.avatarHumanOrangeText,
  },
  avatarTextViolet: {
    color: theme.semantic.color.avatarHumanVioletText,
  },
  content: {
    alignItems: "flex-start",
    gap: theme.spacing.sm,
  },
  dateLine: {
    backgroundColor: theme.semantic.color.separator,
    flex: 1,
    height: theme.semantic.stroke.hairline,
  },
  dateSeparator: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  dateText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  delivery: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  deliveryStandalone: {
    alignItems: "center",
    alignSelf: "flex-end",
    flexDirection: "row",
    minHeight: theme.recipes.messageTimeline.deliveryMinHeight,
  },
  deliveryStandaloneChannel: {
    alignSelf: "flex-start",
  },
  empty: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  emptyConversation: {
    alignItems: "center",
    flex: 1,
    gap: theme.spacing.sm,
    justifyContent: "center",
    minHeight: theme.recipes.emptyState.timelineMinHeight,
  },
  emptyOrbit: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.emptyState.orbitSize,
    justifyContent: "center",
    marginBottom: theme.spacing.sm,
    width: theme.recipes.emptyState.orbitSize,
  },
  emptyOrbitCore: {
    backgroundColor: theme.semantic.color.decorativeAccentSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.emptyState.orbitCoreSize,
    width: theme.recipes.emptyState.orbitCoreSize,
  },
  emptyOrbitRing: {
    borderColor: theme.semantic.color.borderFocus,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.emptyState.orbitRingSize,
    position: "absolute",
    transform: [{scaleY: 0.5}, {rotate: "24deg"}],
    width: theme.recipes.emptyState.orbitRingSize,
  },
  emptyTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  failure: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  failureText: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.meta,
  },
  historyLoading: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: theme.recipes.emptyState.loadingMinHeight,
    padding: theme.spacing.xl,
  },
  historyLoadingHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
    marginTop: theme.spacing.xs,
  },
  historyLoadingIndicator: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.semantic.interaction.minimumTargetSize,
    justifyContent: "center",
    marginBottom: theme.spacing.md,
    width: theme.semantic.interaction.minimumTargetSize,
  },
  historyLoadingTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  image: {
    backgroundColor: theme.semantic.color.statusNeutral,
    maxHeight: theme.recipes.messageTimeline.imageMaxHeight,
    width: "100%",
  },
  imagePreviewBackdrop: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  imagePreviewClose: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.overlayControlBorder,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.control.height,
    justifyContent: "center",
    position: "absolute",
    right: theme.recipes.overlay.previewControlInset,
    top: theme.recipes.overlay.previewControlInset,
    width: theme.recipes.control.squareSize,
    ...theme.semantic.motion.transition.control,
  },
  imagePreviewClosePressed: {
    opacity: theme.semantic.opacity.contentMuted,
    ...theme.semantic.motion.transition.control,
  },
  imagePreviewImage: {
    flex: 1,
    width: "100%",
  },
  imagePreviewModal: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.overlayBackdrop,
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  imagePreviewTrigger: {
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  imagePreviewTriggerPressed: {
    opacity: theme.semantic.opacity.contentEmphasized,
    ...theme.semantic.motion.transition.control,
  },
  loadOlderButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    marginBottom: theme.spacing.sm,
    minHeight: theme.recipes.messageTimeline.touchActionSize,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
  },
  loadOlderButtonPressed: {
    backgroundColor: theme.semantic.color.selectionSurface,
    ...theme.semantic.motion.transition.control,
  },
  loadOlderText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.meta,
  },
  message: {
    alignSelf: "stretch",
    borderWidth: 0,
    flexDirection: "row",
    gap: theme.recipes.conversationWorkspace.messageRowGap,
    paddingVertical: theme.spacing.sm,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  messageCompact: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  messageOutgoing: {
    flexDirection: "row-reverse",
  },
  messageBody: {
    flex: 1,
    gap: theme.spacing.xs,
    minWidth: 0,
  },
  messageBodyOutgoing: {
    alignItems: "flex-end",
  },
  messageContentGrow: {
    flexShrink: 1,
    minWidth: 0,
  },
  messageContentRow: {
    alignItems: "flex-start",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: theme.spacing.sm,
    maxWidth: "100%",
  },
  messageContentRowOutgoing: {
    alignSelf: "flex-end",
    flexDirection: "row-reverse",
  },
  moreActionButton: {
    alignItems: "center",
    flexShrink: 0,
    justifyContent: "center",
    ...theme.semantic.motion.transition.control,
  },
  moreActionButtonPointer: {
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.messageTimeline.pointerActionSize,
    opacity: 0,
    width: theme.recipes.messageTimeline.pointerActionSize,
  },
  moreActionButtonCompact: {
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.messageTimeline.touchActionSize,
    opacity: 1,
    width: theme.recipes.messageTimeline.touchActionSize,
  },
  moreActionButtonVisible: {
    opacity: 1,
  },
  moreActionButtonOpen: {
    backgroundColor: theme.semantic.color.actionTonalSurface,
    opacity: 1,
  },
  moreActionButtonPressed: {
    backgroundColor: theme.semantic.color.actionTonalSurface,
    opacity: theme.semantic.opacity.contentMuted,
    ...theme.semantic.motion.transition.control,
  },
  messageGrouped: {
    paddingBottom: theme.spacing.xxs,
    paddingTop: theme.spacing.xxs,
  },
  messageFocused: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderRadius: theme.semantic.radius.control,
    ...theme.semantic.motion.transition.control,
  },
  messages: {
    flexGrow: 1,
    paddingHorizontal: theme.recipes.conversationWorkspace.messageIndent,
    paddingVertical: theme.spacing.lg,
  },
  messagesCompact: {
    paddingHorizontal: theme.spacing.lg,
  },
  messageText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.messageBody,
    maxWidth: theme.recipes.contentMeasure.messageMaxWidth,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  metaRowOutgoing: {
    flexDirection: "row-reverse",
  },
  quote: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderLeftColor: theme.semantic.color.borderAccent,
    borderLeftWidth: theme.semantic.stroke.accent,
    borderRadius: theme.semantic.radius.control,
    maxWidth: theme.recipes.contentMeasure.readingMaxWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  quoteText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  reaction: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.pill,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    minWidth: theme.recipes.control.squareSize,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xxs,
    ...theme.semantic.motion.transition.control,
  },
  reactionActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  reactionText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.meta,
  },
  retryButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionTonalSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xxs,
  },
  retryText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.label,
  },
  scroller: {
    flex: 1,
  },
  sender: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.messageSender,
  },
  taskCard: {
    alignSelf: "stretch",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    maxWidth: theme.recipes.messageTimeline.taskCardMaxWidth,
    minHeight: theme.recipes.messageTimeline.taskCardMinHeight,
    minWidth: theme.recipes.messageTimeline.taskCardMinWidth,
    padding: theme.spacing.sm,
  },
  taskCardCompact: {
    minWidth: 0,
  },
  taskEyebrow: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.eyebrow,
  },
  taskTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
    marginTop: theme.spacing.xs,
  },
  timestamp: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.messageMeta,
  },
}));

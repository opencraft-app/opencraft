import type { MessageQuote } from "@raft-platform/client-core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type TextInputContentSizeChangeEvent,
  type TextInputKeyPressEvent,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import AtSign from "lucide-react-native/icons/at-sign";
import Check from "lucide-react-native/icons/check";
import ImageIcon from "lucide-react-native/icons/image";
import Paperclip from "lucide-react-native/icons/paperclip";
import Plus from "lucide-react-native/icons/plus";
import Send from "lucide-react-native/icons/send";
import {breakpoints} from "../theme";

const MESSAGE_INPUT_MIN_HEIGHT = 44;
const MESSAGE_INPUT_MAX_HEIGHT = 112;

export interface MentionableAgent {
  displayName: string;
  id: string;
  imUserId: string;
}

export interface MessageComposerProps {
  agents: MentionableAgent[];
  channelName: string;
  conversationLabel?: string;
  disabled?: boolean;
  draft?: string;
  onAttachFile?(): void | Promise<void>;
  onAttachImage?(): void | Promise<void>;
  onClearQuote?(): void | Promise<void>;
  onDraftChange?(text: string): void;
  onFocus?(): void;
  onSend(input: {
    mentionedUserIds: string[];
    text: string;
  }): void | Promise<void>;
  quote?: MessageQuote | null;
  showAttachments?: boolean;
  viewportWidth?: number;
}

export function MessageComposer({
  agents,
  channelName,
  conversationLabel,
  disabled = false,
  draft,
  onAttachFile = () => undefined,
  onAttachImage = () => undefined,
  onClearQuote = () => undefined,
  onDraftChange = () => undefined,
  onFocus = () => undefined,
  onSend,
  quote = null,
  showAttachments = true,
  viewportWidth,
}: MessageComposerProps) {
  const {theme} = useUnistyles();
  const window = useWindowDimensions();
  const layoutWidth = viewportWidth ?? window.width;
  const compactLayout = layoutWidth < breakpoints.medium;
  const narrowLayout = layoutWidth <= breakpoints.narrow;
  const [localText, setLocalText] = useState(() => draft ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [inputHeight, setInputHeight] = useState(MESSAGE_INPUT_MIN_HEIGHT);
  const submitPending = useRef(false);
  const persistedDraft = useRef(draft ?? "");
  const text = localText;
  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedIds.includes(agent.id)),
    [agents, selectedIds],
  );

  useEffect(() => {
    if (draft === undefined || draft === persistedDraft.current) return;
    persistedDraft.current = draft;
    setLocalText(draft);
  }, [draft]);
  useEffect(() => {
    if (text.length === 0) {
      setInputHeight(MESSAGE_INPUT_MIN_HEIGHT);
    }
  }, [text]);
  useEffect(() => {
    if (!showAttachments) {
      setAttachmentPickerOpen(false);
    }
  }, [showAttachments]);

  function toggleAgent(agentId: string): void {
    setSelectedIds((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId],
    );
  }

  function updateText(value: string): void {
    if (value.length === 0) {
      setInputHeight(MESSAGE_INPUT_MIN_HEIGHT);
    }
    setLocalText(value);
  }

  function persistDraft(value: string): void {
    if (value === persistedDraft.current) return;
    persistedDraft.current = value;
    onDraftChange(value);
  }

  function handleInputFocus(): void {
    setAttachmentPickerOpen(false);
    setMentionPickerOpen(false);
    onFocus();
  }

  function handleInputBlur(): void {
    persistDraft(text);
  }

  async function chooseAttachment(
    action: () => void | Promise<void>,
  ): Promise<void> {
    setAttachmentPickerOpen(false);
    await action();
  }

  function handleContentSizeChange(
    event: TextInputContentSizeChangeEvent,
  ): void {
    setInputHeight(
      Math.max(
        MESSAGE_INPUT_MIN_HEIGHT,
        Math.min(
          MESSAGE_INPUT_MAX_HEIGHT,
          event.nativeEvent.contentSize.height,
        ),
      ),
    );
  }

  async function submit(): Promise<void> {
    const body = text.trim();
    if (!body || disabled || submitPending.current) {
      return;
    }
    submitPending.current = true;
    try {
      const mentionPrefix = selectedAgents
        .map((agent) => `@${agent.displayName}`)
        .join(" ");
      await onSend({
        mentionedUserIds: selectedAgents.map((agent) => agent.imUserId),
        text: mentionPrefix ? `${mentionPrefix} ${body}` : body,
      });
      updateText("");
      persistDraft("");
      setSelectedIds([]);
      setAttachmentPickerOpen(false);
      setMentionPickerOpen(false);
    } finally {
      submitPending.current = false;
    }
  }

  async function handleKeyPress(event: TextInputKeyPressEvent): Promise<void> {
    if (Platform.OS !== "web") return;
    const nativeEvent = event.nativeEvent as typeof event.nativeEvent & {
      isComposing?: boolean;
      keyCode?: number;
      shiftKey?: boolean;
    };
    if (
      nativeEvent.key !== "Enter" ||
      nativeEvent.shiftKey ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229 ||
      disabled ||
      text.trim().length === 0
    ) {
      return;
    }
    event.preventDefault();
    await submit();
  }

  const destinationHint = conversationLabel
    ? `发送给 ${conversationLabel}`
    : `发送到 #${channelName}`;
  const placeholder = narrowLayout
    ? "发消息"
    : conversationLabel
      ? compactLayout
        ? `给 ${conversationLabel} 发消息`
        : `发送消息给 ${conversationLabel}`
      : compactLayout
        ? `给 #${channelName} 发消息`
        : `发送消息到 #${channelName}，输入 @ 提及 Agent`;
  const input = (
    <TextInput
      accessibilityHint={destinationHint}
      accessibilityLabel="消息内容"
      editable={!disabled}
      multiline
      onChangeText={updateText}
      onBlur={handleInputBlur}
      onContentSizeChange={handleContentSizeChange}
      onFocus={handleInputFocus}
      onKeyPress={handleKeyPress}
      placeholder={placeholder}
      placeholderTextColor={theme.semantic.color.fieldPlaceholder}
      style={[
        styles.input,
        compactLayout ? styles.inputCompact : styles.inputWide,
        {height: inputHeight},
      ]}
      value={text}
    />
  );
  const mentionAction = agents.length > 0 ? (
    <Pressable
      accessibilityLabel="提及 Agent"
      accessibilityRole="button"
      accessibilityState={{expanded: mentionPickerOpen}}
      disabled={disabled}
      onPress={() => {
        setAttachmentPickerOpen(false);
        setMentionPickerOpen((current) => !current);
      }}
      style={[
        styles.attachmentButton,
        mentionPickerOpen && styles.attachmentButtonPressed,
        disabled && styles.attachmentButtonDisabled,
      ]}
    >
      <AtSign color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.medium} strokeWidth={theme.semantic.icon.stroke.regular} />
    </Pressable>
  ) : null;
  const desktopAttachmentActions = (
    <View style={styles.attachmentActions}>
      {showAttachments ? (
        <>
          <Pressable
            accessibilityLabel="添加文件"
            accessibilityRole="button"
            disabled={disabled}
            hitSlop={theme.semantic.interaction.hitTargetInset}
            onPress={onAttachFile}
            style={({pressed}) => [
              styles.attachmentButton,
              pressed && styles.attachmentButtonPressed,
              disabled && styles.attachmentButtonDisabled,
            ]}
          >
            <View testID="composer-icon-file">
              <Paperclip color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.medium} strokeWidth={theme.semantic.icon.stroke.regular} />
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel="添加图片"
            accessibilityRole="button"
            disabled={disabled}
            hitSlop={theme.semantic.interaction.hitTargetInset}
            onPress={onAttachImage}
            style={({pressed}) => [
              styles.attachmentButton,
              pressed && styles.attachmentButtonPressed,
              disabled && styles.attachmentButtonDisabled,
            ]}
          >
            <View testID="composer-icon-image">
              <ImageIcon color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.medium} strokeWidth={theme.semantic.icon.stroke.regular} />
            </View>
          </Pressable>
        </>
      ) : null}
      {mentionAction}
    </View>
  );
  const compactAttachmentTrigger = showAttachments ? (
    <Pressable
      accessibilityLabel={
        attachmentPickerOpen ? "关闭附件选项" : "打开附件选项"
      }
      accessibilityRole="button"
      accessibilityState={{expanded: attachmentPickerOpen}}
      disabled={disabled}
      onPress={() => {
        setMentionPickerOpen(false);
        setAttachmentPickerOpen((current) => !current);
      }}
      style={[
        styles.attachmentButton,
        attachmentPickerOpen && styles.attachmentButtonPressed,
        disabled && styles.attachmentButtonDisabled,
      ]}
    >
      <Plus color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.large} strokeWidth={theme.semantic.icon.stroke.regular} />
    </Pressable>
  ) : null;
  const compactAttachmentPicker =
    compactLayout && showAttachments && attachmentPickerOpen ? (
      <View style={styles.attachmentPicker} testID="attachment-picker">
        <Pressable
          accessibilityLabel="添加图片"
          accessibilityRole="button"
          disabled={disabled}
          onPress={() => chooseAttachment(onAttachImage)}
          style={({pressed}) => [
            styles.attachmentPickerButton,
            pressed && styles.attachmentButtonPressed,
            disabled && styles.attachmentButtonDisabled,
          ]}
        >
          <ImageIcon color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.medium} strokeWidth={theme.semantic.icon.stroke.regular} />
          <Text style={styles.attachmentPickerText}>图片</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="添加文件"
          accessibilityRole="button"
          disabled={disabled}
          onPress={() => chooseAttachment(onAttachFile)}
          style={({pressed}) => [
            styles.attachmentPickerButton,
            pressed && styles.attachmentButtonPressed,
            disabled && styles.attachmentButtonDisabled,
          ]}
        >
          <Paperclip color={theme.semantic.color.iconMuted} size={theme.semantic.icon.size.medium} strokeWidth={theme.semantic.icon.stroke.regular} />
          <Text style={styles.attachmentPickerText}>文件</Text>
        </Pressable>
      </View>
    ) : null;
  const sendDisabled = disabled || text.trim().length === 0;
  const sendButton = (
    <Pressable
      accessibilityLabel="发送消息"
      accessibilityRole="button"
      disabled={sendDisabled}
      onPress={submit}
      style={({pressed}) => [
        styles.sendButton,
        compactLayout && styles.sendButtonCompact,
        pressed && styles.sendButtonPressed,
        sendDisabled && styles.sendButtonDisabled,
      ]}
    >
      {compactLayout ? null : (
        <Text style={[styles.sendButtonText, sendDisabled && styles.sendButtonTextDisabled]}>发送</Text>
      )}
      <View testID="composer-icon-send">
        <Send
          color={sendDisabled ? theme.semantic.color.actionDisabledText : theme.semantic.color.iconInverse}
          size={compactLayout ? theme.semantic.icon.size.small : theme.semantic.icon.size.compact}
          strokeWidth={theme.semantic.icon.stroke.emphasis}
        />
      </View>
    </Pressable>
  );

  return (
    <View
      style={[
        styles.composer,
        !compactLayout && styles.composerWide,
        compactLayout && styles.composerCompact,
      ]}
      testID="message-composer"
    >
      {quote ? (
        <View style={styles.quotePreview}>
          <View style={styles.quoteCopy}>
            <Text style={styles.quoteSender}>引用 {quote.senderName}</Text>
            <Text numberOfLines={2} style={styles.quoteText}>
              {quote.preview}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="取消引用"
            accessibilityRole="button"
            hitSlop={theme.semantic.interaction.hitTargetInset}
            onPress={onClearQuote}
            style={styles.quoteClose}
          >
            <Text style={styles.quoteCloseText}>×</Text>
          </Pressable>
        </View>
      ) : null}
      {agents.length > 0 && mentionPickerOpen ? (
        <ScrollView
          contentContainerStyle={styles.mentions}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {agents.map((agent) => {
            const selected = selectedIds.includes(agent.id);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                hitSlop={theme.semantic.interaction.hitTargetInset}
                key={agent.id}
                onPress={() => toggleAgent(agent.id)}
                style={[
                  styles.mentionButton,
                  selected && styles.mentionButtonSelected,
                ]}
              >
                {selected ? (
                  <View testID={`mention-selected-icon-${agent.id}`}>
                    <Check color={theme.semantic.color.iconAccent} size={theme.semantic.icon.size.compact} strokeWidth={theme.semantic.icon.stroke.strong} />
                  </View>
                ) : null}
                <Text
                  style={[
                    styles.mentionText,
                    selected && styles.mentionTextSelected,
                  ]}
                >
                  @{agent.displayName}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {compactAttachmentPicker}
      <View
        style={[
          styles.controlRow,
          compactLayout && styles.controlRowCompact,
        ]}
        testID="composer-control-row"
      >
        {compactLayout ? compactAttachmentTrigger : desktopAttachmentActions}
        {compactLayout ? mentionAction : null}
        {input}
        {sendButton}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  attachmentActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xxs,
  },
  attachmentButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    height: theme.recipes.control.height,
    width: theme.recipes.control.squareSize,
  },
  attachmentButtonDisabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  attachmentButtonPressed: {
    backgroundColor: theme.semantic.color.actionTonalSurface,
  },
  composer: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderColor: theme.semantic.color.borderSection,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xxs,
    marginBottom: theme.spacing.lg,
    marginHorizontal: theme.spacing.lg,
    minHeight: theme.recipes.conversationWorkspace.composerSurfaceMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  composerCompact: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderColor: theme.semantic.color.separator,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderRadius: theme.semantic.radius.pane,
    borderRightWidth: 0,
    borderTopWidth: theme.semantic.stroke.hairline,
    marginBottom: 0,
    marginHorizontal: 0,
    minHeight: theme.recipes.compactWorkspace.composerMinHeight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  composerWide: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderColor: theme.semantic.color.separator,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderRadius: theme.semantic.radius.pane,
    borderRightWidth: 0,
    borderTopWidth: theme.semantic.stroke.hairline,
    marginBottom: 0,
    marginHorizontal: 0,
    minHeight: theme.recipes.desktopWorkspace.composerMinHeight,
    paddingHorizontal:
      theme.recipes.desktopWorkspace.composerHorizontalPadding,
    paddingVertical: theme.recipes.desktopWorkspace.composerVerticalPadding,
  },
  controlRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.control.height,
  },
  controlRowCompact: {
    gap: theme.spacing.xxs,
  },
  input: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.composerInput,
    maxHeight: theme.recipes.conversationWorkspace.composerInputMaxHeight,
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.xxs,
    paddingVertical: theme.spacing.sm,
  },
  inputCompact: {
    flex: 1,
    ...theme.semantic.typography.composerInputCompact,
    minWidth: 0,
    paddingHorizontal: theme.spacing.sm,
  },
  inputWide: {
    flex: 1,
    ...theme.semantic.typography.composerInput,
    paddingHorizontal: theme.spacing.sm,
  },
  mentionButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.actionSecondaryBorder,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.xs,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.md,
  },
  mentionButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderSelected,
  },
  mentionText: {
    color: theme.semantic.color.actionSecondaryText,
    ...theme.semantic.typography.label,
  },
  mentionTextSelected: {
    color: theme.semantic.color.textLink,
  },
  mentions: {
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  quoteClose: {
    alignItems: "center",
    alignSelf: "stretch",
    borderLeftColor: theme.semantic.color.separator,
    borderLeftWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    width: theme.recipes.control.squareSize,
  },
  quoteCloseText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.sectionTitle,
  },
  quoteCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  quotePreview: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
  },
  quoteSender: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.label,
  },
  quoteText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  sendButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.control.height,
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.lg,
  },
  sendButtonDisabled: {
    backgroundColor: theme.semantic.color.actionDisabledSurface,
    opacity: 1,
  },
  sendButtonPressed: {
    backgroundColor: theme.semantic.color.actionPrimaryPressedSurface,
  },
  sendButtonText: {
    color: theme.semantic.color.actionPrimaryText,
    ...theme.semantic.typography.label,
  },
  sendButtonTextDisabled: {
    color: theme.semantic.color.actionDisabledText,
  },
  sendButtonCompact: {
    paddingHorizontal: 0,
    width: theme.recipes.control.squareSize,
  },
  attachmentPicker: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  attachmentPickerButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.actionSecondaryBorder,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing.sm,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.md,
  },
  attachmentPickerText: {
    color: theme.semantic.color.actionSecondaryText,
    ...theme.semantic.typography.button,
  },
}));

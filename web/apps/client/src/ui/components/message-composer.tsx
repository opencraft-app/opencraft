import {
  composerDocumentHasContent,
  composerDocumentText,
  createComposerDocument,
  readComposerMentionTrigger,
  type AttachmentSource,
  type ComposerAttachmentDraft,
  type ComposerDraft,
  type ComposerEditorCursor,
  type ComposerMentionTrigger,
  type MessageQuote,
} from "@vela/client-core";
import {useEffect, useMemo, useRef, useState} from "react";
import {Pressable, ScrollView, Text, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";
import AtSign from "lucide-react-native/icons/at-sign";
import Bot from "lucide-react-native/icons/bot";
import FileText from "lucide-react-native/icons/file-text";
import ImageIcon from "lucide-react-native/icons/image";
import Paperclip from "lucide-react-native/icons/paperclip";
import Send from "lucide-react-native/icons/send";
import User from "lucide-react-native/icons/user";
import X from "lucide-react-native/icons/x";

import type {ConversationSurfaceMode} from "./message-presentation";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSnapshot,
  type ComposerSuggestionCommand,
} from "./composer-editor";
import {
  ComposerFooter,
  ComposerMaterialSurface,
  ComposerStage,
  ComposerSurfaceLayout,
} from "./composer-surface";

const MAX_ATTACHMENTS = 9;
const MAX_IMAGE_BYTES = 28 * 1_024 * 1_024;
const MAX_FILE_BYTES = 100 * 1_024 * 1_024;

export interface MentionableMember {
  displayName: string;
  handle: string;
  id: string;
  imUserId: string;
  kind: "human" | "agent";
}

export interface MessageComposerProps {
  channelName: string;
  conversationLabel?: string;
  disabled?: boolean;
  draft?: ComposerDraft;
  members: MentionableMember[];
  onAttachFile?(): AttachmentSource | null | Promise<AttachmentSource | null>;
  onAttachImage?(): AttachmentSource | null | Promise<AttachmentSource | null>;
  onClearQuote?(): void | Promise<void>;
  onDraftChange?(draft: ComposerDraft): void;
  onFocus?(): void;
  onSend(draft: ComposerDraft): void | Promise<void>;
  quote?: MessageQuote | null;
  showAttachments?: boolean;
  surfaceMode: ConversationSurfaceMode;
}

export function MessageComposer({
  channelName,
  conversationLabel,
  disabled = false,
  draft,
  members,
  onAttachFile = () => null,
  onAttachImage = () => null,
  onClearQuote = () => undefined,
  onDraftChange = () => undefined,
  onFocus = () => undefined,
  onSend,
  quote = null,
  showAttachments = true,
  surfaceMode,
}: MessageComposerProps) {
  const {theme} = useUnistyles();
  const compact = surfaceMode !== "desktop";
  const editorRef = useRef<ComposerEditorHandle>(null);
  const submitPending = useRef(false);
  const [localDraft, setLocalDraft] = useState<ComposerDraft>(() =>
    cloneDraft(draft ?? emptyDraft()),
  );
  const [snapshot, setSnapshot] = useState<ComposerEditorSnapshot>(() => ({
    document: localDraft.document,
    selection: null,
    text: composerDocumentText(localDraft.document),
  }));
  const [manualMentionPicker, setManualMentionPicker] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const lastExternalKey = useRef(draftKey(localDraft));

  const externalKey = draft ? draftKey(draft) : draftKey(emptyDraft());
  useEffect(() => {
    if (externalKey === lastExternalKey.current) return;
    const next = cloneDraft(draft ?? emptyDraft());
    lastExternalKey.current = externalKey;
    setLocalDraft(next);
    setSnapshot({
      document: next.document,
      selection: null,
      text: composerDocumentText(next.document),
    });
    editorRef.current?.replaceDocument(next.document);
  }, [draft, externalKey]);

  const trigger = readComposerMentionTrigger(snapshot.text, snapshot.selection);
  const suggestions = useMemo(
    () => filterMembers(members, manualMentionPicker ? "" : trigger?.query ?? ""),
    [manualMentionPicker, members, trigger?.query],
  );
  const suggestionsOpen =
    members.length > 0 && suggestions.length > 0 && (manualMentionPicker || Boolean(trigger));

  useEffect(() => setActiveSuggestion(0), [manualMentionPicker, trigger?.query]);

  function publishDraft(next: ComposerDraft): void {
    lastExternalKey.current = draftKey(next);
    setLocalDraft(next);
    onDraftChange(cloneDraft(next));
  }

  function handleSnapshot(next: ComposerEditorSnapshot): void {
    setSnapshot(next);
    publishDraft({...localDraft, document: next.document});
  }

  function mentionTrigger(): ComposerMentionTrigger {
    if (trigger) return trigger;
    const cursor = collapsedCursor(snapshot.selection, snapshot.text.length);
    return {end: cursor, query: "", start: cursor};
  }

  function selectMember(member: MentionableMember): void {
    editorRef.current?.replaceMention({
      mention: {
        displayName: member.displayName,
        handle: member.handle,
        imUserId: member.imUserId,
        memberId: member.id,
        memberKind: member.kind,
        type: "mention",
      },
      trigger: mentionTrigger(),
    });
    setManualMentionPicker(false);
    setActiveSuggestion(0);
  }

  function handleSuggestionCommand(command: ComposerSuggestionCommand): void {
    if (!suggestionsOpen) return;
    if (command === "dismiss") {
      setManualMentionPicker(false);
      return;
    }
    if (command === "accept") {
      const member = suggestions[activeSuggestion];
      if (member) selectMember(member);
      return;
    }
    setActiveSuggestion((current) =>
      wrapIndex(
        current + (command === "next" ? 1 : -1),
        suggestions.length,
      ),
    );
  }

  async function addAttachment(
    kind: "file" | "image",
    pick: () => AttachmentSource | null | Promise<AttachmentSource | null>,
  ): Promise<void> {
    setManualMentionPicker(false);
    if (localDraft.attachments.length >= MAX_ATTACHMENTS) {
      setLocalError(`每条消息最多可添加 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const source = await pick();
    if (!source) return;
    const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (source.size !== undefined && source.size > limit) {
      setLocalError(
        kind === "image" ? "图片不能超过 28MB" : "文件不能超过 100MB",
      );
      return;
    }
    setLocalError(null);
    publishDraft({
      ...localDraft,
      attachments: [
        ...localDraft.attachments,
        attachmentDraft(kind, source),
      ],
    });
  }

  function removeAttachment(id: string): void {
    publishDraft({
      ...localDraft,
      attachments: localDraft.attachments.filter((item) => item.id !== id),
    });
  }

  async function submit(nextSnapshot: ComposerEditorSnapshot): Promise<void> {
    if (
      disabled ||
      submitPending.current ||
      (!composerDocumentHasContent(nextSnapshot.document) &&
        localDraft.attachments.length === 0)
    ) {
      return;
    }
    submitPending.current = true;
    const outgoing: ComposerDraft = {
      attachments: localDraft.attachments.map((item) => ({...item})),
      document: nextSnapshot.document,
      ...(quote ? {quote} : {}),
    };
    const next = emptyDraft();
    setSnapshot({document: next.document, selection: null, text: ""});
    publishDraft(next);
    editorRef.current?.replaceDocument(next.document);
    setManualMentionPicker(false);
    try {
      await onSend(outgoing);
    } finally {
      submitPending.current = false;
    }
  }

  const destinationHint = conversationLabel
    ? `发送给 ${conversationLabel}`
    : `发送到 #${channelName}`;
  const placeholder = compact
    ? "发消息"
    : conversationLabel
      ? `发送消息给 ${conversationLabel}`
      : `发送消息到 #${channelName}，输入 @ 提及成员`;
  const canSend =
    !disabled &&
    (composerDocumentHasContent(localDraft.document) ||
      localDraft.attachments.length > 0);
  const composerTypography = compact
    ? theme.semantic.typography.composerInputCompact
    : theme.semantic.typography.composerInput;
  const surfaceMetrics =
    theme.recipes.conversationWorkspace.composerSurfaceMetrics[surfaceMode];
  const appearance = {
    backgroundColor: theme.semantic.color.borderTransparent,
    chipBackgroundColor: theme.semantic.color.selectionSurface,
    chipTextColor: theme.semantic.color.textLink,
    maxHeight: surfaceMetrics.editorMaxHeight,
    minHeight: surfaceMetrics.editorMinHeight,
    paddingBottom: theme.spacing.sm,
    paddingHorizontal:
      theme.recipes.desktopWorkspace.composerHorizontalPadding,
    paddingTop: theme.recipes.desktopWorkspace.composerVerticalPadding,
    placeholderColor: theme.semantic.color.fieldPlaceholder,
    textLeading: composerTypography.lineHeight,
    textColor: theme.semantic.color.textPrimary,
    textSize: composerTypography.fontSize,
    typeface: composerTypography.fontFamily,
  };

  const quoteSlot = quote ? (
    <View style={styles.quotePreview}>
      <View style={styles.quoteCopy}>
        <Text style={styles.quoteSender}>引用 {quote.senderName}</Text>
        <Text numberOfLines={2} style={styles.quoteText}>{quote.preview}</Text>
      </View>
      <Pressable
        accessibilityLabel="取消引用"
        accessibilityRole="button"
        onPress={onClearQuote}
        style={styles.iconButton}
      >
        <X
          color={theme.semantic.color.iconMuted}
          size={theme.semantic.icon.size.medium}
        />
      </Pressable>
    </View>
  ) : undefined;
  const attachmentSlot = localDraft.attachments.length ? (
    <ScrollView
      contentContainerStyle={styles.attachmentList}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
    >
      {localDraft.attachments.map((attachment) => (
        <View key={attachment.id} style={styles.attachmentCard}>
          {attachment.kind === "image" ? (
            <ImageIcon
              color={theme.semantic.color.iconAccent}
              size={theme.semantic.icon.size.medium}
            />
          ) : (
            <FileText
              color={theme.semantic.color.iconAccent}
              size={theme.semantic.icon.size.medium}
            />
          )}
          <View style={styles.attachmentCopy}>
            <Text numberOfLines={1} style={styles.attachmentName}>
              {attachment.name}
            </Text>
            <Text style={styles.attachmentMeta}>{formatBytes(attachment.size)}</Text>
          </View>
          <Pressable
            accessibilityLabel={`移除附件 ${attachment.name}`}
            accessibilityRole="button"
            onPress={() => removeAttachment(attachment.id)}
            style={styles.attachmentRemove}
          >
            <X
              color={theme.semantic.color.iconMuted}
              size={theme.semantic.icon.size.compact}
            />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  ) : undefined;
  const editorSlot = (
    <View style={styles.input}>
      <ComposerEditor
        ref={editorRef}
        appearance={appearance}
        disabled={disabled}
        document={localDraft.document}
        onFocus={onFocus}
        onSnapshotChange={handleSnapshot}
        onSubmit={submit}
        onSuggestionCommand={handleSuggestionCommand}
        placeholder={placeholder}
        suggestionsOpen={suggestionsOpen}
      />
    </View>
  );
  const suggestionOverlay = suggestionsOpen ? (
    <View style={styles.suggestions} testID="mention-suggestions">
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.suggestionScroll}>
        {suggestions.map((member, index) => (
          <Pressable
            accessibilityLabel={`@${member.displayName}`}
            accessibilityRole="button"
            key={member.id}
            onPress={() => selectMember(member)}
            style={[
              styles.suggestion,
              index === activeSuggestion && styles.suggestionActive,
            ]}
          >
            <View style={styles.suggestionAvatar}>
              {member.kind === "agent" ? (
                <Bot
                  color={theme.semantic.color.iconAccent}
                  size={theme.semantic.icon.size.small}
                />
              ) : (
                <User
                  color={theme.semantic.color.iconMuted}
                  size={theme.semantic.icon.size.small}
                />
              )}
            </View>
            <View style={styles.suggestionCopy}>
              <Text style={styles.suggestionName}>{member.displayName}</Text>
              <Text style={styles.suggestionHandle}>@{member.handle}</Text>
            </View>
            <Text style={styles.suggestionKind}>
              {member.kind === "agent" ? "Agent" : "成员"}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  ) : undefined;
  const leadingActions = (
    <>
      {showAttachments ? (
        <>
          <Pressable
            accessibilityLabel="添加文件"
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => addAttachment("file", onAttachFile)}
            style={({pressed}) => [
              styles.iconButton,
              pressed && styles.iconButtonPressed,
            ]}
          >
            <Paperclip
              color={theme.semantic.color.iconMuted}
              size={theme.semantic.icon.size.large}
            />
          </Pressable>
          <Pressable
            accessibilityLabel="添加图片"
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => addAttachment("image", onAttachImage)}
            style={({pressed}) => [
              styles.iconButton,
              pressed && styles.iconButtonPressed,
            ]}
          >
            <ImageIcon
              color={theme.semantic.color.iconMuted}
              size={theme.semantic.icon.size.large}
            />
          </Pressable>
        </>
      ) : null}
      {members.length > 0 ? (
        <Pressable
          accessibilityLabel="提及成员"
          accessibilityRole="button"
          aria-expanded={suggestionsOpen}
          disabled={disabled}
          onPress={() => {
            setManualMentionPicker((current) => !current);
            editorRef.current?.focus();
          }}
          style={({pressed}) => [
            styles.iconButton,
            suggestionsOpen && styles.mentionButtonSelected,
            pressed && styles.iconButtonPressed,
          ]}
        >
          <AtSign
            color={theme.semantic.color.iconMuted}
            size={theme.semantic.icon.size.large}
          />
        </Pressable>
      ) : null}
    </>
  );
  const primaryAction = (
    <Pressable
      accessibilityLabel="发送消息"
      accessibilityRole="button"
      disabled={!canSend}
      onPress={() => editorRef.current?.requestSubmit()}
      style={({pressed}) => [
        styles.sendButton,
        pressed && styles.sendButtonPressed,
        !canSend && styles.sendButtonDisabled,
      ]}
    >
      <Send
        color={
          canSend
            ? theme.semantic.color.iconInverse
            : theme.semantic.color.actionDisabledText
        }
        size={theme.semantic.icon.size.medium}
        strokeWidth={theme.semantic.icon.stroke.strong}
      />
    </Pressable>
  );

  return (
    <View
      accessibilityHint={destinationHint}
      style={[
        styles.outer,
        surfaceMode === "desktop" ? styles.outerDesktop : styles.outerCompact,
      ]}
      testID="message-composer"
    >
      <ComposerStage overlay={suggestionOverlay} surfaceMode={surfaceMode}>
        <ComposerMaterialSurface
          disabled={disabled}
          onPressBackground={() => editorRef.current?.focus()}
          surfaceMode={surfaceMode}
          testID="message-composer-surface"
        >
          <ComposerSurfaceLayout
            attachments={attachmentSlot}
            editor={editorSlot}
            error={localError ? <Text style={styles.errorText}>{localError}</Text> : undefined}
            footer={
              <ComposerFooter
                leadingActions={leadingActions}
                primaryAction={primaryAction}
                surfaceMode={surfaceMode}
              />
            }
            quote={quoteSlot}
          />
        </ComposerMaterialSurface>
      </ComposerStage>
    </View>
  );
}

function emptyDraft(): ComposerDraft {
  return {attachments: [], document: createComposerDocument()};
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return {
    attachments: draft.attachments.map((item) => ({...item})),
    document: createComposerDocument(draft.document.nodes),
    ...(draft.quote ? {quote: draft.quote} : {}),
  };
}

function draftKey(draft: ComposerDraft): string {
  return JSON.stringify({
    attachments: draft.attachments.map((item) => item.id),
    document: draft.document,
    quote: draft.quote?.messageId,
  });
}

function filterMembers(members: MentionableMember[], query: string): MentionableMember[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return members
    .filter((member) =>
      normalized.length === 0
        ? true
        : member.displayName.toLocaleLowerCase("zh-CN").includes(normalized) ||
          member.handle.toLocaleLowerCase("zh-CN").includes(normalized),
    )
    .slice(0, 12);
}

function collapsedCursor(selection: ComposerEditorCursor | null, fallback: number): number {
  return selection && selection.start === selection.end ? selection.end : fallback;
}

function wrapIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

function attachmentDraft(
  kind: "file" | "image",
  source: AttachmentSource,
): ComposerAttachmentDraft {
  return {
    id: attachmentId(),
    kind,
    ...(source.mimeType ? {mimeType: source.mimeType} : {}),
    name: source.name,
    ...(source.kind === "uri" && kind === "image" ? {previewUri: source.uri} : {}),
    ...(source.size !== undefined ? {size: source.size} : {}),
    source,
  };
}

function attachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "待上传";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  attachmentCard: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    maxWidth: theme.recipes.conversationWorkspace.composerAttachmentMaxWidth,
    minWidth: theme.recipes.conversationWorkspace.composerAttachmentMinWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  attachmentCopy: {
    flex: 1,
    minWidth: 0,
  },
  attachmentList: {
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
  },
  attachmentMeta: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  attachmentName: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.label,
  },
  attachmentRemove: {
    alignItems: "center",
    height: theme.recipes.iconControl.microSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.microSize,
  },
  errorText: {
    color: theme.semantic.color.actionDangerBorder,
    paddingHorizontal: theme.spacing.sm,
    ...theme.semantic.typography.meta,
  },
  iconButton: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.control,
    height: theme.recipes.iconControl.denseSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.denseSize,
    ...theme.semantic.motion.transition.control,
  },
  iconButtonPressed: {
    backgroundColor: theme.semantic.color.actionSecondaryPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  input: {
    width: "100%",
  },
  mentionButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    ...theme.semantic.motion.transition.control,
  },
  // The outer frame owns placement; desktop gets a bounded editor surface while
  // compact and native surfaces remain docked and full width.
  outer: {
    alignItems: "stretch",
    marginBottom: 0,
    paddingHorizontal: 0,
    width: "100%",
  },
  outerCompact: {
    marginBottom: 0,
    paddingHorizontal: 0,
  },
  outerDesktop: {
    alignItems: "center",
    paddingHorizontal: theme.recipes.desktopWorkspace.composerHorizontalPadding,
    paddingVertical: theme.recipes.desktopWorkspace.composerVerticalPadding,
  },
  quoteCopy: {
    flex: 1,
    gap: theme.spacing.xs,
    minWidth: 0,
    padding: theme.spacing.sm,
  },
  quotePreview: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    marginHorizontal: theme.spacing.sm,
    marginTop: theme.spacing.sm,
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
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.conversationWorkspace.composerPrimaryActionSize,
    justifyContent: "center",
    width: theme.recipes.conversationWorkspace.composerPrimaryActionSize,
    ...theme.semantic.motion.transition.control,
  },
  sendButtonDisabled: {
    backgroundColor: theme.semantic.color.actionDisabledSurface,
    ...theme.semantic.motion.transition.control,
  },
  sendButtonPressed: {
    backgroundColor: theme.semantic.color.actionPrimaryPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  suggestion: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.conversationWorkspace.composerSuggestionMinHeight,
    paddingHorizontal: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
  },
  suggestionActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    ...theme.semantic.motion.transition.control,
  },
  suggestionAvatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.avatarCompactSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarCompactSize,
  },
  suggestionCopy: {
    flex: 1,
    minWidth: 0,
  },
  suggestionHandle: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  suggestionKind: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  suggestionName: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.label,
  },
  suggestionScroll: {
    maxHeight: theme.recipes.managementWorkspace.switcherMenuMaxHeight,
  },
  suggestions: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderColor: theme.semantic.color.borderSection,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    bottom: "100%",
    left: theme.spacing.sm,
    maxWidth: theme.recipes.overlay.confirmDialogMaxWidth,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.xs,
    position: "absolute",
    right: theme.spacing.sm,
    zIndex: theme.semantic.layer.popover,
  },
}));

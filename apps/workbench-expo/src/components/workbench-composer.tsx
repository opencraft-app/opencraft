import { nativeMonoFontFamily, nativeTypographyStyle } from "@opencraft/design-system/typography";
import { BlurView } from "expo-blur";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { PermissionProfileSummary, Project } from "@opencraft/appserver-protocol/generated/v2";
import {
  ArrowUpIcon as ArrowUp,
  BoldIcon as Bold,
  CheckIcon as Check,
  ChevronDownIcon as ChevronDown,
  CodeIcon as Code2,
  NewFileIcon as FilePlus2,
  FolderOpenIcon as FolderOpen,
  AddImageIcon as ImagePlus,
  ItalicIcon as Italic,
  LinkIcon as Link2,
  ListIcon as List,
  OrderedListIcon as ListOrdered,
  AttachmentIcon as Paperclip,
  ParagraphIcon as Pilcrow,
  QuoteIcon as Quote,
  RedoIcon as Redo2,
  ResetIcon as RotateCcw,
  ReviewShieldIcon as ShieldCheck,
  SquareIcon as Square,
  UndoIcon as Undo2,
  CloseIcon as X,
} from "@opencraft/design-system-native/action-icons";
import {
  composerDocumentToPlainText,
  createClientId,
  resolveComposerPrimaryAction,
  reasoningCapability,
  resolveReasoningEffort,
  type ComposerAttachment,
  type ComposerController,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";
import {
  resolveComposerModelChoice,
  humanizeCatalogValue,
  type WorkbenchComposerModelChoice,
} from "@opencraft/workbench-runtime";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Platform, ScrollView, Text, View } from "react-native";
import type { NativeAttachmentSource } from "../runtime/native-attachment-resolver";
import { nativeAttachmentSession } from "../runtime/native-attachment-session";
import { prepareNativeAttachmentSource } from "../runtime/native-attachment-source";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log";
import { nativeComposerHistory } from "../runtime/native-composer-history";
import { formatNativeComposerBlock, nativeComposerBlockFormatAt, type NativeComposerBlockFormat } from "../runtime/native-composer-block-actions";
import { hasNativeComposerMarks, insertNativeComposerText, nativeComposerLinkAt, normalizeNativeComposerLinkAddress, projectNativeComposerVisualRuns, setNativeComposerLink, toggleNativeComposerMark } from "../runtime/native-composer-document";
import { applyNativeComposerTextTransaction } from "../runtime/native-composer-text-transaction";
import { StyleSheet, useWorkbenchTheme } from "../styles/workbench-styles";
import { IconButton } from "./ui/button";
import { InteractiveSurface } from "./ui/interactive-surface";
import { ModalSurface } from "./ui/modal-surface";
import { NativeComposerLinkEditor } from "./native-composer-link-editor";
import { NativeRichTextInput, type NativeRichTextInputHandle } from "./native-rich-text-input";

interface WorkbenchComposerProps {
  controller: ComposerController;
  language: "zh-CN" | "en";
  models: readonly WorkbenchComposerModelChoice[];
  modelsLoading: boolean;
  modelCatalogFailed: boolean;
  onRetryModelCatalog(): void;
  canAttachFiles: boolean;
  permissionProfiles: readonly PermissionProfileSummary[];
  projects: readonly Project[];
  selectedWorkspace: string | null;
  isStreaming: boolean;
  bottomInset: number;
  inputMaximumHeight?: number;
  maximumHeight?: number;
  onSubmit(
    intent: SubmitIntent,
    context: { readonly followUpAction: ComposerFollowUpAction | null },
  ): boolean | void | Promise<boolean | void>;
  onCancel(): void;
  onResolveAttachment(source: NativeAttachmentSource, pending: ComposerAttachment, signal?: AbortSignal): Promise<ComposerAttachment>;
  onRemoveAttachment(attachment: ComposerAttachment): Promise<void>;
  onSelectWorkspace(projectId: string, cwd: string): void;
}

export function WorkbenchComposer({
  controller,
  language,
  models,
  modelsLoading,
  modelCatalogFailed,
  onRetryModelCatalog,
  canAttachFiles,
  permissionProfiles,
  projects,
  selectedWorkspace,
  isStreaming,
  bottomInset,
  inputMaximumHeight,
  maximumHeight,
  onSubmit,
  onCancel,
  onResolveAttachment,
  onRemoveAttachment,
  onSelectWorkspace,
}: WorkbenchComposerProps) {
  const { theme } = useWorkbenchTheme();
  const label = (zh: string, en: string) => language === "zh-CN" ? zh : en;
  const inputRef = useRef<NativeRichTextInputHandle>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [blockFormatOpen, setBlockFormatOpen] = useState(false);
  const [linkEditor, setLinkEditor] = useState<{ draftId: string; start: number; end: number; existing: boolean } | null>(null);
  const [linkAddress, setLinkAddress] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState(false);
  const [textSelection, setTextSelection] = useState({ start: 0, end: 0 });
  const markRange = useRef({ start: 0, end: 0 });
  const selectedRange = useRef<{ start: number; end: number } | null>(null);
  const selectionKnown = useRef(false);
  const selectionFrame = useRef<number | null>(null);
  const inputFocused = useRef(false);
  const mounted = useRef(false);
  const currentController = useRef(controller);
  currentController.current = controller;
  const submittingDrafts = useRef(new Set<string>());
  const attachmentSession = nativeAttachmentSession(controller);
  const editHistory = nativeComposerHistory(controller);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const draft = composerDocumentToPlainText(snapshot.draft.document);
  const activeBlockFormat = nativeComposerBlockFormatAt(snapshot.draft.document,
    selectionKnown.current ? textSelection.start : draft.length);
  // The attributed runs follow the exact shared plain-text projection, so
  // quote and list leaves can show marks in the iOS editor as well.
  const visualRuns = projectNativeComposerVisualRuns(snapshot.draft.document);
  const previewRuns = visualRuns;
  const richEditable = Platform.OS === "ios";
  const editing = snapshot.draft.lifecycle.phase !== "submitting";
  const canSend = snapshot.canSubmit;
  const canUndo = editHistory.canUndo(snapshot.draft.id, snapshot.draft.document);
  const canRedo = editHistory.canRedo(snapshot.draft.id, snapshot.draft.document);
  const metrics = theme.metrics;
  const selectedModel = resolveComposerModelChoice(models, snapshot.draft.selections.model);
  const selectedEffort = selectedModel?.efforts.find(choice => choice.value === snapshot.draft.selections.effort)
    ?? selectedModel?.efforts.find(choice => choice.value === selectedModel.defaultEffort);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setEditorError(false);
    setLinkEditor(null);
    selectionKnown.current = false;
    inputFocused.current = false;
    markRange.current = { start: 0, end: 0 };
    selectedRange.current = null;
    setTextSelection(markRange.current);
  }, [snapshot.draft.id]);

  useEffect(() => () => {
    if (selectionFrame.current !== null) cancelAnimationFrame(selectionFrame.current);
  }, []);

  const addAttachment = useCallback((source: NativeAttachmentSource) => {
    if (controller.getSnapshot().draft.lifecycle.phase === "submitting") return;
    setPickerError(null);
    attachmentSession.add(source, onResolveAttachment, onRemoveAttachment,
      () => mobileDeveloperLog.log("chat.attachment.failed"));
  }, [attachmentSession, controller, onRemoveAttachment, onResolveAttachment]);

  const choosePhoto = useCallback(async () => {
    setAttachmentPickerOpen(false);
    setPickerError(null);
    let originDraftId: string | null = null;
    try {
      originDraftId = controller.getSnapshot().draft.id;
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 1 });
      if (result.canceled || !mounted.current || currentController.current !== controller
        || controller.getSnapshot().draft.id !== originDraftId
        || controller.getSnapshot().draft.lifecycle.phase === "submitting") return;
      for (const asset of result.assets) addAttachment(prepareNativeAttachmentSource({
        uri: asset.uri, name: asset.fileName, mimeType: asset.mimeType, size: asset.fileSize,
      }, "photo", createClientId()));
    } catch {
      if (!mounted.current || currentController.current !== controller
        || controller.getSnapshot().draft.id !== originDraftId) return;
      mobileDeveloperLog.log("chat.picker.failed");
      setPickerError(label("无法打开照片，请重试。", "Could not open photos. Please try again."));
    }
  }, [addAttachment, controller, language]);

  const chooseFile = useCallback(async () => {
    setAttachmentPickerOpen(false);
    setPickerError(null);
    if (!canAttachFiles) return;
    let originDraftId: string | null = null;
    try {
      originDraftId = controller.getSnapshot().draft.id;
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (result.canceled || !mounted.current || currentController.current !== controller
        || controller.getSnapshot().draft.id !== originDraftId
        || controller.getSnapshot().draft.lifecycle.phase === "submitting") return;
      for (const asset of result.assets) addAttachment(prepareNativeAttachmentSource({
        uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size,
      }, "file", createClientId()));
    } catch {
      if (!mounted.current || currentController.current !== controller
        || controller.getSnapshot().draft.id !== originDraftId) return;
      mobileDeveloperLog.log("chat.picker.failed");
      setPickerError(label("无法打开文件，请重试。", "Could not open files. Please try again."));
    }
  }, [addAttachment, canAttachFiles, controller, language]);

  const removeAttachment = useCallback((attachment: ComposerAttachment) => {
    attachmentSession.remove(controller.getSnapshot().draft.id, attachment.id, onRemoveAttachment);
  }, [attachmentSession, controller, onRemoveAttachment]);

  const selectModel = useCallback((model: WorkbenchComposerModelChoice) => {
    const currentEffort = snapshot.draft.selections.effort;
    const effort = resolveReasoningEffort(reasoningCapability(model.efforts.map(choice => choice.value), model.defaultEffort), currentEffort);
    controller.dispatch({
      type: "set-selections",
      patch: { model: model.value, effort },
    });
    setModelPickerOpen(false);
  }, [controller, snapshot.draft.selections.effort]);

  const updateText = useCallback((sourceDraftId: string, text: string) => {
    const activeDraft = controller.getSnapshot().draft;
    if (activeDraft.id !== sourceDraftId || activeDraft.lifecycle.phase === "submitting") return;
    if (selectionFrame.current !== null) {
      cancelAnimationFrame(selectionFrame.current);
      selectionFrame.current = null;
    }
    selectedRange.current = null;
    const current = activeDraft.document;
    const edit = applyNativeComposerTextTransaction(current, text, selectionKnown.current ? markRange.current : null);
    setEditorError(edit.rejected);
    if (edit.document === current) return;
    const beforeSelection = selectionKnown.current ? markRange.current : {
      start: composerDocumentToPlainText(current).length,
      end: composerDocumentToPlainText(current).length,
    };
    const afterSelection = edit.selection ?? (selectionKnown.current ? beforeSelection : { start: text.length, end: text.length });
    editHistory.record(activeDraft.id, current, edit.document, beforeSelection, afterSelection);
    if (edit.selection !== null) {
      markRange.current = edit.selection;
      setTextSelection(edit.selection);
    }
    controller.dispatch({
      type: "set-document",
      document: edit.document,
    });
    const settledSelection = edit.selection;
    if (edit.reconcileText && settledSelection !== null) {
      selectionFrame.current = requestAnimationFrame(() => {
        selectionFrame.current = null;
        const latest = controller.getSnapshot().draft;
        if (latest.id === activeDraft.id && composerDocumentToPlainText(latest.document) === composerDocumentToPlainText(edit.document)) {
          inputRef.current?.setSelection(settledSelection.start, settledSelection.end);
        }
      });
    }
  }, [controller, editHistory]);

  const formatBlock = useCallback((format: NativeComposerBlockFormat) => {
    setBlockFormatOpen(false);
    const current = controller.getSnapshot().draft;
    if (current.lifecycle.phase === "submitting") return;
    const plain = composerDocumentToPlainText(current.document);
    const selection = selectionKnown.current ? markRange.current : { start: plain.length, end: plain.length };
    const formatted = formatNativeComposerBlock(current.document, selection, format);
    if (formatted === null) {
      setEditorError(true);
      return;
    }
    setEditorError(false);
    editHistory.record(current.id, current.document, formatted.document, selection, formatted.selection);
    controller.dispatch({ type: "set-document", document: formatted.document });
    markRange.current = formatted.selection;
    selectedRange.current = formatted.selection.start < formatted.selection.end ? formatted.selection : null;
    selectionKnown.current = true;
    setTextSelection(formatted.selection);
    inputRef.current?.focus();
    if (selectionFrame.current !== null) cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = requestAnimationFrame(() => {
      selectionFrame.current = null;
      const latest = controller.getSnapshot().draft;
      if (latest.id === current.id && composerDocumentToPlainText(latest.document) === composerDocumentToPlainText(formatted.document)) {
        inputRef.current?.setSelection(formatted.selection.start, formatted.selection.end);
      }
    });
  }, [controller, editHistory]);

  const toggleMark = useCallback((mark: "strong" | "emphasis" | "code") => {
    if (controller.getSnapshot().draft.lifecycle.phase === "submitting") return;
    const selection = selectedRange.current ?? markRange.current;
    const document = toggleNativeComposerMark(
      controller.getSnapshot().draft.document, selection.start, selection.end, mark,
    );
    if (document !== null) {
      const current = controller.getSnapshot().draft;
      editHistory.record(current.id, current.document, document, selection, selection);
      controller.dispatch({ type: "set-document", document });
    }
  }, [controller, editHistory]);

  const openLinkEditor = useCallback(() => {
    const current = controller.getSnapshot().draft;
    const selection = selectedRange.current ?? markRange.current;
    if (current.lifecycle.phase === "submitting" || selection.start >= selection.end) return;
    const href = nativeComposerLinkAt(current.document, selection.start, selection.end);
    setLinkEditor({ draftId: current.id, ...selection, existing: href !== null });
    setLinkAddress(href ?? "");
    setLinkError(false);
  }, [controller]);

  const finishLinkEditor = useCallback((address: string | null) => {
    if (linkEditor === null) return;
    const current = controller.getSnapshot().draft;
    if (current.id !== linkEditor.draftId || current.lifecycle.phase === "submitting") {
      setLinkEditor(null);
      return;
    }
    const href = address === null ? null : normalizeNativeComposerLinkAddress(address);
    if (address !== null && href === null) {
      setLinkError(true);
      return;
    }
    const document = setNativeComposerLink(current.document, linkEditor.start, linkEditor.end, href);
    if (document === null) {
      setLinkError(true);
      return;
    }
    if (document !== current.document) {
      editHistory.record(current.id, current.document, document, linkEditor, { start: linkEditor.end, end: linkEditor.end });
      controller.dispatch({ type: "set-document", document });
    }
    markRange.current = { start: linkEditor.end, end: linkEditor.end };
    selectedRange.current = null;
    selectionKnown.current = true;
    setTextSelection(markRange.current);
    setLinkEditor(null);
    requestAnimationFrame(() => {
      if (controller.getSnapshot().draft.id !== current.id) return;
      inputRef.current?.setSelection(linkEditor.end, linkEditor.end);
    });
  }, [controller, editHistory, linkEditor]);

  const send = useCallback(async (followUpAction?: ComposerFollowUpAction) => {
    if (!snapshot.canSubmit) return;
    let intent: SubmitIntent;
    const originDraftId = controller.getSnapshot().draft.id;
    if (submittingDrafts.current.has(originDraftId)) return;
    try {
      intent = controller.createSubmitIntent();
    } catch {
      return;
    }
    submittingDrafts.current.add(originDraftId);
    controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
    try {
      const accepted = await onSubmit(intent, {
        followUpAction: isStreaming ? followUpAction ?? "queue" : null,
      });
      const outcome = accepted === false ? "rejected" : "accepted";
      controller.settleSubmission(originDraftId, intent, { status: outcome });
      attachmentSession.settleSubmission(originDraftId, outcome);
    } catch {
      mobileDeveloperLog.log("chat.submit.failed");
      controller.settleSubmission(originDraftId, intent, {
        status: "failed",
        error: label("消息发送失败，请重试。", "Could not send this message. Please try again."),
      });
      attachmentSession.settleSubmission(originDraftId, "failed");
    } finally {
      submittingDrafts.current.delete(originDraftId);
    }
  }, [attachmentSession, controller, isStreaming, language, onSubmit, snapshot.canSubmit]);

  const restoreHistory = useCallback((direction: "undo" | "redo") => {
    const current = controller.getSnapshot().draft;
    if (current.lifecycle.phase === "submitting") return;
    const restored = direction === "undo"
      ? editHistory.undo(current.id, current.document)
      : editHistory.redo(current.id, current.document);
    if (restored === null) return;
    if (selectionFrame.current !== null) cancelAnimationFrame(selectionFrame.current);
    controller.dispatch({ type: "set-document", document: restored.document });
    markRange.current = restored.selection;
    selectedRange.current = restored.selection.start < restored.selection.end ? restored.selection : null;
    selectionKnown.current = true;
    setTextSelection(restored.selection);
    setEditorError(false);
    selectionFrame.current = requestAnimationFrame(() => {
      selectionFrame.current = null;
      if (controller.getSnapshot().draft.id === current.id) {
        inputRef.current?.setSelection(restored.selection.start, restored.selection.end);
      }
    });
  }, [controller, editHistory]);

  useLayoutEffect(() => controller.registerView({
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    insertText: (text) => {
      const current = controller.getSnapshot().draft;
      if (current.lifecycle.phase === "submitting") return;
      const inserted = insertNativeComposerText(current.document, text, selectionKnown.current ? markRange.current : null);
      if (inserted === null) {
        setEditorError(true);
        return;
      }
      if (inserted.document !== current.document) {
        const previous = selectionKnown.current ? markRange.current : { start: composerDocumentToPlainText(current.document).length, end: composerDocumentToPlainText(current.document).length };
        editHistory.record(current.id, current.document, inserted.document, previous, { start: inserted.cursor, end: inserted.cursor });
        controller.dispatch({ type: "set-document", document: inserted.document });
      }
      markRange.current = { start: inserted.cursor, end: inserted.cursor };
      selectedRange.current = null;
      selectionKnown.current = true;
      setTextSelection(markRange.current);
      inputRef.current?.focus();
      if (selectionFrame.current !== null) cancelAnimationFrame(selectionFrame.current);
      selectionFrame.current = requestAnimationFrame(() => {
        selectionFrame.current = null;
        const latest = controller.getSnapshot().draft;
        if (latest.id === current.id && composerDocumentToPlainText(latest.document) === composerDocumentToPlainText(inserted.document)) {
          inputRef.current?.setSelection(inserted.cursor, inserted.cursor);
        }
      });
    },
    beginTransientTextInput: () => null,
    undo: () => restoreHistory("undo"),
    redo: () => restoreHistory("redo"),
  }), [controller, editHistory, restoreHistory]);

  const primaryAction = resolveComposerPrimaryAction({
    isResponseInProgress: isStreaming,
    canSubmit: snapshot.canSubmit,
    defaultFollowUpAction: "queue",
  });
  const primaryActionLabel = primaryAction === "stop"
    ? label("停止回复", "Stop response")
    : primaryAction === "queue"
      ? label("排队发送", "Queue follow-up")
      : primaryAction === "steer"
        ? label("调整当前回复", "Steer active response")
        : label("发送消息", "Send message");

  return (
    <View style={[styles.region, { paddingBottom: Math.max(bottomInset, metrics.composer.outerBottomInset), maxHeight: maximumHeight }]}>
      <View style={styles.shadowShell}>
        <BlurView intensity={82} tint="systemMaterialLight" style={styles.composer}>
          {snapshot.draft.attachments.length > 0 ? <ScrollView horizontal contentContainerStyle={styles.attachmentList}>
            {snapshot.draft.attachments.map(attachment => {
              const previewUri = attachmentSession.previewUri(snapshot.draft.id, attachment.id);
              return <View key={attachment.id} style={styles.attachmentChip}>
                {previewUri ? (
                  <Image accessibilityLabel={attachment.name} source={{ uri: previewUri }} style={styles.attachmentThumbnail} />
                ) : null}
                <Text numberOfLines={1} style={styles.attachmentName}>{attachment.name}</Text>
                <Text style={styles.attachmentStatus}>{attachment.lifecycle === "ready" ? "✓" : attachment.lifecycle === "failed" ? "!" : "…"}</Text>
                {attachment.lifecycle === "failed" && attachmentSession.canRetry(snapshot.draft.id, attachment.id) ? (
                  <IconButton accessibilityLabel={label(`重试 ${attachment.name}`, `Retry ${attachment.name}`)} disabled={!editing}
                    onPress={() => attachmentSession.retry(snapshot.draft.id, attachment.id)} size="sm">
                    <RotateCcw color={theme.color.icon.secondary} size={15} />
                  </IconButton>
                ) : null}
                <IconButton accessibilityLabel={label(`移除 ${attachment.name}`, `Remove ${attachment.name}`)} disabled={!editing} onPress={() => removeAttachment(attachment)} size="sm">
                  <X color={theme.color.icon.secondary} size={15} />
                </IconButton>
              </View>;
            })}
          </ScrollView> : null}
          {snapshot.draft.attachments.some(attachment => attachment.lifecycle === "failed") ? (
            <Text style={styles.attachmentError}>{label("附件添加失败，请重试或移除。", "Could not attach one of the files. Retry or remove it.")}</Text>
          ) : null}
          {pickerError ? <Text style={styles.attachmentError}>{pickerError}</Text> : null}
          <NativeRichTextInput
            accessibilityLabel={label("给 OpenCraft 发消息", "Message OpenCraft")}
            editable={editing}
            key={snapshot.draft.id}
            multiline
            onChangeText={text => updateText(snapshot.draft.id, text)}
            onFocus={() => {
              if (controller.getSnapshot().draft.id === snapshot.draft.id) inputFocused.current = true;
            }}
            onBlur={() => {
              if (controller.getSnapshot().draft.id === snapshot.draft.id) inputFocused.current = false;
            }}
            onSelectionChange={event => {
              const active = controller.getSnapshot().draft;
              if (active.id !== snapshot.draft.id) return;
              const length = composerDocumentToPlainText(active.document).length;
              const selection = {
                start: Math.max(0, Math.min(event.nativeEvent.selection.start, length)),
                end: Math.max(0, Math.min(event.nativeEvent.selection.end, length)),
              };
              if (selection.start < selection.end || inputFocused.current) {
                markRange.current = selection;
                selectionKnown.current = true;
                setTextSelection(selection);
                if (selection.start < selection.end) selectedRange.current = selection;
              }
            }}
            placeholder={label("给 OpenCraft 发消息", "Message OpenCraft")}
            placeholderTextColor={theme.color.text.tertiary}
            ref={inputRef}
            style={[styles.input, inputMaximumHeight === undefined ? null : {
              maxHeight: inputMaximumHeight,
              minHeight: Math.min(metrics.composer.inputMinimumHeight + metrics.composer.inputTopInset, inputMaximumHeight),
            }]}
            value={draft}
          >{richEditable ? <Text style={styles.richInputText}>
            {visualRuns.map((run, index) => <Text key={index} style={[
              run.marks.includes("strong") && styles.richStrong,
              run.marks.includes("emphasis") && styles.richEmphasis,
              run.marks.includes("code") && styles.richCode,
              run.href && styles.richLink,
            ]}>{run.text}</Text>)}
          </Text> : null}</NativeRichTextInput>
          {editorError ? <Text style={styles.attachmentError}>{label("这段内容请在桌面版继续编辑。", "Continue editing this content on desktop.")}</Text> : null}

          {!richEditable && hasNativeComposerMarks(snapshot.draft.document) ? (
            <View style={styles.richPreview}>
              <Text style={styles.richPreviewLabel}>{label("预览", "Preview")}</Text>
              <Text numberOfLines={3} style={styles.richPreviewText}>
                {previewRuns.map((run, index) => (
                  <Text key={index} style={[
                    run.marks.includes("strong") && styles.richStrong,
                    run.marks.includes("emphasis") && styles.richEmphasis,
                    run.marks.includes("code") && styles.richCode,
                    run.href && styles.richLink,
                  ]}>{run.text}</Text>
                ))}
              </Text>
            </View>
          ) : null}

          {textSelection.start < textSelection.end ? <View style={styles.formatRow}>
              <IconButton accessibilityLabel={label("加粗选中文字", "Bold selection")} disabled={!editing} onPress={() => toggleMark("strong")} size="sm">
                <Bold color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
              </IconButton>
              <IconButton accessibilityLabel={label("倾斜选中文字", "Italic selection")} disabled={!editing} onPress={() => toggleMark("emphasis")} size="sm">
                <Italic color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
              </IconButton>
              <IconButton accessibilityLabel={label("将选中文字设为代码", "Code selection")} disabled={!editing} onPress={() => toggleMark("code")} size="sm">
                <Code2 color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
              </IconButton>
              <IconButton accessibilityLabel={label("给选中文字添加链接", "Link selection")} disabled={!editing} onPress={openLinkEditor} size="sm">
                <Link2 color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
              </IconButton>
          </View> : null}
          <View style={styles.actionRow}>
            <ScrollView horizontal keyboardShouldPersistTaps="always" pointerEvents={editing ? "auto" : "none"} showsHorizontalScrollIndicator={false}
              style={styles.actionControls} contentContainerStyle={styles.actionControlsContent}>
            <IconButton accessibilityLabel={label("添加附件", "Add attachment")} onPress={() => setAttachmentPickerOpen(true)} size="sm">
              <Paperclip color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
            </IconButton>
            {canUndo || canRedo ? <>
              <IconButton accessibilityLabel={label("撤销编辑", "Undo edit")} disabled={!editing || !canUndo}
                onPress={() => restoreHistory("undo")} size="sm">
                <Undo2 color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
              </IconButton>
              <IconButton accessibilityLabel={label("重做编辑", "Redo edit")} disabled={!editing || !canRedo}
                onPress={() => restoreHistory("redo")} size="sm">
                <Redo2 color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
              </IconButton>
            </> : null}
            <InteractiveSurface accessibilityLabel={label("设置段落格式", "Format paragraph")} accessibilityRole="button"
              accessibilityState={{ disabled: !editing }} onPress={() => { if (editing) setBlockFormatOpen(true); }} style={styles.effortButton}>
              <Text style={styles.modelLabel}>{activeBlockFormat === "quote" ? label("引用", "Quote")
                : activeBlockFormat === "bullets" ? label("项目列表", "Bullets")
                  : activeBlockFormat === "numbers" ? label("编号列表", "Numbers")
                    : activeBlockFormat === "code" ? label("代码块", "Code block")
                    : label("段落", "Format")}</Text>
            </InteractiveSurface>
            {selectedModel !== null ? (
              <InteractiveSurface
                accessibilityLabel={label("选择模型", "Select model")}
                accessibilityRole="button"
                onPress={() => setModelPickerOpen(true)}
                style={styles.modelButton}
              >
                <Text numberOfLines={1} style={styles.modelLabel}>{selectedModel.label}</Text>
                <ChevronDown color={theme.color.icon.tertiary} size={metrics.control.iconSmall} strokeWidth={2} />
              </InteractiveSurface>
            ) : modelsLoading ? <Text style={styles.catalogStatus}>{label("正在加载模型…", "Loading models…")}</Text>
              : modelCatalogFailed ? <InteractiveSurface
                accessibilityLabel={label("重试加载模型", "Retry loading models")}
                accessibilityRole="button"
                onPress={onRetryModelCatalog}
                style={styles.effortButton}
              ><Text style={styles.modelLabel}>{label("重试模型", "Retry models")}</Text></InteractiveSurface> : null}
            {selectedModel !== null && selectedModel.efforts.length > 1 ? <InteractiveSurface
              accessibilityLabel={label("选择思考深度", "Select reasoning effort")}
              accessibilityRole="button"
              onPress={() => setEffortPickerOpen(true)}
              style={styles.effortButton}
            ><Text style={styles.modelLabel}>{selectedEffort?.label ?? label("思考", "Effort")}</Text></InteractiveSurface> : null}
            {permissionProfiles.length > 0 ? <IconButton
              accessibilityLabel={label("选择权限", "Select permissions")}
              onPress={() => setPermissionPickerOpen(true)}
              size="sm"
            ><ShieldCheck color={theme.color.icon.secondary} size={metrics.control.iconSmall} /></IconButton> : null}
            {projects.length > 0 ? <IconButton
              accessibilityLabel={label("选择工作区", "Select workspace")}
              onPress={() => setWorkspacePickerOpen(true)}
              size="sm"
            ><FolderOpen color={theme.color.icon.secondary} size={metrics.control.iconSmall} /></IconButton> : null}
            </ScrollView>
            <IconButton
              accessibilityLabel={primaryActionLabel}
              disabled={primaryAction !== "stop" && !canSend}
              onPress={primaryAction === "stop"
                ? onCancel
                : () => { void send(primaryAction === "send" ? undefined : primaryAction); }}
              size="md"
              style={styles.sendButton}
              variant="primary"
            >
              {primaryAction === "stop"
                ? <Square color={theme.color.button.primaryForeground} fill={theme.color.button.primaryForeground} size={12} strokeWidth={0} />
                : <ArrowUp color={theme.color.button.primaryForeground} size={21} strokeWidth={2.2} />}
            </IconButton>
          </View>
        </BlurView>
      </View>

      <ModalSurface
        label={label("模型", "Model")}
        onDismiss={() => setModelPickerOpen(false)}
        size="default"
        visible={modelPickerOpen}
      >
        <View style={styles.modelSheetHeader}>
          <View style={styles.modelSheetTitleCopy}>
            <Text style={styles.modelSheetTitle}>{label("模型", "Model")}</Text>
            <Text style={styles.modelSheetSubtitle}>{label("选择这次对话使用的模型", "Choose the model for this conversation")}</Text>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.modelList}>
          {modelCatalogFailed ? <InteractiveSurface
            accessibilityLabel={label("重试刷新模型", "Retry refreshing models")}
            accessibilityRole="button"
            onPress={onRetryModelCatalog}
            style={styles.modelRow}
          >
            <RotateCcw color={theme.color.icon.secondary} size={metrics.control.iconSmall} />
            <Text style={styles.modelRowTitle}>{label("模型暂时无法更新，点击重试", "Models could not refresh. Tap to retry")}</Text>
          </InteractiveSurface> : null}
          {models.map((model) => {
            const selected = model.value === selectedModel?.value;
            return (
              <InteractiveSurface
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={model.id}
                onPress={() => selectModel(model)}
                style={[styles.modelRow, selected && styles.modelRowSelected]}
              >
                <View style={styles.modelRowCopy}>
                  <Text style={styles.modelRowTitle}>{model.label}</Text>
                  {model.description ? <Text numberOfLines={2} style={styles.modelRowDescription}>{model.description}</Text> : null}
                </View>
                {selected ? <Check color={theme.color.accent.blue} size={metrics.control.icon} strokeWidth={2.1} /> : null}
              </InteractiveSurface>
            );
          })}
        </ScrollView>
      </ModalSurface>
      <ModalSurface label={label("添加附件", "Add attachment")} onDismiss={() => setAttachmentPickerOpen(false)} size="compact" visible={attachmentPickerOpen}>
        <View style={styles.attachmentSheet}>
          <Text style={styles.modelSheetTitle}>{label("添加附件", "Add attachment")}</Text>
          <InteractiveSurface accessibilityRole="button" onPress={() => { void choosePhoto().catch(() => {
            mobileDeveloperLog.log("chat.picker.failed");
            setPickerError(label("无法打开照片，请重试。", "Could not open photos. Please try again."));
          }); }} style={styles.modelRow}>
            <ImagePlus color={theme.color.icon.secondary} size={metrics.control.icon} /><Text style={styles.modelRowTitle}>{label("照片", "Photos")}</Text>
          </InteractiveSurface>
          {canAttachFiles ? <InteractiveSurface accessibilityRole="button" onPress={() => { void chooseFile().catch(() => {
            mobileDeveloperLog.log("chat.picker.failed");
            setPickerError(label("无法打开文件，请重试。", "Could not open files. Please try again."));
          }); }} style={styles.modelRow}>
            <FilePlus2 color={theme.color.icon.secondary} size={metrics.control.icon} /><Text style={styles.modelRowTitle}>{label("文件", "Files")}</Text>
          </InteractiveSurface> : null}
        </View>
      </ModalSurface>
      <ModalSurface label={label("段落格式", "Paragraph format")} onDismiss={() => setBlockFormatOpen(false)} size="compact" visible={blockFormatOpen}>
        <View style={styles.attachmentSheet}>
          <Text style={styles.modelSheetTitle}>{label("段落格式", "Paragraph format")}</Text>
          {([
            { value: "paragraph", title: label("普通文本", "Normal text"), Icon: Pilcrow },
            { value: "quote", title: label("引用", "Quote"), Icon: Quote },
            { value: "bullets", title: label("项目列表", "Bulleted list"), Icon: List },
            { value: "numbers", title: label("编号列表", "Numbered list"), Icon: ListOrdered },
            { value: "code", title: label("代码块", "Code block"), Icon: Code2 },
          ] as const).map(option => <InteractiveSurface accessibilityRole="button" key={option.value}
            onPress={() => formatBlock(option.value)} style={styles.modelRow}>
            <option.Icon color={theme.color.icon.secondary} size={metrics.control.icon} />
            <Text style={styles.modelRowTitle}>{option.title}</Text>
            {activeBlockFormat === option.value ? <Check color={theme.color.accent.blue} size={metrics.control.icon} /> : null}
          </InteractiveSurface>)}
        </View>
      </ModalSurface>
      <ModalSurface label={label("思考深度", "Reasoning effort")} onDismiss={() => setEffortPickerOpen(false)} size="compact" visible={effortPickerOpen}>
        <View style={styles.attachmentSheet}>
          <Text style={styles.modelSheetTitle}>{label("思考深度", "Reasoning effort")}</Text>
          {selectedModel?.efforts.map(choice => <InteractiveSurface accessibilityRole="button" key={choice.value} onPress={() => {
            controller.dispatch({ type: "set-selections", patch: { effort: choice.value } });
            setEffortPickerOpen(false);
          }} style={styles.modelRow}>
            <Text style={styles.modelRowTitle}>{choice.label}</Text>
            {choice.value === snapshot.draft.selections.effort ? <Check color={theme.color.accent.blue} size={metrics.control.icon} /> : null}
          </InteractiveSurface>)}
        </View>
      </ModalSurface>
      <ModalSurface label={label("权限", "Permissions")} onDismiss={() => setPermissionPickerOpen(false)} size="compact" visible={permissionPickerOpen}>
        <View style={styles.attachmentSheet}>
          <Text style={styles.modelSheetTitle}>{label("权限", "Permissions")}</Text>
          <InteractiveSurface accessibilityRole="button" onPress={() => {
            controller.dispatch({ type: "set-selections", patch: { permissionProfile: null } });
            setPermissionPickerOpen(false);
          }} style={styles.modelRow}>
            <Text style={styles.modelRowTitle}>{label("默认", "Default")}</Text>
            {snapshot.draft.selections.permissionProfile == null ? <Check color={theme.color.accent.blue} size={metrics.control.icon} /> : null}
          </InteractiveSurface>
          {permissionProfiles.map(profile => <InteractiveSurface
            accessibilityRole="button"
            accessibilityState={{ disabled: !profile.allowed, selected: snapshot.draft.selections.permissionProfile === profile.id }}
            key={profile.id}
            onPress={() => {
              if (!profile.allowed) return;
              controller.dispatch({ type: "set-selections", patch: { permissionProfile: profile.id } });
              setPermissionPickerOpen(false);
            }}
            style={styles.modelRow}
          >
            <View style={styles.modelRowCopy}>
              <Text style={styles.modelRowTitle}>{humanizeCatalogValue(profile.id)}</Text>
              {profile.description ? <Text style={styles.modelRowDescription}>{profile.description}</Text> : null}
            </View>
            {snapshot.draft.selections.permissionProfile === profile.id ? <Check color={theme.color.accent.blue} size={metrics.control.icon} /> : null}
          </InteractiveSurface>)}
        </View>
      </ModalSurface>
      <ModalSurface label={label("工作区", "Workspace")} onDismiss={() => setWorkspacePickerOpen(false)} size="compact" visible={workspacePickerOpen}>
        <View style={styles.attachmentSheet}>
          <Text style={styles.modelSheetTitle}>{label("工作区", "Workspace")}</Text>
          <ScrollView style={styles.workspaceList}>
            {projects.flatMap(project => project.roots.map(root => ({ project, root }))).map(({ project, root }) => (
              <InteractiveSurface accessibilityRole="button" key={`${project.id}:${root.path}`} onPress={() => {
                onSelectWorkspace(project.id, root.path);
                setWorkspacePickerOpen(false);
              }} style={styles.modelRow}>
                <View style={styles.modelRowCopy}>
                  <Text style={styles.modelRowTitle}>{project.name}</Text>
                  {project.roots.length > 1 ? <Text numberOfLines={1} style={styles.modelRowDescription}>{root.path.split("/").filter(Boolean).at(-1) ?? root.path}</Text> : null}
                </View>
                {selectedWorkspace === root.path ? <Check color={theme.color.accent.blue} size={metrics.control.icon} /> : null}
              </InteractiveSurface>
            ))}
          </ScrollView>
        </View>
      </ModalSurface>
      <NativeComposerLinkEditor
        address={linkAddress}
        canRemove={linkEditor?.existing ?? false}
        error={linkError}
        language={language}
        onAddressChange={value => { setLinkAddress(value); setLinkError(false); }}
        onDismiss={() => setLinkEditor(null)}
        onRemove={() => finishLinkEditor(null)}
        onSave={() => finishLinkEditor(linkAddress)}
        visible={linkEditor !== null}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  region: {
    paddingHorizontal: theme.spacing[6],
    backgroundColor: "transparent",
  },
  shadowShell: {
    flexShrink: 1,
    width: "100%",
    maxWidth: theme.metrics.composer.maximumWidth,
    alignSelf: "center",
    borderRadius: theme.metrics.composer.radius,
    backgroundColor: theme.material.raised,
    shadowColor: theme.shadow.composer.color,
    shadowOpacity: theme.shadow.composer.opacity,
    shadowRadius: theme.shadow.composer.radius,
    shadowOffset: { width: 0, height: theme.shadow.composer.offsetY },
    elevation: theme.shadow.composer.elevation,
  },
  composer: {
    flexShrink: 1,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.material.separator,
    borderRadius: theme.metrics.composer.radius,
    backgroundColor: theme.material.raised,
  },
  input: {
    flexShrink: 1,
    minHeight: theme.metrics.composer.inputMinimumHeight + theme.metrics.composer.inputTopInset,
    maxHeight: theme.metrics.composer.inputMaximumHeight,
    paddingTop: theme.metrics.composer.inputTopInset,
    paddingHorizontal: theme.metrics.composer.inputHorizontalInset,
    paddingBottom: theme.spacing[1],
    color: theme.color.text.primary,
    textAlignVertical: "top",
    ...theme.platformTypography.composer,
  },
  richInputText: { color: theme.color.text.primary, ...theme.platformTypography.composer },
  actionRow: {
    height: theme.metrics.composer.actionRowHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  actionControls: { flex: 1, minWidth: 0 },
  actionControlsContent: { alignItems: "center", gap: theme.spacing[1] },
  modelButton: {
    maxWidth: 180,
    height: theme.metrics.composer.actionButton,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radii.full,
    backgroundColor: theme.material.grouped,
  },
  modelLabel: { color: theme.color.text.secondary, ...nativeTypographyStyle("controlCompact", Platform.OS) },
  catalogStatus: { color: theme.color.text.tertiary, ...theme.platformTypography.label },
  effortButton: { height: theme.metrics.composer.actionButton, paddingHorizontal: theme.spacing[2], justifyContent: "center", borderRadius: theme.radii.full, backgroundColor: theme.material.grouped },
  attachmentList: { gap: theme.spacing[1], paddingHorizontal: theme.spacing[3], paddingTop: theme.spacing[2] },
  attachmentChip: { maxWidth: 200, minHeight: 34, flexDirection: "row", alignItems: "center", borderRadius: theme.radii.lg, paddingLeft: theme.spacing[2], backgroundColor: theme.material.grouped },
  attachmentThumbnail: { width: 28, height: 28, marginRight: theme.spacing[1], borderRadius: theme.radii.sm },
  attachmentName: { flexShrink: 1, minWidth: 0, maxWidth: 120, color: theme.color.text.primary, ...theme.platformTypography.label },
  attachmentError: { marginHorizontal: theme.spacing[3], marginTop: theme.spacing[1], color: theme.color.accent.negative, ...theme.platformTypography.caption },
  attachmentStatus: { marginLeft: theme.spacing[1], color: theme.color.text.tertiary, ...theme.platformTypography.label },
  attachmentSheet: { padding: theme.spacing[5], paddingTop: theme.spacing[8] },
  workspaceList: { maxHeight: 350 },
  richPreview: { marginHorizontal: theme.spacing[3], marginBottom: theme.spacing[2], padding: theme.spacing[2], borderRadius: theme.radii.lg, backgroundColor: theme.material.grouped },
  richPreviewLabel: { color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  richPreviewText: { color: theme.color.text.primary, ...theme.platformTypography.body },
  richStrong: { fontWeight: theme.typography.weight.semibold },
  richEmphasis: { fontStyle: "italic" },
  richCode: { fontFamily: nativeMonoFontFamily(Platform.OS) },
  richLink: { color: theme.color.accent.blue, textDecorationLine: "underline" },
  formatRow: { minHeight: 36, flexDirection: "row", gap: theme.spacing[2], paddingHorizontal: theme.spacing[2] },
  sendButton: {
    borderRadius: theme.radii.full,
  },
  modelSheetHeader: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.material.separator,
  },
  modelSheetTitleCopy: { flex: 1, minWidth: 0 },
  modelSheetTitle: { color: theme.color.text.primary, ...theme.platformTypography.navigationTitle },
  modelSheetSubtitle: { marginTop: 2, color: theme.color.text.tertiary, ...theme.platformTypography.caption },
  modelList: { padding: theme.spacing[2] },
  modelRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radii.lg,
  },
  modelRowSelected: { backgroundColor: theme.material.grouped },
  modelRowCopy: { flex: 1, minWidth: 0 },
  modelRowTitle: { color: theme.color.text.primary, ...nativeTypographyStyle("control", Platform.OS) },
  modelRowDescription: { marginTop: 2, color: theme.color.text.tertiary, ...theme.platformTypography.caption },
}));

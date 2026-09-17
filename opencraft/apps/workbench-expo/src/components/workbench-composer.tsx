import { BlurView } from "expo-blur";
import { ArrowUp, Check, ChevronDown, Square } from "lucide-react-native";
import {
  composerDocumentToPlainText,
  resolveComposerPrimaryAction,
  reasoningCapability,
  resolveReasoningEffort,
  type ComposerController,
  type ComposerFollowUpAction,
  type SubmitIntent,
} from "@opencraft/composer-core";
import {
  resolveComposerModelChoice,
  type WorkbenchComposerModelChoice,
} from "@opencraft/workbench-runtime";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, TextInput, type TextInput as TextInputHandle, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { IconButton } from "./ui/button";
import { InteractiveSurface } from "./ui/interactive-surface";
import { ModalSurface } from "./ui/modal-surface";

interface WorkbenchComposerProps {
  controller: ComposerController;
  models: readonly WorkbenchComposerModelChoice[];
  modelsLoading: boolean;
  isStreaming: boolean;
  bottomInset: number;
  onSubmit(
    intent: SubmitIntent,
    context: { readonly followUpAction: ComposerFollowUpAction | null },
  ): boolean | void | Promise<boolean | void>;
  onCancel(): void;
}

export function WorkbenchComposer({
  controller,
  models,
  modelsLoading,
  isStreaming,
  bottomInset,
  onSubmit,
  onCancel,
}: WorkbenchComposerProps) {
  const { theme } = useUnistyles();
  const inputRef = useRef<TextInputHandle>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const submitPendingRef = useRef(false);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const draft = composerDocumentToPlainText(snapshot.draft.document);
  const canSend = snapshot.canSubmit;
  const metrics = theme.metrics;
  const selectedModel = resolveComposerModelChoice(models, snapshot.draft.selections.model);

  const selectModel = useCallback((model: WorkbenchComposerModelChoice) => {
    const currentEffort = snapshot.draft.selections.effort;
    const effort = resolveReasoningEffort(reasoningCapability(model.efforts.map(choice => choice.value), model.defaultEffort), currentEffort);
    controller.dispatch({
      type: "set-selections",
      patch: { model: model.value, effort },
    });
    setModelPickerOpen(false);
  }, [controller, snapshot.draft.selections.effort]);

  const updateText = useCallback((text: string) => {
    controller.dispatch({
      type: "set-document",
      document: {
        version: 1,
        blocks: [{ type: "paragraph", children: text.length === 0 ? [] : [{ type: "text", text }] }],
      },
    });
  }, [controller]);

  const send = useCallback(async (followUpAction?: ComposerFollowUpAction) => {
    if (!snapshot.canSubmit || submitPendingRef.current) return;
    let intent: SubmitIntent;
    try {
      intent = controller.createSubmitIntent();
    } catch {
      return;
    }
    submitPendingRef.current = true;
    controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
    try {
      const accepted = await onSubmit(intent, {
        followUpAction: isStreaming ? followUpAction ?? "queue" : null,
      });
      if (accepted !== false) controller.dispatch({ type: "clear" });
      else controller.dispatch({ type: "set-lifecycle", phase: "editing" });
    } catch (error) {
      controller.dispatch({
        type: "set-lifecycle",
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      submitPendingRef.current = false;
    }
  }, [controller, isStreaming, onSubmit, snapshot.canSubmit]);

  useLayoutEffect(() => controller.registerView({
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    insertText: (text) => {
      updateText(`${composerDocumentToPlainText(controller.getSnapshot().draft.document)}${text}`);
      inputRef.current?.focus();
    },
    beginTransientTextInput: () => null,
    undo: () => undefined,
    redo: () => undefined,
  }), [controller, updateText]);

  const primaryAction = resolveComposerPrimaryAction({
    isResponseInProgress: isStreaming,
    canSubmit: snapshot.canSubmit,
    defaultFollowUpAction: "queue",
  });
  const primaryActionLabel = primaryAction === "stop"
    ? "Stop response"
    : primaryAction === "queue"
      ? "Queue follow-up"
      : primaryAction === "steer"
        ? "Steer active response"
        : "Send message";

  return (
    <View style={[styles.region, { paddingBottom: Math.max(bottomInset, metrics.composer.outerBottomInset) }]}> 
      <View style={styles.shadowShell}>
        <BlurView intensity={82} tint="systemMaterialLight" style={styles.composer}>
          <TextInput
            accessibilityLabel="Message OpenCraft"
            multiline
            onChangeText={updateText}
            placeholder="Message OpenCraft"
            placeholderTextColor={theme.color.text.tertiary}
            ref={inputRef}
            style={styles.input}
            value={draft}
          />

          <View style={styles.actionRow}>
            {selectedModel !== null ? (
              <InteractiveSurface
                accessibilityLabel="Select model"
                accessibilityRole="button"
                onPress={() => setModelPickerOpen(true)}
                style={styles.modelButton}
              >
                <Text numberOfLines={1} style={styles.modelLabel}>{selectedModel.label}</Text>
                <ChevronDown color={theme.color.icon.tertiary} size={metrics.control.iconSmall} strokeWidth={2} />
              </InteractiveSurface>
            ) : modelsLoading ? <Text style={styles.catalogStatus}>Loading models…</Text> : null}
            <View style={styles.actionSpacer} />
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
        label="Model"
        onDismiss={() => setModelPickerOpen(false)}
        size="default"
        visible={modelPickerOpen}
      >
        <View style={styles.modelSheetHeader}>
          <View style={styles.modelSheetTitleCopy}>
            <Text style={styles.modelSheetTitle}>Model</Text>
            <Text style={styles.modelSheetSubtitle}>Available from the connected AppServer</Text>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.modelList}>
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  region: {
    paddingHorizontal: theme.spacing[6],
    backgroundColor: "transparent",
  },
  shadowShell: {
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
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.material.separator,
    borderRadius: theme.metrics.composer.radius,
    backgroundColor: theme.material.raised,
  },
  input: {
    minHeight: theme.metrics.composer.inputMinimumHeight + theme.metrics.composer.inputTopInset,
    maxHeight: theme.metrics.composer.inputMaximumHeight,
    paddingTop: theme.metrics.composer.inputTopInset,
    paddingHorizontal: theme.metrics.composer.inputHorizontalInset,
    paddingBottom: theme.spacing[1],
    color: theme.color.text.primary,
    textAlignVertical: "top",
    ...theme.platformTypography.composer,
  },
  actionRow: {
    height: theme.metrics.composer.actionRowHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  modelButton: {
    maxWidth: "72%",
    height: theme.metrics.composer.actionButton,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radii.full,
    backgroundColor: theme.material.grouped,
  },
  modelLabel: { color: theme.color.text.secondary, ...theme.platformTypography.label },
  catalogStatus: { color: theme.color.text.tertiary, ...theme.platformTypography.label },
  actionSpacer: { flex: 1 },
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
  modelRowTitle: { color: theme.color.text.primary, ...theme.platformTypography.body },
  modelRowDescription: { marginTop: 2, color: theme.color.text.tertiary, ...theme.platformTypography.caption },
}));

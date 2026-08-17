import {Modal, Pressable, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {SystemButton} from "./system-button";
import {SystemMaterialSurface} from "./system-material-surface.native";
import type {
  DialogCloseReason,
  SystemDialogAction,
  SystemDialogProps,
} from "./system-dialog.types";

export type {
  DialogCloseReason,
  SystemDialogAction,
  SystemDialogProps,
} from "./system-dialog.types";

export function SystemDialog({
  actions,
  atomicLock = false,
  busy = false,
  children,
  description,
  dialogId,
  dismissOnBackdrop = false,
  onAction,
  onOpenChange,
  open,
  title,
  urgency = "normal",
}: SystemDialogProps) {
  const locked = atomicLock && busy;
  const close = (reason: DialogCloseReason) => {
    if (locked) return;
    onOpenChange(false, reason);
  };
  const activate = (action: SystemDialogAction) => {
    if (action.disabled || (busy && action.kind === "action") || locked) return;
    onAction(action.id);
    close(action.kind === "cancel" ? "cancel" : "action");
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => close("nativeBack")}
      transparent
      visible={open}
    >
      <Pressable
        accessible={false}
        onPress={() => {
          if (dismissOnBackdrop) close("backdrop");
        }}
        style={styles.backdrop}
      >
        <SystemMaterialSurface materialRole="dialog" style={styles.surface}>
          <View
            accessibilityLabel={title}
            accessibilityRole={(urgency === "urgent" ? "alert" : "dialog") as never}
            accessibilityViewIsModal
            nativeID={dialogId}
            onStartShouldSetResponder={() => true}
            style={styles.dialog}
          >
            <View style={styles.copy}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.description}>{description}</Text>
            </View>
            {children}
            <View style={styles.actions}>
              {actions.map(action => {
                const unavailable = Boolean(
                  action.disabled || locked || (busy && action.kind === "action"),
                );
                return (
                  <View key={action.id} style={styles.actionSlot}>
                    <SystemButton
                      align="stretch"
                      busy={busy && action.kind === "action"}
                      disabled={unavailable}
                      label={action.label}
                      nativeID={`${dialogId}-action-${action.id}`}
                      onPress={() => activate(action)}
                      variant={action.intent === "destructive" ? "destructive" : "standard"}
                    />
                  </View>
                );
              })}
            </View>
          </View>
        </SystemMaterialSurface>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create(theme => ({
  actionSlot: {
    flex: 1,
    minWidth: 0,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    justifyContent: "flex-end",
  },
  backdrop: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.modalBackdrop,
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  copy: {gap: theme.spacing.xs},
  description: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  dialog: {gap: theme.spacing.lg},
  surface: {
    maxWidth: theme.recipes.overlay.confirmDialogMaxWidth,
    padding: theme.spacing.xl,
    width: "100%",
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.dialogTitle,
  },
}));

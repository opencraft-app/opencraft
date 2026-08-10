import Check from "lucide-react-native/icons/check";
import {Modal, Pressable, Text, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import {SystemMaterialSurface} from "./system-material-surface.native";
import type {
  SystemActionMenuItem,
  SystemActionMenuProps,
} from "./system-action-menu.types";

export type {
  SystemActionMenuItem,
  SystemActionMenuProps,
} from "./system-action-menu.types";

export function SystemActionMenu({
  accessibilityLabel,
  header,
  items,
  onAction,
  onOpenChange,
  open,
  overlayId,
  renderTrigger,
}: SystemActionMenuProps) {
  const {theme} = useUnistyles();
  const activate = (item: SystemActionMenuItem) => {
    if (item.disabled) return;
    onAction(item.id);
    onOpenChange(false, "action");
  };
  return (
    <>
      {renderTrigger({
        accessibilityControls: overlayId,
        accessibilityExpanded: open,
        onPress: () => onOpenChange(!open),
        ref: () => undefined,
      })}
      <Modal
        animationType="fade"
        onRequestClose={() => onOpenChange(false, "nativeBack")}
        transparent
        visible={open}
      >
        <Pressable
          accessible={false}
          onPress={() => onOpenChange(false, "outside")}
          style={styles.backdrop}
        >
          <SystemMaterialSurface materialRole="popover" style={styles.surface}>
            <View
              accessibilityLabel={accessibilityLabel}
              accessibilityRole={"menu" as never}
              accessibilityViewIsModal
              nativeID={overlayId}
              onStartShouldSetResponder={() => true}
            >
              {header ? <View style={styles.header}>{header}</View> : null}
              {header && items.length > 0 ? <View style={styles.separator} /> : null}
              {items.map((item, index) => (
                <View key={item.id}>
                  {index > 0 && item.groupId !== items[index - 1]?.groupId ? (
                    <View style={styles.separator} />
                  ) : null}
                  <Pressable
                    accessibilityLabel={item.label}
                    accessibilityRole={"menuitem" as never}
                    accessibilityState={{checked: item.selectionKind ? Boolean(item.checked) : undefined, disabled: Boolean(item.disabled)}}
                    aria-checked={item.selectionKind ? Boolean(item.checked) : undefined}
                    disabled={item.disabled}
                    onPress={() => activate(item)}
                    style={({pressed}) => [
                      styles.item,
                      pressed && styles.itemPressed,
                      item.disabled && styles.itemDisabled,
                    ]}
                  >
                    <View style={styles.check}>
                      {item.icon ?? (item.selectionKind && item.checked ? (
                        <Check
                          color={theme.semantic.color.iconAccent}
                          size={theme.semantic.icon.size.small}
                          strokeWidth={theme.semantic.icon.stroke.emphasis}
                        />
                      ) : null)}
                    </View>
                    <Text style={[
                      styles.label,
                      item.intent === "destructive" && styles.labelDestructive,
                    ]}>{item.label}</Text>
                    {item.shortcutLabel ? (
                      <Text style={styles.shortcut}>{item.shortcutLabel}</Text>
                    ) : null}
                  </Pressable>
                </View>
              ))}
            </View>
          </SystemMaterialSurface>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create(theme => ({
  backdrop: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.modalBackdrop,
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  check: {
    alignItems: "center",
    height: theme.semantic.icon.size.small,
    justifyContent: "center",
    width: theme.semantic.icon.size.small,
  },
  item: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.overlay.menuRowHeight,
    paddingHorizontal: theme.spacing.md,
  },
  itemDisabled: {opacity: theme.semantic.interaction.disabledOpacity},
  itemPressed: {backgroundColor: theme.semantic.color.interactivePressedSurface},
  header: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  label: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.bodyCompact,
  },
  labelDestructive: {color: theme.semantic.color.statusDangerText},
  separator: {
    backgroundColor: theme.semantic.color.separator,
    height: theme.semantic.stroke.hairline,
    marginVertical: theme.spacing.xs,
  },
  shortcut: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  surface: {
    maxHeight: 640,
    maxWidth: 360,
    padding: theme.spacing.xs,
    width: theme.recipes.overlay.accountMenuWidth,
  },
}));

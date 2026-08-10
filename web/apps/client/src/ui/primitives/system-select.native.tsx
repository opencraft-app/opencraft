import {Modal, Pressable, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {SystemMaterialSurface} from "./system-material-surface.native";
import type {SystemSelectProps} from "./system-select.types";

export type {
  ControlledOverlayProps,
  FocusableHandle,
  OverlayCloseReason,
  OverlayTriggerProps,
  SystemSelectOption,
  SystemSelectProps,
} from "./system-select.types";

export function SystemSelect<T extends string>({
  accessibilityLabel,
  onChange,
  onOpenChange,
  open,
  options,
  overlayId,
  renderTrigger,
  value,
}: SystemSelectProps<T>) {
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
          <SystemMaterialSurface materialRole="popover" style={styles.popover}>
            <View
              accessible
              accessibilityLabel={accessibilityLabel}
              accessibilityRole={"listbox" as never}
              nativeID={overlayId}
              onStartShouldSetResponder={() => true}
              style={styles.listbox}
            >
              {options.map(option => {
                const selected = option.value === value;
                return (
                  <Pressable
                    accessibilityLabel={option.accessibilityLabel ?? option.label}
                    accessibilityRole={"option" as never}
                    accessibilityState={{disabled: Boolean(option.disabled), selected}}
                    aria-selected={selected}
                    disabled={option.disabled}
                    key={option.value}
                    onPress={() => {
                      onChange(option.value);
                      onOpenChange(false, "selection");
                    }}
                    style={({pressed}) => [
                      styles.option,
                      selected && styles.optionSelected,
                      pressed && styles.optionPressed,
                      option.disabled && styles.optionDisabled,
                    ]}
                  >
                    <Text style={[styles.label, selected && styles.labelSelected]}>
                      {option.label}
                    </Text>
                    {selected ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                );
              })}
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
    color: theme.semantic.color.iconAccent,
    ...theme.semantic.typography.bodyEmphasis,
  },
  label: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.body,
  },
  labelSelected: {
    color: theme.semantic.color.actionTonalText,
  },
  listbox: {
    gap: theme.spacing.xs,
  },
  option: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    flexDirection: "row",
    minHeight: theme.recipes.control.rowHeight,
    paddingHorizontal: theme.spacing.md,
    width: "100%",
  },
  optionDisabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  optionPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
  optionSelected: {
    backgroundColor: theme.semantic.color.actionTonalSurface,
  },
  popover: {
    maxHeight: 640,
    maxWidth: 480,
    padding: theme.spacing.xs,
    width: "100%",
  },
}));

import {Modal, Pressable, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {SystemMaterialSurface} from "./system-material-surface.native";
import type {SystemPopoverProps} from "./system-popover.types";

export type {SystemPopoverProps} from "./system-popover.types";

export function SystemPopover({
  accessibilityLabel,
  children,
  onOpenChange,
  open,
  overlayId,
  renderTrigger,
  width,
}: SystemPopoverProps) {
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
          <SystemMaterialSurface
            materialRole="popover"
            style={[styles.surface, width ? {width} : null]}
          >
            <View
              accessibilityLabel={accessibilityLabel}
              accessibilityRole={"dialog" as never}
              accessibilityViewIsModal
              nativeID={overlayId}
              onStartShouldSetResponder={() => true}
            >
              {children}
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
  surface: {
    maxHeight: 640,
    maxWidth: 480,
    padding: theme.spacing.xs,
    width: "100%",
  },
}));

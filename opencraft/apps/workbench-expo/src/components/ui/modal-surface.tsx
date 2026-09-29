import {
  modalGeometry,
  type ModalDescriptor,
  type ModalDismissReason,
  type ModalSize,
} from "@opencraft/design-system/modal";
import { X } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  Modal,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useWorkbenchTheme } from "../../styles/workbench-styles";
import { IconButton } from "./button";

export interface ModalSurfaceProps extends ModalDescriptor {
  readonly children: ReactNode;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly onDismiss: (reason: ModalDismissReason) => void;
  readonly visible: boolean;
}

const modalWidths: Record<ModalSize, number> = modalGeometry.widths;

/** Native platform adapter for the shared modal intent contract. */
export function ModalSurface({
  children,
  contentStyle,
  dismissOnOutsidePress = true,
  label,
  onDismiss,
  presentation = "dialog",
  showCloseButton = true,
  size = "default",
  visible,
}: ModalSurfaceProps) {
  const { theme } = useWorkbenchTheme();
  const fullscreen = presentation === "fullscreen";
  const sheet = presentation === "sheet" || presentation === "inspector";

  return (
    <Modal
      animationType={fullscreen || sheet ? "slide" : "fade"}
      onRequestClose={() => onDismiss("system")}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent={!fullscreen}
      visible={visible}
    >
      <View
        accessibilityLabel={label}
        accessibilityViewIsModal
        style={[
          styles.root,
          sheet && styles.rootSheet,
          fullscreen && styles.rootFullscreen,
        ]}
      >
        {fullscreen ? null : dismissOnOutsidePress ? (
          <Pressable
            accessibilityLabel={`Close ${label.toLocaleLowerCase()}`}
            onPress={() => onDismiss("outside-press")}
            style={styles.scrim}
          />
        ) : (
          <View pointerEvents="none" style={styles.scrim} />
        )}
        <View
          style={[
            styles.surface,
            { maxWidth: modalWidths[size] },
            sheet && styles.surfaceSheet,
            fullscreen && styles.surfaceFullscreen,
            contentStyle,
          ]}
        >
          {children}
          {showCloseButton ? (
            <IconButton
              accessibilityLabel={`Close ${label.toLocaleLowerCase()}`}
              onPress={() => onDismiss("close-button")}
              size="md"
              style={styles.close}
            >
              <X
                color={theme.color.icon.secondary}
                size={theme.metrics.control.icon}
                strokeWidth={1.9}
              />
            </IconButton>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  rootSheet: {
    justifyContent: "flex-end",
    paddingBottom: 0,
  },
  rootFullscreen: {
    alignItems: "stretch",
    padding: 0,
  },
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.material.scrim,
  },
  surface: {
    width: "100%",
    maxHeight: "92%",
    overflow: "hidden",
    borderRadius: theme.radii.xxl,
    backgroundColor: theme.material.raised,
    shadowColor: theme.shadow.prominent.color,
    shadowOpacity: theme.shadow.prominent.opacity,
    shadowRadius: theme.shadow.prominent.radius,
    shadowOffset: { width: 0, height: theme.shadow.prominent.offsetY },
    elevation: theme.shadow.prominent.elevation,
  },
  surfaceSheet: {
    maxWidth: "100%",
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  surfaceFullscreen: {
    flex: 1,
    maxWidth: "100%",
    maxHeight: "100%",
    borderRadius: 0,
  },
  close: {
    position: "absolute",
    zIndex: 1,
    top: theme.spacing[3],
    right: theme.spacing[3],
  },
}));

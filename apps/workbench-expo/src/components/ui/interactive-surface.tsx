import type { ReactNode } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "../../styles/workbench-styles";

/**
 * Pressable interaction for rows, disclosures and selectable cards.
 * It deliberately carries no button chrome; semantic action controls use
 * Button/IconButton instead.
 */
export interface InteractiveSurfaceProps extends Omit<PressableProps, "children" | "style"> {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function InteractiveSurface({ children, disabled, style, ...props }: InteractiveSurfaceProps) {
  return (
    <Pressable
      {...props}
      disabled={disabled}
      style={({ pressed }) => [
        style,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  pressed: { opacity: theme.metrics.interaction.pressedOpacity },
  disabled: { opacity: theme.metrics.interaction.disabledOpacity },
}));

import type {LucideIcon} from "lucide-react-native";
import {useState} from "react";
import {Pressable, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

import type {ActionContext} from "./action-button";

/**
 * The one icon-only button.
 *
 * The management kit drew these as bordered 48pt squares while the chat shell
 * drew them borderless and small; a header full of the former reads like a web
 * form rather than a desktop app. This is the shell's idiom, sized off
 * `control.squareSize` so a finger still gets 44pt on a touch density.
 *
 * Its former `importance` axis is gone: every call site in the app used the
 * default, so the quiet and tonal variants only ever widened the API.
 */
export interface IconActionButtonProps {
  accessibilityLabel: string;
  context?: ActionContext;
  disabled?: boolean;
  icon: LucideIcon;
  iconTestID?: string;
  onPress(): void;
  testID?: string;
}

export function IconActionButton({
  accessibilityLabel,
  context = "default",
  disabled = false,
  icon: Icon,
  iconTestID,
  onPress,
  testID,
}: IconActionButtonProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{disabled}}
      disabled={disabled}
      hitSlop={theme.semantic.interaction.hitTargetInsetCompact}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.iconAction,
        context === "header" && styles.iconActionHeader,
        hovered && !disabled && styles.iconActionHover,
        pressed && styles.iconActionPressed,
        disabled && styles.iconActionDisabled,
      ]}
      testID={testID}
    >
      <View testID={iconTestID}>
        <Icon
          color={theme.semantic.color.iconSecondary}
          size={theme.semantic.icon.size.medium}
          strokeWidth={theme.semantic.icon.stroke.emphasis}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconAction: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.control.squareSize,
    justifyContent: "center",
    width: theme.recipes.control.squareSize,
    ...theme.semantic.motion.transition.control,
  },
  iconActionDisabled: {opacity: theme.semantic.interaction.disabledOpacity},
  iconActionHeader: {
    height: theme.recipes.managementWorkspace.headerActionHeight,
    width: theme.recipes.managementWorkspace.headerActionHeight,
  },
  iconActionHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  iconActionPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
}));

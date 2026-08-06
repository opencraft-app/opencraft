import type {LucideIcon} from "lucide-react-native";
import {useState} from "react";
import {Pressable, Text, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

/**
 * The one button in the app.
 *
 * The chat shell and the management screens each grew their own vocabulary for
 * the same handful of jobs, so a "secondary action" was drawn one way in a
 * conversation header and another way on an agent detail page. Importance is
 * the axis that actually varies; everything else is shared.
 */
export type ActionContext = "compact" | "default" | "header";
export type ActionImportance =
  | "danger"
  | "primary"
  | "quiet"
  | "secondary"
  | "tonal";

/**
 * Hugging its content is the button's business; which edge it hugs is the
 * parent's. React Native has no `fit-content`, so the button has to set
 * `alignSelf` itself — which reads as "left" in a column and "top" in a row.
 */
export type ActionAlign = "center" | "start" | "stretch";

export interface ActionButtonProps {
  accessibilityLabel?: string;
  align?: ActionAlign;
  busy?: boolean;
  context?: ActionContext;
  disabled?: boolean;
  icon?: LucideIcon;
  iconTestID?: string;
  importance: ActionImportance;
  label: string;
  onPress(): void;
  testID?: string;
}

export function ActionButton({
  accessibilityLabel,
  align = "start",
  busy = false,
  context = "default",
  disabled = false,
  icon: Icon,
  iconTestID,
  importance,
  label,
  onPress,
  testID,
}: ActionButtonProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const iconColor = importance === "primary" ? theme.semantic.color.iconInverse
    : importance === "danger" ? theme.semantic.color.statusDanger
      : importance === "tonal" ? theme.semantic.color.iconAccent
      : theme.semantic.color.iconPrimary;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{busy, disabled}}
      disabled={disabled}
      hitSlop={context === "header" ? theme.semantic.interaction.hitTargetInsetCompact : undefined}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.action,
        align === "center" && styles.actionAlignCenter,
        align === "stretch" && styles.actionAlignStretch,
        context === "header" && styles.actionHeader,
        importance === "secondary" && styles.actionSecondary,
        importance === "quiet" && styles.actionQuiet,
        importance === "danger" && styles.actionDanger,
        importance === "tonal" && styles.actionTonal,
        hovered && !disabled && importance === "primary" && styles.actionPrimaryHover,
        hovered && !disabled && importance === "secondary" && styles.actionSecondaryHover,
        hovered && !disabled && importance === "quiet" && styles.actionQuietHover,
        hovered && !disabled && importance === "danger" && styles.actionDangerHover,
        hovered && !disabled && importance === "tonal" && styles.actionTonalHover,
        pressed && importance === "primary" && styles.actionPrimaryPressed,
        pressed && importance === "secondary" && styles.actionSecondaryPressed,
        pressed && importance === "quiet" && styles.actionQuietPressed,
        pressed && importance === "danger" && styles.actionDangerPressed,
        pressed && importance === "tonal" && styles.actionTonalPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {Icon ? (
        <View testID={iconTestID}>
          <Icon color={iconColor} size={theme.semantic.icon.size.small} strokeWidth={theme.semantic.icon.stroke.emphasis} />
        </View>
      ) : null}
      <Text style={[
        styles.actionText,
        importance !== "primary" && styles.actionTextDark,
        importance === "danger" && styles.actionTextDanger,
        importance === "tonal" && styles.actionTextTonal,
      ]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    justifyContent: "center",
    minHeight: theme.recipes.managementWorkspace.actionHeight,
    paddingHorizontal: theme.spacing.lg,
    ...theme.semantic.motion.transition.control,
  },
  actionAlignCenter: {alignSelf: "center"},
  actionAlignStretch: {alignSelf: "stretch"},
  actionDanger: {
    backgroundColor: theme.semantic.color.actionDangerSurface,
    borderColor: theme.semantic.color.actionDangerBorder,
    ...theme.semantic.motion.transition.control,
  },
  actionDangerHover: {
    backgroundColor: theme.semantic.color.actionDangerHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionDangerPressed: {
    backgroundColor: theme.semantic.color.actionDangerPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionHeader: {
    minHeight: theme.recipes.managementWorkspace.headerActionHeight,
    paddingHorizontal: theme.spacing.md,
  },
  actionPrimaryHover: {
    backgroundColor: theme.semantic.color.actionPrimaryHoverSurface,
    borderColor: theme.semantic.color.actionPrimaryHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionPrimaryPressed: {
    backgroundColor: theme.semantic.color.actionPrimaryPressedSurface,
    borderColor: theme.semantic.color.actionPrimaryPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionQuiet: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderColor: theme.semantic.color.borderTransparent,
    ...theme.semantic.motion.transition.control,
  },
  actionQuietHover: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionQuietPressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionSecondary: {
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.actionSecondaryBorder,
    ...theme.semantic.motion.transition.control,
  },
  actionSecondaryHover: {
    backgroundColor: theme.semantic.color.actionSecondaryHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionSecondaryPressed: {
    backgroundColor: theme.semantic.color.actionSecondaryPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionText: {
    color: theme.semantic.color.actionPrimaryText,
    ...theme.semantic.typography.button,
  },
  actionTextDanger: {color: theme.semantic.color.actionDangerText},
  actionTextDark: {color: theme.semantic.color.actionSecondaryText},
  actionTextTonal: {color: theme.semantic.color.actionTonalText},
  actionTonal: {
    backgroundColor: theme.semantic.color.actionTonalSurface,
    borderColor: theme.semantic.color.actionTonalSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionTonalHover: {
    backgroundColor: theme.semantic.color.actionTonalHoverSurface,
    borderColor: theme.semantic.color.actionTonalHoverSurface,
    ...theme.semantic.motion.transition.control,
  },
  actionTonalPressed: {
    backgroundColor: theme.semantic.color.actionTonalPressedSurface,
    borderColor: theme.semantic.color.actionTonalPressedSurface,
    ...theme.semantic.motion.transition.control,
  },
  disabled: {opacity: theme.semantic.interaction.disabledOpacity},
}));

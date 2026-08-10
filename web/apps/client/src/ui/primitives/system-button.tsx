import type {LucideIcon} from "lucide-react-native";
import {useState} from "react";
import {ActivityIndicator, Pressable, Text, View} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

export type SystemButtonVariant =
  | "destructive"
  | "standard"
  | "toolbar";

export interface SystemButtonProps {
  accessibilityLabel?: string;
  align?: "center" | "start" | "stretch";
  busy?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  iconTestID?: string;
  label: string;
  onPress(): void;
  testID?: string;
  variant?: SystemButtonVariant;
}

export interface SystemIconButtonProps {
  accessibilityLabel: string;
  busy?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  iconTestID?: string;
  onPress(): void;
  testID?: string;
  variant?: "destructive" | "standard" | "toolbar";
}

export function SystemButton({
  accessibilityLabel,
  align = "start",
  busy = false,
  disabled = false,
  icon: Icon,
  iconTestID,
  label,
  onPress,
  testID,
  variant = "standard",
}: SystemButtonProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const unavailable = disabled || busy;
  const iconColor = variant === "destructive"
    ? theme.semantic.color.statusDanger
    : variant === "toolbar"
      ? theme.semantic.color.iconSecondary
      : theme.semantic.color.iconPrimary;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{busy, disabled: unavailable}}
      aria-busy={busy}
      disabled={unavailable}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        align === "center" && styles.alignCenter,
        align === "stretch" && styles.alignStretch,
        variant === "toolbar" && styles.toolbar,
        variant === "destructive" && styles.destructive,
        hovered && !unavailable && styles.hovered,
        pressed && !unavailable && styles.pressed,
        unavailable && styles.unavailable,
      ]}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : Icon ? (
        <View testID={iconTestID}>
          <Icon
            color={iconColor}
            size={theme.semantic.icon.size.small}
            strokeWidth={theme.semantic.icon.stroke.emphasis}
          />
        </View>
      ) : null}
      <Text
        style={[
          styles.label,
          variant === "destructive" && styles.labelDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SystemIconButton({
  accessibilityLabel,
  busy = false,
  disabled = false,
  icon: Icon,
  iconTestID,
  onPress,
  testID,
  variant = "toolbar",
}: SystemIconButtonProps) {
  const {theme} = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const unavailable = disabled || busy;
  const color = variant === "destructive"
    ? theme.semantic.color.statusDanger
    : variant === "toolbar"
      ? theme.semantic.color.iconSecondary
      : theme.semantic.color.iconPrimary;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{busy, disabled: unavailable}}
      aria-busy={busy}
      disabled={unavailable}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({pressed}) => [
        styles.iconButton,
        variant === "standard" && styles.iconStandard,
        variant === "destructive" && styles.iconDestructive,
        hovered && !unavailable && styles.hovered,
        pressed && !unavailable && styles.pressed,
        unavailable && styles.unavailable,
      ]}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        <View testID={iconTestID}>
          <Icon
            color={color}
            size={theme.semantic.icon.size.medium}
            strokeWidth={theme.semantic.icon.stroke.emphasis}
          />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  alignCenter: {alignSelf: "center"},
  alignStretch: {alignSelf: "stretch"},
  button: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.control.height,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.lg,
    ...theme.semantic.motion.transition.control,
  },
  destructive: {
    backgroundColor: theme.semantic.color.actionDangerSurface,
    borderColor: theme.semantic.color.actionDangerBorder,
  },
  hovered: {
    backgroundColor: theme.semantic.color.interactiveHoverSurface,
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.managementWorkspace.headerActionHeight,
    justifyContent: "center",
    width: theme.recipes.managementWorkspace.headerActionHeight,
    ...theme.semantic.motion.transition.control,
  },
  iconDestructive: {
    backgroundColor: theme.semantic.color.actionDangerSurface,
  },
  iconStandard: {
    backgroundColor: theme.semantic.color.actionSecondarySurface,
    borderColor: theme.semantic.color.borderControl,
  },
  label: {
    color: theme.semantic.color.actionSecondaryText,
    ...theme.semantic.typography.button,
  },
  labelDanger: {color: theme.semantic.color.actionDangerText},
  pressed: {
    backgroundColor: theme.semantic.color.interactivePressedSurface,
  },
  toolbar: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderColor: theme.semantic.color.borderTransparent,
    height: theme.recipes.managementWorkspace.headerActionHeight,
    paddingHorizontal: theme.spacing.md,
  },
  unavailable: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
}));

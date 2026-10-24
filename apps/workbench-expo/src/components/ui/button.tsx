import { typographyRole } from "@opencraft/design-system/typography";
import {
  buttonSizeMetrics,
  defaultButtonSize,
  defaultButtonVariant,
  type ButtonSize,
  type ButtonVariant,
} from "@opencraft/design-system/button";
import { type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useWorkbenchTheme } from "../../styles/workbench-styles";

export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  readonly children: ReactNode;
  readonly loading?: boolean;
  readonly size?: ButtonSize;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: StyleProp<TextStyle>;
  readonly variant?: ButtonVariant;
}

export interface IconButtonProps extends Omit<ButtonProps, "children"> {
  readonly accessibilityLabel: string;
  readonly children: ReactNode;
  readonly selected?: boolean;
}

export function Button({
  children,
  disabled = false,
  loading = false,
  size = defaultButtonSize,
  style,
  textStyle,
  variant = defaultButtonVariant,
  ...props
}: ButtonProps) {
  const { theme } = useWorkbenchTheme();
  const inactive = disabled || loading;
  const pressed = pressedStyles[variant](styles);
  const spinnerColor = variant === "primary" || variant === "destructive" || variant === "hero"
    ? theme.color.button.primaryForeground
    : theme.color.text.primary;

  return (
    <Pressable
      {...props}
      accessibilityRole={props.accessibilityRole ?? "button"}
      accessibilityState={{ ...props.accessibilityState, busy: loading, disabled: inactive }}
      disabled={inactive}
      hitSlop={size === "sm" ? 6 : props.hitSlop}
      style={({ pressed: isPressed }) => [
        styles.container,
        containerVariantStyles[variant],
        containerSizeStyles[size],
        inactive && styles.disabled,
        isPressed && pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={spinnerColor} />
      ) : typeof children === "string" || typeof children === "number" ? (
        <Text style={[labelVariantStyles[variant], labelSizeStyles[size], (variant === "primary" || variant === "hero") && { fontWeight: typographyRole("primaryAction", "native").fontWeight }, textStyle]}>{children}</Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

export function IconButton({
  children,
  selected = false,
  size = "md",
  style,
  variant = selected ? "secondary" : "ghost",
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      accessibilityState={{ ...props.accessibilityState, selected }}
      size={size}
      style={[iconButtonStyles.control, iconButtonSizeStyles[size], style]}
      variant={variant}
    >
      {children}
    </Button>
  );
}

type ButtonStyles = typeof styles;

const pressedStyles: Record<ButtonVariant, (sheet: ButtonStyles) => ViewStyle> = {
  primary: (sheet) => sheet.primaryPressed,
  secondary: (sheet) => sheet.secondaryPressed,
  outline: (sheet) => sheet.tertiaryPressed,
  ghost: (sheet) => sheet.tertiaryPressed,
  link: (sheet) => sheet.linkPressed,
  destructive: (sheet) => sheet.destructivePressed,
  hero: (sheet) => sheet.primaryPressed,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    borderRadius: theme.metrics.control.radius,
  },
  containerPrimary: { backgroundColor: theme.color.button.primary },
  containerSecondary: { backgroundColor: theme.color.button.secondary },
  containerOutline: { backgroundColor: "transparent", borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border.default },
  containerGhost: { backgroundColor: "transparent" },
  containerLink: { minHeight: 0, paddingHorizontal: 0, backgroundColor: "transparent" },
  containerDestructive: { backgroundColor: theme.color.accent.negative },
  disabled: { opacity: theme.metrics.interaction.disabledOpacity },
  sizeSm: { minHeight: buttonSizeMetrics.sm.height, paddingHorizontal: buttonSizeMetrics.sm.horizontalPadding },
  sizeMd: { minHeight: buttonSizeMetrics.md.height, paddingHorizontal: buttonSizeMetrics.md.horizontalPadding },
  sizeLg: { minHeight: buttonSizeMetrics.lg.height, paddingHorizontal: buttonSizeMetrics.lg.horizontalPadding },
  sizeToolbar: { minHeight: buttonSizeMetrics.toolbar.height, paddingHorizontal: buttonSizeMetrics.toolbar.horizontalPadding },
  primaryPressed: { backgroundColor: theme.color.button.primaryHover },
  secondaryPressed: { backgroundColor: theme.color.button.secondaryHover },
  tertiaryPressed: { backgroundColor: theme.color.button.tertiaryHover },
  linkPressed: { opacity: theme.metrics.interaction.pressedOpacity },
  destructivePressed: { opacity: theme.metrics.interaction.pressedOpacity },
  labelPrimary: { color: theme.color.button.primaryForeground },
  labelDefault: { color: theme.color.text.primary },
  labelLink: { color: theme.color.text.secondary, textDecorationLine: "underline" as const },
  labelSm: { fontWeight: buttonSizeMetrics.sm.fontWeight, fontSize: buttonSizeMetrics.sm.fontSize, lineHeight: buttonSizeMetrics.sm.lineHeight },
  labelMd: { fontWeight: buttonSizeMetrics.md.fontWeight, fontSize: buttonSizeMetrics.md.fontSize, lineHeight: buttonSizeMetrics.md.lineHeight },
  labelLg: { fontWeight: buttonSizeMetrics.lg.fontWeight, fontSize: buttonSizeMetrics.lg.fontSize, lineHeight: buttonSizeMetrics.lg.lineHeight },
  labelToolbar: { fontWeight: buttonSizeMetrics.toolbar.fontWeight, fontSize: buttonSizeMetrics.toolbar.fontSize, lineHeight: buttonSizeMetrics.toolbar.lineHeight },
}));

const iconButtonStyles = StyleSheet.create({
  control: { paddingHorizontal: 0 },
  sm: { width: buttonSizeMetrics.sm.height },
  md: { width: buttonSizeMetrics.md.height },
  lg: { width: buttonSizeMetrics.lg.height },
  toolbar: { width: buttonSizeMetrics.toolbar.height },
});

const containerVariantStyles: Record<ButtonVariant, ViewStyle> = {
  primary: styles.containerPrimary,
  secondary: styles.containerSecondary,
  outline: styles.containerOutline,
  ghost: styles.containerGhost,
  link: styles.containerLink,
  destructive: styles.containerDestructive,
  hero: styles.containerPrimary,
};

const labelVariantStyles: Record<ButtonVariant, TextStyle> = {
  primary: styles.labelPrimary,
  secondary: styles.labelDefault,
  outline: styles.labelDefault,
  ghost: styles.labelDefault,
  link: styles.labelLink,
  destructive: styles.labelPrimary,
  hero: styles.labelPrimary,
};

const containerSizeStyles: Record<ButtonSize, ViewStyle> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
  toolbar: styles.sizeToolbar,
};

const labelSizeStyles: Record<ButtonSize, TextStyle> = {
  sm: styles.labelSm,
  md: styles.labelMd,
  lg: styles.labelLg,
  toolbar: styles.labelToolbar,
};

const iconButtonSizeStyles: Record<ButtonSize, ViewStyle> = {
  sm: iconButtonStyles.sm,
  md: iconButtonStyles.md,
  lg: iconButtonStyles.lg,
  toolbar: iconButtonStyles.toolbar,
};

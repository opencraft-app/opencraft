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
import { StyleSheet, useUnistyles } from "react-native-unistyles";

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
  const { theme } = useUnistyles();
  const inactive = disabled || loading;
  styles.useVariants({ variant, size, disabled: inactive });
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
        isPressed && pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={spinnerColor} />
      ) : typeof children === "string" || typeof children === "number" ? (
        <Text style={[styles.label, textStyle]}>{children}</Text>
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
  iconButtonStyles.useVariants({ size });
  return (
    <Button
      {...props}
      accessibilityState={{ ...props.accessibilityState, selected }}
      size={size}
      style={[iconButtonStyles.control, style]}
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
    variants: {
      variant: {
        primary: { backgroundColor: theme.color.button.primary },
        secondary: { backgroundColor: theme.color.button.secondary },
        outline: {
          backgroundColor: "transparent",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.color.border.default,
        },
        ghost: { backgroundColor: "transparent" },
        link: { minHeight: 0, paddingHorizontal: 0, backgroundColor: "transparent" },
        destructive: { backgroundColor: theme.color.accent.negative },
        hero: { backgroundColor: theme.color.button.primary },
      },
      size: {
        sm: {
          minHeight: buttonSizeMetrics.sm.height,
          paddingHorizontal: buttonSizeMetrics.sm.horizontalPadding,
        },
        md: {
          minHeight: buttonSizeMetrics.md.height,
          paddingHorizontal: buttonSizeMetrics.md.horizontalPadding,
        },
        lg: {
          minHeight: buttonSizeMetrics.lg.height,
          paddingHorizontal: buttonSizeMetrics.lg.horizontalPadding,
        },
        toolbar: {
          minHeight: buttonSizeMetrics.toolbar.height,
          paddingHorizontal: buttonSizeMetrics.toolbar.horizontalPadding,
        },
      },
      disabled: {
        true: { opacity: theme.metrics.interaction.disabledOpacity },
        false: { opacity: 1 },
      },
    },
  },
  primaryPressed: { backgroundColor: theme.color.button.primaryHover },
  secondaryPressed: { backgroundColor: theme.color.button.secondaryHover },
  tertiaryPressed: { backgroundColor: theme.color.button.tertiaryHover },
  linkPressed: { opacity: theme.metrics.interaction.pressedOpacity },
  destructivePressed: { opacity: theme.metrics.interaction.pressedOpacity },
  label: {
    variants: {
      variant: {
        primary: { color: theme.color.button.primaryForeground },
        secondary: { color: theme.color.text.primary },
        outline: { color: theme.color.text.primary },
        ghost: { color: theme.color.text.primary },
        link: { color: theme.color.text.secondary, textDecorationLine: "underline" },
        destructive: { color: theme.color.button.primaryForeground },
        hero: { color: theme.color.button.primaryForeground },
      },
      size: {
        sm: {
          fontWeight: buttonSizeMetrics.sm.fontWeight,
          fontSize: buttonSizeMetrics.sm.fontSize,
          lineHeight: buttonSizeMetrics.sm.lineHeight,
        },
        md: {
          fontWeight: buttonSizeMetrics.md.fontWeight,
          fontSize: buttonSizeMetrics.md.fontSize,
          lineHeight: buttonSizeMetrics.md.lineHeight,
        },
        lg: {
          fontWeight: buttonSizeMetrics.lg.fontWeight,
          fontSize: buttonSizeMetrics.lg.fontSize,
          lineHeight: buttonSizeMetrics.lg.lineHeight,
        },
        toolbar: {
          fontWeight: buttonSizeMetrics.toolbar.fontWeight,
          fontSize: buttonSizeMetrics.toolbar.fontSize,
          lineHeight: buttonSizeMetrics.toolbar.lineHeight,
        },
      },
    },
  },
}));

const iconButtonStyles = StyleSheet.create({
  control: {
    paddingHorizontal: 0,
    variants: {
      size: {
        sm: { width: buttonSizeMetrics.sm.height },
        md: { width: buttonSizeMetrics.md.height },
        lg: { width: buttonSizeMetrics.lg.height },
        toolbar: { width: buttonSizeMetrics.toolbar.height },
      },
    },
  },
});

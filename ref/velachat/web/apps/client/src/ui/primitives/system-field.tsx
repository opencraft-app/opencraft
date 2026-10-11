import type {ReactNode} from "react";
import {
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import {StyleSheet, useUnistyles} from "react-native-unistyles";

export type SystemFieldLayout = "compact" | "flex" | "stacked";

export interface SystemFieldProps {
  children: ReactNode;
  error?: string | null;
  hint?: string;
  label: string;
  labelTone?: "muted" | "primary";
  layout?: SystemFieldLayout;
  testID?: string;
}

export function SystemField({
  children,
  error,
  hint,
  label,
  labelTone = "muted",
  layout = "stacked",
  testID = "system-field",
}: SystemFieldProps) {
  return (
    <View
      style={[
        styles.field,
        layout === "flex" && styles.fieldFlex,
        layout === "compact" && styles.fieldCompact,
      ]}
      testID={testID}
    >
      <Text
        style={[
          styles.fieldLabel,
          labelTone === "primary" && styles.fieldLabelPrimary,
        ]}
      >
        {label}
      </Text>
      {children}
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export interface SystemTextInputProps extends TextInputProps {
  invalid?: boolean;
  size?: "large" | "regular";
}

export function SystemTextInput({
  editable = true,
  invalid = false,
  multiline = false,
  placeholderTextColor,
  size = "regular",
  style,
  ...props
}: SystemTextInputProps) {
  const {theme} = useUnistyles();
  return (
    <TextInput
      {...props}
      editable={editable}
      multiline={multiline}
      placeholderTextColor={
        placeholderTextColor ?? theme.semantic.color.fieldPlaceholder
      }
      style={[
        styles.textInput,
        size === "large" && styles.textInputLarge,
        multiline && styles.textInputMultiline,
        invalid && styles.textInputInvalid,
        !editable && styles.disabled,
        style,
      ]}
      {...({dataSet: {velaField: "form"}} as object)}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  disabled: {opacity: theme.semantic.interaction.disabledOpacity},
  field: {
    flexGrow: 0,
    gap: theme.spacing.xs,
    minWidth: 0,
    width: "100%",
  },
  fieldCompact: {
    width: theme.recipes.managementWorkspace.fieldCompactWidth,
  },
  fieldError: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.meta,
  },
  fieldFlex: {
    flex: 1,
    minWidth: theme.recipes.managementWorkspace.formFieldMinWidth,
  },
  fieldHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  fieldLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.label,
  },
  fieldLabelPrimary: {
    color: theme.semantic.color.textPrimary,
  },
  textInput: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    color: theme.semantic.color.textPrimary,
    height: theme.recipes.control.fieldHeight,
    minHeight: theme.recipes.control.fieldHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 0,
    ...theme.semantic.typography.body,
    width: "100%",
    ...theme.semantic.motion.transition.control,
    _web: {
      boxSizing: "border-box",
      _hover: {
        borderColor: theme.semantic.color.borderFieldHover,
      },
      _focus: {
        borderColor: theme.semantic.color.borderFocus,
        boxShadow: `0 0 0 2px ${theme.semantic.color.fieldFocusGlow}`,
      },
    },
  },
  textInputInvalid: {
    borderColor: theme.semantic.color.borderDangerStrong,
    _web: {
      _focus: {
        borderColor: theme.semantic.color.borderDangerStrong,
        boxShadow: `0 0 0 3px ${theme.semantic.color.borderDanger}`,
      },
    },
  },
  textInputLarge: {
    height: "auto",
    minHeight: theme.recipes.authWorkspace.controlHeight,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  textInputMultiline: {
    height: "auto",
    minHeight: theme.recipes.managementWorkspace.textareaMinHeight,
    paddingVertical: theme.spacing.sm,
    textAlignVertical: "top",
  },
}));

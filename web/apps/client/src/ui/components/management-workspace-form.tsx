import type {ReactNode} from "react";
import {
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import {useUnistyles} from "react-native-unistyles";

import {
  LocalDateTimeInput,
  type LocalDateTimeInputProps,
} from "./local-date-time-input";
import {styles} from "./management-workspace.styles";

import {ActionButton} from "../primitives/action-button";

interface SemanticContainerProps {
  children: ReactNode;
  testID?: string;
}

export type ManagementFieldLayout = "compact" | "flex" | "stacked";

export function ManagementForm({
  children,
  testID = "management-form",
}: SemanticContainerProps) {
  return <View style={styles.form} testID={testID}>{children}</View>;
}

export function ManagementFormActions({
  children,
  testID = "management-form-actions",
}: SemanticContainerProps) {
  return <View style={styles.formActions} testID={testID}>{children}</View>;
}

export interface ManagementFieldProps extends SemanticContainerProps {
  error?: string | null;
  hint?: string;
  label: string;
  layout?: ManagementFieldLayout;
}

export function ManagementField({
  children,
  error,
  hint,
  label,
  layout = "stacked",
  testID = "management-field",
}: ManagementFieldProps) {
  return (
    <View
      style={[
        styles.field,
        layout === "flex" && styles.fieldFlex,
        layout === "compact" && styles.fieldCompact,
      ]}
      testID={testID}
    >
      <Text style={styles.fieldLabel}>{label}</Text>
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

export interface ManagementTextInputProps
  extends Omit<TextInputProps, "style"> {
  invalid?: boolean;
}

export function ManagementTextInput({
  editable = true,
  invalid = false,
  multiline = false,
  placeholderTextColor,
  ...props
}: ManagementTextInputProps) {
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
        multiline && styles.textInputMultiline,
        invalid && styles.textInputInvalid,
        !editable && styles.disabled,
      ]}
      {...({dataSet: {velaField: "form"}} as object)}
    />
  );
}

export interface ManagementDateTimeInputProps
  extends Omit<LocalDateTimeInputProps, "style"> {
  invalid?: boolean;
}

export function ManagementDateTimeInput({
  disabled = false,
  invalid = false,
  ...props
}: ManagementDateTimeInputProps) {
  return (
    <LocalDateTimeInput
      {...props}
      disabled={disabled}
      invalid={invalid}
      style={[
        styles.textInput,
        invalid && styles.textInputInvalid,
        disabled && styles.disabled,
      ]}
    />
  );
}

export interface ManagementFormFooterAction {
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress(): unknown | Promise<unknown>;
  testID?: string;
}

export interface ManagementFormFooterProps {
  backAction?: ManagementFormFooterAction;
  cancelAction?: ManagementFormFooterAction;
  primaryAction: ManagementFormFooterAction;
  testID?: string;
}

/** One ordering and state contract for cancel/back/submit form actions. */
export function ManagementFormFooter({
  backAction,
  cancelAction,
  primaryAction,
  testID = "management-form-footer",
}: ManagementFormFooterProps) {
  const renderSecondaryAction = (action: ManagementFormFooterAction) => (
    <ActionButton
      accessibilityLabel={action.accessibilityLabel}
      busy={action.busy}
      disabled={action.disabled}
      importance="secondary"
      label={action.label}
      onPress={() => void action.onPress()}
      testID={action.testID}
    />
  );
  return (
    <ManagementFormActions testID={testID}>
      {cancelAction ? renderSecondaryAction(cancelAction) : null}
      {backAction ? renderSecondaryAction(backAction) : null}
      <ActionButton
        accessibilityLabel={primaryAction.accessibilityLabel}
        busy={primaryAction.busy}
        disabled={primaryAction.disabled}
        importance="primary"
        label={primaryAction.label}
        onPress={() => void primaryAction.onPress()}
        testID={primaryAction.testID}
      />
    </ManagementFormActions>
  );
}

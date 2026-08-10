import type {ReactNode} from "react";
import {View} from "react-native";

import {
  LocalDateTimeInput,
  type LocalDateTimeInputProps,
} from "./local-date-time-input";
import {styles} from "./management-workspace.styles";

import {SystemButton} from "../primitives/system-button";
import {
  SystemField,
  type SystemFieldLayout,
  type SystemFieldProps,
  SystemTextInput,
  type SystemTextInputProps,
} from "../primitives/system-field";

interface SemanticContainerProps {
  children: ReactNode;
  testID?: string;
}

export type ManagementFieldLayout = SystemFieldLayout;

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

export type ManagementFieldProps = SystemFieldProps;

export function ManagementField(props: ManagementFieldProps) {
  return <SystemField {...props} testID={props.testID ?? "management-field"} />;
}

export type ManagementTextInputProps = SystemTextInputProps;

export function ManagementTextInput(props: ManagementTextInputProps) {
  return <SystemTextInput {...props} />;
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
    <SystemButton
      accessibilityLabel={action.accessibilityLabel}
      busy={action.busy}
      disabled={action.disabled}
      variant="secondary"
      label={action.label}
      onPress={() => void action.onPress()}
      testID={action.testID}
    />
  );
  return (
    <ManagementFormActions testID={testID}>
      {cancelAction ? renderSecondaryAction(cancelAction) : null}
      {backAction ? renderSecondaryAction(backAction) : null}
      <SystemButton
        accessibilityLabel={primaryAction.accessibilityLabel}
        busy={primaryAction.busy}
        disabled={primaryAction.disabled}
        variant="default"
        label={primaryAction.label}
        onPress={() => void primaryAction.onPress()}
        testID={primaryAction.testID}
      />
    </ManagementFormActions>
  );
}

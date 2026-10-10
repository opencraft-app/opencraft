import type {PresentationField} from "../presentation";

import {
  ManagementDateTimeInput,
  ManagementField,
} from "./management-workspace-form";
import type {InviteExpirationSession} from "./invite-expiration";

export interface InviteExpirationFieldProps {
  field: PresentationField;
  session: InviteExpirationSession;
}

/** Connects invite-domain expiry rules to the reusable date-time control. */
export function InviteExpirationField({
  field,
  session,
}: InviteExpirationFieldProps) {
  return (
    <ManagementField
      error={field.error}
      hint={field.hint}
      label={field.label}
      layout="flex"
    >
      <ManagementDateTimeInput
        accessibilityLabel={field.accessibilityLabel ?? "邀请有效期"}
        disabled={field.disabled}
        invalid={Boolean(field.error)}
        maxValue={session.maxValue}
        minValue={session.minValue}
        minuteStep={session.minuteStep}
        onChangeText={field.onChange}
        placeholder={field.placeholder}
        presets={session.presets}
        timezone={session.timezone}
        value={field.value}
      />
    </ManagementField>
  );
}

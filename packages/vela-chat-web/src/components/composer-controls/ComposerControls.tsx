"use client";

import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import { ShellSelect } from "../../../../vela-desktop-shell/src";
import styles from "../../styles/desktop.module.css";
import type {
  ComposerControlsModel,
  ComposerModelOption,
  ComposerOption,
  ComposerPermissionOption,
} from "./model";

export interface ComposerControlsProps {
  controls: ComposerControlsModel;
  isUpdating?: boolean;
  placement?: "all" | "primary" | "secondary";
  onChange: (patch: AgentConfigPatchWire) => void;
}

export function ComposerControls({
  controls,
  isUpdating = false,
  placement = "all",
  onChange,
}: ComposerControlsProps) {
  if (!controls.ready) {
    return (
      <div
        aria-hidden="true"
        className={styles.composerControls}
        data-composer-controls-ready="false"
        data-placement={placement}
      />
    );
  }

  const disabled = controls.disabled || isUpdating;

  return (
    <div
      className={styles.composerControls}
      aria-label={`${controls.providerLabel} controls`}
      data-composer-controls-ready="true"
      data-placement={placement}
    >
      {placement === "all" || placement === "secondary" ? (
        <>
          <ControlMenu
            ariaLabel="Select model"
            disabled={disabled || controls.modelOptions.length === 0}
            label={controls.selectedModel?.label ?? controls.providerLabel}
            leading="◎"
            options={controls.modelOptions}
            selectedId={controls.selectedModel?.id}
            onSelect={(option) => onChange({ model: option.id })}
          />
          {controls.reasoningEffortOptions.length > 0 ? (
            <ControlMenu
              ariaLabel="Select reasoning effort"
              disabled={disabled}
              label={controls.selectedReasoningEffort?.label ?? "Reasoning"}
              leading="✣"
              options={controls.reasoningEffortOptions}
              selectedId={controls.selectedReasoningEffort?.id}
              onSelect={(option) => onChange({ reasoning_effort: option.id })}
            />
          ) : null}
        </>
      ) : null}
      {placement === "all" || placement === "primary" ? (
        <ControlMenu
          ariaLabel="Select permission mode"
          disabled={disabled || controls.permissionModeOptions.length === 0}
          label={controls.selectedPermissionMode?.label ?? "Permissions"}
          leading="▣"
          options={controls.permissionModeOptions}
          selectedId={controls.selectedPermissionMode?.id}
          tone={controls.selectedPermissionMode?.id === "full_access" ? "accent" : "neutral"}
          onSelect={(option) => onChange({ permission_mode: option.id })}
        />
      ) : null}
    </div>
  );
}

function ControlMenu<T extends ComposerModelOption | ComposerOption | ComposerPermissionOption>({
  ariaLabel,
  disabled,
  label,
  leading,
  options,
  selectedId,
  tone = "neutral",
  onSelect,
}: {
  ariaLabel: string;
  disabled: boolean;
  label: string;
  leading: string;
  options: T[];
  selectedId?: string;
  tone?: "neutral" | "accent";
  onSelect: (option: T) => void;
}) {
  const selectedOption = options.find((option) => option.id === selectedId);

  return (
    <ShellSelect
      ariaLabel={ariaLabel}
      density="compact"
      disabled={disabled}
      leading={leading}
      options={options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      }))}
      placement="top-start"
      placeholder={label}
      tone={tone}
      value={selectedOption?.id}
      onValueChange={(value) => {
        const option = options.find((candidate) => candidate.id === value);
        if (option) onSelect(option);
      }}
    />
  );
}

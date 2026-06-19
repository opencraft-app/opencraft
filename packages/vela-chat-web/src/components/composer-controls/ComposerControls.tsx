"use client";

import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
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
  const disabled = controls.disabled || isUpdating;

  return (
    <div className={styles.composerControls} aria-label={`${controls.providerLabel} controls`}>
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
          <ControlMenu
            ariaLabel="Select reasoning effort"
            disabled={disabled || controls.reasoningEffortOptions.length === 0}
            label={controls.selectedReasoningEffort?.label ?? "Reasoning"}
            leading="✣"
            options={controls.reasoningEffortOptions}
            selectedId={controls.selectedReasoningEffort?.id}
            onSelect={(option) => onChange({ reasoning_effort: option.id })}
          />
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
  return (
    <details className={styles.controlMenu}>
      <summary
        aria-label={ariaLabel}
        className={tone === "accent" ? styles.controlButtonAccent : styles.controlButton}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <span aria-hidden="true">{leading}</span>
        <span className={styles.controlButtonLabel}>{label}</span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className={styles.controlPopover} role="menu">
        {options.map((option) => (
          <button
            className={styles.controlOption}
            key={option.id}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onSelect(option);
            }}
            role="menuitemradio"
            type="button"
            aria-checked={option.id === selectedId}
          >
            <span className={styles.controlOptionText}>
              <span className={styles.controlOptionLabel}>{option.label}</span>
              {option.description ? (
                <span className={styles.controlOptionDescription}>{option.description}</span>
              ) : null}
            </span>
            <span aria-hidden="true" className={styles.controlCheck}>
              {option.id === selectedId ? "✓" : ""}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}

import { useId, useState } from "react";
import { Button, DisclosureButton, IconButton, SplitButtonGroup } from "@opencraft/design-system-web/button";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  FolderIcon,
  LaptopIcon,
  LoadingRingIcon,
  NewFolderIcon,
  NewMessageIcon,
  PersonIcon,
  ServerIcon,
  WarningIcon,
} from "@opencraft/design-system-web/action-icons";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import "./composer-handoff.scss";

export interface ComposerHandoffDeviceOption {
  readonly id: string;
  readonly label: string;
  readonly role: "local" | "server" | "cloud";
  readonly selected: boolean;
  readonly connectable: boolean;
}

export interface ComposerHandoffWorkspaceOption {
  readonly cwd: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface ComposerHandoffState {
  readonly sourceTitle: string;
  readonly sourceAgentLabel?: string | null;
  readonly workspacePath?: string | null;
  readonly hostId: string;
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
  readonly permissionProfile?: string | null;
  readonly isCrossDevice?: boolean;
  readonly switchingDevice?: boolean;
  readonly devices?: readonly ComposerHandoffDeviceOption[];
  readonly onSelectDevice?: (deviceId: string) => void | Promise<void>;
  readonly targetWorkspacePath?: string | null;
  readonly targetWorkspaces?: readonly ComposerHandoffWorkspaceOption[];
  readonly onSelectTargetWorkspace?: (cwd: string) => void;
  readonly onBrowseTargetWorkspace?: () => void;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly canContinueInCurrentThread?: boolean;
  readonly onChangeSelections: (patch: {
    readonly model?: string;
    readonly effort?: string | null;
    readonly serviceTier?: string | null;
    readonly permissionProfile?: string | null;
  }) => void;
  readonly onSubmit: () => void | Promise<void>;
  readonly onContinueInCurrentThread?: () => void;
  readonly onDismissError?: () => void;
  readonly onCancel: () => void;
}

function DeviceRoleIcon({ role }: { readonly role: ComposerHandoffDeviceOption["role"] }) {
  const Icon = role === "local" ? LaptopIcon : role === "cloud" ? CloudIcon : ServerIcon;
  return <Icon size={14} aria-hidden="true" />;
}

export function ComposerHandoffBanner({
  sourceTitle,
  sourceAgentLabel,
  workspacePath,
  isCrossDevice = false,
  switchingDevice = false,
  devices,
  onSelectDevice,
  targetWorkspacePath,
  targetWorkspaces,
  onSelectTargetWorkspace,
  onBrowseTargetWorkspace,
  portalContainer,
  disabled = false,
  onCancel,
}: {
  readonly sourceTitle: string;
  readonly sourceAgentLabel?: string | null;
  readonly workspacePath?: string | null;
  readonly isCrossDevice?: boolean;
  readonly switchingDevice?: boolean;
  readonly devices?: readonly ComposerHandoffDeviceOption[];
  readonly onSelectDevice?: (deviceId: string) => void | Promise<void>;
  readonly targetWorkspacePath?: string | null;
  readonly targetWorkspaces?: readonly ComposerHandoffWorkspaceOption[];
  readonly onSelectTargetWorkspace?: (cwd: string) => void;
  readonly onBrowseTargetWorkspace?: () => void;
  readonly portalContainer?: HTMLElement | null;
  readonly disabled?: boolean;
  readonly onCancel: () => void;
}) {
  const intl = useIntl();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const folderName = workspacePath?.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
  const selectedDevice = devices?.find(device => device.selected) ?? null;
  const targetFolderName = targetWorkspacePath?.split(/[\\/]/u).filter(Boolean).at(-1)
    ?? intl.formatMessage({ id: "composer.handoff.chooseFolder", defaultMessage: "Choose folder" });
  const toggleLabel = intl.formatMessage(
    detailsOpen
      ? { id: "composer.handoff.hideDetails", defaultMessage: "Hide handoff context details" }
      : { id: "composer.handoff.showDetails", defaultMessage: "Show handoff context details" },
  );

  return (
    <div
      className="opencraft-composer-handoff"
      data-details-open={detailsOpen ? "true" : undefined}
      data-cross-device={isCrossDevice ? "true" : undefined}
    >
      <div className="opencraft-composer-handoff__header">
        <div className="opencraft-composer-handoff__header-main">
          <div className="opencraft-composer-handoff__title">
            <NewMessageIcon size={16} aria-hidden="true" />
            <span>
              <FormattedMessage id="composer.handoff.title" defaultMessage="Handoff to new thread" />
            </span>
          </div>
          {devices && devices.length > 1 && onSelectDevice && selectedDevice ? (
            <div className="opencraft-composer-handoff__targets">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <DisclosureButton
                    size="accessory"
                    disabled={disabled || switchingDevice}
                    aria-label={intl.formatMessage(
                      { id: "composer.handoff.targetDevice", defaultMessage: "Target device: {device}" },
                      { device: selectedDevice.label },
                    )}
                    title={selectedDevice.label}
                  >
                    {switchingDevice ? <LoadingRingIcon size={13} aria-hidden="true" /> : <DeviceRoleIcon role={selectedDevice.role} />}
                    <span className="opencraft-composer-handoff__target-label">{selectedDevice.label}</span>
                    <ChevronDownIcon size={12} aria-hidden="true" />
                  </DisclosureButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal container={portalContainer ?? undefined}>
                  <DropdownMenu.Content
                    className="opencraft-composer-selection-menu"
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <DropdownMenu.Group className="opencraft-composer-selection-menu__items">
                      {devices.map(device => (
                        <DropdownMenu.Item
                          key={device.id}
                          className="opencraft-composer-selection-menu__item has-leading"
                          data-selected={device.selected ? "true" : undefined}
                          disabled={!device.connectable || switchingDevice}
                          onSelect={() => {
                            if (!device.selected) void onSelectDevice(device.id);
                          }}
                        >
                          <DeviceRoleIcon role={device.role} />
                          <span className="opencraft-composer-selection-menu__copy">
                            <span className="opencraft-composer-selection-menu__label">{device.label}</span>
                          </span>
                          {device.selected ? <CheckIcon size={15} aria-hidden="true" /> : null}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Group>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              {isCrossDevice && (onSelectTargetWorkspace || onBrowseTargetWorkspace) ? (
                <>
                  <ChevronRightIcon size={12} aria-hidden="true" className="opencraft-composer-handoff__target-sep" />
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <DisclosureButton
                        size="accessory"
                        disabled={disabled || switchingDevice}
                        aria-label={intl.formatMessage(
                          { id: "composer.handoff.targetFolder", defaultMessage: "Target folder: {folder}" },
                          { folder: targetFolderName },
                        )}
                        title={targetWorkspacePath ?? targetFolderName}
                      >
                        <FolderIcon size={14} aria-hidden="true" />
                        <span className="opencraft-composer-handoff__target-label">{targetFolderName}</span>
                        <ChevronDownIcon size={12} aria-hidden="true" />
                      </DisclosureButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal container={portalContainer ?? undefined}>
                      <DropdownMenu.Content
                        className="opencraft-composer-selection-menu"
                        align="start"
                        sideOffset={6}
                        collisionPadding={12}
                      >
                        {targetWorkspaces && targetWorkspaces.length > 0 && onSelectTargetWorkspace ? (
                          <DropdownMenu.Group className="opencraft-composer-selection-menu__items">
                            {targetWorkspaces.map(option => (
                              <DropdownMenu.Item
                                key={option.cwd}
                                className="opencraft-composer-selection-menu__item has-leading"
                                data-selected={option.selected ? "true" : undefined}
                                onSelect={() => onSelectTargetWorkspace(option.cwd)}
                              >
                                <FolderIcon size={15} aria-hidden="true" />
                                <span className="opencraft-composer-selection-menu__copy">
                                  <span className="opencraft-composer-selection-menu__label">{option.label}</span>
                                </span>
                                {option.selected ? <CheckIcon size={15} aria-hidden="true" /> : null}
                              </DropdownMenu.Item>
                            ))}
                          </DropdownMenu.Group>
                        ) : null}
                        {onBrowseTargetWorkspace ? (
                          <>
                            {targetWorkspaces && targetWorkspaces.length > 0 ? (
                              <DropdownMenu.Separator className="opencraft-composer-selection-menu__separator" />
                            ) : null}
                            <DropdownMenu.Group className="opencraft-composer-selection-menu__items">
                              <DropdownMenu.Item
                                className="opencraft-composer-selection-menu__item has-leading"
                                onSelect={() => onBrowseTargetWorkspace()}
                              >
                                <NewFolderIcon size={15} aria-hidden="true" />
                                <span className="opencraft-composer-selection-menu__copy">
                                  <span className="opencraft-composer-selection-menu__label">
                                    <FormattedMessage id="composer.handoff.browseFolder" defaultMessage="Browse folder…" />
                                  </span>
                                </span>
                              </DropdownMenu.Item>
                            </DropdownMenu.Group>
                          </>
                        ) : null}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <IconButton
          size="accessory"
          variant="ghost"
          disabled={disabled}
          aria-label={intl.formatMessage({ id: "composer.handoff.cancel", defaultMessage: "Cancel handoff" })}
          onClick={onCancel}
        >
          <CloseIcon size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="opencraft-composer-handoff__source">
        <div className="opencraft-composer-handoff__from">
          <span className="opencraft-composer-handoff__prefix">
            <FormattedMessage id="composer.handoff.continueFrom" defaultMessage="Continue from" />
          </span>
          <button
            type="button"
            className="opencraft-composer-handoff__pill"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            title={sourceTitle}
            onClick={() => setDetailsOpen(current => !current)}
          >
            <PersonIcon size={14} aria-hidden="true" />
            <span className="opencraft-composer-handoff__pill-title">{sourceTitle}</span>
          </button>
        </div>
        <IconButton
          size="accessory"
          variant="ghost"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          aria-label={toggleLabel}
          onClick={() => setDetailsOpen(current => !current)}
        >
          <ChevronDownIcon
            size={15}
            aria-hidden="true"
            className="opencraft-composer-handoff__chevron"
            data-open={detailsOpen ? "true" : undefined}
          />
        </IconButton>
      </div>
      {isCrossDevice ? (
        <div className="opencraft-composer-handoff__cross-device-notice" role="note">
          <WarningIcon size={14} aria-hidden="true" />
          <span>
            <FormattedMessage
              id="composer.handoff.crossDeviceNotice"
              defaultMessage="Execution machine and system environment changed: cross-device handoff only syncs conversation context (including JSONL history), not folders or uncommitted changes, so tasks may not run identically."
            />
          </span>
        </div>
      ) : null}
      {detailsOpen ? (
        <div id={detailsId} className="opencraft-composer-handoff__details" role="region" aria-label={toggleLabel}>
          {(sourceAgentLabel || folderName) ? (
            <div className="opencraft-composer-handoff__meta">
              {sourceAgentLabel ? <span>{sourceAgentLabel}</span> : null}
              {folderName ? (
                <span className="opencraft-composer-handoff__folder" title={workspacePath ?? undefined}>
                  <FolderIcon size={13} aria-hidden="true" />
                  {folderName}
                </span>
              ) : null}
            </div>
          ) : null}
          <p>
            <FormattedMessage
              id="composer.handoff.details"
              defaultMessage="Carries this conversation's history into a new thread. Your current conversation stays unchanged."
            />
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ComposerHandoffSubmitButton({
  canSubmit,
  submitting = false,
  disabled = false,
  blockedReason,
  canContinueInCurrentThread = false,
  portalContainer,
  onSubmit,
  onContinueInCurrentThread,
  onCancel,
}: {
  readonly canSubmit: boolean;
  readonly submitting?: boolean;
  readonly disabled?: boolean;
  readonly blockedReason?: string | null;
  readonly canContinueInCurrentThread?: boolean;
  readonly portalContainer?: HTMLElement | null;
  readonly onSubmit: () => void;
  readonly onContinueInCurrentThread?: () => void;
  readonly onCancel: () => void;
}) {
  const intl = useIntl();
  const newThreadLabel = intl.formatMessage({ id: "composer.handoff.newThread", defaultMessage: "New thread" });
  const optionsLabel = intl.formatMessage({ id: "composer.handoff.options", defaultMessage: "Handoff options" });

  return (
    <SplitButtonGroup
      className="opencraft-composer-handoff-submit"
      aria-label={intl.formatMessage({ id: "composer.handoff.title", defaultMessage: "Handoff to new thread" })}
    >
      <Button
        size="sm"
        variant="primary"
        splitPosition="leading"
        loading={submitting}
        disabled={!canSubmit}
        aria-label={newThreadLabel}
        title={blockedReason ?? newThreadLabel}
        data-composer-primary-action="handoff"
        onMouseDown={event => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={onSubmit}
      >
        <NewMessageIcon size={15} aria-hidden="true" />
        <span className="opencraft-composer-handoff-submit__label">{newThreadLabel}</span>
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            size="sm"
            variant="primary"
            splitPosition="trailing"
            contentLayout="icon"
            disabled={disabled || submitting}
            aria-label={optionsLabel}
            title={optionsLabel}
            onMouseDown={event => {
              if (event.button === 0) event.preventDefault();
            }}
          >
            <ChevronDownIcon size={14} aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer ?? undefined}>
          <DropdownMenu.Content
            className="opencraft-composer-selection-menu opencraft-composer-handoff-menu"
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
          >
            <DropdownMenu.Group className="opencraft-composer-selection-menu__items">
              <DropdownMenu.Item
                className="opencraft-composer-selection-menu__item has-leading"
                data-selected="true"
                disabled={!canSubmit}
                onSelect={() => onSubmit()}
              >
                <NewMessageIcon size={16} aria-hidden="true" />
                <span className="opencraft-composer-selection-menu__copy">
                  <span className="opencraft-composer-selection-menu__label">
                    <FormattedMessage id="composer.handoff.startNewThread" defaultMessage="Start new thread" />
                  </span>
                </span>
                <CheckIcon size={16} aria-hidden="true" />
              </DropdownMenu.Item>
              {canContinueInCurrentThread && onContinueInCurrentThread ? (
                <DropdownMenu.Item
                  className="opencraft-composer-selection-menu__item"
                  onSelect={() => onContinueInCurrentThread()}
                >
                  <span className="opencraft-composer-selection-menu__copy">
                    <span className="opencraft-composer-selection-menu__label">
                      <FormattedMessage id="composer.handoff.continueHere" defaultMessage="Continue in current thread" />
                    </span>
                  </span>
                </DropdownMenu.Item>
              ) : null}
            </DropdownMenu.Group>
            <DropdownMenu.Separator className="opencraft-composer-selection-menu__separator" />
            <DropdownMenu.Group className="opencraft-composer-selection-menu__items">
              <DropdownMenu.Item
                className="opencraft-composer-selection-menu__item has-leading"
                onSelect={() => onCancel()}
              >
                <CloseIcon size={16} aria-hidden="true" />
                <span className="opencraft-composer-selection-menu__copy">
                  <span className="opencraft-composer-selection-menu__label">
                    <FormattedMessage id="composer.handoff.cancel" defaultMessage="Cancel handoff" />
                  </span>
                </span>
              </DropdownMenu.Item>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </SplitButtonGroup>
  );
}

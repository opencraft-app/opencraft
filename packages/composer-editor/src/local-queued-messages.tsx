import { useRef, useState } from "react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { DisclosureButton, IconButton } from "@opencraft/design-system-web/button";
import {
  HistoryIcon,
  RefreshIcon,
  MoreIcon,
  EditIcon,
  CloseIcon,
  CircleIcon,
} from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import type { ComposerQueuedSubmissionPresentation } from "./composer-editor";

/** Submitted client-owned input lives outside the editable Composer surface. */
export function LocalQueuedMessages({
  items,
  canWithdraw,
  onWithdraw,
  onCancel,
  onRetry,
  portalContainer,
}: {
  readonly items: readonly ComposerQueuedSubmissionPresentation[];
  readonly canWithdraw: boolean;
  readonly onWithdraw?: (id: string) => Promise<void>;
  readonly onCancel?: (id: string) => Promise<void>;
  readonly onRetry?: (id: string) => Promise<void>;
  readonly portalContainer?: HTMLElement | null;
}) {
  const intl = useIntl();
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = async (id: string, action: (() => Promise<void>) | undefined) => {
    if (!action || pending.current.has(id)) return;
    pending.current.add(id);
    setBusy(new Set(pending.current));
    try {
      await action();
    } catch {
      /* The host action owns its failure notice. */
    } finally {
      pending.current.delete(id);
      setBusy(new Set(pending.current));
    }
  };
  const more = intl.formatMessage({ id: "chat.outbox.actions", defaultMessage: "Message actions" });
  const withdraw = intl.formatMessage({ id: "chat.outbox.withdraw", defaultMessage: "Move back to input" });
  const keepDraft = intl.formatMessage({
    id: "chat.outbox.keepDraft",
    defaultMessage: "Keep or send the current draft first",
  });
  const cancel = intl.formatMessage({ id: "chat.outbox.cancel", defaultMessage: "Cancel sending" });
  const retry = intl.formatMessage({ id: "chat.queue.retry", defaultMessage: "Retry" });
  return (
    <div
      className="opencraft-local-messages"
      aria-label={intl.formatMessage({ id: "chat.outbox.pending", defaultMessage: "Pending messages" })}
    >
      {items.map((item) => {
        const waiting = item.deliveryState === "local-waiting";
        const failed = item.deliveryState === "local-failed";
        const sending = item.deliveryState === "local-sending";
        const operating = busy.has(item.id);
        return (
          <div
            className="opencraft-local-message"
            key={item.renderKey ?? item.id}
            data-delivery-state={item.deliveryState}
            aria-busy={sending || operating}
          >
            <div className="opencraft-local-message__body">{item.preview}</div>
            <div className="opencraft-local-message__meta">
              <span className="opencraft-local-message__status">
                {failed ? <CircleIcon size={8} aria-hidden="true" /> : <HistoryIcon size={13} aria-hidden="true" />}
                <span>{item.pausedReason}</span>
              </span>
              {failed && onRetry ? (
                <IconButton
                  size="accessory"
                  aria-label={retry}
                  title={retry}
                  disabled={operating}
                  onClick={() => void run(item.id, () => onRetry(item.id))}
                >
                  <RefreshIcon size={14} />
                </IconButton>
              ) : null}
              {(waiting || failed) && (onWithdraw || onCancel) ? (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <DisclosureButton size="accessory" aria-label={more} title={more} disabled={operating}>
                      <MoreIcon size={16} />
                    </DisclosureButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal container={portalContainer}>
                    <DropdownMenu.Content
                      className="opencraft-composer-selection-menu opencraft-composer-add-menu"
                      align="end"
                      sideOffset={4}
                      collisionPadding={8}
                    >
                      {onWithdraw ? (
                        <DropdownMenu.Item
                          className="opencraft-composer-selection-menu__item opencraft-composer-add-menu__item"
                          disabled={!canWithdraw || operating}
                          title={!canWithdraw ? keepDraft : undefined}
                          onSelect={() => void run(item.id, () => onWithdraw(item.id))}
                        >
                          <EditIcon size={15} />
                          <span>{withdraw}</span>
                        </DropdownMenu.Item>
                      ) : null}
                      {onCancel ? (
                        <DropdownMenu.Item
                          className="opencraft-composer-selection-menu__item opencraft-composer-add-menu__item"
                          disabled={operating}
                          onSelect={() => void run(item.id, () => onCancel(item.id))}
                        >
                          <CloseIcon size={15} />
                          <span>{cancel}</span>
                        </DropdownMenu.Item>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

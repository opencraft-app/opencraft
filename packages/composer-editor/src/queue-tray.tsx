import { EditIcon as Pencil, DeleteIcon as Trash2, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { AvatarImage } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import React, { useState } from "react";
import { AlertIcon as CircleAlert, TurnRightIcon as CornerDownRight, GripIcon as GripVertical, PlayIcon as Play, PersonIcon as User } from "@opencraft/design-system-web/action-icons";

/** Display-only author resolved by the host; the Composer owns no directory policy. */
export interface ComposerQueueSender {
  readonly name: string;
  readonly avatarUrl: string | null;
}

export interface ComposerQueueTrayItem {
  readonly sender?: ComposerQueueSender | null;
  /** Stable message identity across local admission and the server queue ID. */
  readonly renderKey?: string;
  readonly id: string;
  readonly preview: string;
  readonly state: "submitting" | "queued" | "failed" | "unknown";
  readonly operation: "idle" | "updating" | "deleting" | "starting";
  readonly actionable: boolean;
  readonly dismissible?: boolean;
  readonly reorderable?: boolean;
  readonly editing: boolean;
  readonly pausedReason?: string | null;
  readonly error?: string | null;
  readonly unconfirmedTargetTurnId?: string;
}

export interface ComposerQueueTrayProps {
  readonly items: readonly ComposerQueueTrayItem[];
  readonly isResponseInProgress: boolean;
  readonly atomicSteer?: boolean;
  readonly onEdit?: (id: string) => void;
  readonly onCancelEdit?: () => void;
  readonly onDelete?: (id: string) => Promise<void>;
  readonly onDiscardUnconfirmed?: (id: string, expectedTurnId: string) => Promise<void>;
  readonly onReorder?: (ids: readonly string[]) => Promise<void>;
  readonly onSteer?: (id: string) => Promise<void>;
  readonly onResume?: () => Promise<void>;
  readonly portalContainer?: HTMLElement | null;
}

/** The shortcut and row button must respect the same queue admission state. */
export function canSteerQueueItem(
  item: Pick<ComposerQueueTrayItem, "actionable" | "operation" | "pausedReason">,
  isResponseInProgress: boolean,
  atomicSteer: boolean,
  blockedByUnconfirmedDelivery: boolean,
): boolean {
  return item.actionable && item.operation === "idle"
    && item.pausedReason !== "restored-after-host-restart"
    && !blockedByUnconfirmedDelivery
    && (!isResponseInProgress || atomicSteer);
}

function ignoreRejected(operation: Promise<void> | undefined): void {
  void operation?.catch(() => undefined);
}

function QueueTooltip({ children, label, portalContainer, disabled = false }: {
  readonly children: React.ReactElement;
  readonly label: string;
  readonly portalContainer?: HTMLElement | null;
  readonly disabled?: boolean;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {disabled ? (
          <span
            className="opencraft-composer-queue-action-trigger"
            tabIndex={0}
            role="group"
            aria-disabled="true"
            aria-label={label}
          >{children}</span>
        ) : children}
      </Tooltip.Trigger>
      <Tooltip.Portal container={portalContainer ?? undefined}>
        <Tooltip.Content className="opencraft-composer-queue-action-tooltip" side="top" sideOffset={8} collisionPadding={8}>
          {label}
          <Tooltip.Arrow className="opencraft-composer-queue-action-tooltip__arrow" width={10} height={6} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function SortableQueueItem({
  item,
  isResponseInProgress,
  atomicSteer,
  blockedByUnconfirmedDelivery,
  portalContainer,
  onEdit,
  onCancelEdit,
  onDelete,
  onDiscardUnconfirmed,
  onSteer,
}: {
  readonly item: ComposerQueueTrayItem;
  readonly isResponseInProgress: boolean;
  readonly atomicSteer: boolean;
  readonly blockedByUnconfirmedDelivery: boolean;
  readonly portalContainer?: HTMLElement | null;
  readonly onEdit?: ComposerQueueTrayProps["onEdit"];
  readonly onCancelEdit?: ComposerQueueTrayProps["onCancelEdit"];
  readonly onDelete?: ComposerQueueTrayProps["onDelete"];
  readonly onDiscardUnconfirmed?: ComposerQueueTrayProps["onDiscardUnconfirmed"];
  readonly onSteer?: ComposerQueueTrayProps["onSteer"];
}) {
  const intl = useIntl();
  const steerLabel = intl.formatMessage({ id: "chat.queue.steer", defaultMessage: "Steer with queued message" });
  const reorderLabel = intl.formatMessage({ id: "chat.queue.reorder", defaultMessage: "Reorder queued message" });
  const cancelEditLabel = intl.formatMessage({ id: "chat.queue.cancelEdit", defaultMessage: "Cancel editing queued message" });
  const editLabel = intl.formatMessage({ id: "chat.queue.edit", defaultMessage: "Edit queued message" });
  const deleteLabel = intl.formatMessage({ id: "chat.queue.delete", defaultMessage: "Delete queued message" });
  const busy = item.operation !== "idle";
  const awaitingNativeReconciliation = item.pausedReason === "restored-after-host-restart";
  const dragDisabled = blockedByUnconfirmedDelivery || item.reorderable === false || !item.actionable || busy || item.editing;
  const dragTooltip = item.reorderable === false ? item.error ?? item.pausedReason ?? intl.formatMessage({ id: "chat.queue.message", defaultMessage: "Queued message" }) : reorderLabel;
  const steerDisabled = !canSteerQueueItem(item, isResponseInProgress, atomicSteer, blockedByUnconfirmedDelivery);
  const deleteDisabled = (!item.actionable && !item.dismissible) || busy;
  const steerTooltip = blockedByUnconfirmedDelivery
    ? intl.formatMessage({ id: "chat.queue.blockedUnconfirmed", defaultMessage: "An earlier message has unconfirmed delivery; review it before sending another message" })
    : awaitingNativeReconciliation
      ? intl.formatMessage({ id: "chat.queue.awaitingReconciliation", defaultMessage: "This queued message is awaiting native reconciliation before it can be sent" })
      : isResponseInProgress && !atomicSteer
        ? intl.formatMessage({ id: "chat.queue.awaitingTurn", defaultMessage: "This Host cannot steer a queued message; it will remain queued until the turn finishes" })
        : isResponseInProgress ? steerLabel : intl.formatMessage({ id: "chat.queue.start", defaultMessage: "Start queued message" });
  const sortable = useSortable({
    id: item.id,
    disabled: dragDisabled,
  });

  return (
    <div
      ref={sortable.setNodeRef}
      className="opencraft-composer-queue-item"
      data-state={item.state}
      data-operation={item.operation}
      data-editing={item.editing ? "true" : undefined}
      data-dragging={sortable.isDragging ? "true" : undefined}
      aria-busy={item.state === "submitting" || busy}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <QueueTooltip label={dragTooltip} portalContainer={portalContainer} disabled={dragDisabled}>
        <button
          ref={sortable.setActivatorNodeRef}
          className="opencraft-composer-queue-item__drag"
          type="button"
          aria-label={item.reorderable === false ? intl.formatMessage({ id: "chat.queue.message", defaultMessage: "Queued message" }) : reorderLabel}
          disabled={dragDisabled}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          {item.reorderable === false ? null : <GripVertical className="opencraft-composer-queue-item__grip" size={12} aria-hidden="true" />}
        </button>
      </QueueTooltip>

      <QueueTooltip label={item.sender?.name ?? intl.formatMessage({ id: "chat.queue.message", defaultMessage: "Queued message" })} portalContainer={portalContainer}>
        <span className="opencraft-composer-queue-item__sender">
          <span className="opencraft-composer-queue-item__avatar" role={item.sender ? "img" : undefined} aria-label={item.sender?.name} aria-hidden={item.sender ? undefined : true}>
            <AvatarImage src={item.sender?.avatarUrl ?? null} fallback={<User size={13} aria-hidden="true" />} />
          </span>
          {item.state === "failed" || item.state === "unknown" || item.pausedReason ? (
            <CircleAlert className="opencraft-composer-queue-item__status" size={11} aria-hidden="true" />
          ) : null}
        </span>
      </QueueTooltip>

      <QueueTooltip label={item.error ?? item.pausedReason ?? item.preview} portalContainer={portalContainer}>
        <span className="opencraft-composer-queue-item__preview" tabIndex={0}>{item.preview}</span>
      </QueueTooltip>

      <div className="opencraft-composer-queue-item__actions">
        {item.unconfirmedTargetTurnId ? (
          <QueueTooltip label={intl.formatMessage({ id: "chat.queue.reviewDiscard", defaultMessage: "Review & discard" })} portalContainer={portalContainer}>
            <button type="button" className="is-labelled" onClick={() => ignoreRejected(onDiscardUnconfirmed?.(item.id, item.unconfirmedTargetTurnId!))}>
              <Trash2 size={12} /><span>{intl.formatMessage({ id: "chat.queue.reviewDiscard", defaultMessage: "Review & discard" })}</span>
            </button>
          </QueueTooltip>
        ) : item.editing ? (
          <QueueTooltip label={cancelEditLabel} portalContainer={portalContainer}>
            <button type="button" aria-label={cancelEditLabel} onClick={onCancelEdit}>
              <X size={12} />
            </button>
          </QueueTooltip>
        ) : (
          <>
            <QueueTooltip label={steerTooltip} portalContainer={portalContainer} disabled={steerDisabled}>
              <button
                className={isResponseInProgress ? "is-labelled is-steer" : "is-labelled"}
                type="button"
                aria-label={isResponseInProgress ? steerLabel : intl.formatMessage({ id: "chat.queue.start", defaultMessage: "Start queued message" })}
                disabled={steerDisabled}
                onClick={() => ignoreRejected(onSteer?.(item.id))}
              >
                {isResponseInProgress ? <CornerDownRight size={12} /> : <Play size={12} />}
                <span>{isResponseInProgress ? intl.formatMessage({ id: "chat.queue.steerAction", defaultMessage: "Steer" }) : intl.formatMessage({ id: "chat.queue.sendAction", defaultMessage: "Send" })}</span>
              </button>
            </QueueTooltip>
            <QueueTooltip label={editLabel} portalContainer={portalContainer} disabled={!item.actionable || busy}>
              <button type="button" aria-label={editLabel} disabled={!item.actionable || busy} onClick={() => onEdit?.(item.id)}>
                <Pencil size={12} />
              </button>
            </QueueTooltip>
            <QueueTooltip label={deleteLabel} portalContainer={portalContainer} disabled={deleteDisabled}>
              <button type="button" aria-label={deleteLabel} disabled={deleteDisabled} onClick={() => ignoreRejected(onDelete?.(item.id))}>
                <Trash2 size={12} />
              </button>
            </QueueTooltip>
          </>
        )}
      </div>
    </div>
  );
}

export function ComposerQueueTray({
  items,
  isResponseInProgress,
  atomicSteer = false,
  onEdit,
  onCancelEdit,
  onDelete,
  onDiscardUnconfirmed,
  onReorder,
  onSteer,
  onResume,
  portalContainer,
}: ComposerQueueTrayProps) {
  const intl = useIntl();
  const [discardCandidate, setDiscardCandidate] = useState<{ id: string; turnId: string } | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const sortableIds = items.map((item) => item.id);
  const reorderableIds = items.filter((item) => !item.unconfirmedTargetTurnId).map((item) => item.id);
  const pausedReason = items.find((item) => !item.unconfirmedTargetTurnId && item.pausedReason)?.pausedReason ?? null;
  const hasUnconfirmedDelivery = items.some((item) => item.unconfirmedTargetTurnId !== undefined);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (hasUnconfirmedDelivery) return;
    if (over === null || active.id === over.id) return;
    const from = reorderableIds.indexOf(String(active.id));
    const to = reorderableIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    ignoreRejected(onReorder?.(arrayMove(reorderableIds, from, to)));
  };

  if (items.length === 0) return null;
  return (
    <>
    <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
    <div
      className="opencraft-composer-queue-tray"
      data-queue-size={items.length}
      aria-label={intl.formatMessage({ id: "chat.queue.followUps", defaultMessage: "Queued follow-ups" })}
    >
      {pausedReason !== null ? (
        <div className="opencraft-composer-queue-tray__heading">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{pausedReason}</span>
          {hasUnconfirmedDelivery || !items.some(item => item.actionable && item.pausedReason) ? null : (
            <button
              className="opencraft-composer-queue-tray__resume"
              type="button"
              onClick={() => ignoreRejected(onResume?.())}
            >
              <Play size={11} /> {intl.formatMessage({ id: "chat.queue.resume", defaultMessage: "Resume" })}
            </button>
          )}
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className="opencraft-composer-queue-tray__items">
            {items.map((item) => (
          <SortableQueueItem
                key={item.renderKey ?? item.id}
                item={item}
                isResponseInProgress={isResponseInProgress}
                atomicSteer={atomicSteer}
                blockedByUnconfirmedDelivery={hasUnconfirmedDelivery}
                portalContainer={portalContainer}
            onDelete={onDelete}
            onDiscardUnconfirmed={(id, expectedTurnId) => {
              setDiscardError(null);
              setDiscardCandidate({ id, turnId: expectedTurnId });
              return Promise.resolve();
            }}
                onSteer={onSteer}
                onEdit={onEdit}
                onCancelEdit={onCancelEdit}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
    </Tooltip.Provider>
    <AlertDialog.Root open={discardCandidate !== null} onOpenChange={(open) => { if (!open && !discardBusy) { setDiscardCandidate(null); setDiscardError(null); } }}>
      <AlertDialog.Portal container={portalContainer ?? undefined}>
        <AlertDialog.Overlay className="modal-surface__scrim" data-layer="confirmation" data-appearance="utility" />
        <AlertDialog.Content className="modal-surface modal-confirmation opencraft-composer-steer-discard-dialog" data-size="compact" data-layer="confirmation" data-appearance="utility">
          <div className="opencraft-composer-steer-discard-dialog__body">
            <AlertDialog.Title>{intl.formatMessage({ id: "chat.queue.discardTitle", defaultMessage: "Discard message with unconfirmed delivery?" })}</AlertDialog.Title>
            <AlertDialog.Description>{intl.formatMessage({ id: "chat.queue.discardDescription", defaultMessage: "Delivery may already have happened. Review the conversation before discarding. This only removes the unresolved claim; it will not resend the message." })}</AlertDialog.Description>
            {discardError ? <p role="alert">{discardError}</p> : null}
          </div>
          <div className="modal-confirmation__actions">
            <AlertDialog.Cancel className="ui-button" data-variant="secondary" data-size="sm" disabled={discardBusy}>{intl.formatMessage({ id: "chat.queue.cancelDiscard", defaultMessage: "Cancel" })}</AlertDialog.Cancel>
            <button className="ui-button" data-variant="primary" data-size="sm" type="button" disabled={discardBusy} onClick={() => {
              if (discardCandidate === null) return;
              setDiscardBusy(true);
              void (onDiscardUnconfirmed?.(discardCandidate.id, discardCandidate.turnId) ?? Promise.reject(new Error(intl.formatMessage({ id: "chat.queue.discardUnavailable", defaultMessage: "Discard is unavailable on this Host" }))))
                .then(() => { setDiscardCandidate(null); setDiscardError(null); })
                .catch((error: unknown) => setDiscardError(error instanceof Error ? error.message : String(error)))
                .finally(() => setDiscardBusy(false));
            }}>{discardBusy ? intl.formatMessage({ id: "chat.queue.discarding", defaultMessage: "Discarding…" }) : intl.formatMessage({ id: "chat.queue.discard", defaultMessage: "Discard claim" })}</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    </>
  );
}

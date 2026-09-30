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
import React, { useState } from "react";
import {
  CircleAlert,
  CornerDownRight,
  GripVertical,
  Pencil,
  Play,
  Trash2,
  X,
} from "lucide-react";

export interface ComposerQueueTrayItem {
  readonly id: string;
  readonly preview: string;
  readonly state: "submitting" | "queued" | "failed";
  readonly operation: "idle" | "updating" | "deleting" | "starting";
  readonly actionable: boolean;
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

function ignoreRejected(operation: Promise<void> | undefined): void {
  void operation?.catch(() => undefined);
}

function SortableQueueItem({
  item,
  isResponseInProgress,
  atomicSteer,
  blockedByUnconfirmedDelivery,
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
  readonly onEdit?: ComposerQueueTrayProps["onEdit"];
  readonly onCancelEdit?: ComposerQueueTrayProps["onCancelEdit"];
  readonly onDelete?: ComposerQueueTrayProps["onDelete"];
  readonly onDiscardUnconfirmed?: ComposerQueueTrayProps["onDiscardUnconfirmed"];
  readonly onSteer?: ComposerQueueTrayProps["onSteer"];
}) {
  const intl = useIntl();
  const steerLabel = intl.formatMessage({ id: "chat.queue.steer", defaultMessage: "Steer with queued message" });
  const busy = item.operation !== "idle";
  const awaitingNativeReconciliation = item.pausedReason === "restored-after-host-restart";
  const sortable = useSortable({
    id: item.id,
    disabled:
      blockedByUnconfirmedDelivery || item.reorderable === false || !item.actionable || busy || item.editing,
  });

  return (
    <div
      ref={sortable.setNodeRef}
      className="codex-composer-queue-item"
      data-state={item.state}
      data-operation={item.operation}
      data-editing={item.editing ? "true" : undefined}
      data-dragging={sortable.isDragging ? "true" : undefined}
      aria-busy={item.state === "submitting" || busy}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      title={item.error ?? item.pausedReason ?? item.preview}
    >
      <button
        ref={sortable.setActivatorNodeRef}
        className="codex-composer-queue-item__drag"
        type="button"
        aria-label={item.reorderable === false ? "Queued message" : "Reorder queued message"}
        disabled={blockedByUnconfirmedDelivery || item.reorderable === false || !item.actionable || busy || item.editing}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        {item.state === "failed" || item.pausedReason ? (
          <CircleAlert size={12} aria-hidden="true" />
        ) : (
          <>
            {item.reorderable === false ? null : (
              <GripVertical
                className="codex-composer-queue-item__grip"
                size={12}
                aria-hidden="true"
              />
            )}
            <CornerDownRight
              className="codex-composer-queue-item__message-icon"
              size={13}
              aria-hidden="true"
            />
          </>
        )}
      </button>

      <span className="codex-composer-queue-item__preview">{item.preview}</span>

      <div className="codex-composer-queue-item__actions">
        {item.unconfirmedTargetTurnId ? (
          <button type="button" className="is-labelled" onClick={() => ignoreRejected(onDiscardUnconfirmed?.(item.id, item.unconfirmedTargetTurnId!))}>
            <Trash2 size={12} /><span>Review &amp; discard</span>
          </button>
        ) : item.editing ? (
          <button
            type="button"
            aria-label="Cancel editing queued message"
            onClick={onCancelEdit}
          >
            <X size={12} />
          </button>
        ) : (
          <>
            <button
              className={isResponseInProgress ? "is-labelled is-steer" : "is-labelled"}
              type="button"
              aria-label={
                isResponseInProgress
                  ? steerLabel
                  : "Start queued message"
              }
              disabled={!item.actionable || busy || awaitingNativeReconciliation || blockedByUnconfirmedDelivery || (isResponseInProgress && !atomicSteer)}
              title={blockedByUnconfirmedDelivery
                ? "An earlier message has unconfirmed delivery; review it before sending another message"
                : awaitingNativeReconciliation
                ? "This queued message is awaiting native reconciliation before it can be sent"
                : isResponseInProgress && !atomicSteer
                  ? "This Host cannot steer a queued message; it will remain queued until the turn finishes"
                  : isResponseInProgress ? steerLabel : "Start queued message"}
              onClick={() => ignoreRejected(onSteer?.(item.id))}
            >
              {isResponseInProgress ? (
                <CornerDownRight size={12} />
              ) : (
                <Play size={12} />
              )}
              <span>{isResponseInProgress ? "Steer" : "Send"}</span>
            </button>
            <button
              type="button"
              aria-label="Edit queued message"
              disabled={!item.actionable || busy}
              onClick={() => onEdit?.(item.id)}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              aria-label="Delete queued message"
              disabled={!item.actionable || busy}
              onClick={() => ignoreRejected(onDelete?.(item.id))}
            >
              <Trash2 size={12} />
            </button>
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
    <div
      className="codex-composer-queue-tray"
      data-queue-size={items.length}
      aria-label="Queued follow-ups"
    >
      {pausedReason !== null ? (
        <div className="codex-composer-queue-tray__heading">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{pausedReason}</span>
          {hasUnconfirmedDelivery ? null : (
            <button
              className="codex-composer-queue-tray__resume"
              type="button"
              onClick={() => ignoreRejected(onResume?.())}
            >
              <Play size={11} /> Resume
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
          <div className="codex-composer-queue-tray__items">
            {items.map((item) => (
          <SortableQueueItem
                key={item.id}
                item={item}
                isResponseInProgress={isResponseInProgress}
                atomicSteer={atomicSteer}
                blockedByUnconfirmedDelivery={hasUnconfirmedDelivery}
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
    <AlertDialog.Root open={discardCandidate !== null} onOpenChange={(open) => { if (!open && !discardBusy) { setDiscardCandidate(null); setDiscardError(null); } }}>
      <AlertDialog.Portal container={portalContainer ?? undefined}>
        <AlertDialog.Overlay className="modal-surface__scrim" data-layer="confirmation" data-appearance="utility" />
        <AlertDialog.Content className="modal-surface modal-confirmation codex-composer-steer-discard-dialog" data-size="compact" data-layer="confirmation" data-appearance="utility">
          <div className="codex-composer-steer-discard-dialog__body">
            <AlertDialog.Title>Discard message with unconfirmed delivery?</AlertDialog.Title>
            <AlertDialog.Description>Delivery may already have happened. Review the conversation before discarding. This only removes the unresolved claim; it will not resend the message.</AlertDialog.Description>
            {discardError ? <p role="alert">{discardError}</p> : null}
          </div>
          <div className="modal-confirmation__actions">
            <AlertDialog.Cancel className="ui-button" data-variant="secondary" data-size="sm" disabled={discardBusy}>Cancel</AlertDialog.Cancel>
            <button className="ui-button" data-variant="primary" data-size="sm" type="button" disabled={discardBusy} onClick={() => {
              if (discardCandidate === null) return;
              setDiscardBusy(true);
              void (onDiscardUnconfirmed?.(discardCandidate.id, discardCandidate.turnId) ?? Promise.reject(new Error("Discard is unavailable on this Host")))
                .then(() => { setDiscardCandidate(null); setDiscardError(null); })
                .catch((error: unknown) => setDiscardError(error instanceof Error ? error.message : String(error)))
                .finally(() => setDiscardBusy(false));
            }}>{discardBusy ? "Discarding…" : "Discard claim"}</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    </>
  );
}

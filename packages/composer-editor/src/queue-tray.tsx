import { ChatDocumentCompiler, chatDocumentPlainText } from "@opencraft/chat-document";
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
import * as Tooltip from "@radix-ui/react-tooltip";
import React, { lazy, Suspense, useMemo, useRef, useState } from "react";

const WebUserMessageDocument = lazy(() => import("@opencraft/chat-render-web").then(module => ({ default: module.WebUserMessageDocument })));
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
  readonly steerable?: boolean;
  readonly dismissible?: boolean;
  readonly reorderable?: boolean;
  readonly editing: boolean;
  /** Automatic recovery waits do not require a manual Resume action. */
  readonly resumable?: boolean;
  readonly pausedReason?: string | null;
  readonly error?: string | null;
  readonly unconfirmedTargetTurnId?: string;
  readonly retryable?: boolean;
}

export interface ComposerQueueTrayProps {
  readonly items: readonly ComposerQueueTrayItem[];
  readonly isResponseInProgress: boolean;
  readonly atomicSteer?: boolean;
  readonly onEdit?: (id: string) => void;
  readonly onCancelEdit?: () => void;
  readonly onDelete?: (id: string) => Promise<void>;
  readonly onRetryUnconfirmed?: (id: string, expectedTurnId: string) => Promise<void>;
  readonly onReorder?: (ids: readonly string[]) => Promise<void>;
  readonly onSteer?: (id: string) => Promise<void>;
  readonly onResume?: () => Promise<void>;
  readonly portalContainer?: HTMLElement | null;
}

/** The shortcut and row button must respect the same queue admission state. */
export function canSteerQueueItem(
  item: Pick<ComposerQueueTrayItem, "actionable" | "steerable" | "operation" | "pausedReason">,
  isResponseInProgress: boolean,
  atomicSteer: boolean,
): boolean {
  return (item.steerable ?? item.actionable) && item.operation === "idle"
    && item.pausedReason !== "restored-after-host-restart"
    && (!isResponseInProgress || atomicSteer);
}

function ignoreRejected(operation: Promise<void> | undefined): void {
  void operation?.catch(() => undefined);
}

function QueueTooltip({ children, label, content, portalContainer, disabled = false, tapToOpen = false }: {
  readonly children: React.ReactElement;
  readonly label: string;
  readonly content?: React.ReactNode;
  readonly portalContainer?: HTMLElement | null;
  readonly disabled?: boolean;
  readonly tapToOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pointerStartedOpen = useRef(false);
  return (
    <Tooltip.Root open={tapToOpen ? open : undefined} onOpenChange={tapToOpen ? setOpen : undefined}>
      <Tooltip.Trigger asChild aria-expanded={tapToOpen ? open : undefined}
        onPointerDown={tapToOpen ? () => { pointerStartedOpen.current = open; } : undefined}
        onPointerLeave={tapToOpen ? event => { if (event.pointerType === "touch") event.preventDefault(); } : undefined}
        onClick={tapToOpen ? event => {
          // Radix normally dismisses a tooltip on click. Message previews also
          // support deliberate activation; capture before its pointer-down close.
          event.preventDefault();
          setOpen(event.detail === 0 ? !open : !pointerStartedOpen.current);
        } : undefined}>
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
          {tapToOpen ? <div className="opencraft-composer-queue-message-text" style={{ maxHeight: "min(50dvh, calc(var(--radix-tooltip-content-available-height, 50dvh) - 24px))", overflowY: "auto", overscrollBehavior: "contain", whiteSpace: content ? "normal" : "pre-wrap" }}>{content ?? label}</div> : label}
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
  portalContainer,
  onEdit,
  onCancelEdit,
  onDelete,
  onRetryUnconfirmed,
  onSteer,
}: {
  readonly item: ComposerQueueTrayItem;
  readonly isResponseInProgress: boolean;
  readonly atomicSteer: boolean;
  readonly portalContainer?: HTMLElement | null;
  readonly onEdit?: ComposerQueueTrayProps["onEdit"];
  readonly onCancelEdit?: ComposerQueueTrayProps["onCancelEdit"];
  readonly onDelete?: ComposerQueueTrayProps["onDelete"];
  readonly onRetryUnconfirmed?: ComposerQueueTrayProps["onRetryUnconfirmed"];
  readonly onSteer?: ComposerQueueTrayProps["onSteer"];
}) {
  const intl = useIntl();
  const plainPreview = useMemo(() => chatDocumentPlainText(new ChatDocumentCompiler().compile(item.preview, { dialect: "user-message" }).nodes).replace(/\s+/gu, " ").trim(), [item.preview]);
  const steerLabel = intl.formatMessage({ id: "chat.queue.steer", defaultMessage: "Steer with queued message" });
  const reorderLabel = intl.formatMessage({ id: "chat.queue.reorder", defaultMessage: "Reorder queued message" });
  const cancelEditLabel = intl.formatMessage({ id: "chat.queue.cancelEdit", defaultMessage: "Cancel editing queued message" });
  const editLabel = intl.formatMessage({ id: "chat.queue.edit", defaultMessage: "Edit queued message" });
  const deleteLabel = intl.formatMessage({ id: "chat.queue.delete", defaultMessage: "Delete queued message" });
  const retryOwner = useRef({ id: item.id, turnId: item.unconfirmedTargetTurnId, pending: false });
  if (retryOwner.current.id !== item.id || retryOwner.current.turnId !== item.unconfirmedTargetTurnId) {
    retryOwner.current = { id: item.id, turnId: item.unconfirmedTargetTurnId, pending: false };
  }
  const [retryState, setRetryState] = useState<{ owner: typeof retryOwner.current; busy: boolean; failed: boolean } | null>(null);
  const retryBusy = retryState?.owner === retryOwner.current && retryState.busy;
  const retryFailed = retryState?.owner === retryOwner.current && retryState.failed;
  const busy = item.operation !== "idle" || retryBusy;
  const retryLabel = intl.formatMessage({ id: "chat.queue.retry", defaultMessage: "Retry" });
  const retryStatus = busy
    ? intl.formatMessage({ id: "chat.queue.retrying", defaultMessage: "Retrying…" })
    : retryFailed ? intl.formatMessage({ id: "chat.queue.retryFailed", defaultMessage: "Could not retry" })
    : intl.formatMessage({ id: "chat.queue.deliveryUnconfirmed", defaultMessage: "Delivery unconfirmed" });
  const awaitingNativeReconciliation = item.pausedReason === "restored-after-host-restart";
  const dragDisabled = item.reorderable === false || !item.actionable || busy || item.editing;
  const dragTooltip = item.reorderable === false ? item.error ?? item.pausedReason ?? intl.formatMessage({ id: "chat.queue.message", defaultMessage: "Queued message" }) : reorderLabel;
  const steerDisabled = !canSteerQueueItem(item, isResponseInProgress, atomicSteer);
  const deleteDisabled = (!item.actionable && !item.dismissible) || busy;
  const steerTooltip = awaitingNativeReconciliation
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

      <QueueTooltip label={[plainPreview, item.error ?? item.pausedReason].filter(Boolean).join("\n\n")} content={<>
        <Suspense fallback={item.preview}><WebUserMessageDocument documentId={`queue-preview:${item.id}`} source={item.preview} allowWideBlocks={false} /></Suspense>
        {item.error ?? item.pausedReason ? <p>{item.error ?? item.pausedReason}</p> : null}
      </>} portalContainer={portalContainer} tapToOpen>
        <button type="button" aria-label={plainPreview || intl.formatMessage({ id: "chat.queue.message", defaultMessage: "Queued message" })} className="opencraft-composer-queue-item__preview-trigger" style={{ width: "100%", minWidth: 0, maxWidth: "100%", textAlign: "left" }}><span className="opencraft-composer-queue-item__preview">{plainPreview}</span></button>
      </QueueTooltip>

      <div className="opencraft-composer-queue-item__actions">
        {item.unconfirmedTargetTurnId ? (
          <>
            <span className="opencraft-composer-queue-item__delivery-status" role="status">{retryStatus}</span>
            {item.retryable !== false && onRetryUnconfirmed ? <button type="button" className="is-labelled is-retry" disabled={busy || !onRetryUnconfirmed}
              onClick={() => {
                const owner = retryOwner.current;
                if (owner.pending || !onRetryUnconfirmed || !owner.turnId) return;
                owner.pending = true;
                setRetryState({ owner, busy: true, failed: false });
                void Promise.resolve().then(() => onRetryUnconfirmed(item.id, owner.turnId!))
                  .then(() => {
                    if (retryOwner.current === owner) setRetryState({ owner, busy: false, failed: false });
                  }, () => {
                    if (retryOwner.current === owner) setRetryState({ owner, busy: false, failed: true });
                  })
                  .finally(() => { owner.pending = false; });
              }}>{retryLabel}</button> : null}
          </>
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
  onRetryUnconfirmed,
  onReorder,
  onSteer,
  onResume,
  portalContainer,
}: ComposerQueueTrayProps) {
  const intl = useIntl();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const sortableIds = items.map((item) => item.id);
  const reorderableIds = items.filter((item) => !item.unconfirmedTargetTurnId).map((item) => item.id);
  const pausedReason = items.find((item) => !item.unconfirmedTargetTurnId && item.pausedReason)?.pausedReason ?? null;

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = reorderableIds.indexOf(String(active.id));
    const to = reorderableIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    ignoreRejected(onReorder?.(arrayMove(reorderableIds, from, to)));
  };

  if (items.length === 0) return null;
  return (
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
          {!items.some(item => item.actionable && item.pausedReason && item.resumable !== false) ? null : (
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
                portalContainer={portalContainer}
                onDelete={onDelete}
                onRetryUnconfirmed={onRetryUnconfirmed}
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
  );
}

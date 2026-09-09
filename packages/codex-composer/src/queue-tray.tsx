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
import React from "react";
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
  readonly error?: string | null;
}

export interface ComposerQueueTrayProps {
  readonly items: readonly ComposerQueueTrayItem[];
  readonly pausedReason: "interrupted" | null;
  readonly isResponseInProgress: boolean;
  readonly onEdit?: (id: string) => void;
  readonly onCancelEdit?: () => void;
  readonly onDelete?: (id: string) => Promise<void>;
  readonly onReorder?: (ids: readonly string[]) => Promise<void>;
  readonly onSteer?: (id: string) => Promise<void>;
  readonly onResume?: () => Promise<void>;
}

function ignoreRejected(operation: Promise<void> | undefined): void {
  void operation?.catch(() => undefined);
}

function SortableQueueItem({
  item,
  isResponseInProgress,
  onEdit,
  onCancelEdit,
  onDelete,
  onSteer,
}: {
  readonly item: ComposerQueueTrayItem;
  readonly isResponseInProgress: boolean;
  readonly onEdit?: ComposerQueueTrayProps["onEdit"];
  readonly onCancelEdit?: ComposerQueueTrayProps["onCancelEdit"];
  readonly onDelete?: ComposerQueueTrayProps["onDelete"];
  readonly onSteer?: ComposerQueueTrayProps["onSteer"];
}) {
  const busy = item.operation !== "idle";
  const sortable = useSortable({
    id: item.id,
    disabled:
      item.reorderable === false || !item.actionable || busy || item.editing,
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
      title={item.error ?? item.preview}
    >
      <button
        ref={sortable.setActivatorNodeRef}
        className="codex-composer-queue-item__drag"
        type="button"
        aria-label={item.reorderable === false ? "Queued message" : "Reorder queued message"}
        disabled={item.reorderable === false || !item.actionable || busy || item.editing}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        {item.state === "failed" ? (
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
        {item.editing ? (
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
              className="is-labelled"
              type="button"
              aria-label={
                isResponseInProgress
                  ? "Steer with queued message"
                  : "Start queued message"
              }
              disabled={!item.actionable || busy}
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
  pausedReason,
  isResponseInProgress,
  onEdit,
  onCancelEdit,
  onDelete,
  onReorder,
  onSteer,
  onResume,
}: ComposerQueueTrayProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const ids = items.map((item) => item.id);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    ignoreRejected(onReorder?.(arrayMove(ids, from, to)));
  };

  if (items.length === 0) return null;
  return (
    <div
      className="codex-composer-queue-tray"
      data-queue-size={items.length}
      aria-label="Queued follow-ups"
    >
      {pausedReason === "interrupted" ? (
        <div className="codex-composer-queue-tray__heading">
          <CircleAlert size={13} aria-hidden="true" />
          <span>Queue paused because you interrupted</span>
          <button
            className="codex-composer-queue-tray__resume"
            type="button"
            onClick={() => ignoreRejected(onResume?.())}
          >
            <Play size={11} /> Resume
          </button>
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="codex-composer-queue-tray__items">
            {items.map((item) => (
              <SortableQueueItem
                key={item.id}
                item={item}
                isResponseInProgress={isResponseInProgress}
                onDelete={onDelete}
                onSteer={onSteer}
                onEdit={onEdit}
                onCancelEdit={onCancelEdit}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

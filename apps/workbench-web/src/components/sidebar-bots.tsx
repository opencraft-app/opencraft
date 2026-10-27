import { LoadingRingIcon as LoaderCircle, AddIcon as Plus, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { NativeSelect } from "@opencraft/design-system-web/native-controls";
import { useIntl } from "@opencraft/i18n/react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  defaultDropAnimationSideEffects,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  SidebarDragTransaction,
  type SidebarDropIntent,
  type SidebarEntity,
  type SidebarEntityAvatar,
  type SidebarEntityCreationCommand,
  type SidebarEntityKey,
  type SidebarLayoutStore,
} from "@opencraft/sidebar-layout";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AgentIcon as Bot } from "@opencraft/design-system-web/action-icons";
import {
  useCallback,
  createContext,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import "../styles/sidebar-bots.scss";

const PIN_ZONE = "sidebar-bots:pin-zone";
const LIST_ZONE = "sidebar-bots:list-zone";
const MOTION = { type: "spring", mass: 1, stiffness: 1000, damping: 63 } as const;
const REDUCED_MOTION = { duration: 0 } as const;
const DROP_DURATION_MS = 300;
const DROP_EASING = "cubic-bezier(0.25, 1.15, 0.4, 1)";

interface RectSnapshot {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface PinSlotSnapshot {
  readonly key: SidebarEntityKey;
  readonly rect: RectSnapshot;
}

interface RowGlide {
  readonly key: SidebarEntityKey;
  readonly x: number;
  readonly y: number;
  readonly nonce: number;
}

function rectSnapshot(rect: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">): RectSnapshot {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** Resolve a slot's durable layout box without sampling a transient Framer transform. */
function stablePinSlotRect(element: HTMLElement): RectSnapshot {
  let left = 0;
  let top = 0;
  let current: HTMLElement | null = element;
  while (current !== null && current.dataset.sidebarPinGrid !== "true") {
    left += current.offsetLeft;
    top += current.offsetTop;
    current = current.offsetParent instanceof HTMLElement ? current.offsetParent : null;
  }
  if (current === null) return rectSnapshot(element.getBoundingClientRect());
  const gridRect = current.getBoundingClientRect();
  left += gridRect.left;
  top += gridRect.top;
  return {
    left,
    top,
    right: left + element.offsetWidth,
    bottom: top + element.offsetHeight,
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}

function draggableId(entityKey: string): string {
  return `entity:${entityKey}`;
}

function entityKeyFromDraggableId(id: string): SidebarEntityKey | null {
  return id.startsWith("entity:") ? id.slice("entity:".length) as SidebarEntityKey : null;
}

function seedNumber(seed: string): number {
  let result = 2166136261;
  for (const character of seed) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function browserImageUrl(avatar: SidebarEntityAvatar): string | null {
  const value = avatar.kind === "image-url" ? avatar.url : avatar.kind === "resource" ? avatar.uri : null;
  if (value === null) return null;
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "data:", "blob:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function GeneratedBotAvatar({ seed, palette }: { readonly seed: string; readonly palette?: string }) {
  const hash = seedNumber(seed);
  const hue = hash % 360;
  const background = palette?.startsWith("#")
    ? palette
    : `hsl(${hue} 72% ${46 + ((hash >>> 8) % 12)}%)`;
  const shape = hash % 3;
  return (
    <span
      className="sidebar-bot-avatar__generated"
      style={{ "--sidebar-bot-generated-background": background } as CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48" focusable="false">
        <path
          className="sidebar-bot-avatar__body"
          d={shape === 0
            ? "M8 12C14 4 34 3 41 13c6 10 2 25-10 29C19 46 5 38 5 27c0-6 0-10 3-15Z"
            : shape === 1
              ? "M11 7c9-5 25 0 30 10 5 11-2 25-14 27C16 46 4 36 5 24 6 16 6 10 11 7Z"
              : "M7 17C10 6 24 2 35 7c10 5 11 18 5 28-6 11-22 12-31 3C1 29 3 23 7 17Z"}
        />
        <g className="sidebar-bot-avatar__eyes">
          <rect x="16" y="18" width="4" height="11" rx="2" />
          <rect x="29" y="18" width="4" height="11" rx="2" />
        </g>
      </svg>
    </span>
  );
}

function BotAvatar({ entity, presentation }: {
  readonly entity: SidebarEntity;
  readonly presentation: "tile" | "row" | "overlay";
}) {
  const imageUrl = browserImageUrl(entity.avatar);
  if (imageUrl !== null) {
    return (
      <img
        className="sidebar-bot-avatar"
        data-presentation={presentation}
        data-availability={entity.availability}
        src={imageUrl}
        alt={entity.avatar.kind === "image-url" ? entity.avatar.alt ?? "" : ""}
        draggable={false}
      />
    );
  }
  if (entity.avatar.kind === "generated" || entity.avatar.kind === "resource") {
    return (
      <span
        className="sidebar-bot-avatar sidebar-bot-avatar--generated"
        data-presentation={presentation}
        data-availability={entity.availability}
      >
        <GeneratedBotAvatar
          seed={entity.avatar.kind === "generated" ? entity.avatar.seed : entity.avatar.uri}
          palette={entity.avatar.kind === "generated" ? entity.avatar.palette : undefined}
        />
      </span>
    );
  }
  if (entity.avatar.kind === "image-url") {
    return (
      <span
        className="sidebar-bot-avatar sidebar-bot-avatar--generated"
        data-presentation={presentation}
        data-availability={entity.availability}
      >
        <GeneratedBotAvatar seed={entity.avatar.url} />
      </span>
    );
  }
  return (
    <span
      className="sidebar-bot-avatar sidebar-bot-avatar--monogram"
      data-presentation={presentation}
      style={{
        "--sidebar-bot-avatar-background": entity.avatar.background,
        "--sidebar-bot-avatar-foreground": entity.avatar.foreground ?? "#fff",
      } as CSSProperties}
      aria-hidden="true"
    >
      {entity.avatar.text}
    </span>
  );
}

function BotFace({ entity, presentation, dragging = false, reducedMotion }: {
  readonly entity: SidebarEntity;
  readonly presentation: "tile" | "row";
  readonly dragging?: boolean;
  readonly reducedMotion: boolean;
}) {
  return (
    <motion.span
      className="sidebar-bot-face"
      data-presentation={presentation}
      data-dragging={dragging || undefined}
      layout
      transition={reducedMotion ? REDUCED_MOTION : MOTION}
    >
      <BotAvatar entity={entity} presentation={presentation} />
      <span className="sidebar-bot-face__copy">
        <strong>{entity.title}</strong>
        {presentation === "row" && entity.subtitle !== undefined
          ? <small>{entity.subtitle}</small>
          : null}
      </span>
      {entity.availability === "connecting" ? <LoaderCircle className="sidebar-bot-spinner" size={13} /> : null}
    </motion.span>
  );
}

function SidebarBot({ entity, presentation, reducedMotion }: {
  readonly entity: SidebarEntity;
  readonly presentation: "tile" | "row";
  readonly reducedMotion: boolean;
}) {
  const { rowGlide, vanishedKey, finishRowGlide } = useSidebarEntityDnd();
  const sortable = useSortable({
    id: draggableId(entity.key),
    data: { kind: "sidebar-entity", entityKey: entity.key, presentation },
    disabled: { droppable: presentation === "row" },
  });
  const interactive = entity.availability === "available";
  const face = (
    <BotFace
      entity={entity}
      presentation={presentation}
      dragging={sortable.isDragging}
      reducedMotion={reducedMotion}
    />
  );
  return (
    <motion.button
      ref={sortable.setNodeRef}
      className={presentation === "tile" ? "sidebar-bot-tile" : "sidebar-bot-row"}
      type="button"
      layout="position"
      transition={reducedMotion ? REDUCED_MOTION : MOTION}
      data-availability={entity.availability}
      data-sidebar-pin-slot-id={presentation === "tile" ? entity.key : undefined}
      data-vanished={presentation === "tile" && vanishedKey === entity.key ? "true" : undefined}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      onClick={interactive ? entity.invoke : undefined}
      aria-label={`Open ${entity.title}`}
      {...sortable.attributes}
      {...sortable.listeners}
      aria-disabled={!interactive || undefined}
    >
      {presentation === "tile" && rowGlide?.key === entity.key && !reducedMotion ? (
        <motion.span
          key={rowGlide.nonce}
          className="sidebar-bot-row-glide"
          initial={{ x: rowGlide.x, y: rowGlide.y, scale: 1 }}
          animate={{ x: 0, y: 0, scale: 1 }}
          transition={MOTION}
          onAnimationComplete={finishRowGlide}
        >
          {face}
        </motion.span>
      ) : face}
    </motion.button>
  );
}

function CreateBotDialog({ creation, onClose, onCreated }: {
  readonly creation: SidebarEntityCreationCommand;
  readonly onClose: () => void;
  readonly onCreated: (invoke: () => void) => void;
}) {
  const [targetId, setTargetId] = useState(creation.targets[0]?.id ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || targetId === "" || creating) return;
    setCreating(true);
    setError(null);
    try {
      const receipt = await creation.create(targetId, trimmed);
      onCreated(receipt.invoke);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };
  return createPortal(
    <div className="sidebar-bot-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="sidebar-bot-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-bot-create-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>NEW {creation.noun.toLocaleUpperCase()}</small><h2 id="sidebar-bot-create-title">Create a {creation.noun}</h2></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </header>
        <p>The selected provider remains authoritative for this {creation.noun}.</p>
        <label>
          <span>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
              if (event.key === "Escape") onClose();
            }}
            placeholder="Research assistant"
            maxLength={64}
          />
        </label>
        {creation.targets.length > 1 ? (
          <label>
            <span>Provider</span>
            <NativeSelect value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)}>
              {creation.targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </NativeSelect>
          </label>
        ) : null}
        {error === null ? null : <div className="sidebar-bot-dialog__error" role="alert">{error}</div>}
        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="is-primary" onClick={() => void submit()} disabled={creating || name.trim() === "" || targetId === ""}>
            {creating ? <LoaderCircle size={14} className="sidebar-bot-spinner" /> : null}
            {creating ? "Creating…" : `Create ${creation.noun}`}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

const botCollisionDetection: CollisionDetection = (arguments_) => {
  const prioritizeEntities = <TCollision extends { readonly id: string | number }>(
    collisions: readonly TCollision[],
  ): TCollision[] => [...collisions].sort((left, right) =>
    Number(String(right.id).startsWith("entity:")) - Number(String(left.id).startsWith("entity:")));
  const pointerHits = prioritizeEntities(pointerWithin(arguments_));
  if (pointerHits.length > 0) return pointerHits;
  const intersections = prioritizeEntities(rectIntersection(arguments_));
  return intersections.length > 0 ? intersections : closestCenter(arguments_);
};

interface SidebarEntityDndProjection {
  readonly activeKey: SidebarEntityKey | null;
  readonly visiblePinned: readonly SidebarEntityKey[];
  readonly snapshot: ReturnType<SidebarLayoutStore["getSnapshot"]>;
  readonly reducedMotion: boolean;
  readonly rowGlide: RowGlide | null;
  readonly vanishedKey: SidebarEntityKey | null;
  readonly attachPinGrid: (node: HTMLDivElement | null) => void;
  readonly finishRowGlide: () => void;
}

const SidebarEntityDndContext = createContext<SidebarEntityDndProjection | null>(null);

function useSidebarEntityDnd(): SidebarEntityDndProjection {
  const value = useContext(SidebarEntityDndContext);
  if (value === null) throw new Error("SidebarBots must be owned by SidebarEntityDndCoordinator");
  return value;
}

/**
 * Sidebar-root interaction owner. Bot rows are its first entity projection;
 * Threads and projects can join without introducing another DndContext.
 */
export function SidebarEntityDndCoordinator({ items, layout, children }: {
  readonly items: readonly SidebarEntity[];
  readonly layout: SidebarLayoutStore;
  readonly children: ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion() === true;
  const snapshot = useSyncExternalStore(layout.subscribe, layout.getSnapshot, layout.getSnapshot);
  const dragTransaction = useRef(new SidebarDragTransaction());
  const [dragSnapshot, setDragSnapshot] = useState(() => dragTransaction.current.getSnapshot());
  const [activePresentation, setActivePresentation] = useState<"tile" | "row" | null>(null);
  const [isUnpinTarget, setIsUnpinTarget] = useState(false);
  const [rowGlide, setRowGlide] = useState<RowGlide | null>(null);
  const [vanishedKey, setVanishedKey] = useState<SidebarEntityKey | null>(null);
  const pointerStartX = useRef<number | null>(null);
  const pinGrid = useRef<HTMLDivElement | null>(null);
  const pinSlotsAtStart = useRef<readonly PinSlotSnapshot[]>([]);
  const pinnedDropTarget = useRef<RectSnapshot | null>(null);
  const overlayNode = useRef<HTMLDivElement | null>(null);
  const glideNonce = useRef(0);
  const itemsByKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const visibleKeys = useMemo(() => items.map((item) => item.key), [items]);
  const durableVisiblePinned = useMemo(
    () => snapshot.pinnedEntityKeys.filter((key) => itemsByKey.has(key as SidebarEntityKey)) as SidebarEntityKey[],
    [itemsByKey, snapshot.pinnedEntityKeys],
  );
  const activeKey = dragSnapshot.activeKey;
  const visiblePinned = dragSnapshot.phase === "dragging"
    ? dragSnapshot.visiblePinnedKeys
    : durableVisiblePinned;
  const activeItem = activeKey === null ? null : itemsByKey.get(activeKey) ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    const defaults = items.filter((item) => item.defaultPinned).map((item) => item.key);
    if (defaults.length > 0) layout.adoptDefaults(defaults);
  }, [items, layout]);

  const attachPinGrid = useCallback((node: HTMLDivElement | null) => {
    pinGrid.current = node;
  }, []);
  const finishRowGlide = useCallback(() => setRowGlide(null), []);
  const readPinSlots = useCallback((): PinSlotSnapshot[] => {
    if (pinGrid.current === null) return [];
    return [...pinGrid.current.querySelectorAll<HTMLElement>("[data-sidebar-pin-slot-id]")].map((node) => ({
      key: node.dataset.sidebarPinSlotId as SidebarEntityKey,
      rect: stablePinSlotRect(node),
    }));
  }, []);

  const begin = useCallback((event: DragStartEvent) => {
    const key = event.active.data.current?.entityKey;
    const presentation = event.active.data.current?.presentation;
    if (typeof key !== "string" || (presentation !== "tile" && presentation !== "row")) return;
    const activator = event.activatorEvent as Event & { readonly clientX?: unknown };
    pointerStartX.current = typeof activator.clientX === "number" ? activator.clientX : null;
    pinnedDropTarget.current = null;
    pinSlotsAtStart.current = readPinSlots();
    const entityKey = key as SidebarEntityKey;
    setDragSnapshot(dragTransaction.current.begin(durableVisiblePinned, entityKey, presentation));
    setActivePresentation(presentation);
    setVanishedKey(presentation === "row" ? entityKey : null);
    setIsUnpinTarget(false);
  }, [durableVisiblePinned, readPinSlots]);
  const project = useCallback((event: DragOverEvent | DragMoveEvent) => {
    const drag = dragTransaction.current.getSnapshot();
    if (drag.phase !== "dragging" || event.over === null) return;
    const overId = String(event.over.id);
    const overPresentation = event.over.data.current?.presentation;
    let intent: SidebarDropIntent | null = null;
    if (overId === LIST_ZONE) intent = { kind: "unpin" };
    else if (overId === PIN_ZONE) intent = { kind: "append-pin" };
    else if (overPresentation === "row") intent = { kind: "unpin" };
    else {
      const targetKey = entityKeyFromDraggableId(overId);
      if (overPresentation === "tile" && targetKey !== null && targetKey !== drag.activeKey) {
        const translated = event.active.rect.current.translated;
        const pointerX = pointerStartX.current === null
          ? (translated?.left ?? 0) + (translated?.width ?? 0) / 2
          : pointerStartX.current + event.delta.x;
        intent = {
          kind: "place-pin",
          targetKey,
          edge: pointerX < event.over.rect.left + event.over.rect.width / 2 ? "before" : "after",
        };
      }
    }
    if (intent === null) return;
    setIsUnpinTarget(intent.kind === "unpin");
    setDragSnapshot(dragTransaction.current.project(intent));
  }, []);
  const finish = useCallback((_event: DragEndEvent) => {
    const completion = dragTransaction.current.complete();
    if (completion !== null && completion.intent !== null) {
      const destinationIndex = completion.visiblePinnedKeys.indexOf(completion.activeKey);
      if (destinationIndex >= 0) {
        const liveSlot = readPinSlots().find((slot) => slot.key === completion.activeKey)?.rect;
        const indexedSlot = pinSlotsAtStart.current[destinationIndex]?.rect;
        const destination = liveSlot ?? indexedSlot ?? null;
        if (completion.presentation === "tile") {
          pinnedDropTarget.current = destination;
        } else if (destination !== null && overlayNode.current !== null) {
          const source = rectSnapshot(overlayNode.current.getBoundingClientRect());
          glideNonce.current += 1;
          setRowGlide({
            key: completion.activeKey,
            x: source.left - destination.left,
            y: source.top - destination.top,
            nonce: glideNonce.current,
          });
        }
      }
      if (completion.changed) {
        layout.commitVisibleOrder(visibleKeys, completion.visiblePinnedKeys);
      }
    }
    pointerStartX.current = null;
    setDragSnapshot(dragTransaction.current.getSnapshot());
    setVanishedKey(null);
  }, [layout, readPinSlots, visibleKeys]);
  const cancel = useCallback((_event: DragCancelEvent) => {
    pointerStartX.current = null;
    setDragSnapshot(dragTransaction.current.cancel());
    setActivePresentation(null);
    setIsUnpinTarget(false);
    setVanishedKey(null);
  }, []);

  const pinnedDropAnimation = useMemo<DropAnimation>(() => ({
    duration: DROP_DURATION_MS,
    easing: DROP_EASING,
    sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
    keyframes: ({ transform, dragOverlay }) => {
      const destination = pinnedDropTarget.current;
      const initial = CSS.Transform.toString(transform.initial);
      if (destination === null) return [{ transform: initial }, { transform: initial }];
      const overlayRect = dragOverlay.node.getBoundingClientRect();
      const final = {
        ...transform.initial,
        x: transform.initial.x + destination.left - overlayRect.left,
        y: transform.initial.y + destination.top - overlayRect.top,
      };
      return [{ transform: initial }, { transform: CSS.Transform.toString(final) }];
    },
  }), []);

  const contextValue = useMemo<SidebarEntityDndProjection>(() => ({
    activeKey,
    visiblePinned,
    snapshot,
    reducedMotion: prefersReducedMotion,
    rowGlide,
    vanishedKey,
    attachPinGrid,
    finishRowGlide,
  }), [activeKey, attachPinGrid, finishRowGlide, prefersReducedMotion, rowGlide, snapshot, vanishedKey, visiblePinned]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={botCollisionDetection}
      onDragStart={begin}
      onDragMove={project}
      onDragOver={project}
      onDragCancel={cancel}
      onDragEnd={finish}
    >
      <SidebarEntityDndContext.Provider value={contextValue}>
        {children}
      </SidebarEntityDndContext.Provider>
      <DragOverlay
        dropAnimation={prefersReducedMotion || activePresentation !== "tile" || isUnpinTarget ? null : pinnedDropAnimation}
      >
        {activeItem === null ? null : (
          <motion.div
            ref={overlayNode}
            className="sidebar-bot-overlay"
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={MOTION}
          >
            <BotAvatar entity={activeItem} presentation="overlay" />
            <span>{activeItem.title}</span>
          </motion.div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

export function SidebarBots({ items, creation }: {
  readonly items: readonly SidebarEntity[];
  readonly creation: SidebarEntityCreationCommand | null;
}) {
  const intl = useIntl();
  const botsLabel = intl.formatMessage({ id: "sidebar.bots", defaultMessage: "Bots" });
  const { activeKey, visiblePinned, snapshot, reducedMotion, attachPinGrid } = useSidebarEntityDnd();
  const [showCreate, setShowCreate] = useState(false);
  const itemsByKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const pinnedSet = useMemo(() => new Set(visiblePinned), [visiblePinned]);
  const pinnedItems = visiblePinned.flatMap((key) => {
    const item = itemsByKey.get(key);
    return item === undefined ? [] : [item];
  });
  const availableItems = items.filter((item) => !pinnedSet.has(item.key));
  const pinZone = useDroppable({ id: PIN_ZONE, data: { kind: "sidebar-pin-zone" } });
  const listZone = useDroppable({ id: LIST_ZONE, data: { kind: "sidebar-list-zone" } });

  if (items.length === 0 && creation === null) return null;
  const showPinShell = pinnedItems.length > 0 || activeKey !== null;
  return (
    <>
      <section className="sidebar-bots" aria-label={botsLabel} data-dragging={activeKey === null ? undefined : "true"}>
          <div className="sidebar-section-heading sidebar-bots__heading">
            <button type="button"><Bot size={13} /><span>{botsLabel}</span></button>
            {creation === null ? null : (
              <button type="button" aria-label={intl.formatMessage({ id: "sidebar.createBot", defaultMessage: "Create Bot" })} onClick={() => creation.open ? creation.open() : setShowCreate(true)}><Plus size={13} /></button>
            )}
          </div>
          <AnimatePresence initial={false} mode="popLayout">
            {!showPinShell ? null : (
              <motion.div
                ref={pinZone.setNodeRef}
                key="pinned-shell"
                className="sidebar-bots__pinned-shell"
                data-over={pinZone.isOver || undefined}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={reducedMotion ? REDUCED_MOTION : MOTION}
              >
                <SortableContext items={visiblePinned.map(draggableId)} strategy={rectSortingStrategy}>
                  <div
                    ref={attachPinGrid}
                    className="sidebar-bots__pinned-grid"
                    data-sidebar-pin-grid="true"
                    data-count={pinnedItems.length}
                  >
                    {pinnedItems.map((entity) => (
                      <SidebarBot
                        key={entity.key}
                        entity={entity}
                        presentation="tile"
                        reducedMotion={reducedMotion}
                      />
                    ))}
                    {pinnedItems.length === 0 && activeKey !== null
                      ? <span className="sidebar-bots__drop-prompt">Drop to pin</span>
                      : null}
                  </div>
                </SortableContext>
              </motion.div>
            )}
          </AnimatePresence>
          <div ref={listZone.setNodeRef} className="sidebar-bots__list" data-over={listZone.isOver || undefined}>
            <AnimatePresence initial={false} mode="popLayout">
              {availableItems.map((entity) => (
                <SidebarBot
                  key={entity.key}
                  entity={entity}
                  presentation="row"
                  reducedMotion={reducedMotion}
                />
              ))}
            </AnimatePresence>
          </div>
          {snapshot.phase !== "error" ? null : <small className="sidebar-bots__error">{snapshot.error}</small>}
      </section>
      {!showCreate || creation === null ? null : (
        <CreateBotDialog
          creation={creation}
          onClose={() => setShowCreate(false)}
          onCreated={(invoke) => {
            setShowCreate(false);
            invoke();
          }}
        />
      )}
    </>
  );
}

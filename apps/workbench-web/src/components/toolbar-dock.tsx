import { useIntl } from "@opencraft/i18n/react";
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MoreIcon, EditIcon, AddIcon, MinusIcon, GripIcon } from "@opencraft/design-system-web/action-icons";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { SettingsButton, SettingsNotice, SettingsPanel } from "@opencraft/extension-react";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ModalSurface } from "./modal";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import { moveToolbarAction } from "./toolbar-dock-model";
import { toolbarEditorCollision } from "./toolbar-dock-drag";
import { useToolbarDock } from "./toolbar-dock-state";
import { useAsyncNotices } from "./async-notices";
import "../styles/toolbar-dock.scss";

export interface ToolbarDockAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly dialog?: boolean;
  invoke(): void;
}

function SortableAction({ action, customize, selected, onToggle, onInvoke }: {
  action: ToolbarDockAction; customize?: boolean; selected?: boolean; onToggle?(): void; onInvoke?(element: HTMLButtonElement): void;
}) {
  const intl = useIntl();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: action.id, data: { zone: customize ? selected ? "@dock" : "@more" : undefined },
  });
  return <div ref={setNodeRef} className={customize ? "toolbar-dock__choice" : "toolbar-dock__item"}
    data-dragging={isDragging || undefined} style={{ transform: customize && isDragging ? undefined : CSS.Transform.toString(transform), transition }}>
    {customize ? <>
      <button ref={setActivatorNodeRef} type="button" className="toolbar-dock__grip" {...attributes} {...listeners} aria-label={intl.formatMessage({ id: "toolbarDock.dragAction", defaultMessage: "Drag {action}" }, { action: action.label })} title={intl.formatMessage({ id: "toolbarDock.drag", defaultMessage: "Drag to reorder" })}><GripIcon size={16} /></button>
      <span className="toolbar-dock__choice-icon" aria-hidden="true">{action.icon}</span><span className="toolbar-dock__choice-label">{action.label}</span>
      <button type="button" className="toolbar-dock__toggle" aria-label={intl.formatMessage(selected ? { id: "toolbarDock.remove", defaultMessage: "Remove from toolbar: {action}" } : { id: "toolbarDock.add", defaultMessage: "Add to toolbar: {action}" }, { action: action.label })} onClick={onToggle}>{selected ? <MinusIcon size={16} /> : <AddIcon size={16} />}</button>
    </> : <button type="button" className="chrome-button toolbar-dock__action" {...attributes} {...listeners}
      aria-roledescription={intl.formatMessage({ id: "toolbarDock.action", defaultMessage: "Draggable toolbar button" })} aria-label={action.label} title={action.label} disabled={action.disabled}
      aria-busy={action.pending || undefined} aria-haspopup={action.dialog ? "dialog" : undefined}
      onClick={event => onInvoke?.(event.currentTarget)}>{action.icon}</button>}
  </div>;
}

function DropZone({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <section ref={setNodeRef} className="toolbar-dock__zone" data-over={isOver || undefined} aria-label={label}>
    <h3>{label}</h3>{children}
  </section>;
}

export function ToolbarDock({ scope, dockId, actions, label, defaultActions = [], onActionTrigger, returnFocus }: {
  scope: string; dockId: string; defaultActions?: readonly string[]; actions: readonly ToolbarDockAction[]; label: string;
  onActionTrigger(element: HTMLElement): void; returnFocus(): HTMLElement | null;
}) {
  const intl = useIntl();
  const message = (id: string, defaultMessage: string) => intl.formatMessage({ id, defaultMessage });
  const state = useToolbarDock(scope, dockId, actions.map(action => action.id), defaultActions);
  const portal = useWorkbenchPresentationRoot();
  const notices = useAsyncNotices();
  const overflow = useRef<HTMLButtonElement | null>(null);
  const handoff = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<readonly string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [draggedAction, setDraggedAction] = useState<ToolbarDockAction | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const byId = new Map(actions.map(action => [action.id, action]));
  const docked = state.projection.docked.flatMap(({ id }) => byId.has(id) ? [byId.get(id)!] : []);
  const invoke = (action: ToolbarDockAction, element: HTMLElement) => {
    onActionTrigger(element); handoff.current = action.dialog === true; setMenuOpen(false); action.invoke();
  };
  const saveOrder = async (order: readonly string[]) => {
    try { await state.save(order); } catch {
      notices.error({ key: `toolbar-dock:${scope}:${dockId}`, message: message("toolbarDock.saveFailed", "Could not save toolbar settings. Try again.") });
    }
  };
  const draftDocked = draft === null ? [] : actions.filter(action => draft.includes(action.id)).sort((a, b) => draft.indexOf(a.id) - draft.indexOf(b.id));
  const draftMore = draft === null ? [] : actions.filter(action => !draft.includes(action.id));
  return <>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
      if (!over || active.id === over.id) return;
      const ids = docked.map(action => action.id);
      const from = ids.indexOf(String(active.id)); const to = ids.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const next = [...state.order];
      const a = next.indexOf(ids[from]!); const b = next.indexOf(ids[to]!);
      next.splice(a, 1); next.splice(b, 0, ids[from]!); void saveOrder(next);
    }}>
      <div className="toolbar-dock" role="toolbar" aria-label={label}>
        <SortableContext items={docked.map(action => action.id)} strategy={horizontalListSortingStrategy}>
          {docked.map(action => <SortableAction key={action.id} action={action} onInvoke={element => invoke(action, element)} />)}
        </SortableContext>
      </div>
    </DndContext>
    <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button ref={overflow} type="button" className="chrome-button" aria-label={label} title={label}><MoreIcon size={16} aria-hidden="true" /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portal}><DropdownMenu.Content className="workbench-context-menu" align="end" sideOffset={4}
        onCloseAutoFocus={event => { if (handoff.current) { event.preventDefault(); handoff.current = false; } }}>
        {state.projection.overflow.map(({ id }) => byId.get(id)!).map(action => <DropdownMenu.Item key={action.id} disabled={action.disabled}
          aria-busy={action.pending || undefined} onSelect={() => invoke(action, overflow.current!)}>{action.icon}{action.label}</DropdownMenu.Item>)}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => { handoff.current = true; setSaveError(false); setDraft([...state.order]); }}><EditIcon size={16} aria-hidden="true" />{message("toolbarDock.customize", "Customize toolbar")}</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {draft !== null ? <ModalSurface label={message("toolbarDock.customize", "Customize toolbar")} size="compact" appearance="utility" onDismiss={() => { if (!saving) setDraft(null); }} returnFocus={() => overflow.current ?? returnFocus()}>
      <SettingsPanel title={message("toolbarDock.customize", "Customize toolbar")} footer={<>
        <SettingsButton variant="quiet" disabled={saving} onClick={() => setDraft([...defaultActions])}>{message("toolbarDock.reset", "Restore defaults")}</SettingsButton>
        <SettingsButton variant="quiet" disabled={saving} onClick={() => setDraft(null)}>{message("common.cancel", "Cancel")}</SettingsButton>
        <SettingsButton disabled={saving} onClick={() => { setSaving(true); setSaveError(false); void state.save(draft).then(() => setDraft(null)).catch(() => setSaveError(true)).finally(() => setSaving(false)); }}>{message("common.save", "Save")}</SettingsButton>
      </>}>
        <SettingsNotice>{message("toolbarDock.hint", "Drag to reorder or move actions between toolbar and menu. Actions fold into the menu when space is limited.")}</SettingsNotice>
        {saveError ? <SettingsNotice tone="error" role="alert">{message("toolbarDock.saveFailed", "Could not save toolbar settings. Try again.")}</SettingsNotice> : null}
        <DndContext sensors={sensors} collisionDetection={toolbarEditorCollision}
          onDragStart={({ active }) => setDraggedAction(byId.get(String(active.id)) ?? null)}
          onDragCancel={() => setDraggedAction(null)} onDragEnd={({ active, over }) => {
          setDraggedAction(null);
          if (!over || saving || active.id === over.id) return;
          const id = String(active.id); const target = String(over.id);
          if (draft.includes(id) && draft.includes(target)) {
            const next = [...draft]; const from = next.indexOf(id); const to = next.indexOf(target);
            next.splice(from, 1); next.splice(to, 0, id); setDraft(next);
          } else setDraft(moveToolbarAction(draft, id, target.startsWith("@") ? null : target, target === "@dock" || draft.includes(target)));
        }}>
          <div className="toolbar-dock__editor" aria-busy={saving || undefined} inert={saving || undefined}>
            <DropZone id="@dock" label={message("toolbarDock.docked", "Toolbar")}><SortableContext items={draftDocked.map(action => action.id)} strategy={verticalListSortingStrategy}>
              {draftDocked.map(action => <SortableAction key={action.id} action={action} customize selected onToggle={() => setDraft(moveToolbarAction(draft, action.id, null, false))} />)}
            </SortableContext>{!draftDocked.length ? <p>{message("toolbarDock.emptyDock", "Drag your frequent actions here")}</p> : null}</DropZone>
            <DropZone id="@more" label={message("toolbarDock.overflow", "More menu")}><SortableContext items={draftMore.map(action => action.id)} strategy={verticalListSortingStrategy}>
              {draftMore.map(action => <SortableAction key={action.id} action={action} customize onToggle={() => setDraft(moveToolbarAction(draft, action.id, null, true))} />)}
            </SortableContext>{!draftMore.length ? <p>{message("toolbarDock.emptyMenu", "All actions are in the toolbar")}</p> : null}</DropZone>
          </div>
          {createPortal(<DragOverlay adjustScale={false} dropAnimation={null}
            style={{ zIndex: "calc(var(--layer-application-modal, 230) + 2)", pointerEvents: "none" }}>
            {draggedAction ? <div className="toolbar-dock__choice toolbar-dock__drag-preview" aria-hidden="true">
              <span className="toolbar-dock__grip"><GripIcon size={16} /></span>
              <span className="toolbar-dock__choice-icon">{draggedAction.icon}</span>
              <span className="toolbar-dock__choice-label">{draggedAction.label}</span>
              <span className="toolbar-dock__toggle">{draft.includes(draggedAction.id) ? <MinusIcon size={16} /> : <AddIcon size={16} />}</span>
            </div> : null}
          </DragOverlay>, portal ?? document.body)}
        </DndContext>
      </SettingsPanel>
    </ModalSurface> : null}
  </>;
}

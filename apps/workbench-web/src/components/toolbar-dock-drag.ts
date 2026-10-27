import { closestCenter, pointerWithin, type CollisionDetection } from "@dnd-kit/core";

/** A zone is a destination, not a competing sortable row. */
export const toolbarEditorCollision: CollisionDetection = args => {
  const zones = args.droppableContainers.filter(container => container.id === "@dock" || container.id === "@more");
  const rows = args.droppableContainers.filter(container => container.data.current?.zone);
  if (args.pointerCoordinates) {
    const zone = pointerWithin({ ...args, droppableContainers: zones })[0];
    if (!zone) return [];
    const children = rows.filter(container => container.data.current?.zone === zone.id);
    return children.length ? closestCenter({ ...args, droppableContainers: children }) : [zone];
  }
  // Keyboard coordinates target rows, with a zone target only when it is empty.
  const emptyZones = zones.filter(zone => !rows.some(row => row.data.current?.zone === zone.id));
  return closestCenter({ ...args, droppableContainers: [...rows, ...emptyZones] });
};

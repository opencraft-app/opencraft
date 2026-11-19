import type { ComposerQueueTrayItem } from "./queue-tray";

/** The shortcut and row button must respect the same queue admission state. */
export function canSteerQueueItem(
  item: Pick<ComposerQueueTrayItem, "actionable" | "steerable" | "operation" | "pausedReason">,
  isResponseInProgress: boolean,
  atomicSteer: boolean,
  blockedByUnconfirmedDelivery: boolean,
): boolean {
  return (
    (item.steerable ?? item.actionable) &&
    item.operation === "idle" &&
    item.pausedReason !== "restored-after-host-restart" &&
    !blockedByUnconfirmedDelivery &&
    (!isResponseInProgress || atomicSteer)
  );
}

import { asTurnId, type TimelineSourceItem, type TimelineSourceTurn } from "@opencraft/chat-core";
import type { PendingInteraction } from "./models";

interface InteractionItems {
  readonly provisionalCommand: TimelineSourceItem | null;
  readonly request: TimelineSourceItem;
}
interface TurnProjection {
  readonly interactions: readonly PendingInteraction[];
  readonly turn: TimelineSourceTurn;
}

/** Display projection only: the caller owns request/response truth. Retain only
 * currently pending Turn projections; per-request artifacts have weak keys. */
export function createPendingInteractionProjector(
  project: (interaction: PendingInteraction) => InteractionItems,
): (
  source: readonly TimelineSourceTurn[],
  interactions: readonly PendingInteraction[],
) => readonly TimelineSourceTurn[] {
  const requestItems = new WeakMap<PendingInteraction, InteractionItems>();
  let previous = new Map<TimelineSourceTurn, TurnProjection>();
  let synthetic = new Map<string, TimelineSourceTurn>();
  return (source, interactions) => {
    if (interactions.length === 0) {
      previous.clear();
      synthetic.clear();
      return source;
    }
    const groups = new Map<string, PendingInteraction[]>();
    for (const interaction of interactions) {
      const id = interaction.turnId ?? asTurnId(`interaction:${interaction.requestId}`);
      let group = groups.get(id);
      if (!group) {
        group = [];
        groups.set(id, group);
      }
      group.push(interaction);
    }
    const next = new Map<TimelineSourceTurn, TurnProjection>();
    const nextSynthetic = new Map<string, TimelineSourceTurn>();
    const attach = (turn: TimelineSourceTurn, group: readonly PendingInteraction[]): TimelineSourceTurn => {
      const cached = previous.get(turn);
      if (
        cached &&
        cached.interactions.length === group.length &&
        group.every((interaction, index) => interaction === cached.interactions[index])
      ) {
        next.set(turn, cached);
        return cached.turn;
      }
      const items = [...turn.items];
      let commands: Set<string> | undefined;
      for (const interaction of group) {
        let projected = requestItems.get(interaction);
        if (!projected) {
          projected = project(interaction);
          requestItems.set(interaction, projected);
        }
        if (projected.provisionalCommand) {
          commands ??= new Set(items.filter((item) => item.type === "commandExecution").map((item) => item.id));
          if (!commands.has(projected.provisionalCommand.id)) {
            items.push(projected.provisionalCommand);
            commands.add(projected.provisionalCommand.id);
          }
        }
        items.push(projected.request);
        if (commands && projected.request.type === "commandExecution") commands.add(projected.request.id);
      }
      const result = { ...turn, items };
      next.set(turn, { interactions: group, turn: result });
      return result;
    };
    const result = source.map((turn) => {
      const group = groups.get(turn.id);
      if (!group) return turn;
      // The former find() selected the first matching Turn, even for malformed
      // duplicate ids. Preserve that ownership and source order.
      groups.delete(turn.id);
      return attach(turn, group);
    });
    // Missing targets retain first-request order, not source/group sorting.
    for (const [id, group] of groups) {
      const base = synthetic.get(id) ?? { id, status: "pending" as const, items: [] };
      nextSynthetic.set(id, base);
      result.push(attach(base, group));
    }
    previous = next;
    synthetic = nextSynthetic;
    return result;
  };
}

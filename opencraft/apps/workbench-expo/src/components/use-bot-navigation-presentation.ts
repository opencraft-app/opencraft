import { useCallback, useState } from "react";
import type { BotConsoleState } from "@opencraft/mobile-bot-bridge";
import { emptyBotNavigation, selectBotNavigation, receiveBotNavigation, pruneBotNavigation, projectBotNavigation,
  type BotNavigationState } from "../runtime/mobile-bot-navigation-state";

/** Native and Expo Web share the same continuity and command admission policy. */
export function useBotNavigationPresentation(scope: string, botId: string, ready: boolean) {
  const [stored, setStored] = useState(() => ({ scope, state: emptyBotNavigation() }));
  const update = useCallback((change: (state: BotNavigationState) => BotNavigationState) => {
    setStored(current => ({ scope, state: change(current.scope === scope ? current.state : emptyBotNavigation()) }));
  }, [scope]);
  const select = useCallback((id: string) => update(state => selectBotNavigation(state, id)), [update]);
  const receive = useCallback((message: BotConsoleState, selectedBotId: string) => update(state =>
    receiveBotNavigation(selectBotNavigation(state, selectedBotId), message)), [update]);
  const prune = useCallback((ids: readonly string[]) => update(state => pruneBotNavigation(state, ids)), [update]);
  return { ...projectBotNavigation(stored.scope === scope ? stored.state : emptyBotNavigation(), botId, ready), select, receive, prune };
}

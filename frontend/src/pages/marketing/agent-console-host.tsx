import { useEffect, useRef } from "react";
import { boundBotConsoleState, type BotCommand, type BotConsoleState } from "@opencraft/mobile-bot-bridge";

/** A renderer port, not a second Bot/session controller. */
export interface AgentConsoleHostPort {
  publish(state: BotConsoleState): void;
  subscribe(listener: (command: BotCommand) => boolean): () => void;
}

/** Commit the native projection only after the frontend render is committed. */
export function AgentConsoleHostProjection({ host, state, onCommand }: {
  host?: AgentConsoleHostPort;
  state: BotConsoleState;
  onCommand: (command: BotCommand) => boolean;
}) {
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;
  useEffect(() => host?.subscribe(command => commandRef.current(command)), [host]);
  const wire = JSON.stringify(boundBotConsoleState(state));
  useEffect(() => {
    if (host) host.publish(JSON.parse(wire) as BotConsoleState);
  }, [host, wire]);
  return null;
}

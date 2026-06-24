"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import type { Bot } from "@/domain/types";

import styles from "./AgentsWorkbenchPage.module.css";
import { VelaWorkbenchDesktopHost } from "./VelaWorkbenchDesktopHost";

const pickInitialBotId = (bots: Bot[], previousId: string) => {
  if (previousId && bots.some((bot) => bot.id === previousId)) return previousId;
  return bots.find((bot) => bot.status === "active")?.id ?? bots[0]?.id ?? "";
};

export function AgentsWorkbenchPage() {
  const repositories = useRepositories();
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.id === selectedBotId) ?? null,
    [bots, selectedBotId],
  );

  const loadBots = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const snapshot = await repositories.bots.getDashboardSnapshot("live");
      setBots(snapshot.bots);
      setSelectedBotId((current) => pickInitialBotId(snapshot.bots, current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [repositories]);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  return (
    <main className={styles.workbenchHost}>
      <VelaWorkbenchDesktopHost
        bot={selectedBot}
        botError={error}
        botLoading={isLoading}
        execDebugCommand={repositories.bots.execDebugCommand}
        getTerminalSession={repositories.bots.getTerminalSession}
        onReloadBots={loadBots}
      />
    </main>
  );
}

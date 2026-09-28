import { useEffect, useState } from "react";
import type { OpenClawBot } from "@/contexts/agent-context";
import { listCronJobs } from "@/lib/hermes-cron-client";
import { isCronJobExpired } from "@/pages/marketing/agent-automations-panel";

type Scope = Pick<OpenClawBot, "id" | "instanceId" | "profileId" | "status">;

export function getBotAutomationTarget(bot: Scope) {
  return { instanceId: bot.instanceId || bot.id, profileId: bot.profileId! };
}

/** An incomplete read is unknown, never a partial account-wide total. */
export const sumBotAutomationCounts = (bots: Scope[], counts: Record<string, number | null>) => {
  if (bots.some((bot) => counts[bot.id] == null)) return null;
  return bots.reduce((sum, bot) => sum + counts[bot.id]!, 0);
};

export async function loadBotAutomationCounts(
  bots: Scope[],
  read: (bot: Scope) => Promise<number>,
  cancelled: () => boolean = () => false,
): Promise<Record<string, number | null>> {
  const counts: Record<string, number | null> = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, bots.length) }, async () => {
    while (next < bots.length && !cancelled()) {
      const bot = bots[next++]!;
      counts[bot.id] = null;
      if (bot.status !== "running" || !bot.profileId?.trim()) continue;
      try { counts[bot.id] = await read(bot); } catch { /* Unknown; keep the other cards usable. */ }
    }
  }));
  return counts;
}

export function useFleetAutomationCounts(bots: OpenClawBot[], revision: number) {
  const scopeKey = JSON.stringify(bots.map(({ id, instanceId, profileId, status }) => ({ id, instanceId, profileId, status })));
  const [snapshot, setSnapshot] = useState<{ key: string; revision: number; counts: Record<string, number | null> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const scopes = JSON.parse(scopeKey) as Scope[];
    void loadBotAutomationCounts(scopes, async (bot) => {
      const jobs = await listCronJobs(getBotAutomationTarget(bot), { hydrateContextFrom: false });
      return jobs.filter((job) => !isCronJobExpired(job)).length;
    }, () => cancelled).then((counts) => {
      if (!cancelled) setSnapshot({ key: scopeKey, revision, counts });
    });
    return () => { cancelled = true; };
  }, [scopeKey, revision]);
  return snapshot?.key === scopeKey && snapshot.revision === revision ? snapshot.counts : {};
}

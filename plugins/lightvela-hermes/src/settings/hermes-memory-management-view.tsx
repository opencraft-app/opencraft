import { Brain, RefreshCw, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsTextInput,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import {
  fetchHermesMemorySnapshot,
  getMemoryUsagePercent,
  splitHermesMemoryEntries,
  validateHermesMemoryLimit,
  type HermesMemoryLimitTarget,
  type HermesMemorySnapshot,
} from "../management/memory/agent-memory";
import { saveHermesMemoryLimit } from "../management/memory/agent-memory-save";
import { accountDebugCommandExecutor } from "../management/debug-command";

export function HermesMemoryManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const executor = accountDebugCommandExecutor(account);
  const [snapshot, setSnapshot] = useState<HermesMemorySnapshot | null>(null);
  const [memoryLimit, setMemoryLimit] = useState("");
  const [userLimit, setUserLimit] = useState("");
  const [pending, setPending] = useState<HermesMemoryLimitTarget | "load" | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success" | "neutral"; text: string } | null>(null);

  const load = useCallback(async () => {
    setPending("load");
    setMessage(null);
    try {
      const next = await fetchHermesMemorySnapshot(executor, botId);
      setSnapshot(next);
      setMemoryLimit(String(next.memoryCharLimit));
      setUserLimit(String(next.userCharLimit));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(null);
    }
  }, [account, botId]);

  useEffect(() => { void load(); }, [load]);

  const save = async (target: HermesMemoryLimitTarget) => {
    if (!snapshot || pending) return;
    const input = target === "memory" ? memoryLimit : userLimit;
    const used = target === "memory" ? snapshot.memoryChars : snapshot.userChars;
    const validation = validateHermesMemoryLimit(target, input, used);
    if (!validation.ok) {
      setMessage({ tone: "error", text: `Enter an integer between ${validation.min} and ${validation.max}.` });
      return;
    }
    setPending(target);
    setMessage(null);
    const result = await saveHermesMemoryLimit({
      bots: executor,
      botId,
      target,
      value: validation.value,
      existingChars: used,
      getGatewayRestartCommand: async () => "harness gateway restart",
    });
    if (result.status === "success") {
      setSnapshot(result.snapshot);
      setMemoryLimit(String(result.snapshot.memoryCharLimit));
      setUserLimit(String(result.snapshot.userCharLimit));
      setMessage({ tone: "success", text: "Saved, gateway restarted, and the value was verified by rereading Hermes." });
    } else {
      setMessage({
        tone: "error",
        text: result.status === "partial"
          ? `The configuration was written, but restart/readback failed: ${result.error.message}`
          : result.error.message,
      });
    }
    setPending(null);
  };

  return (
    <>
      <SettingsSection
        title="Memory limits"
        icon={<Brain size={16} />}
        description="Hermes owns the durable files and limits. Saving is a write, restart, and verified-read transaction."
        action={<SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => void load()}><RefreshCw size={14} /> Refresh</SettingsButton>}
      >
        {pending === "load" && !snapshot ? <SettingsNotice>Reading MEMORY.md and USER.md…</SettingsNotice> : null}
        {message ? <SettingsNotice tone={message.tone}>{message.text}</SettingsNotice> : null}
        {snapshot ? (
          <SettingsGroup>
            <SettingsRow label="Agent memory limit" description={`${snapshot.memoryChars} characters used · ${getMemoryUsagePercent(snapshot.memoryChars, snapshot.memoryCharLimit)}%`} htmlFor="hermes-memory-limit"><SettingsTextInput id="hermes-memory-limit" inputMode="numeric" value={memoryLimit} onChange={(event) => setMemoryLimit(event.currentTarget.value)} /></SettingsRow>
            <SettingsActions><SettingsButton type="button" variant="primary" disabled={pending !== null || memoryLimit === String(snapshot.memoryCharLimit)} onClick={() => void save("memory")}>{pending === "memory" ? "Saving…" : "Save memory limit"}</SettingsButton></SettingsActions>
            <SettingsRow label="User memory limit" description={`${snapshot.userChars} characters used · ${getMemoryUsagePercent(snapshot.userChars, snapshot.userCharLimit)}%`} htmlFor="hermes-user-limit"><SettingsTextInput id="hermes-user-limit" inputMode="numeric" value={userLimit} onChange={(event) => setUserLimit(event.currentTarget.value)} /></SettingsRow>
            <SettingsActions><SettingsButton type="button" variant="primary" disabled={pending !== null || userLimit === String(snapshot.userCharLimit)} onClick={() => void save("user")}>{pending === "user" ? "Saving…" : "Save user limit"}</SettingsButton></SettingsActions>
          </SettingsGroup>
        ) : null}
      </SettingsSection>
      {snapshot ? (
        <SettingsSection title="Durable context" description="Read-only projection of the files currently owned by Hermes.">
          <SettingsGroup>
            {splitHermesMemoryEntries(snapshot.memoryText).map((entry, index) => <SettingsListItem key={`memory-${index}`} icon={<Brain size={14} />} label={entry} metadata="MEMORY.md" />)}
            {splitHermesMemoryEntries(snapshot.userText).map((entry, index) => <SettingsListItem key={`user-${index}`} icon={<UserRound size={14} />} label={entry} metadata="USER.md" />)}
            {!snapshot.memoryText.trim() && !snapshot.userText.trim() ? <SettingsNotice>No durable memory entries yet.</SettingsNotice> : null}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
    </>
  );
}

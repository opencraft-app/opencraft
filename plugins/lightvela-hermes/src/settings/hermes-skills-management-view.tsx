import { Download, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  createSkillsDataLayer,
  formatInstalls,
  mergeSkills,
  skillIdentity,
  sortByPopular,
  type InstalledSkill,
  type Skill,
  type SkillsDataLayer,
} from "../management/skills/skill-registries";

export function HermesSkillsManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [results, setResults] = useState<Skill[]>([]);
  const [query, setQuery] = useState("");
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchAuthority = useRef<AbortController | null>(null);

  const dataLayer = useMemo<SkillsDataLayer>(() => createSkillsDataLayer(
    botId,
    async (targetBotId, command, options) => {
      const result = await account.execDebugCommand(targetBotId, command, options);
      return { ...result, stdout: result.output, stderr: "" };
    },
    account.getSnapshot().region === "cn" ? "domestic" : "global",
    account.getSnapshot().region === "cn" ? "zh" : "en",
    (targetBotId, command, onChunk, options) => account.execDebugCommandStream(
      targetBotId,
      command,
      onChunk,
      options,
    ),
  ), [account, botId, account.getSnapshot().region]);

  const load = useCallback(async () => {
    setPending("load");
    setError(null);
    try {
      const installed = await dataLayer.listInstalled();
      setSkills(installed.skills);
      setFailedSources(installed.failedSources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }, [dataLayer]);

  useEffect(() => {
    void load();
    return () => searchAuthority.current?.abort();
  }, [load]);

  const search = async (keyword = query) => {
    searchAuthority.current?.abort();
    const authority = new AbortController();
    searchAuthority.current = authority;
    setPending("search");
    setError(null);
    try {
      const found = keyword.trim()
        ? await dataLayer.search(keyword.trim(), { signal: authority.signal, sortBy: "score" })
        : await dataLayer.getPopular().then((popular) => ({
          ...popular,
          failedSources: [] as string[],
        }));
      if (authority.signal.aborted) return;
      setResults(sortByPopular(mergeSkills(found.clawhub, found.skillssh, found.skillhub)));
      setFailedSources(found.failedSources);
    } catch (cause) {
      if (!authority.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (searchAuthority.current === authority) setPending(null);
    }
  };

  const install = async (skill: Skill) => {
    const identity = skillIdentity(skill);
    setPending(`install:${identity}`);
    setError(null);
    setNotice(null);
    try {
      const result = await dataLayer.install(skill);
      if (!result.ok) throw new Error(result.message || "Skill installation failed.");
      setNotice(`${skill.name} installed.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const remove = async (skill: InstalledSkill) => {
    const identity = skillIdentity(skill);
    setPending(`delete:${identity}`);
    setError(null);
    try {
      const result = await dataLayer.uninstall(skill);
      if (!result.ok) throw new Error(result.message || "Skill removal failed.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const installedIdentities = useMemo(
    () => new Set(skills.flatMap((skill) => [
      skillIdentity(skill),
      ...(skill.uninstallTargets ?? []).map(skillIdentity),
    ])),
    [skills],
  );

  return (
    <>
      <SettingsSection
        title="Installed skills"
        icon={<Sparkles size={16} />}
        description="ClawHub, skills.sh/SkillHub and native Hermes inventories are reconciled by the copied mono2 registry data layer."
        action={<SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => void load()}><RefreshCw size={14} /> Refresh</SettingsButton>}
      >
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
        {notice ? <SettingsNotice tone="success">{notice}</SettingsNotice> : null}
        {failedSources.length > 0 ? <SettingsNotice>Some registries are unavailable: {failedSources.join(", ")}. Source-uncertain entries cannot be removed safely.</SettingsNotice> : null}
        <SettingsGroup>
          {pending === "load" && skills.length === 0 ? <SettingsNotice>Reconciling installed registries…</SettingsNotice> : null}
          {skills.map((skill) => (
            <SettingsListItem
              key={skillIdentity(skill)}
              icon={<Sparkles size={15} />}
              label={skill.name || skill.slug}
              description={skill.rawId}
              metadata={[skill.sourceLabel, skill.version, skill.status].filter(Boolean).join(" · ")}
              actions={skill.uninstallable !== false && !skill.sourceUncertain
                ? <SettingsButton type="button" variant="ghost" aria-label={`Delete ${skill.name}`} disabled={pending !== null} onClick={() => void remove(skill)}><Trash2 size={14} /></SettingsButton>
                : undefined}
            />
          ))}
          {pending !== "load" && skills.length === 0 ? <SettingsNotice>No installed skills.</SettingsNotice> : null}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Discover skills" icon={<Search size={16} />} description="Domestic accounts use SkillHub; international accounts query ClawHub and skills.sh with their distinct identities and commands.">
        <SettingsRow label="Search" htmlFor="hermes-skill-search">
          <div className="lightvela-management-inline">
            <SettingsTextInput id="hermes-skill-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search registry skills" onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />
            <SettingsButton type="button" disabled={pending !== null} onClick={() => void search()}><Search size={14} /> {pending === "search" ? "Searching…" : "Search"}</SettingsButton>
          </div>
        </SettingsRow>
        <SettingsGroup>
          {results.map((skill) => {
            const installed = installedIdentities.has(skillIdentity(skill));
            return (
              <SettingsListItem
                key={skillIdentity(skill)}
                icon={<Download size={15} />}
                label={skill.name || skill.slug}
                description={skill.description || skill.rawId}
                metadata={[skill.registry, formatInstalls(skill.downloads ?? skill.installs)].filter(Boolean).join(" · ")}
                actions={<SettingsButton type="button" variant={installed ? "ghost" : "primary"} disabled={pending !== null || installed} onClick={() => void install(skill)}>{installed ? "Installed" : "Install"}</SettingsButton>}
              />
            );
          })}
          {pending !== "search" && results.length === 0 ? <SettingsNotice>Search a registry or leave the field blank for available recommendations.</SettingsNotice> : null}
        </SettingsGroup>
        <SettingsActions><SettingsButton type="button" disabled={pending !== null} onClick={() => { setQuery(""); void search(""); }}>Browse available</SettingsButton></SettingsActions>
      </SettingsSection>
    </>
  );
}

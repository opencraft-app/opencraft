import { useCallback, useEffect, useState } from "react";

import type { ProfileSkillInstalled } from "@opencraft/appserver-protocol";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSection,
} from "@opencraft/extension-react";

export function profileSkillsTarget(hostId: string, profileId = "default") {
  const normalizedHostId = hostId.trim();
  if (normalizedHostId === "") throw new TypeError("A connected Hermes Host is required");
  return { hostId: normalizedHostId, profileId };
}

export function HermesSkillsManagementView({
  hostId,
  profileId = "default",
  profileSkills,
}: {
  readonly hostId: string;
  readonly profileId?: string;
  readonly profileSkills?: AppServerProfileSkillsService;
}) {
  const [skills, setSkills] = useState<readonly ProfileSkillInstalled[] | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (profileSkills === undefined || hostId.trim() === "") return;
    setError(null);
    try {
      const result = await profileSkills.listInstalled(
        profileSkillsTarget(hostId, profileId),
        { limit: 100, forceReload: true },
      );
      setSkills(result.data);
      setRevision(result.revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [hostId, profileId, profileSkills]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback((skill: ProfileSkillInstalled) => {
    if (profileSkills === undefined || revision === null || pendingSkill !== null) return;
    setPendingSkill(skill.name);
    setError(null);
    void profileSkills.setEnabled(profileSkillsTarget(hostId, profileId), {
      name: skill.name,
      enabled: !skill.enabled,
      expectedRevision: revision,
      operationId: crypto.randomUUID(),
    }).then(() => load()).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => setPendingSkill(null));
  }, [hostId, load, pendingSkill, profileId, profileSkills, revision]);

  if (profileSkills === undefined) {
    return <SettingsNotice tone="error">The connected Hermes Host does not expose the Profile Skills protocol.</SettingsNotice>;
  }
  if (hostId.trim() === "") {
    return <SettingsNotice>Select a Hermes Host to manage its Profile Skills.</SettingsNotice>;
  }

  return (
    <>
      <SettingsPageHeader title="Skills" description={`Installed Skills for Hermes Profile: ${profileId}.`} />
      <SettingsSection title="Installed Skills" description="Skills are managed through the connected Hermes Host; no LightVela account is required.">
        <SettingsActions>
          <SettingsButton type="button" variant="secondary" disabled={pendingSkill !== null} onClick={() => void load()}>
            Refresh
          </SettingsButton>
        </SettingsActions>
        {error === null ? null : <SettingsNotice tone="error">{error}</SettingsNotice>}
        {skills === null ? <SettingsNotice>Loading installed Skills…</SettingsNotice> : skills.length === 0 ? (
          <SettingsNotice>No Skills are installed for this Profile. Refresh after installing a Skill through Hermes.</SettingsNotice>
        ) : (
          <SettingsGroup aria-label="Installed Skills">
            {skills.map((skill) => (
              <SettingsListItem
                key={skill.name}
                label={skill.name}
                description={skill.description}
                metadata={`${skill.category} · ${skill.provenance}`}
                actions={(
                  <SettingsButton
                    type="button"
                    variant="secondary"
                    disabled={pendingSkill !== null}
                    onClick={() => toggle(skill)}
                  >
                    {pendingSkill === skill.name ? "Saving…" : skill.enabled ? "Disable" : "Enable"}
                  </SettingsButton>
                )}
              />
            ))}
          </SettingsGroup>
        )}
      </SettingsSection>
    </>
  );
}

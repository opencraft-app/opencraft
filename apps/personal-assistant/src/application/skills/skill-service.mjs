import { skillDefinition } from "../../domain/skill.mjs";

/** Owns installed content, enablement and execution load receipts. Skills grant no tools. */
export class SkillService {
  constructor({ repository, inbox, uow, assertCurrent, now = Date.now }) {
    Object.assign(this, { repository, inbox, uow, assertCurrent, now });
  }
  install(inputId, params) {
    if (
      !Array.isArray(params.skills) ||
      !params.skills.length ||
      params.skills.length > 32
    )
      throw new Error("Install requires 1..32 skills");
    const definitions = params.skills.map((s) =>
      skillDefinition(s, params.pluginId),
    );
    if (new Set(definitions.map((s) => s.id)).size !== definitions.length)
      throw new Error("Duplicate skill id in bundle");
    return this.inbox.accept(inputId, "skill.install", params, () => {
      if (
        this.repository.countNew(definitions.map((s) => s.id)) +
          this.repository.count() >
        128
      )
        throw new Error("Skill catalog exceeds 128 entries");
      for (const definition of definitions)
        this.repository.install(definition, this.now());
      return {
        installed: definitions.map(({ id, version }) => ({ id, version })),
      };
    });
  }
  enable(inputId, params) {
    if (typeof params.enabled !== "boolean")
      throw new Error("enabled must be boolean");
    return this.inbox.accept(inputId, "skill.enable", params, () => {
      if (!this.repository.get(params.skillId))
        throw new Error("Unknown skill");
      this.repository.enable(params.skillId, params.enabled);
      return { skillId: params.skillId, enabled: params.enabled };
    });
  }
  catalog() {
    return this.repository.catalog();
  }
  snapshot() {
    return this.catalog()
      .filter((s) => s.enabled)
      .map(({ id, version, summary, plugin_id }) => ({
        id,
        version,
        summary,
        pluginId: plugin_id,
      }));
  }
  available(snapshot) {
    return (snapshot.skills ?? []).filter(
      (s) => this.repository.get(s.id)?.enabled,
    );
  }
  load(work, snapshot, skillId) {
    return this.uow.transaction(() => {
      this.assertCurrent(work);
      const captured = this.available(snapshot).find((s) => s.id === skillId);
      if (!captured)
        throw new Error("Skill is not enabled in this execution scope");
      const skill = this.repository.version(skillId, captured.version);
      if (!skill) throw new Error("Pinned skill version is unavailable");
      this.repository.loaded(
        snapshot.executionId,
        skillId,
        captured.version,
        this.now(),
      );
      return {
        id: skillId,
        version: captured.version,
        summary: skill.summary,
        body: skill.body,
      };
    });
  }
  loads(workId) {
    return this.repository.loads(workId);
  }
}

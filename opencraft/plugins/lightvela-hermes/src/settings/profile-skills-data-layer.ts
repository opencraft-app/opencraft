import type {
  AppServerProfileSkillsService,
  ProfileSkillsTarget,
} from "@opencraft/profile-skills-appserver";
import type {
  ProfileSkillAction,
  ProfileSkillCatalogEntry,
} from "@opencraft/appserver-protocol";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

import {
  installSkillsSequentially,
  type InstalledSkill,
  type Registry,
  type SearchRegistry,
  type Skill,
  type SkillsDataLayer,
} from "../upstream/mono2/pages/marketing/skills-demo/skill-registries";

const ACTION_POLL_MS = 1_200;
const ACTION_TIMEOUT_MS = 10 * 60_000;

function registryFor(source: string): Registry {
  const normalized = source.trim().toLowerCase();
  if (normalized.includes("claw")) return "clawhub";
  if (normalized.includes("skills.sh") || normalized.includes("skills-sh") || normalized === "github") return "skills-sh";
  return "skillhub";
}

function catalogSkill(entry: ProfileSkillCatalogEntry): Skill {
  const registry = registryFor(entry.source);
  const segments = entry.identifier.split("/").filter(Boolean);
  return {
    registry,
    rawId: entry.identifier,
    slug: segments.at(-1) ?? entry.identifier,
    name: entry.name,
    description: entry.description,
    ...(entry.tags.length === 0 ? {} : { category: entry.tags[0] }),
  };
}

function installedSkill(entry: {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly provenance: string;
  readonly catalogIdentifier?: string;
}): InstalledSkill {
  const catalogIdentifier = entry.catalogIdentifier;
  const registry = catalogIdentifier === undefined ? "hermes" : registryFor(catalogIdentifier);
  return {
    registry,
    rawId: catalogIdentifier ?? entry.name,
    slug: (catalogIdentifier ?? entry.name).split("/").filter(Boolean).at(-1) ?? entry.name,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    status: entry.enabled ? "enabled" : "disabled",
    nativeSource: entry.provenance,
    sourceLabel: entry.provenance === "catalog"
      ? "Hermes Hub"
      : entry.provenance === "bundled"
        ? "Hermes bundled"
        : entry.provenance === "local"
          ? "Local"
          : "Hermes",
    registries: registry === "hermes" ? ["hermes"] : [registry, "hermes"],
    nativeAliases: [entry.name],
    uninstallable: entry.provenance === "catalog" || entry.provenance === "local",
  };
}

function partition(entries: readonly ProfileSkillCatalogEntry[]) {
  const result: { clawhub: Skill[]; skillssh: Skill[]; skillhub: Skill[] } = {
    clawhub: [],
    skillssh: [],
    skillhub: [],
  };
  for (const entry of entries) {
    const skill = catalogSkill(entry);
    if (skill.registry === "clawhub") result.clawhub.push(skill);
    else if (skill.registry === "skills-sh") result.skillssh.push(skill);
    else result.skillhub.push(skill);
  }
  return result;
}

function failedSources(values: readonly string[]): SearchRegistry[] {
  return [...new Set(values.map(registryFor).filter((value): value is SearchRegistry => value !== "hermes"))];
}

async function waitForAction(
  service: AppServerProfileSkillsService,
  target: ProfileSkillsTarget,
  initial: ProfileSkillAction,
): Promise<ProfileSkillAction> {
  let action = initial;
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (action.state === "accepted" || action.state === "running") {
    if (Date.now() >= deadline) throw new Error(`Skill ${action.kind} is still running after 10 minutes`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, ACTION_POLL_MS));
    action = (await service.readAction(target, { actionId: action.actionId, maxLogLines: 200 })).action;
  }
  return action;
}

function actionMessage(action: ProfileSkillAction): string {
  return action.logLines.at(-1)
    ?? (action.error === undefined ? `Skill ${action.kind} failed` : `${action.error.code}: Skill ${action.kind} failed`);
}

/** Mono2 presentation adapter. All domain commands remain AppServer-owned. */
export function createProfileSkillsDataLayer(
  service: AppServerProfileSkillsService,
  target: ProfileSkillsTarget,
): SkillsDataLayer {
  const ready = () => service.waitForCapability(target.hostId);
  const run = async (request: () => Promise<{ readonly action: ProfileSkillAction }>) => {
    await ready();
    const action = await waitForAction(service, target, (await request()).action);
    return action.state === "succeeded"
      ? { ok: true }
      : { ok: false, message: actionMessage(action) };
  };
  const dataLayer: SkillsDataLayer = {
    async search(keyword, options) {
      await ready();
      throwIfSignalAborted(options?.signal);
      const response = await service.searchCatalog(target, { query: keyword, limit: 100 });
      throwIfSignalAborted(options?.signal);
      return { ...partition(response.data), failedSources: failedSources(response.timedOutSources) };
    },
    async listInstalled() {
      await ready();
      const response = await service.listInstalled(target, { limit: 100, forceReload: true });
      return { skills: response.data.map(installedSkill), failedSources: [] };
    },
    install(skill) {
      return run(() => service.install(target, {
        identifier: skill.rawId,
        operationId: crypto.randomUUID(),
      }));
    },
    uninstall(skill) {
      const installedName = (skill as Partial<InstalledSkill>).nativeAliases?.[0] ?? skill.rawId;
      return run(() => service.uninstall(target, {
        name: installedName,
        operationId: crypto.randomUUID(),
      }));
    },
    async getPopular() {
      await ready();
      const response = await service.listCatalogSources(target);
      return partition(response.featured);
    },
  };
  dataLayer.installBatch = (skills, onProgress, options) => (
    installSkillsSequentially(dataLayer, skills, onProgress, options)
  );
  return dataLayer;
}

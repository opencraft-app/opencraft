import { loadSkills, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import type { SkillsListEntry } from '@opencraft/appserver-protocol/generated/v2';
import { isAbsolute, resolve } from 'node:path';
/** Native Pi discovery: user/project roots stay owned by the native loader. */
export function piSkills(cwd: string, agentDirectory: string) {
  const official = process.env.OPENCRAFT_OFFICIAL_SKILLS_ROOT;
  return loadSkills({cwd,agentDir:agentDirectory,includeDefaults:true,skillPaths:official?[official]:[]});
}
export function piSkillsPrompt(cwd: string, agentDirectory: string) {
  return formatSkillsForPrompt(piSkills(cwd,agentDirectory).skills,'indirect');
}

/** Rescan through Pi's native precedence, validation and deduplication rules. */
export function piSkillCatalog(cwd: string, agentDirectory: string): SkillsListEntry {
  if (!isAbsolute(cwd)) throw new Error('Pi Skill workspace must be an absolute path');
  const { skills, diagnostics } = piSkills(cwd, agentDirectory);
  return {
    cwd,
    skills: skills.map(skill => ({
      name: skill.name, description: skill.description, path: skill.filePath,
      scope: skill.sourceInfo.scope === 'project' ? 'repo' : 'user', enabled: true, pluginId: null,
    })),
    errors: diagnostics.map(diagnostic => ({ path: diagnostic.path ?? cwd, message: diagnostic.message })),
  };
}

/** A retained draft from another engine cannot authorize an arbitrary skill file. */
export function validatePiSkillInput(input: readonly Record<string, unknown>[], cwd: string, agentDirectory: string): void {
  const selected = input.filter(item => item.type === 'skill');
  if (!selected.length) return;
  const { skills } = piSkills(cwd, agentDirectory);
  for (const item of selected) {
    const path = typeof item.path === 'string' && isAbsolute(item.path) ? resolve(item.path) : null;
    if (path === null || !skills.some(skill => skill.name === item.name && resolve(skill.filePath) === path)) {
      throw new Error('Selected Skill is unavailable in this Pi workspace; select it again');
    }
  }
}

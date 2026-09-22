// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  DEFAULT_HERMES_AGENT_ID,
  toHermesNativeProfileId,
} from "./hermes-agent-command";
import { execCommand } from "./hermes-cron-client";

const HERMES_BUNDLED_MANIFEST_MARKER = "__HERMES_BUNDLED_MANIFEST__";
const HERMES_SKILLS_ROOT_MARKER = "__HERMES_SKILLS_ROOT__";
const HERMES_NO_BUNDLED_SKILLS_MARKER = "__HERMES_NO_BUNDLED_SKILLS__";
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function buildHermesProfileRootCommand(profileId: string): string {
  if (profileId === DEFAULT_HERMES_AGENT_ID) {
    return 'HERMES_PROFILE_ROOT="${HERMES_HOME:-$HOME/.hermes}"';
  }
  return `HERMES_PROFILE_ROOT="\${HERMES_HOME:-$HOME/.hermes}/profiles/${profileId}"`;
}

export interface InstalledSkillLoadState {
  status: "idle" | "loading" | "ready" | "error";
  slugs: string[];
  error: string | null;
}

export interface InstalledHermesSkill {
  slug: string;
  category?: string;
  source?: string;
  status?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readInstalledSkillSlug(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
  if (typeof value.slug === "string" && value.slug.trim()) return value.slug.trim();
  return "";
}

function readInstalledSkill(value: unknown): InstalledHermesSkill | null {
  const slug = readInstalledSkillSlug(value);
  if (!slug) return null;
  const source = isRecord(value) && typeof value.source === "string"
    ? value.source.trim()
    : "";
  const category = isRecord(value) && typeof value.category === "string"
    ? value.category.trim()
    : "";
  const status = isRecord(value) && typeof value.status === "string"
    ? value.status.trim()
    : "";
  return {
    slug,
    ...(category ? { category } : {}),
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
  };
}

function getUniqueInstalledSkills(skills: InstalledHermesSkill[]): InstalledHermesSkill[] {
  const bySlug = new Map<string, InstalledHermesSkill>();
  for (const skill of skills) {
    const slug = skill.slug.trim();
    if (!slug) continue;
    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { ...skill, slug });
    } else {
      if (!existing.category && skill.category) existing.category = skill.category;
      if (!existing.source && skill.source) existing.source = skill.source;
      if (!existing.status && skill.status) existing.status = skill.status;
    }
  }
  return Array.from(bySlug.values());
}

function parseInstalledSkillsTable(output: string): InstalledHermesSkill[] {
  const skills: InstalledHermesSkill[] = [];
  let nameIndex = 0;
  let categoryIndex = -1;
  let sourceIndex = -1;
  let statusIndex = -1;
  for (const line of output.split("\n")) {
    if (!/[│┃]/.test(line)) continue;
    const cells = line
      .split(/[│┃]/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.includes("Name") || cells.includes("名称")) {
      nameIndex = Math.max(cells.indexOf("Name"), cells.indexOf("名称"));
      categoryIndex = Math.max(cells.indexOf("Category"), cells.indexOf("分类"));
      sourceIndex = Math.max(cells.indexOf("Source"), cells.indexOf("来源"));
      statusIndex = Math.max(cells.indexOf("Status"), cells.indexOf("状态"));
      continue;
    }
    const slug = cells[nameIndex]?.trim();
    if (!slug) continue;
    const category = categoryIndex >= 0 ? cells[categoryIndex]?.trim() : "";
    const source = sourceIndex >= 0 ? cells[sourceIndex]?.trim() : "";
    const status = statusIndex >= 0 ? cells[statusIndex]?.trim() : "";
    skills.push({
      slug,
      ...(category ? { category } : {}),
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
    });
  }
  return getUniqueInstalledSkills(skills);
}

export function buildInstalledSkillsListCommand(profileId: string = DEFAULT_HERMES_AGENT_ID): string {
  return `HERMES_BASE="\${HERMES_HOME:-$HOME/.hermes}"; ${buildHermesProfileRootCommand(profileId)}; cd "$HERMES_BASE/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main -p ${shellQuote(toHermesNativeProfileId(profileId))} skills list && { printf '\\n${HERMES_BUNDLED_MANIFEST_MARKER}\\n'; if test -f "$HERMES_PROFILE_ROOT/skills/.bundled_manifest"; then cat "$HERMES_PROFILE_ROOT/skills/.bundled_manifest"; fi; } && { printf '\\n${HERMES_SKILLS_ROOT_MARKER}\\n'; if test -d "$HERMES_PROFILE_ROOT/skills"; then find "$HERMES_PROFILE_ROOT/skills" -mindepth 2 -type f -name SKILL.md -print; fi; } && { if test -f "$HERMES_PROFILE_ROOT/.no-bundled-skills"; then printf '\\n${HERMES_NO_BUNDLED_SKILLS_MARKER}\\n'; fi; }`;
}

export function hasHermesBundledSkillsOptOut(output: string): boolean {
  return output.includes(HERMES_NO_BUNDLED_SKILLS_MARKER);
}

/** GitHub 仓库子目录作为技能来源 */
export interface GithubSkillSource {
  /** owner/repo，如 NousResearch/hermes-agent */
  repo: string;
  /** 分支名，如 main 或 feature/stocks；不支持 tag 或 commit SHA。 */
  ref: string;
  /** 仓库内目录，如 optional-skills/finance/stocks */
  path: string;
}

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const GITHUB_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
// 安装目录允许多层，官方技能会保留 category 层级（如 finance/stocks）
const SKILL_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * 从 GitHub 仓库子目录安装 Hermes 技能。
 *
 * 为什么不调用 CLI：
 *   官方文档写的是 `hermes skills install <ref>`，但沙箱里既没有 `hermes`
 *   可执行文件，`hermes_cli.main` 也没有 install 子命令的先例（同文件只用到
 *   skills list）。所以这里不猜 CLI，直接按技能的落盘契约安装。
 *
 * 落盘契约（由同文件两处代码确证，非推测）：
 *   - buildInstalledSkillsListCommand 用
 *     `find "$HERMES_PROFILE_ROOT/skills" -mindepth 2 -name SKILL.md` 发现技能
 *   - buildHermesSkillDeleteCommand 直接 rm -rf 技能目录
 *   ⇒ 把目录放到 skills/<name>/ 且含 SKILL.md 即视为已安装。
 *
 * 实现要点：
 *   - 下载 codeload tarball，只解出目标子目录（--strip-components）
 *   - 先在临时目录校验 SKILL.md 存在，再原子替换，避免装出半个技能
 *   - 全部入参走白名单正则，挡命令注入与路径穿越
 *
 * @param installDir 相对 skills/ 的安装目录，可含多层。必须与 SKILL.md 里
 *   自述的路径一致 —— agent 会照着 SKILL.md 的示例命令执行脚本，层级装错
 *   会 file-not-found。例：stocks 技能的 SKILL.md 写的是
 *   `~/.hermes/skills/finance/stocks/scripts/stocks_client.py`，
 *   所以必须传 "finance/stocks" 而不是 "stocks"。
 */
export function buildGithubSkillInstallCommand(
  source: GithubSkillSource,
  installDir: string,
  profileId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  const repo = source.repo.trim();
  const ref = source.ref.trim();
  const path = source.path.trim().replace(/\/+$/, "");
  const dirName = installDir.trim().replace(/\/+$/, "");

  if (!GITHUB_REPO_PATTERN.test(repo)) throw new Error("Invalid GitHub repo");
  if (!GITHUB_REF_PATTERN.test(ref) || ref.includes("..")) throw new Error("Invalid GitHub ref");
  if (!GITHUB_PATH_PATTERN.test(path) || path.includes("..")) throw new Error("Invalid GitHub path");
  if (!SKILL_DIR_PATTERN.test(dirName) || dirName.includes("..")) {
    throw new Error("Invalid skill directory name");
  }

  // tarball 顶层目录是 <repo>-<ref>，加上子目录层数一起剥掉
  const repoName = repo.split("/")[1]!;
  const tarballTopDir = `${repoName}-${ref.replace(/\//g, "-")}`;
  const stripDepth = 1 + path.split("/").length;
  const tarUrl = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`;

  const skillDir = `"$HERMES_PROFILE_ROOT/skills/${dirName}"`;
  // 前置语句用 ; 分隔（含 trap），实际安装步骤用 && 串成失败即停
  const prelude = [
    buildHermesProfileRootCommand(profileId),
    'SKILL_TMP="$(mktemp -d)"',
    // 无论成功失败都清理临时目录，不留垃圾
    `trap 'rm -rf "$SKILL_TMP"' EXIT`,
  ].join("; ");

  const install = [
    `curl -fsSL --retry 3 --max-time 300 ${shellQuote(tarUrl)} -o "$SKILL_TMP/repo.tar.gz"`,
    `mkdir -p "$SKILL_TMP/extract"`,
    `tar -xzf "$SKILL_TMP/repo.tar.gz" -C "$SKILL_TMP/extract" --strip-components=${stripDepth} ${shellQuote(`${tarballTopDir}/${path}`)}`,
    // 没有 SKILL.md 就不是合法技能，直接失败而不是装个空目录进去
    `{ test -f "$SKILL_TMP/extract/SKILL.md" || { echo ${shellQuote(`SKILL.md not found in ${path}`)} >&2; exit 1; }; }`,
    // 多层安装目录（如 finance/stocks）需要先建出父目录
    `mkdir -p "$(dirname ${skillDir})"`,
    // 先删旧目录再整体拷入，避免残留上一版本的文件
    `rm -rf ${skillDir}`,
    `cp -R "$SKILL_TMP/extract" ${skillDir}`,
    // scripts/ 下的脚本需要可执行位，tar 通常保留，这里兜底
    `{ find ${skillDir} -type f \\( -name "*.sh" -o -name "*.py" \\) -exec chmod +x {} + 2>/dev/null || true; }`,
    // 收尾自检：落盘结果满足 skills/<name>/SKILL.md 契约才算装好
    `test -f ${skillDir}/SKILL.md`,
  ].join(" && ");

  return `${prelude}; ${install}`;
}

export function buildHermesSkillDeleteCommand(slug: string, profileId: string = DEFAULT_HERMES_AGENT_ID): string {
  const normalized = slug.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("Invalid Hermes skill slug");
  }
  const findSkill = `find "$HERMES_PROFILE_ROOT/skills" -mindepth 1 -type d -name "${normalized}" -exec test -f "{}/SKILL.md" \\; -print -quit`;
  const deleteSkill = `find "$HERMES_PROFILE_ROOT/skills" -mindepth 1 -type d -name "${normalized}" -exec test -f "{}/SKILL.md" \\; -prune -exec rm -rf -- {} +`;
  return `${buildHermesProfileRootCommand(profileId)}; test -d "$HERMES_PROFILE_ROOT/skills" && ${findSkill} | grep -q . || { echo "Hermes skill not found: ${normalized}" >&2; exit 1; }; ${deleteSkill} && ! ${findSkill} | grep -q .`;
}

export function getUniqueSkillSlugs(skillSlugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const skillSlug of skillSlugs) {
    const normalized = skillSlug.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseInstalledSkillsOutput(output: string): InstalledHermesSkill[] {
  if (!output.trim()) return [];

  try {
    const parsed = JSON.parse(output) as unknown;
    const payload = isRecord(parsed) && parsed.success === true && isRecord(parsed.data)
      ? parsed.data
      : parsed;
    const items = isRecord(payload) && Array.isArray(payload.skills)
      ? payload.skills
      : Array.isArray(payload)
        ? payload
        : null;
    if (items) {
      return getUniqueInstalledSkills(
        items.map(readInstalledSkill).filter((skill): skill is InstalledHermesSkill => skill !== null),
      );
    }
  } catch {
    // Non-JSON output falls through to table/plain-text parsing.
  }

  const tableSkills = parseInstalledSkillsTable(output);
  if (tableSkills.length > 0) return tableSkills;

  return getUniqueInstalledSkills(
    output.split("\n").map(readInstalledSkill).filter((skill): skill is InstalledHermesSkill => skill !== null),
  );
}

function parseBundledSkillNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const normalized = line.trim();
    const separatorIndex = normalized.indexOf(":");
    if (separatorIndex <= 0) continue;
    names.add(normalized.slice(0, separatorIndex).trim().toLocaleLowerCase());
  }
  return names;
}

function parseSkillNamesFromPaths(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const normalized = line.trim().replace(/\/+$/, "");
    if (!normalized.endsWith("/SKILL.md")) continue;
    const skillDirectory = normalized.slice(0, -"/SKILL.md".length);
    const separatorIndex = skillDirectory.lastIndexOf("/");
    const name = skillDirectory.slice(separatorIndex + 1).trim();
    if (name) names.add(name.toLocaleLowerCase());
  }
  return names;
}

export function parseInstalledSkills(output: string): InstalledHermesSkill[] {
  const bundledMarkerIndex = output.indexOf(HERMES_BUNDLED_MANIFEST_MARKER);
  const skillsRootMarkerIndex = output.indexOf(HERMES_SKILLS_ROOT_MARKER);
  const markerIndexes = [bundledMarkerIndex, skillsRootMarkerIndex].filter((index) => index >= 0);
  const skillsOutput = markerIndexes.length > 0 ? output.slice(0, Math.min(...markerIndexes)) : output;
  const skills = parseInstalledSkillsOutput(skillsOutput);
  if (bundledMarkerIndex < 0 && skillsRootMarkerIndex < 0) return skills;

  const bundledSectionEnd = skillsRootMarkerIndex > bundledMarkerIndex
    ? skillsRootMarkerIndex
    : output.length;
  const bundledSkillNames = bundledMarkerIndex >= 0
    ? parseBundledSkillNames(output.slice(
      bundledMarkerIndex + HERMES_BUNDLED_MANIFEST_MARKER.length,
      bundledSectionEnd,
    ))
    : new Set<string>();
  const hermesRootSkillNames = skillsRootMarkerIndex >= 0
    ? parseSkillNamesFromPaths(output.slice(skillsRootMarkerIndex + HERMES_SKILLS_ROOT_MARKER.length))
    : new Set<string>();

  return skills.map((skill) => {
    const normalizedSlug = skill.slug.toLocaleLowerCase();
    if (bundledSkillNames.has(normalizedSlug)) return { ...skill, source: "builtin" };
    if (hermesRootSkillNames.has(normalizedSlug)) return { ...skill, source: "other" };
    return skill;
  });
}

export function parseInstalledSkillSlugs(output: string): string[] {
  return parseInstalledSkills(output).map((skill) => skill.slug);
}

export function formatInstalledSkillDisplayName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function matchesInstalledSkillSearch(slug: string, displayName: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return slug.toLocaleLowerCase().includes(normalizedQuery)
    || displayName.toLocaleLowerCase().includes(normalizedQuery);
}

export async function listInstalledSkillSlugs(botId: string, profileId: string = DEFAULT_HERMES_AGENT_ID): Promise<string[]> {
  const result = await execCommand(botId, buildInstalledSkillsListCommand(profileId));
  return parseInstalledSkillSlugs(result.output);
}

/**
 * 模板 → 真实配置的编排层
 * ──────────────────────────────────────────────────────────────
 * 把一个 AgentTemplate 拆解成「落到沙箱里的具体命令」，供创建流程按步执行。
 *
 * 重要背景：本项目**没有任何写配置的 REST API**。SOUL / Skill / Cron / 用户画像
 * 全部通过 `repositories.bots.execDebugCommand(botId, command)` 在沙箱里跑 shell
 * （`hermes` / `acli` CLI + Python）。所以这一层的产物就是命令字符串。
 *
 * 本文件只做**纯函数**：输入模板与资料，输出计划（步骤 + 命令）。
 * 不发请求、不碰 DOM，因此可以完整单测 —— 真实执行交给调用方。
 *
 * 关于「记忆」：MEMORY.md 是 Agent 自己在对话中维护的工作记忆，前端不应伪造。
 * 模板里的 memories 因此写入 **USER.md（用户画像）**，语义上才成立。
 */

import { buildSoulMd } from "@/lib/soul-interpretations";
import { getHermesProfileRootCommand } from "@/lib/hermes-agent-command";
import { buildCreateCommand, shellQuote, type CreateCronJobInput } from "@/lib/hermes-cron-client";
import { buildHermesSoulWriteCommand } from "@/pages/marketing/agent-buddy-command";
import { buildGithubSkillInstallCommand } from "@/lib/hermes-skills-client";
import { buildSkillsshInstallCommand } from "@/pages/marketing/skills-demo/skill-registries";
import { buildInstallSkillCommand } from "@/pages/marketing/agent-experts-panel";
import type { AgentTemplate } from "@/pages/marketing/agent-demo-templates";

/** 用户在引导表单里填的资料 */
export interface BuddyProfileInput {
  name: string;
  /** 逗号/顿号分隔的标签，可为空 */
  tags: string;
  /** 描述，可为空 */
  description: string;
}

export type SetupStepKind = "soul" | "user-profile" | "skill" | "cron";

export interface SetupStep {
  kind: SetupStepKind;
  /** 面向用户的进度文案（已本地化的原文，调用方按需 t()） */
  label: string;
  /** 要在沙箱里执行的命令 */
  command: string;
  /** 该步骤的建议超时（毫秒） */
  timeoutMs: number;
  /**
   * 失败是否阻断整个流程。
   * SOUL 是身份基石，失败必须让用户知道；技能 / 定时任务失败可降级为「稍后重试」。
   */
  required: boolean;
}

/* ── 各步骤超时：对齐各自现有实现的量级 ── */

/** SOUL 写入：沿用 HERMES_PERSONA_COMMAND_TIMEOUT_MS */
export const SOUL_STEP_TIMEOUT_MS = 120_000;
/** 单个技能安装：沿用 agent-experts-panel 的 SKILL_PACKAGE_COMMAND_TIMEOUT_MS */
export const SKILL_STEP_TIMEOUT_MS = 120_000;
/** cron 创建 / USER.md 写入：短命令 */
export const QUICK_STEP_TIMEOUT_MS = 60_000;

/** 标签字符串 → 数组（支持「、」「,」「，」三种分隔） */
export const parseBuddyTags = (tags: string): string[] => (
  tags
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
);

/**
 * 拼装 SOUL.md 的人设正文。
 *
 * 模板存在时以模板的 instructions 为骨架，再把用户填的描述/标签作为补充约束，
 * 让「用户自定义」不会被模板整段覆盖。
 */
export const buildBuddySoulContent = (
  profile: BuddyProfileInput,
  template?: AgentTemplate,
): string => {
  const sections: string[] = [];

  if (template) {
    sections.push(template.instructions.trim());
  }

  const description = profile.description.trim();
  if (description) {
    sections.push(`## 用户期望\n${description}`);
  }

  const tags = parseBuddyTags(profile.tags);
  if (tags.length > 0) {
    sections.push(`## 关注领域\n${tags.map((tag) => `- ${tag}`).join("\n")}`);
  }

  // 三者都空时给一句兜底，避免写出空的 ## Content
  if (sections.length === 0) {
    sections.push("你是我的智能伙伴，帮助我处理日常任务。回答简洁直接，先给结论再给理由。");
  }

  return sections.join("\n\n");
};

/** name → SOUL slug（ASCII 化，中文名回落到时间戳后缀） */
export const buildBuddySoulSlug = (name: string, fallbackSuffix: string): string => {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii ? `buddy-${ascii}` : `buddy-${fallbackSuffix}`;
};

/* ────────────────── SOUL 自定义元数据：标签 + 头像 ──────────────────
 * SOUL.md 原生只有 Slug / Name / Summary，而资料卡还需要「标签」和「几何体头像」。
 * 沿用既有的 `LightVela-Source` 先例，加两个自定义字段，让这两项跟着 bot 走
 * （换设备、换浏览器都不丢，优于存本地）。
 */

export const SOUL_TAGS_FIELD = "LightVela-Tags";
export const SOUL_AVATAR_FIELD = "LightVela-Avatar";

/** 头像序列化：`<shapeId>:<color>`，例 `blob:#B7A6F3` */
export const serializeAvatar = (shapeId: string, color: string): string => `${shapeId}:${color}`;

export const parseAvatarField = (
  value: string | null,
): { shapeId: string; color: string } | null => {
  if (!value) return null;
  const index = value.indexOf(":");
  if (index <= 0) return null;
  const shapeId = value.slice(0, index).trim();
  const color = value.slice(index + 1).trim();
  return shapeId && color ? { shapeId, color } : null;
};

/**
 * 把自定义字段插进 SOUL 的元数据区（`# Soul` 与 `## Content` 之间）。
 *
 * 不直接改 buildSoulMd —— 那是 SkillHub 共用的标准格式，
 * 这里只在生成后追加自己的字段，避免影响其它调用方。
 */
export const injectSoulMetadata = (
  markdown: string,
  fields: Record<string, string | undefined>,
): string => {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => Boolean(entry[1]?.trim()),
  );
  if (entries.length === 0) return markdown;

  const lines = markdown.split("\n");
  // 插在 ## Content 之前（元数据区末尾）；找不到就退回追加到开头之后
  const contentIndex = lines.findIndex((line) => line.startsWith("## Content"));
  const insertAt = contentIndex > 0 ? contentIndex - 1 : 1;
  const extra = entries.map(([key, value]) => `${key}: ${value.trim()}`);
  lines.splice(insertAt, 0, ...extra);
  return lines.join("\n");
};

/** 从 SOUL markdown 的元数据区读一个字段 */
export const readSoulField = (markdown: string, field: string): string | null => {
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    // 元数据区在 ## Content 之前，越界即停，避免误读正文里的同名行
    if (line.startsWith("## ")) break;
    const prefix = `${field}:`;
    if (line.startsWith(prefix)) {
      const value = line.slice(prefix.length).trim();
      return value || null;
    }
  }
  return null;
};

/** 从 SOUL markdown 还原资料卡所需的全部字段 */
export const parseBuddyProfileFromSoul = (markdown: string) => ({
  name: readSoulField(markdown, "Name"),
  summary: readSoulField(markdown, "Summary"),
  tags: readSoulField(markdown, SOUL_TAGS_FIELD),
  avatar: parseAvatarField(readSoulField(markdown, SOUL_AVATAR_FIELD)),
});

/** 生成 SOUL.md 的完整 markdown（含标签 / 头像自定义字段） */
export const buildBuddySoulMarkdown = (
  profile: BuddyProfileInput,
  template: AgentTemplate | undefined,
  fallbackSuffix: string,
  avatar?: { shapeId: string; color: string },
): string => {
  const base = buildSoulMd({
    slug: buildBuddySoulSlug(profile.name, fallbackSuffix),
    displayName: profile.name,
    summary: profile.description.trim() || template?.description,
    content: buildBuddySoulContent(profile, template),
  });
  return injectSoulMetadata(base, {
    [SOUL_TAGS_FIELD]: profile.tags.trim() || undefined,
    [SOUL_AVATAR_FIELD]: avatar ? serializeAvatar(avatar.shapeId, avatar.color) : undefined,
  });
};

/**
 * 写入 USER.md（用户画像）。
 *
 * 与 SOUL 写入同构：base64 heredoc + mktemp + 原子 mv，避免半截文件。
 * 已存在内容时**追加**而非覆盖 —— 用户画像是累积的，不该被模板抹掉。
 */
export const buildUserProfileWriteCommand = (
  markdownBase64: string,
  profileId = "main",
): string => [
  "set -eo pipefail",
  getHermesProfileRootCommand(profileId, "HERMES_ROOT"),
  'MEM_DIR="$HERMES_ROOT/memories"',
  'mkdir -p "$MEM_DIR"',
  'TARGET="$MEM_DIR/USER.md"',
  'TEMP="$(mktemp "$MEM_DIR/.USER.md.tmp.XXXXXX")"',
  "trap 'rm -f \"$TEMP\"' EXIT",
  'if [ -s "$TARGET" ]; then cat "$TARGET" > "$TEMP"; printf \'\\n\' >> "$TEMP"; fi',
  "cat <<'__CTL_USER_EOF__' | base64 -d >> \"$TEMP\"",
  markdownBase64,
  "__CTL_USER_EOF__",
  'test -s "$TEMP"',
  'mv "$TEMP" "$TARGET"',
  "trap - EXIT",
].join("\n");

/** 模板的 memories → USER.md 片段 */
export const buildUserProfileMarkdown = (template: AgentTemplate): string => [
  `## ${template.name} 预设画像`,
  "",
  ...template.memories.map((item) => `- ${item}`),
  "",
].join("\n");

/**
 * 定时任务的调度文案 → cron 表达式。
 *
 * 只支持平台真实能解析的形式（见 automation-template-catalog.ts 的
 * toAutomationTemplateSchedule）：daily / weekly / interval。
 * 无法识别时返回 null，调用方应跳过该条而不是猜一个。
 */
export const toCronExpression = (label: string): string | null => {
  const normalized = label.trim();

  // 「每 6 小时」/「每 30 分钟」
  const interval = /^每\s*(\d+)\s*(小时|分钟)$/.exec(normalized);
  if (interval) {
    const amount = Number(interval[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return interval[2] === "小时" ? `0 */${amount} * * *` : `*/${amount} * * * *`;
  }

  const time = /(\d{1,2}):(\d{2})/.exec(normalized);
  if (!time) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return null;

  // 「工作日 10:00」
  if (normalized.startsWith("工作日")) return `${minute} ${hour} * * 1-5`;

  // 「每周日 18:00」等
  const weekdayMap: Record<string, number> = {
    日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  };
  const weekly = /^每周([日一二三四五六])/.exec(normalized);
  if (weekly) {
    const day = weekdayMap[weekly[1]!];
    if (day === undefined) return null;
    return `${minute} ${hour} * * ${day}`;
  }

  // 「每天 08:00」
  if (normalized.startsWith("每天")) return `${minute} ${hour} * * *`;

  return null;
};

/** 模板的一条 routine → hermes cron create 命令；无法解析调度时返回 null */
export const buildRoutineCommand = (
  routine: AgentTemplate["routines"][number],
  templateName: string,
): string | null => {
  const schedule = toCronExpression(routine.label);
  if (!schedule) return null;
  const input: CreateCronJobInput = {
    schedule,
    name: `${templateName} · ${routine.label}`,
    prompt: routine.desc,
  };
  return buildCreateCommand(input);
};

/**
 * 生成完整的配置计划。
 *
 * 顺序有意为之：SOUL 先落（身份是后续一切的基础），再写画像，
 * 然后装技能（耗时最长），最后建定时任务（依赖技能已就位）。
 */
export const buildBuddySetupPlan = (params: {
  profile: BuddyProfileInput;
  template?: AgentTemplate;
  profileId?: string;
  /** 几何体头像，写入 SOUL 自定义字段 */
  avatar?: { shapeId: string; color: string };
  /** 注入时间戳，便于测试与备份命名 */
  timestamp: string;
}): SetupStep[] => {
  const { profile, template, profileId = "main", avatar, timestamp } = params;
  const steps: SetupStep[] = [];

  // 1. SOUL.md —— 名字 / 描述 / 标签 / 头像 / 人设
  const soulMarkdown = buildBuddySoulMarkdown(profile, template, timestamp, avatar);
  steps.push({
    kind: "soul",
    label: "正在写入智能伙伴人设",
    command: buildHermesSoulWriteCommand(
      encodeBase64(soulMarkdown),
      timestamp,
      profileId,
    ),
    timeoutMs: SOUL_STEP_TIMEOUT_MS,
    required: true,
  });

  // 2. USER.md —— 模板预设画像（原「记忆」）
  if (template && template.memories.length > 0) {
    steps.push({
      kind: "user-profile",
      label: "正在写入用户画像",
      command: buildUserProfileWriteCommand(
        encodeBase64(buildUserProfileMarkdown(template)),
        profileId,
      ),
      timeoutMs: QUICK_STEP_TIMEOUT_MS,
      required: false,
    });
  }

  // 3. 技能安装
  for (const skill of template?.skills ?? []) {
    steps.push({
      kind: "skill",
      label: `正在安装技能 ${skill.name}`,
      // 三种来源命令不同，见 TemplateSkill 的注释：
      //   githubSource → 拉 GitHub 目录落盘；skillsShId → acli skills-sh；其余 → SkillHub
      command: skill.githubSource
        ? buildGithubSkillInstallCommand(skill.githubSource, skill.installDir ?? skill.slug, profileId)
        : skill.skillsShId
          ? buildSkillsshInstallCommand(skill.skillsShId)
          : buildInstallSkillCommand(skill.slug),
      timeoutMs: SKILL_STEP_TIMEOUT_MS,
      required: false,
    });
  }

  // 4. 定时任务
  for (const routine of template?.routines ?? []) {
    const command = buildRoutineCommand(routine, template!.name);
    // 调度无法解析时直接跳过，不猜一个可能错的 cron
    if (!command) continue;
    steps.push({
      kind: "cron",
      label: `正在创建定时任务 ${routine.label}`,
      command,
      timeoutMs: QUICK_STEP_TIMEOUT_MS,
      required: false,
    });
  }

  return steps;
};

/**
 * UTF-8 → base64。
 *
 * 浏览器的 btoa 只吃 latin1，中文会抛 InvalidCharacterError，
 * 所以先用 TextEncoder 转字节再编码。
 */
export const encodeBase64 = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** 供调用方展示的技能 slug 列表（用于「稍后重试」提示） */
export const collectSkillSlugs = (template?: AgentTemplate): string[] => (
  (template?.skills ?? []).map((skill) => skill.slug)
);

/** 供调试：把计划渲染成可读文本 */
export const describeSetupPlan = (steps: SetupStep[]): string => (
  steps.map((step, index) => `${index + 1}. [${step.kind}] ${step.label}`).join("\n")
);

/** shellQuote 再导出，方便调用方拼装额外命令时保持同一套转义 */
export { shellQuote };

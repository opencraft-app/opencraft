import { describe, expect, it } from "vitest";

import {
  SOUL_AVATAR_FIELD,
  SOUL_TAGS_FIELD,
  buildBuddySetupPlan,
  buildBuddySoulContent,
  buildBuddySoulMarkdown,
  buildBuddySoulSlug,
  buildRoutineCommand,
  buildUserProfileMarkdown,
  buildUserProfileWriteCommand,
  encodeBase64,
  injectSoulMetadata,
  parseAvatarField,
  parseBuddyProfileFromSoul,
  toCronExpression,
  updateSoulMetadataFields,
} from "@/pages/marketing/agent-buddy-setup";
import { DEMO_TEMPLATES, __TEMPLATE_DEFS_FOR_TEST, resolveTemplatesForRegion } from "@/pages/marketing/agent-demo-templates";
import { withHermesSkillsProfile } from "@/lib/hermes-agent-command";
import { buildSkillhubInstallCommand } from "@/pages/marketing/skills-demo/skill-registries";

const template = DEMO_TEMPLATES[0]!;
/* 带技能的模板 —— 有的模板（如健康管家）刻意不配技能，
   涉及 skill 步骤的断言必须挑一个真的有技能的 */
const templateWithSkills = DEMO_TEMPLATES.find((item) => item.skills.length > 0)!;

describe("buildBuddySoulSlug", () => {
  it("slugifies ASCII names", () => {
    expect(buildBuddySoulSlug("My Helper", "20260914")).toBe("buddy-my-helper");
  });

  it("falls back to the suffix when the name has no ASCII", () => {
    expect(buildBuddySoulSlug("我的 Hermes", "20260914")).toBe("buddy-hermes");
    expect(buildBuddySoulSlug("程序员", "20260914")).toBe("buddy-20260914");
  });
});

describe("buildBuddySoulContent", () => {
  it("keeps the template instructions as the backbone", () => {
    const content = buildBuddySoulContent({ name: "x", description: "" }, template);
    expect(content).toContain(template.instructions.trim());
  });

  it("appends the user description without dropping the template", () => {
    const content = buildBuddySoulContent(
      { name: "x", description: "帮我盯竞品" },
      template,
    );
    expect(content).toContain(template.instructions.trim());
    // 有模板时才需要小节标题：区分「模板给的」与「用户要的」
    expect(content).toContain("## 用户期望\n帮我盯竞品");
  });

  it("writes the description as plain body when no template is used", () => {
    const content = buildBuddySoulContent(
      { name: "x", description: "帮我盯项目进度" },
      undefined,
    );
    /*
     * 空白创建时描述就是全部正文，不该再套 `## 用户期望` ——
     * 那会让文件出现 `## Content` 紧跟 `## 用户期望` 的双标题。
     * 功能上无碍，但这份 SOUL.md 用户自己也会打开看。
     */
    expect(content).toBe("帮我盯项目进度");
    expect(content).not.toContain("## 用户期望");
  });

  it("no longer emits a tags section", () => {
    // 标签已移除 —— hermes 的 profile.yaml 没有 tags 字段，
    // 塞进 SOUL 只会白占模型上下文
    const content = buildBuddySoulContent({ name: "x", description: "帮我盯竞品" }, template);
    expect(content).not.toContain("## 关注领域");
  });

  it("never produces empty content when everything is blank", () => {
    const content = buildBuddySoulContent({ name: "x", description: "" }, undefined);
    expect(content.trim().length).toBeGreaterThan(0);
  });
});

describe("buildBuddySoulMarkdown", () => {
  it("emits the canonical SOUL sections", () => {
    const markdown = buildBuddySoulMarkdown(
      { name: "我的 Hermes", description: "帮我处理日常" },
      template,
      "20260914",
    );
    expect(markdown).toContain("# Soul");
    expect(markdown).toContain("Name: 我的 Hermes");
    expect(markdown).toContain("Summary: 帮我处理日常");
    expect(markdown).toContain("## Content");
  });

  it("borrows the template description when the user left it blank", () => {
    const markdown = buildBuddySoulMarkdown(
      { name: "n", description: "" },
      template,
      "20260914",
    );
    expect(markdown).toContain(`Summary: ${template.description}`);
  });
});

describe("toCronExpression", () => {
  it.each([
    ["每天 08:00", "0 8 * * *"],
    ["每天 21:30", "30 21 * * *"],
    ["工作日 10:00", "0 10 * * 1-5"],
    ["每周日 18:00", "0 18 * * 0"],
    ["每周五 17:00", "0 17 * * 5"],
    ["每 6 小时", "0 */6 * * *"],
    ["每 30 分钟", "*/30 * * * *"],
  ])("maps %s to %s", (label, expected) => {
    expect(toCronExpression(label)).toBe(expected);
  });

  it("returns null for schedules the platform cannot express", () => {
    // 事件触发 / 月度 / 自然语言，平台的 cron 解析都不支持
    expect(toCronExpression("财报季自动跟踪")).toBeNull();
    expect(toCronExpression("每月 1 日")).toBeNull();
    expect(toCronExpression("")).toBeNull();
  });

  it("rejects out-of-range clock values", () => {
    expect(toCronExpression("每天 25:00")).toBeNull();
    expect(toCronExpression("每天 10:70")).toBeNull();
  });
});

describe("buildRoutineCommand", () => {
  it("builds a hermes cron create command with a quoted schedule and prompt", () => {
    const command = buildRoutineCommand({ label: "每天 08:00", desc: "生成晨报" }, "办公助手");
    // prompt 是位置参数（紧跟 schedule），不是 --prompt 选项
    expect(command).toBe("hermes cron create '0 8 * * *' '生成晨报' --name '办公助手 · 每天 08:00'");
  });

  it("returns null when the schedule cannot be parsed", () => {
    expect(buildRoutineCommand({ label: "财报季", desc: "x" }, "t")).toBeNull();
  });
});

describe("buildUserProfileWriteCommand", () => {
  it("appends instead of overwriting so existing profile survives", () => {
    const command = buildUserProfileWriteCommand(encodeBase64("- 喜欢简洁"), "main");
    expect(command).toContain('if [ -s "$TARGET" ]; then cat "$TARGET" > "$TEMP"');
    // 追加用 >>，不是 >
    expect(command).toContain('base64 -d >> "$TEMP"');
    expect(command).toContain("memories");
    expect(command).toContain("USER.md");
  });

  it("writes atomically via mktemp + mv", () => {
    const command = buildUserProfileWriteCommand(encodeBase64("x"));
    expect(command).toContain("mktemp");
    expect(command).toContain('mv "$TEMP" "$TARGET"');
    expect(command).toContain('test -s "$TEMP"');
  });
});

describe("buildUserProfileMarkdown", () => {
  it("renders template memories as a bullet list", () => {
    const markdown = buildUserProfileMarkdown(template);
    expect(markdown).toContain(`## ${template.name} 预设画像`);
    for (const memory of template.memories) {
      expect(markdown).toContain(`- ${memory}`);
    }
  });
});

describe("encodeBase64", () => {
  it("round-trips non-ASCII content (btoa alone would throw)", () => {
    const source = "你是我的智能伙伴，帮助我处理日常任务";
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encodeBase64(source)), (char) => char.charCodeAt(0)),
    );
    expect(decoded).toBe(source);
  });
});

describe("updateSoulMetadataFields", () => {
  /** 模拟一个用户在对话里调教过的 SOUL：正文是他自己写的人设 */
  const userAuthored = [
    "# Soul",
    "Slug: buddy-old",
    "Name: 旧名字",
    "Summary: 旧描述",
    "",
    "## Content",
    "你是我的私人助理，说话要像老朋友一样随意。",
    "",
    "## 我的偏好",
    "- 不要用敬语",
    "- 回答先给结论",
  ].join("\n");

  it("never touches the body — the whole point of this function", () => {
    const next = updateSoulMetadataFields(userAuthored, {
      Name: "新名字",
      Summary: "新描述",
    });
    // 正文逐行原样保留，这是防止「编辑资料冲掉对话调教人设」的核心保证
    expect(next).toContain("你是我的私人助理，说话要像老朋友一样随意。");
    expect(next).toContain("## 我的偏好");
    expect(next).toContain("- 不要用敬语");
    expect(next).toContain("- 回答先给结论");
  });

  it("replaces existing metadata fields in place", () => {
    const next = updateSoulMetadataFields(userAuthored, {
      Name: "新名字",
      Summary: "新描述",
    });
    expect(next).toContain("Name: 新名字");
    expect(next).toContain("Summary: 新描述");
    expect(next).not.toContain("Name: 旧名字");
    expect(next).not.toContain("Summary: 旧描述");
    // 未指定的字段保持原样
    expect(next).toContain("Slug: buddy-old");
  });

  it("inserts a field that does not exist yet, before the body", () => {
    const withoutSummary = ["# Soul", "Name: n", "", "## Content", "正文"].join("\n");
    const next = updateSoulMetadataFields(withoutSummary, { Summary: "新描述" });
    expect(next.indexOf("Summary: 新描述")).toBeLessThan(next.indexOf("## Content"));
    expect(next).toContain("正文");
  });

  it("deletes a field when given an empty string", () => {
    const next = updateSoulMetadataFields(userAuthored, { Summary: "" });
    expect(next).not.toContain("Summary:");
    expect(next).toContain("Name: 旧名字");
    expect(next).toContain("你是我的私人助理，说话要像老朋友一样随意。");
  });

  it("ignores undefined values so callers can patch selectively", () => {
    const next = updateSoulMetadataFields(userAuthored, {
      Name: "新名字",
      Summary: undefined,
    });
    expect(next).toContain("Name: 新名字");
    expect(next).toContain("Summary: 旧描述");
  });

  it("does not mistake body lines for metadata", () => {
    const tricky = [
      "# Soul",
      "Name: real",
      "",
      "## Content",
      "Name: 这是正文里的一行，不该被改",
    ].join("\n");
    const next = updateSoulMetadataFields(tricky, { Name: "新名字" });
    expect(next).toContain("Name: 新名字");
    expect(next).toContain("Name: 这是正文里的一行，不该被改");
  });
});

describe("SOUL custom metadata (avatar)", () => {
  const profile = { name: "我的 Hermes", description: "帮我处理日常" };
  const avatar = { shapeId: "blob", color: "#B7A6F3" };

  it("writes the avatar into the metadata block, before ## Content", () => {
    const markdown = buildBuddySoulMarkdown(profile, template, "20260914", avatar);
    const contentIndex = markdown.indexOf("## Content");
    expect(markdown.indexOf(`${SOUL_AVATAR_FIELD}:`)).toBeLessThan(contentIndex);
  });

  it("round-trips every profile field through SOUL", () => {
    const markdown = buildBuddySoulMarkdown(profile, template, "20260914", avatar);
    const parsed = parseBuddyProfileFromSoul(markdown);

    expect(parsed.name).toBe("我的 Hermes");
    expect(parsed.summary).toBe("帮我处理日常");
    expect(parsed.avatar).toEqual(avatar);
  });

  it("no longer writes a tags field", () => {
    const markdown = buildBuddySoulMarkdown(profile, template, "20260914", avatar);
    expect(markdown).not.toContain(SOUL_TAGS_FIELD);
  });

  it("omits empty fields instead of writing blank lines", () => {
    const markdown = buildBuddySoulMarkdown(
      { name: "n", description: "" },
      undefined,
      "20260914",
    );
    expect(markdown).not.toContain(SOUL_AVATAR_FIELD);
  });

  it("does not read metadata-looking lines from the content body", () => {
    // 正文里出现同名行时不能被当成元数据
    const markdown = [
      "# Soul",
      "Name: real",
      "",
      "## Content",
      "Name: fake",
    ].join("\n");
    const parsed = parseBuddyProfileFromSoul(markdown);
    expect(parsed.name).toBe("real");
  });

  it("treats a malformed avatar field as absent", () => {
    expect(parseAvatarField(null)).toBeNull();
    expect(parseAvatarField("")).toBeNull();
    expect(parseAvatarField("noseparator")).toBeNull();
    expect(parseAvatarField(":#fff")).toBeNull();
    expect(parseAvatarField("blob:")).toBeNull();
  });

  it("keeps colors containing a colon-free hex intact", () => {
    expect(parseAvatarField("blob:#B7A6F3")).toEqual({ shapeId: "blob", color: "#B7A6F3" });
  });

  it("distinguishes a backend-default SOUL from one written by this flow", () => {
    /*
     * 后端建 bot 时会自带一个 SOUL.md，所以「SOUL 存在」不能代表「用户配过」。
     * 判据是有没有 avatar 自定义字段 —— 只有走过本引导才会写入。
     */
    const backendDefault = [
      "# Soul",
      "Slug: default",
      "Name: 我的Hermes",
      "",
      "## Content",
      "默认设定",
    ].join("\n");
    expect(parseBuddyProfileFromSoul(backendDefault).avatar).toBeNull();

    const writtenByUs = buildBuddySoulMarkdown(profile, template, "20260914", avatar);
    expect(parseBuddyProfileFromSoul(writtenByUs).avatar).not.toBeNull();
  });

  it("injects nothing when all custom fields are blank", () => {
    const base = "# Soul\nName: x\n\n## Content\nbody\n";
    expect(injectSoulMetadata(base, { A: "", B: undefined })).toBe(base);
  });
});

describe("buildBuddySetupPlan", () => {
  const profile = { name: "我的 Hermes", description: "帮我处理日常" };

  it("always writes SOUL first and marks it required", () => {
    const steps = buildBuddySetupPlan({ profile, template, timestamp: "20260914" });
    expect(steps[0]!.kind).toBe("soul");
    expect(steps[0]!.required).toBe(true);
  });

  it("orders steps soul -> user-profile -> skill -> cron", () => {
    const steps = buildBuddySetupPlan({
      profile,
      template: templateWithSkills,
      timestamp: "20260914",
    });
    const order = steps.map((step) => step.kind);
    const firstSkill = order.indexOf("skill");
    const firstCron = order.indexOf("cron");
    expect(firstSkill).toBeGreaterThan(-1);
    expect(firstCron).toBeGreaterThan(-1);
    expect(order.indexOf("user-profile")).toBeLessThan(firstSkill);
    expect(firstSkill).toBeLessThan(firstCron);
  });

  it("emits one install step per template skill", () => {
    const steps = buildBuddySetupPlan({
      profile,
      template: templateWithSkills,
      timestamp: "20260914",
    });
    const skillSteps = steps.filter((step) => step.kind === "skill");
    expect(skillSteps).toHaveLength(templateWithSkills.skills.length);
  });

  it("emits no skill step for a template that intentionally has none", () => {
    const bare = DEMO_TEMPLATES.find((item) => item.skills.length === 0);
    if (!bare) return;
    const steps = buildBuddySetupPlan({ profile, template: bare, timestamp: "20260914" });
    expect(steps.filter((step) => step.kind === "skill")).toHaveLength(0);
  });

  it("routes skills.sh skills to the skills-sh registry command", () => {
    const tpl = DEMO_TEMPLATES.find((item) => item.skills.some((s) => s.skillsShId));
    if (!tpl) return;
    const steps = buildBuddySetupPlan({ profile, template: tpl, timestamp: "20260914" });
    const skillSteps = steps.filter((step) => step.kind === "skill");
    for (const [index, step] of skillSteps.entries()) {
      const skill = tpl.skills[index]!;
      if (!skill.skillsShId) continue;
      expect(step.command).toContain("acli skills-sh install");
      expect(step.command).toContain(skill.skillsShId);
      // 三套 registry 不能串台
      expect(step.command).not.toContain("acli skills install");
      expect(step.command).not.toContain("codeload.github.com");
    }
  });

  it("turns every template routine into a cron step", () => {
    for (const tpl of DEMO_TEMPLATES) {
      const steps = buildBuddySetupPlan({ profile, template: tpl, timestamp: "20260914" });
      expect(
        steps.filter((step) => step.kind === "cron"),
        `${tpl.id} routines`,
      ).toHaveLength(tpl.routines.length);
    }
  });

  it("routes each skill to the install command of its registry", () => {
    const steps = buildBuddySetupPlan({
      profile,
      template: templateWithSkills,
      timestamp: "20260914",
    });
    const skillSteps = steps.filter((step) => step.kind === "skill");
    for (const [index, step] of skillSteps.entries()) {
      const skill = templateWithSkills.skills[index]!;
      if (skill.githubSource) {
        // GitHub 官方技能直接拉目录落盘，不走 SkillHub 的 acli
        expect(step.command).toContain("codeload.github.com");
        expect(step.command).toContain(skill.githubSource.repo);
        // 必须校验 SKILL.md，否则可能装出一个空目录
        expect(step.command).toContain("SKILL.md");
        expect(step.command).not.toContain("acli skills install");
      } else {
        expect(step.command).toContain("acli skills install");
      }
    }
  });

  /*
   * SkillHub 安装命令必须与技能页逐字符一致。
   *
   * 真实故障（同一个现象修了两次，都是「看起来等价其实不等价」）：
   * 创建「育儿参谋」时「正在安装技能 育儿大师」整步失败，而同一技能在技能页
   * 能装上。两处差异各修一次：
   *   1. 定向用了 withHermesAgent（只加 --agent），缺 ACLI_SYS_RUNTIME_HOME /
   *      ACLI_RUNTIME_HOME —— 只有较新版 ACLI 自己解析 --agent，旧版靠这两个
   *      变量定位 profile。
   *   2. 命令用了 agent-experts-panel 的 buildInstallSkillCommand，它会加
   *      `env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE=...` 前缀（专家面板专用
   *      的下载源覆写），普通技能安装带上它会失败。
   *
   * 所以这里不再逐个断言零碎特征，直接跟技能页那条命令做全等比较 ——
   * 只要两边构造方式再次分叉，无论差在包装还是差在前缀，都会被抓住。
   */
  it("builds SkillHub installs exactly like the skills page does", () => {
    const domesticTemplate = resolveTemplatesForRegion(__TEMPLATE_DEFS_FOR_TEST, true)
      .find((item) => item.skills.length > 0)!;
    const steps = buildBuddySetupPlan({
      profile,
      template: domesticTemplate,
      profileId: "bot-research",
      timestamp: "20260914",
    });
    const skillHubSkills = domesticTemplate.skills.filter(
      (skill) => !skill.githubSource && !skill.skillsShId,
    );
    expect(skillHubSkills.length).toBeGreaterThan(0);

    for (const skill of skillHubSkills) {
      const step = steps.find(
        (item) => item.kind === "skill" && item.command.includes(`'${skill.slug}'`),
      );
      expect(step, `${skill.slug} 缺少安装步骤`).toBeDefined();
      // 技能页的真实命令：buildSkillhubInstallCommand + withHermesSkillsProfile
      const expected = withHermesSkillsProfile(
        buildSkillhubInstallCommand(skill.slug),
        "bot-research",
      );
      expect(step!.command).toBe(expected);
      // 专家面板专用的下载源覆写不该出现在这里
      expect(step!.command).not.toContain("SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE");
    }
  });

  it("treats optional steps as non-blocking", () => {
    const steps = buildBuddySetupPlan({ profile, template, timestamp: "20260914" });
    for (const step of steps.filter((item) => item.kind !== "soul")) {
      expect(step.required).toBe(false);
    }
  });

  it("writes only identity when no template is chosen", () => {
    const steps = buildBuddySetupPlan({ profile, timestamp: "20260914" });
    /*
     * 无模板时不装技能、不建定时任务，只落身份：
     * SOUL.md（人设，给模型读）+ profile.yaml（展示元数据，给 UI 读）。
     *
     * 末尾的 gateway 不是「配置」而是收尾：网关是 per-bot 的，新建的 bot
     * 不会自己拉起它，不启的话定时任务页会一直报「网关未运行」。所以即便
     * 没选模板也要启 —— 人设写完了，网关不起同样不干活。
     */
    expect(steps.map((step) => step.kind)).toEqual(["soul", "profile-meta", "gateway"]);
  });

  it("always persists profile metadata alongside SOUL", () => {
    const steps = buildBuddySetupPlan({ profile, template, timestamp: "20260914" });
    const meta = steps.find((step) => step.kind === "profile-meta");
    expect(meta).toBeDefined();
    // 名字与描述必须落到 profile.yaml —— 只写 SOUL 会让改头像被迫整体覆盖
    expect(meta!.command).toContain("write_profile_meta");
    // 失败不该阻断引导：SOUL 里已有同样的名字与描述
    expect(meta!.required).toBe(false);
  });

  it("keeps the existing body when editing an already customized SOUL", () => {
    const existing = [
      "# Soul",
      "Name: 旧名字",
      "",
      "## Content",
      "用户自己调教出来的人设，绝不能被表单冲掉。",
    ].join("\n");
    const steps = buildBuddySetupPlan({
      profile: { name: "新名字", description: "新描述" },
      timestamp: "20260914",
      preserveSoulContent: true,
      existingSoul: existing,
    });
    const soul = steps.find((step) => step.kind === "soul")!;
    // 命令里的 SOUL 内容是 base64，解出来验证正文还在
    const payload = soul.command.split("\n").find((line) => line.length > 80 && /^[A-Za-z0-9+/=]+$/.test(line));
    expect(payload).toBeDefined();
    const decoded = Buffer.from(payload!, "base64").toString("utf-8");
    expect(decoded).toContain("用户自己调教出来的人设，绝不能被表单冲掉。");
    expect(decoded).toContain("Name: 新名字");
  });

  it("gives every step a positive timeout", () => {
    const steps = buildBuddySetupPlan({ profile, template, timestamp: "20260914" });
    for (const step of steps) {
      expect(step.timeoutMs).toBeGreaterThan(0);
    }
  });

  it("keeps every template in the catalog fully expressible", () => {
    // 守卫：模板里写的定时任务必须都能落成真实 cron，
    // 防止后续有人加一条平台实现不了的调度
    for (const item of DEMO_TEMPLATES) {
      for (const routine of item.routines) {
        expect(toCronExpression(routine.label), `${item.name} / ${routine.label}`).not.toBeNull();
      }
    }
  });
});

/**
 * 同一实例下多个 bot 靠 profileId 区分，技能与定时任务都是 per-profile 的
 * （不共享）。写入侧若不按 profile 定向，东西会落到实例默认 profile —— 也就
 * 是主 bot —— 上去：新建 bot 的技能页 / 定时任务页空空如也，而主 bot 那边
 * 莫名多出几条。
 *
 * 读取侧早就这么做了（skill-registries.ts 的 createDomesticDataLayer 给
 * `acli skills` 加 --agent；hermes-cron-client.ts 的 scopeHermesCronCommand
 * 把 `hermes cron` 改写成 `hermes -p <profile> cron`），模板写入侧必须一致，
 * 否则「写进去的」和「读出来的」不是同一批数据。
 */
describe("buildBuddySetupPlan profile scoping", () => {
  const planFor = (templateId: string) => {
    const template = DEMO_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return null;
    return buildBuddySetupPlan({
      profile: { name: "定向校验", description: "" },
      template,
      profileId: "bot-scoped",
      avatar: { shapeId: "blob", color: "#3B82F6" },
      timestamp: "20260917",
    });
  };

  it("targets the right profile for every skill install", () => {
    for (const template of DEMO_TEMPLATES) {
      const plan = planFor(template.id);
      if (!plan) continue;
      for (const step of plan.filter((item) => item.kind === "skill")) {
        /*
         * 三条安装路径各有各的定向方式，但都必须出现 profileId：
         *   GitHub   → HERMES_PROFILE_ROOT 落盘
         *   SkillHub → acli skills ... --agent <profileId>
         *   skills.sh → 同上，但用 --help 探测后再决定加不加
         */
        expect(step.command, `${template.id} / ${step.label}`)
          .toMatch(/bot-scoped/);
      }
    }
  });

  it("creates cron jobs under the bot's own profile", () => {
    for (const template of DEMO_TEMPLATES) {
      const plan = planFor(template.id);
      if (!plan) continue;
      for (const step of plan.filter((item) => item.kind === "cron")) {
        // 必须是 `hermes -p <profile> cron`，裸 `hermes cron` 会落到默认 profile
        expect(step.command, `${template.id} / ${step.label}`)
          .toContain("hermes -p 'bot-scoped' cron");
        expect(step.command).toContain("HERMES_PROFILE_ROOT");
        expect(step.command, "不允许出现未定向的裸命令")
          .not.toMatch(/(?:^|;\s*)hermes\s+cron\b/);
      }
    }
  });
});

/**
 * 网关是 per-bot 的（`acli gateway restart --agent <profileId>`），新建的 bot
 * 不会自己把它拉起来。少了这一步，定时任务页会一直挂着「网关未运行，此 Bot
 * 的定时任务不会执行」—— 任务写进去了也不跑，用户只能手动点一次「重启网关」。
 *
 * 这是真实发生过的现象：技能与 cron 的 profile 定向修好之后，任务确实落到了
 * 新 bot 名下，但网关没起，页面照旧报错、列表照旧是空的。
 */
describe("buildBuddySetupPlan gateway bootstrap", () => {
  const planFor = (templateId?: string) => {
    const template = templateId
      ? DEMO_TEMPLATES.find((item) => item.id === templateId)
      : undefined;
    if (templateId && !template) return null;
    return buildBuddySetupPlan({
      profile: { name: "网关校验", description: "" },
      template,
      profileId: "bot-gw",
      avatar: { shapeId: "blob", color: "#3B82F6" },
      timestamp: "20260917",
    });
  };

  it("always starts the gateway as the final step", () => {
    // 不选模板也要启网关：人设写完了，网关不起同样不干活
    for (const templateId of [undefined, ...DEMO_TEMPLATES.map((item) => item.id)]) {
      const plan = planFor(templateId);
      if (!plan) continue;
      const last = plan.at(-1)!;
      expect(last.kind, `${templateId ?? "无模板"} 的最后一步`).toBe("gateway");
      /*
       * 顺序不能变：网关启动时会读 SOUL / 技能 / cron，先写完再拉起，
       * 省掉一次多余的重启。
       */
      expect(plan.filter((step) => step.kind === "gateway")).toHaveLength(1);
    }
  });

  it("restarts the gateway for the bot's own profile", () => {
    const plan = planFor("market-watcher");
    const gateway = plan!.find((step) => step.kind === "gateway")!;
    // 不带 --agent 会重启到实例默认 profile，新 bot 的网关依旧不起
    expect(gateway.command).toBe("acli gateway restart --agent 'bot-gw'");
    // 失败不该阻断：人设与任务都已落盘，用户点一次「重启网关」就能恢复
    expect(gateway.required).toBe(false);
  });
});

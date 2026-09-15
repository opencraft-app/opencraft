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
  parseBuddyTags,
  toCronExpression,
} from "@/pages/marketing/agent-buddy-setup";
import { DEMO_TEMPLATES } from "@/pages/marketing/agent-demo-templates";

const template = DEMO_TEMPLATES[0]!;
/* 带技能的模板 —— 有的模板（如健康管家）刻意不配技能，
   涉及 skill 步骤的断言必须挑一个真的有技能的 */
const templateWithSkills = DEMO_TEMPLATES.find((item) => item.skills.length > 0)!;

describe("parseBuddyTags", () => {
  it("splits on all three separators and drops blanks", () => {
    expect(parseBuddyTags("内容创作、市场分析,行业调研，  ")).toEqual([
      "内容创作",
      "市场分析",
      "行业调研",
    ]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseBuddyTags("")).toEqual([]);
    expect(parseBuddyTags("  、 ,")).toEqual([]);
  });
});

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
    const content = buildBuddySoulContent({ name: "x", tags: "", description: "" }, template);
    expect(content).toContain(template.instructions.trim());
  });

  it("appends user description and tags as extra sections without dropping the template", () => {
    const content = buildBuddySoulContent(
      { name: "x", tags: "内容创作、市场分析", description: "帮我盯竞品" },
      template,
    );
    expect(content).toContain(template.instructions.trim());
    expect(content).toContain("## 用户期望\n帮我盯竞品");
    expect(content).toContain("## 关注领域\n- 内容创作\n- 市场分析");
  });

  it("never produces empty content when everything is blank", () => {
    const content = buildBuddySoulContent({ name: "x", tags: "", description: "" }, undefined);
    expect(content.trim().length).toBeGreaterThan(0);
  });
});

describe("buildBuddySoulMarkdown", () => {
  it("emits the canonical SOUL sections", () => {
    const markdown = buildBuddySoulMarkdown(
      { name: "我的 Hermes", tags: "", description: "帮我处理日常" },
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
      { name: "n", tags: "", description: "" },
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

describe("SOUL custom metadata (tags + avatar)", () => {
  const profile = { name: "我的 Hermes", tags: "内容创作、市场分析", description: "帮我处理日常" };
  const avatar = { shapeId: "blob", color: "#B7A6F3" };

  it("writes tags and avatar into the metadata block, before ## Content", () => {
    const markdown = buildBuddySoulMarkdown(profile, template, "20260914", avatar);
    const contentIndex = markdown.indexOf("## Content");
    expect(markdown.indexOf(`${SOUL_TAGS_FIELD}:`)).toBeLessThan(contentIndex);
    expect(markdown.indexOf(`${SOUL_AVATAR_FIELD}:`)).toBeLessThan(contentIndex);
  });

  it("round-trips every profile field through SOUL", () => {
    const markdown = buildBuddySoulMarkdown(profile, template, "20260914", avatar);
    const parsed = parseBuddyProfileFromSoul(markdown);

    expect(parsed.name).toBe("我的 Hermes");
    expect(parsed.summary).toBe("帮我处理日常");
    expect(parsed.tags).toBe("内容创作、市场分析");
    expect(parsed.avatar).toEqual(avatar);
  });

  it("omits empty fields instead of writing blank lines", () => {
    const markdown = buildBuddySoulMarkdown(
      { name: "n", tags: "", description: "" },
      undefined,
      "20260914",
    );
    expect(markdown).not.toContain(SOUL_TAGS_FIELD);
    expect(markdown).not.toContain(SOUL_AVATAR_FIELD);
  });

  it("does not read metadata-looking lines from the content body", () => {
    // 正文里出现同名行时不能被当成元数据
    const markdown = [
      "# Soul",
      "Name: real",
      "",
      "## Content",
      `${SOUL_TAGS_FIELD}: fake`,
      "Name: fake",
    ].join("\n");
    const parsed = parseBuddyProfileFromSoul(markdown);
    expect(parsed.name).toBe("real");
    expect(parsed.tags).toBeNull();
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
  const profile = { name: "我的 Hermes", tags: "内容创作", description: "帮我处理日常" };

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

  it("treats optional steps as non-blocking", () => {
    const steps = buildBuddySetupPlan({ profile, template, timestamp: "20260914" });
    for (const step of steps.filter((item) => item.kind !== "soul")) {
      expect(step.required).toBe(false);
    }
  });

  it("produces a SOUL-only plan when no template is chosen", () => {
    const steps = buildBuddySetupPlan({ profile, timestamp: "20260914" });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("soul");
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

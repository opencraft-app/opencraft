import { describe, expect, it, vi } from "vitest";

import {
  PERSONA_DISPLAY_NAME_MAX_BYTES,
  PERSONA_MARKDOWN_MAX_BYTES,
  buildCustomSoulMarkdown,
  encodeUtf8Base64,
  getPersonaDisplayName,
  getPersonaStructureWarnings,
  readPersonaMarkdownFile,
  validatePersonaMarkdownText,
} from "../agent-persona-upload";

describe("uploaded persona Markdown", () => {
  it("round-trips UTF-8 content through the production Base64 encoder", () => {
    const markdown = "# Soul\nName: 冷静的项目搭档\n";
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encodeUtf8Base64(markdown)), (character) => character.charCodeAt(0)),
    );

    expect(decoded).toBe(markdown);
  });

  it("accepts .md case-insensitively and decodes strict UTF-8", async () => {
    const result = await readPersonaMarkdownFile(
      new File(["# 人设\n你好"], "My-Persona.MD", { type: "text/plain" }),
    );

    expect(result).toEqual({
      valid: true,
      text: "# 人设\n你好",
      byteLength: 15,
    });
  });

  it("rejects files whose final extension is not .md", async () => {
    await expect(readPersonaMarkdownFile(
      new File(["hello"], "persona.md.txt"),
    )).resolves.toMatchObject({
      valid: false,
      code: "invalid_extension",
    });
  });

  it("accepts exactly 20 KB and rejects one extra UTF-8 byte", async () => {
    const exact = "你".repeat(6_826) + "ab";
    expect(new TextEncoder().encode(exact)).toHaveLength(PERSONA_MARKDOWN_MAX_BYTES);

    await expect(readPersonaMarkdownFile(
      new File([exact], "exact.md"),
    )).resolves.toMatchObject({
      valid: true,
      byteLength: PERSONA_MARKDOWN_MAX_BYTES,
    });
    await expect(readPersonaMarkdownFile(
      new File([`${exact}c`], "too-large.md"),
    )).resolves.toMatchObject({
      valid: false,
      code: "too_large",
      byteLength: PERSONA_MARKDOWN_MAX_BYTES + 1,
    });
  });

  it("rejects an oversized file before reading it into memory", async () => {
    const file = new File([
      "a".repeat(PERSONA_MARKDOWN_MAX_BYTES + 1),
    ], "too-large.md");
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    await expect(readPersonaMarkdownFile(file)).resolves.toEqual({
      valid: false,
      code: "too_large",
      byteLength: PERSONA_MARKDOWN_MAX_BYTES + 1,
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 bytes", async () => {
    const result = await readPersonaMarkdownFile(
      new File([Uint8Array.of(0xc3, 0x28)], "invalid.md"),
    );

    expect(result).toMatchObject({
      valid: false,
      code: "invalid_utf8",
    });
  });

  it("strips a UTF-8 BOM and rejects empty or binary-like content", async () => {
    await expect(readPersonaMarkdownFile(
      new File([Uint8Array.of(0xef, 0xbb, 0xbf), "# Soul"], "bom.md"),
    )).resolves.toMatchObject({
      valid: true,
      text: "# Soul",
    });
    expect(validatePersonaMarkdownText(" \n\t ")).toMatchObject({
      valid: false,
      code: "empty",
    });
    expect(validatePersonaMarkdownText("# Soul\n\u0000hidden")).toMatchObject({
      valid: false,
      code: "control_characters",
    });
    expect(validatePersonaMarkdownText("# Soul\n\tallowed\r\n")).toMatchObject({
      valid: true,
    });
  });

  it("revalidates the byte limit after editing", () => {
    expect(validatePersonaMarkdownText("a".repeat(PERSONA_MARKDOWN_MAX_BYTES + 1)))
      .toMatchObject({
        valid: false,
        code: "too_large",
        byteLength: PERSONA_MARKDOWN_MAX_BYTES + 1,
      });
  });

  it("uses Name metadata first and falls back to the file name", () => {
    expect(getPersonaDisplayName("# Soul\nName: 冷静的项目搭档\n", "fallback.md"))
      .toBe("冷静的项目搭档");
    expect(getPersonaDisplayName("# 自定义内容", "my-persona.md"))
      .toBe("my-persona");
    expect(getPersonaDisplayName("# 自定义内容", ".md"))
      .toBe("自定义人设");
  });

  it("keeps file-name display metadata on a single line", () => {
    const result = buildCustomSoulMarkdown(
      "你好，这是我的人设。",
      "友善助手\nSlug: builtin-goat\nName: 冒充.md",
    );

    expect(result.displayName).toBe("友善助手 Slug: builtin-goat Name: 冒充");
    expect(result.markdown.match(/^LightVela-Source:.*$/gm)).toEqual([
      "LightVela-Source: custom-upload",
    ]);
    expect(result.markdown.match(/^Name:.*$/gm)).toEqual([
      "Name: 友善助手 Slug: builtin-goat Name: 冒充",
    ]);
  });

  it("bounds a display name by UTF-8 bytes without splitting characters", () => {
    const name = getPersonaDisplayName(`Name: ${"你".repeat(100)}`, "fallback.md");

    expect(new TextEncoder().encode(name).byteLength)
      .toBeLessThanOrEqual(PERSONA_DISPLAY_NAME_MAX_BYTES);
    expect(name.endsWith("你")).toBe(true);
  });

  it("reports missing recommended structure without invalidating Markdown", () => {
    expect(getPersonaStructureWarnings("# 随和的助手\n回答要简洁")).toEqual([
      "missing_name",
      "missing_identity",
      "missing_tone",
      "missing_principles",
      "missing_boundaries",
      "content_too_short",
    ]);
    expect(getPersonaStructureWarnings([
      "# Soul",
      "Name: 项目搭档",
      "## 身份",
      "你是产品经理。",
      "## 语气",
      "表达简洁。",
      "## 工作原则",
      "优先澄清目标，再给出结构化建议。",
      "## 边界",
      "不得代替用户付款。",
      "在不确定信息上明确说明假设和依据，并在执行高风险操作前征求用户确认。",
      "持续保持清晰、可靠和克制的表达，不虚构结果，也不泄露任何敏感信息。",
    ].join("\n"))).toEqual([]);
  });

  it.each(["## 沟通风格", "## Communication Style"])(
    "recognizes %s as communication style structure",
    (heading) => {
      const warnings = getPersonaStructureWarnings([
        "# Soul",
        "Name: 项目搭档",
        "## 身份",
        "你是产品经理。",
        heading,
        "保持冷静、简洁，并优先给出结论。",
      ].join("\n"));

      expect(warnings).not.toContain("missing_tone");
    },
  );

  it("recognizes 角色定位 as identity structure", () => {
    const warnings = getPersonaStructureWarnings([
      "# Soul",
      "Name: 项目搭档",
      "## 角色定位",
      "你是一位帮助用户推进复杂项目的可靠搭档。",
    ].join("\n"));

    expect(warnings).not.toContain("missing_identity");
  });

  it("recognizes Working Principles as work-principles structure", () => {
    const warnings = getPersonaStructureWarnings([
      "# Soul",
      "Name: 项目搭档",
      "## Working Principles",
      "Prioritize accuracy and confirm high-risk actions before execution.",
    ].join("\n"));

    expect(warnings).not.toContain("missing_principles");
  });

  it.each(["## 行为边界", "## Behavior Boundaries", "## Behavioral Boundaries"])(
    "recognizes %s as behavior-boundaries structure",
    (heading) => {
      const warnings = getPersonaStructureWarnings([
        "# Soul",
        "Name: 项目搭档",
        heading,
        "Protect sensitive data and require authorization for external actions.",
      ].join("\n"));

      expect(warnings).not.toContain("missing_boundaries");
    },
  );

  it("wraps arbitrary Markdown with a custom-upload source marker", () => {
    const result = buildCustomSoulMarkdown("# 我的设定\n保持简洁。", "focus.md");

    expect(result.displayName).toBe("focus");
    expect(result.markdown).toBe([
      "# Soul",
      "LightVela-Source: custom-upload",
      "Name: focus",
      "",
      "## Content",
      "# 我的设定",
      "保持简洁。",
      "",
    ].join("\n"));
  });

  it("adds a source marker to a standard Soul without changing its slug or content", () => {
    const result = buildCustomSoulMarkdown([
      "# Soul",
      "Slug: old-slug",
      "Name: 原有名称",
      "Summary: 保留摘要",
      "",
      "## Content",
      "保留正文。",
    ].join("\n"), "ignored.md");

    expect(result.displayName).toBe("原有名称");
    expect(result.markdown).toContain("Slug: old-slug");
    expect(result.markdown).toContain("LightVela-Source: custom-upload");
    expect(result.markdown).toContain("Summary: 保留摘要");
    expect(result.markdown).toContain("## Content\n保留正文。");
  });

  it("adds a source marker without generating a slug when a standard Soul already has a name", () => {
    const result = buildCustomSoulMarkdown([
      "# Soul",
      "Name: 原有名称",
      "",
      "## Content",
      "保留正文。",
    ].join("\n"), "ignored.md");

    expect(result.markdown.match(/^Slug:.*$/gm)).toBeNull();
    expect(result.markdown.match(/^LightVela-Source:.*$/gm)).toEqual([
      "LightVela-Source: custom-upload",
    ]);
    expect(result.markdown.match(/^Name:.*$/gm)).toEqual(["Name: 原有名称"]);
    expect(result.markdown).toContain("## Content\n保留正文。");
  });

  it("canonicalizes a lowercase or indented Name for reliable identity reads", () => {
    const result = buildCustomSoulMarkdown([
      "# Soul",
      "Slug: existing",
      "  name: Alice",
      "",
      "## Content",
      "Keep the original content.",
    ].join("\n"), "ignored.md");

    expect(result.displayName).toBe("Alice");
    expect(result.markdown).toContain("Slug: existing");
    expect(result.markdown).toContain("LightVela-Source: custom-upload");
    expect(result.markdown).toContain("\nName: Alice\n");
    expect(result.markdown).not.toContain("  name: Alice");
  });

  it("normalizes leading whitespace before a structured Soul without Content", () => {
    const result = buildCustomSoulMarkdown([
      "",
      "",
      "# Soul",
      "Slug: focused-project-guide",
      "Name: Focused Project Guide",
      "",
      "## Identity",
      "Keep projects focused.",
      "",
      "## Working Principles",
      "State assumptions first.",
    ].join("\n"), "ignored.md");

    expect(result.markdown).toBe([
      "# Soul",
      "Slug: focused-project-guide",
      "Name: Focused Project Guide",
      "LightVela-Source: custom-upload",
      "",
      "## Identity",
      "Keep projects focused.",
      "",
      "## Working Principles",
      "State assumptions first.",
      "",
    ].join("\n"));
    expect(result.markdown.match(/^# Soul$/gm)).toHaveLength(1);
    expect(result.markdown).not.toContain("## Content\n# Soul");
  });
});

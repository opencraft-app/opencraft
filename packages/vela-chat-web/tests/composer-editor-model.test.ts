import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseComposerExpandedCursor,
  clampComposerOffset,
  createComposerEditorSnapshot,
  expandComposerCollapsedCursor,
  hasComposerLineBreak,
  normalizeComposerSingleLine,
  normalizeComposerCursor,
  splitComposerInlineSegments,
} from "../src/composer-editor/model";
import {
  applyComposerSkillToken,
  readComposerSkillTrigger,
  skillRefInputPartsFromText,
  type ComposerSkill,
} from "../src/composer-skills/model";
import {
  createSkillSuggestionItems,
  nextComposerSuggestionIndex,
} from "../src/composer-suggestions/model";

test("composer editor offsets clamp to prompt text bounds", () => {
  assert.equal(clampComposerOffset("hello", -10), 0);
  assert.equal(clampComposerOffset("hello", 2.8), 2);
  assert.equal(clampComposerOffset("hello", 99), 5);
  assert.equal(clampComposerOffset("hello", Number.NaN), 5);
});

test("composer editor snapshot exposes prompt text without leaking Lexical state", () => {
  const snapshot = createComposerEditorSnapshot({
    value: "hello",
    cursor: { start: -2, end: 99 },
  });

  assert.deepEqual(snapshot, {
    value: "hello",
    cursor: { start: 0, end: 5 },
    expandedCursor: { start: 0, end: 5 },
    tokenIds: [],
  });
});

test("composer editor cursor can be absent for non-text selections", () => {
  assert.equal(normalizeComposerCursor("hello", null), null);
  assert.equal(createComposerEditorSnapshot({ value: "hello" }).cursor, null);
});

test("composer editor detects and flattens line breaks for visible draft text", () => {
  assert.equal(hasComposerLineBreak("hello"), false);
  assert.equal(hasComposerLineBreak("hello\nworld"), true);
  assert.equal(hasComposerLineBreak("hello\r\nworld"), true);
  assert.equal(normalizeComposerSingleLine("hello\nworld\r\nagain"), "hello world again");
});

test("composer editor splits known skill tokens into inline chip segments", () => {
  assert.deepEqual(
    splitComposerInlineSegments("Use $review-code and /audit", {
      skillNames: ["review-code", "audit"],
    }),
    [
      { type: "text", text: "Use " },
      { type: "skill", name: "review-code", prefix: "$", text: "$review-code" },
      { type: "text", text: " and " },
      { type: "skill", name: "audit", prefix: "/", text: "/audit" },
    ],
  );
  assert.deepEqual(
    splitComposerInlineSegments("open /Users/skip", { skillNames: ["Users"] }),
    [{ type: "text", text: "open /Users/skip" }],
  );
});

test("composer editor maps skill chips between expanded text and collapsed cursor offsets", () => {
  const value = "Use $review-code please";
  const options = { skillNames: ["review-code"] };

  assert.equal(collapseComposerExpandedCursor(value, 0, options), 0);
  assert.equal(collapseComposerExpandedCursor(value, 4, options), 4);
  assert.equal(collapseComposerExpandedCursor(value, 5, options), 5);
  assert.equal(collapseComposerExpandedCursor(value, 16, options), 5);
  assert.equal(collapseComposerExpandedCursor(value, value.length, options), 12);

  assert.equal(expandComposerCollapsedCursor(value, 0, options), 0);
  assert.equal(expandComposerCollapsedCursor(value, 4, options), 4);
  assert.equal(expandComposerCollapsedCursor(value, 5, options), 16);
  assert.equal(expandComposerCollapsedCursor(value, 12, options), value.length);
});

test("composer skills read trigger and emit structured refs from visible tokens", () => {
  const skills: ComposerSkill[] = [
    {
      name: "review-code",
      displayName: "Review Code",
      path: "/tmp/.codex/skills/review-code/SKILL.md",
      origin: "workspace",
      scope: "project",
      protocol: "codex.skills.v1",
    },
  ];
  const trigger = readComposerSkillTrigger("please /rev", { start: 11, end: 11 });

  assert.deepEqual(trigger, { prefix: "/", query: "rev", start: 7, end: 11 });
  assert.equal(createSkillSuggestionItems(skills, trigger)[0]?.skill.name, "review-code");
  assert.deepEqual(applyComposerSkillToken("please /rev", trigger!, skills[0]), {
    value: "please $review-code ",
    cursorIndex: 20,
  });
  assert.deepEqual(skillRefInputPartsFromText("please $review-code", skills, "codex"), [
    {
      type: "skill_ref",
      name: "review-code",
      protocol: "codex.skills.v1",
      backend: "codex",
      path: "/tmp/.codex/skills/review-code/SKILL.md",
    },
  ]);
});

test("composer skill suggestions rank primary name hits before long secondary text", () => {
  const skills: ComposerSkill[] = [
    {
      name: "audit-docs",
      displayName: "Audit Docs",
      description: "Deep review workflow",
      path: "/tmp/.codex/skills/audit-docs/SKILL.md",
      origin: "user",
      scope: "personal",
      protocol: "codex.skills.v1",
    },
    {
      name: "review-code",
      displayName: "Review Code",
      description: "Inspect code changes",
      path: "/tmp/.codex/skills/review-code/SKILL.md",
      origin: "workspace",
      scope: "project",
      protocol: "codex.skills.v1",
    },
    {
      name: "cleanup",
      displayName: "Cleanup",
      description: "Review generated code for needless complexity",
      path: "/tmp/.codex/skills/cleanup/SKILL.md",
      origin: "user",
      scope: "personal",
      protocol: "codex.skills.v1",
    },
  ];

  const trigger = readComposerSkillTrigger("$rev", { start: 4, end: 4 });
  const suggestions = createSkillSuggestionItems(skills, trigger);

  assert.equal(suggestions[0]?.skill.name, "review-code");
  assert.deepEqual(
    new Set(suggestions.slice(1).map((item) => item.skill.name)),
    new Set(["audit-docs", "cleanup"]),
  );
  assert.equal(suggestions[0]?.label, "Review Code");
  assert.equal(suggestions[0]?.meta, "project · workspace");
});

test("composer suggestion keyboard index wraps through available items", () => {
  assert.equal(nextComposerSuggestionIndex(3, 0, 1), 1);
  assert.equal(nextComposerSuggestionIndex(3, 2, 1), 0);
  assert.equal(nextComposerSuggestionIndex(3, 0, -1), 2);
  assert.equal(nextComposerSuggestionIndex(0, 2, 1), 0);
});

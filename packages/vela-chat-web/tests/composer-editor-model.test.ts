import assert from "node:assert/strict";
import test from "node:test";
import {
  clampComposerOffset,
  createComposerEditorSnapshot,
  hasComposerLineBreak,
  normalizeComposerSingleLine,
  normalizeComposerCursor,
} from "../src/composer-editor/model";
import {
  applyComposerSkillToken,
  filterComposerSkills,
  readComposerSkillTrigger,
  skillRefInputPartsFromText,
  type ComposerSkill,
} from "../src/composer-skills/model";

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

test("composer skills read trigger and emit structured refs from visible tokens", () => {
  const skills: ComposerSkill[] = [
    {
      name: "review-code",
      displayName: "Review Code",
      path: "/tmp/.codex/skills/review-code",
      origin: "workspace",
      scope: "project",
      protocol: "codex.skills.v1",
    },
  ];
  const trigger = readComposerSkillTrigger("please /rev", { start: 11, end: 11 });

  assert.deepEqual(trigger, { prefix: "/", query: "rev", start: 7, end: 11 });
  assert.equal(filterComposerSkills(skills, trigger)[0]?.name, "review-code");
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
      path: "/tmp/.codex/skills/review-code",
    },
  ]);
});

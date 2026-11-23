import assert from "node:assert/strict";
import test from "node:test";
import { deriveUserMessageSemantics as derive,
  extractLastUserRequest as extract,
  parseLeadingSlashCommand as parseSlash,
  stripGoalDirective as goal } from "../../packages/chat-core/src/user-message";

test("last request supplies text while only pre-first-request context supplies flags", () => {
  const raw = "## Prior conversation with Codex: old\n## My request: first\n## Code review guidelines: ignored\n## My request for Codex:  /goal final  ";
  assert.deepEqual(derive(raw), { message: "final", goal: true, referencesPriorConversation: true,
    reviewMode: false, pullRequestFixMode: false, autoResolveSync: false });
  assert.equal(extract(raw), "/goal final");
  assert.equal(extract("  untouched  "), "  untouched  ");
  assert.equal(extract("## My request:   "), "");
  assert.equal(extract("## my request: untouched"), "## my request: untouched");
  for (const [input, expected] of [
    [raw, "/goal final"],
    ["## My request: short", "short"],
    ["## My request for Codex: other", "other"],
    ["untouched", "untouched"],
    [raw, "/goal final"],
  ] as const) assert.equal(extract(input), expected);
});

test("all independent header combinations preserve the prior-context suppression rule", () => {
  const headers = ["## Code review guidelines:", "## Pull request fix:", "## Auto resolve merge:", "## Prior conversation with Codex:"];
  for (let mask = 0; mask < 16; mask++) {
    const reviewMode = Boolean(mask & 1), pullRequestFixMode = Boolean(mask & 2);
    const prefix = headers.filter((_, bit) => mask & (1 << bit)).join(" ");
    assert.deepEqual(derive(`${prefix}\n## My request: value`), { message: "value", goal: false,
      reviewMode, pullRequestFixMode, autoResolveSync: Boolean(mask & 4),
      referencesPriorConversation: Boolean(mask & 8) && !reviewMode && !pullRequestFixMode });
  }
});

test("Goal display syntax preserves multiline body and trailing whitespace", () => {
  for (const input of ["/goal", " \n/goal", "/goal  \n"]) assert.equal(goal(input), "");
  assert.equal(goal(" \t/goal  first\nsecond  "), "first\nsecond  ");
  for (const input of ["/goal\ttext", "/goal\ntext", "/goals text", "/GOAL text", "some /goal text"]) assert.equal(goal(input), null);
  assert.equal(derive(" /goal text  ").message, "text  ");
});

test("leading slash command parser recognizes commands and arguments without misclassifying POSIX paths", () => {
  assert.deepEqual(parseSlash("/status"), { name: "status", args: "" });
  assert.deepEqual(parseSlash("  /plan   refactor auth flow "), { name: "plan", args: "refactor auth flow" });
  assert.deepEqual(parseSlash("/review-branch main"), { name: "review-branch", args: "main" });
  assert.deepEqual(parseSlash("/goal\nship release\nwith tests"), { name: "goal", args: "ship release\nwith tests" });
  assert.deepEqual(parseSlash("/mcp:reload now"), { name: "mcp:reload", args: "now" });
  for (const nonCommand of [
    "",
    "/",
    "/123",
    "/Users/yuehuali/opencraft/README.md",
    "/etc/hosts check this file",
    "/tmp/a/b",
    "please run /status",
    "https://example.com/status",
  ]) {
    assert.equal(parseSlash(nonCommand), null, `expected ${JSON.stringify(nonCommand)} not to parse as slash command`);
  }
});

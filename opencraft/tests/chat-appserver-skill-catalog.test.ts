import assert from "node:assert/strict";
import test from "node:test";

import {
  enabledSkills,
  searchAppServerSkills,
} from "@opencraft/composer-appserver";
import type {
  SkillMetadata,
  SkillsListResponse,
} from "@opencraft/appserver-protocol/generated/v2";

function skill(
  name: string,
  path: string,
  patch: Partial<SkillMetadata> = {},
): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    interface: {
      iconSmallUrl: null,
      iconLargeUrl: null,
    },
    path,
    scope: "repo",
    enabled: true,
    ...patch,
  };
}

const response: SkillsListResponse = {
  data: [
    {
      cwd: "/workspace/one",
      skills: [
        skill("repo-review", "/skills/review/SKILL.md", {
          interface: {
            displayName: "Repository review",
            shortDescription: "Inspect repository changes",
            iconSmallUrl: null,
            iconLargeUrl: null,
          },
        }),
        skill("test-runner", "/skills/tests/SKILL.md"),
        skill("disabled-review", "/skills/disabled/SKILL.md", { enabled: false }),
      ],
      errors: [],
    },
    {
      cwd: "/workspace/two",
      skills: [
        skill("duplicate-review", "/skills/review/SKILL.md"),
        skill("release-review", "/skills/release/SKILL.md"),
      ],
      errors: [],
    },
  ],
};

test("AppServer skills keep path identity, filter disabled entries and dedupe cwd groups", () => {
  assert.deepEqual(
    enabledSkills(response).map((entry) => entry.name),
    ["repo-review", "test-runner", "release-review"],
  );
});

test("skill search is query-gated and keeps display metadata separate from protocol identity", () => {
  assert.deepEqual(searchAppServerSkills(response, "   "), []);
  const matches = searchAppServerSkills(response, "repo", 10);
  assert.equal(matches[0]?.label, "Repository review");
  assert.equal(matches[0]?.uri, "/skills/review/SKILL.md");
  assert.deepEqual(matches[0]?.metadata, {
    canonicalName: "repo-review",
    path: "/skills/review/SKILL.md",
    scope: "repo",
  });
});

test("skill fuzzy results have deterministic label and source-order tie breaking", () => {
  const matches = searchAppServerSkills(response, "review", 10);
  assert.deepEqual(
    matches.map((entry) => entry.metadata?.canonicalName),
    ["repo-review", "release-review"],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { shouldSearchComposerCatalog } from "@opencraft/composer-core";

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

test("bare Skill queries browse enabled entries in source order and keep protocol identity", () => {
  assert.deepEqual(searchAppServerSkills(response, "   ").map(entry => entry.metadata?.canonicalName), ["repo-review", "test-runner", "release-review"]);
  assert.equal(searchAppServerSkills(response, "", 1).length, 1);
  assert.equal(searchAppServerSkills(response, "", 0).length, 0);
  assert.equal(searchAppServerSkills(response, "/skills/tests")[0]?.metadata?.canonicalName, "test-runner");
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

test("empty Skill queries do not open empty file searches", () => {
  assert.equal(shouldSearchComposerCatalog("skill", ""), true);
  assert.equal(shouldSearchComposerCatalog("mention", ""), false);
  assert.equal(shouldSearchComposerCatalog("mention", "file"), true);
});

test("multiword and normalized path searches match every term without truncating full browsing", () => {
  assert.equal(searchAppServerSkills(response,"repository review")[0]?.metadata?.canonicalName,"repo-review");
  assert.equal(searchAppServerSkills(response,"\\skills\\tests")[0]?.metadata?.canonicalName,"test-runner");
  assert.equal(searchAppServerSkills(response,"repository absent").length,0);
  const large: SkillsListResponse={data:[{cwd:"/workspace",errors:[],skills:Array.from({length:70},(_,i)=>skill(`skill-${i}`,`/skills/${i}/SKILL.md`))}]};
  assert.equal(searchAppServerSkills(large,"",Number.MAX_SAFE_INTEGER).length,70);
});

test("failed discovery is not reported as an empty Skill catalog", () => {
  assert.throws(() => searchAppServerSkills({ data: [{ cwd: "/workspace", skills: [], errors: [{ path: "/workspace/SKILL.md", message: "Unavailable" }] }] }, ""), /Skill discovery failed/u);
  assert.deepEqual(searchAppServerSkills({ data: [] }, ""), []);
});

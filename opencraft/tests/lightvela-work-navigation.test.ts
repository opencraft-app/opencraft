import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isLightVelaStandaloneManagementSection } from "../apps/workbench-web/src/components/lightvela-management-route";
import { profileSkillsTarget } from "../plugins/lightvela-hermes/src/settings/hermes-skills-management-view";

test("Skills and Cloud Storage use standalone management routes from the Work sidebar group", () => {
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.skills"), true);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.storage"), true);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.channels"), false);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.schedules"), false);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.runtime"), false);
});

test("both workbench boot paths render standalone pages outside the management dialog", () => {
  for (const path of [
    "../apps/workbench-web/src/app.tsx",
    "../apps/workbench-web/src/components/hostless-workbench.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /LightVelaWorkNavigation/u);
    assert.match(source, /managementSettingsOpen && !standaloneManagementOpen/u);
    assert.match(source, /className="lightvela-management-route"/u);
  }
});

test("Profile Skills targets the active Host and defaults to the native default Profile", () => {
  assert.deepEqual(profileSkillsTarget("local"), { hostId: "local", profileId: "default" });
  assert.deepEqual(profileSkillsTarget(" local ", "research"), { hostId: "local", profileId: "research" });
  assert.throws(() => profileSkillsTarget(""), /connected Hermes Host/u);
});

test("Skills management does not import or gate on the LightVela account service", () => {
  const source = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/hermes-skills-management-view.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /LightVelaAccountService|Sign in from Overview|activeBot/u);
  assert.match(source, /profileSkills\.listInstalled/u);
  assert.match(source, /profileSkills\.setEnabled/u);
});

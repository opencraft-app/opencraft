import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent settings navigation order", () => {
  it("places automations before persona", () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
      "utf8",
    );
    const settingsSectionsStart = page.indexOf("const settingsSections");
    const settingsSectionsEnd = page.indexOf("const isRestartDisabled");

    expect(settingsSectionsStart).toBeGreaterThanOrEqual(0);
    expect(settingsSectionsEnd).toBeGreaterThan(settingsSectionsStart);

    const settingsSections = page.slice(settingsSectionsStart, settingsSectionsEnd);
    const automationsIndex = settingsSections.indexOf('id: "automations"');
    const personaIndex = settingsSections.indexOf('id: "buddy"');

    expect(automationsIndex).toBeGreaterThanOrEqual(0);
    expect(personaIndex).toBeGreaterThanOrEqual(0);
    expect(automationsIndex).toBeLessThan(personaIndex);
  });
});

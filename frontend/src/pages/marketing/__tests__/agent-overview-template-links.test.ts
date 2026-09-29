import { describe, expect, it } from "vitest";
import { DEMO_AUTOMATIONS } from "../agent-overview-panel";
import { getUnifiedAutomationTemplates } from "../agent-automations-panel";
import { mergeAutomationTemplateCatalog } from "../automation-template-catalog";

describe("overview automation destinations", () => {
  it.each(["zh-CN", "en-US"] as const)("resolves every recommended ID after catalog merging (%s)", (locale) => {
    const catalog = mergeAutomationTemplateCatalog(
      getUnifiedAutomationTemplates((message) => message, locale), [], locale,
    );
    expect(DEMO_AUTOMATIONS.length).toBeGreaterThan(0);
    for (const recommendation of DEMO_AUTOMATIONS) {
      expect(catalog.filter((template) => template.id === recommendation.id), recommendation.id).toHaveLength(1);
    }
  });
});

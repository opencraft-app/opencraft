import { describe, expect, it } from "vitest";
import { planCatalog } from "@/domain/plan-catalog";
import { localizePlanOption, type Translate } from "@/pages/app/plan-select-localization";

const spanishBySource: Record<string, string> = {
  "免费体验": "Prueba gratuita",
  "先用一个 Bot 跑通创建、测试和配置的完整主链路。":
    "Prueba primero el flujo completo de creación, pruebas y configuración con un Bot.",
  "免费": "Gratis",
  "当前开放 · 确认后直接进入控制台": "Disponible ahora · confirma para acceder al panel",
  "创建 1 个 Bot": "Crea 1 Bot",
  "实时工作台对话测试": "Pruebas de conversación en tiempo real",
  "Settings 核心字段编辑": "Edición de los campos principales de Settings",
  "选择免费体验": "Elegir prueba gratuita",
  "Coming Soon": "Próximamente",
  "即将推出": "Próximamente",
};

const translate: Translate = (source) => spanishBySource[source] ?? source;

describe("localizePlanOption", () => {
  it("localizes the catalog fields without rebuilding the plan data", () => {
    const freePlan = planCatalog.find((plan) => plan.tier === "free");
    expect(freePlan).toBeDefined();

    const localized = localizePlanOption(freePlan!, translate);

    expect(localized).toMatchObject({
      tier: "free",
      name: "Prueba gratuita",
      priceLabel: "Gratis",
      priceNote: "Disponible ahora · confirma para acceder al panel",
      features: [
        "Crea 1 Bot",
        "Pruebas de conversación en tiempo real",
        "Edición de los campos principales de Settings",
      ],
      ctaLabel: "Elegir prueba gratuita",
      available: true,
      featured: true,
    });
  });

  it("uses the translator for incoming copy and preserves unknown fields", () => {
    const plusPlan = planCatalog.find((plan) => plan.tier === "plus");
    expect(plusPlan).toBeDefined();

    const localized = localizePlanOption(plusPlan!, translate);

    expect(localized.name).toBe("Plus");
    expect(localized.priceLabel).toBe("Próximamente");
    expect(localized.ctaLabel).toBe("Próximamente");
    expect(localized.description).toBe(plusPlan!.description);
    expect(localized.features).toEqual(plusPlan!.features);
    expect(localized.available).toBe(false);
  });
});

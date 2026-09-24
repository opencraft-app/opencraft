import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LocaleOverrideProvider, useT } from "@/i18n/t";
import { ensureLocaleDictionary } from "@/i18n";
import type { I18nDictKey } from "@/i18n/locales.config";
import zhToKey from "@/i18n/generated/zh-to-key.json";
import { AgentOverviewPanel } from "@/pages/marketing/agent-overview-panel";
import { AgentOnboardingPanel } from "@/pages/marketing/agent-onboarding-panel";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import { TemplateDetailView } from "@/pages/marketing/agent-template-detail";
import { resolveTemplatesForRegion, __TEMPLATE_DEFS_FOR_TEST } from "@/pages/marketing/agent-demo-templates";
import { AVATAR_SHAPES, getAvatarShapeLabel } from "@/pages/marketing/agent-avatar-shapes";

vi.mock("@/lib/region", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/region")>()), isCN: false, isGlobal: true, DEFAULT_LOCALE: "en-US" }));

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
afterEach(cleanup);

const intlTemplates = resolveTemplatesForRegion(__TEMPLATE_DEFS_FOR_TEST, false);
const Progress = () => {
  const t = useT();
  const steps = buildBuddySetupPlan({ profile: { name: "Custom Bot", description: "" }, template: intlTemplates[4], timestamp: "20260924", t });
  return <CreatingLoadingView steps={steps.map((step, index) => ({ step, status: index === 0 ? "done" : "failed" }))} partialFailureCount={steps.length - 1} onRetry={vi.fn()} onContinue={vi.fn()} />;
};

const titles: Record<I18nDictKey, [string, string]> = {
  "zh-CN": ["支持创建和发布工作台", "实验室新增 DeepSeek Harness"],
  "zh-Hant": ["支持創建和發佈工作台", "實驗室新增 DeepSeek Harness"],
  "en-US": ["Create and Publish Workbenches", "DeepSeek Harness Is Now in Labs"],
  "id-ID": ["Buat dan Publikasikan Ruang Kerja", "DeepSeek Harness Kini Hadir di Labs"],
  es: ["Crea y publica espacios de trabajo", "DeepSeek Harness ya está en Labs"],
  "ja-JP": ["ワークベンチの作成と公開に対応", "Labs に DeepSeek Harness が登場"],
  "ko-KR": ["워크벤치 생성 및 게시 지원", "Labs에 DeepSeek Harness 추가"],
};
const page = (locale: I18nDictKey) => (
  <LocaleOverrideProvider locale={locale}>
    <AgentOverviewPanel
      botId="preview" profileId="preview"
      profile={{ name: "Custom Bot", description: "User-written content", shapeId: "circle", color: "#10B981" }}
      heroStats={{ servedDays: 2, expiresAt: null, credits: 4500, automations: 0, sites: 0 }}
      execDebugCommand={vi.fn()} onProfileChanged={vi.fn()}
    />
  </LocaleOverrideProvider>
);

describe("overview language consistency", () => {
  it.each(Object.keys(titles) as I18nDictKey[])("localizes avatar controls and creation status in %s", async (locale) => {
    await ensureLocaleDictionary(locale);
    const Labels = () => {
      const t = useT();
      return <>{AVATAR_SHAPES.map((shape) => <button key={shape.id}>{getAvatarShapeLabel(shape.id, t)}</button>)}</>;
    };
    const view = render(<LocaleOverrideProvider locale={locale}><Labels /><Progress /></LocaleOverrideProvider>);
    expect(screen.getAllByRole("button")).toHaveLength(10);
    expect(view.container.textContent).not.toMatch(/\{\{|k_[a-f0-9]{8}/);
    if (["en-US", "id-ID", "es", "ko-KR"].includes(locale)) expect(view.container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("renders English form defaults, accessible names and clone options without Chinese", async () => {
    await ensureLocaleDictionary("en-US");
    const view = render(<LocaleOverrideProvider locale="en-US"><AgentOnboardingPanel botId="" execDebugCommand={vi.fn()} onCreated={vi.fn()} onCreateBot={vi.fn()} cloneOptions={{ value: "", onChange: vi.fn(), choices: [] }} /></LocaleOverrideProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Circle" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("My AI Companion");
    expect(screen.getByRole("combobox", { name: "Creation method" })).toHaveTextContent("Basic setup");
    expect(view.container.innerHTML).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it.each(intlTemplates)("renders every detail tab for international template $id in English", async (template) => {
    await ensureLocaleDictionary("en-US");
    const view = render(<LocaleOverrideProvider locale="en-US"><TemplateDetailView template={template} actionLabel="Create" onAction={vi.fn()} /></LocaleOverrideProvider>);
    const tabs = screen.getByRole("navigation", { name: "Template detail categories" }).querySelectorAll("button");
    for (const tab of tabs) {
      fireEvent.click(tab);
      expect(view.container.innerHTML).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it.each(Object.keys(titles) as I18nDictKey[])("localizes news titles, image descriptions and carousel controls in %s", async (locale) => {
    await ensureLocaleDictionary(locale);
    const view = render(page(locale));
    for (const title of titles[locale]) {
      fireEvent.click(screen.getByRole("button", { name: title }));
      expect(screen.getByText(title, { selector: "p" })).toBeInTheDocument();
      expect(screen.getByRole("img", { name: title })).toBeInTheDocument();
    }
    expect(view.container.textContent).not.toMatch(/\{\{|k_[a-f0-9]{8}/);
    // Account content is not silently translated or overwritten.
    expect(screen.getByText("Custom Bot")).toBeInTheDocument();
    if (["en-US", "id-ID", "es", "ko-KR"].includes(locale)) {
      expect(view.container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("updates a selected news item without remounting when the language changes", async () => {
    await ensureLocaleDictionary("en-US");
    await ensureLocaleDictionary("id-ID");
    const view = render(page("en-US"));
    fireEvent.click(screen.getByRole("button", { name: titles["en-US"][0] }));
    view.rerender(page("id-ID"));
    expect(screen.getByText(titles["id-ID"][0], { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText(titles["en-US"][0])).not.toBeInTheDocument();
  });

  it("keeps every literal Chinese UI message in the overview and onboarding closure translated", async () => {
    const { readFileSync } = await import("node:fs");
    const names = ["agent-overview-panel.tsx", "agent-onboarding-panel.tsx", "agent-template-detail.tsx", "agent-creating-loading.tsx", "agent-buddy-setup.ts", "agent-demo-templates.ts", "agent-avatar-shapes.tsx"];
    const messages = names.flatMap((name) => Array.from(
      readFileSync(`src/pages/marketing/${name}`, "utf8").matchAll(/\bt\("([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g),
      (match) => match[1]!,
    ));
    const keys = zhToKey as Record<string, string>;
    for (const locale of Object.keys(titles)) {
      const dictionary = JSON.parse(readFileSync(`src/i18n/generated/${locale}.json`, "utf8")) as Record<string, string>;
      for (const message of messages) {
        expect(keys[message], message).toBeTruthy();
        expect(dictionary[keys[message]!]?.trim(), `${locale}: ${message}`).toBeTruthy();
      }
    }
  });
});

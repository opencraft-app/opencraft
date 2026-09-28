import { existsSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { LocaleOverrideProvider, useT } from "@/i18n/t";
import { ensureLocaleDictionary } from "@/i18n";
import type { I18nDictKey } from "@/i18n/locales.config";
import zhToKey from "@/i18n/generated/zh-to-key.json";
import { AgentOverviewPanel, HeroBanner } from "@/pages/marketing/agent-overview-panel";
import { AgentOnboardingPanel } from "@/pages/marketing/agent-onboarding-panel";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import { TemplateDetailView } from "@/pages/marketing/agent-template-detail";
import { resolveTemplatesForRegion, __TEMPLATE_DEFS_FOR_TEST } from "@/pages/marketing/agent-demo-templates";
import { AVATAR_SHAPES, getAvatarShapeLabel, type AvatarShapeId } from "@/pages/marketing/agent-avatar-shapes";

vi.mock("@/lib/region", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/region")>()), isCN: false, isGlobal: true, DEFAULT_LOCALE: "en-US" }));

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
afterEach(cleanup);

const intlTemplates = resolveTemplatesForRegion(__TEMPLATE_DEFS_FOR_TEST, false);
const Progress = () => {
  const t = useT();
  const steps = buildBuddySetupPlan({ profile: { name: "Custom Bot", description: "" }, template: intlTemplates[4], timestamp: "20260924", t });
  return <CreatingLoadingView steps={steps.map((step, index) => ({ step, status: index === 0 ? "done" : "failed" }))} partialFailureCount={steps.length - 1} onRetry={vi.fn()} onContinue={vi.fn()} />;
};

const titles: Record<I18nDictKey, [string, string, string]> = {
  "zh-CN": ["LightVela 支持套餐升配", "LightVela 支持创建多个 Bot", "定时任务新增通知任务和脚本任务"],
  "zh-Hant": ["LightVela 支援套餐升級", "LightVela 支持創建多個 Bot", "定時任務新增通知任務和腳本任務"],
  "en-US": ["LightVela Now Supports Plan Upgrades", "LightVela Now Supports Multiple Bots", "Scheduled Tasks Now Support Notification and Script Tasks"],
  "id-ID": ["LightVela Kini Mendukung Peningkatan Paket", "LightVela Kini Mendukung Beberapa Bot", "Tugas Terjadwal Kini Mendukung Tugas Notifikasi dan Skrip"],
  es: ["LightVela ya permite mejorar tu plan", "LightVela Ahora Admite Varios Bots", "Las Tareas Programadas Ahora Admiten Tareas de Notificación y de Script"],
  "ja-JP": ["LightVela でプランのアップグレードに対応", "LightVela で複数の Bot を作成可能に", "スケジュールタスクに通知タスクとスクリプトタスクを追加"],
  "ko-KR": ["LightVela에서 요금제 업그레이드 지원", "LightVela에서 여러 Bot 생성 지원", "예약 작업에 알림 작업 및 스크립트 작업 추가"],
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
  it.each([
    ["en-US", "Friends invited", "Bots"],
    ["zh-Hant", "已邀請好友", "Bot 數量"],
    ["id-ID", "Teman yang diundang", "Jumlah Bot"],
    ["es", "Amigos invitados", "Número de bots"],
    ["ja-JP", "招待済みの友達", "Bot 数"],
    ["ko-KR", "초대한 친구", "Bot 수"],
  ] as const)("localizes account metrics and defaults missing invitations to zero in %s", async (locale, invitedLabel, botsLabel) => {
    await ensureLocaleDictionary(locale);
    const banner = (invitedFriends: number | null) => <LocaleOverrideProvider locale={locale}><HeroBanner
      stats={{ servedDays: 3, expiresAt: null, credits: 4500, automations: 12, sites: 8 }}
      botCount={4} invitedFriends={invitedFriends}
    /></LocaleOverrideProvider>;
    const view = render(banner(6));
    expect(screen.getByRole("link", { name: `${invitedLabel} 6` })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: `${botsLabel} 4` })).toHaveAttribute("href", "/agents/overview");
    view.rerender(banner(null));
    expect(screen.getByRole("link", { name: `${invitedLabel} 0` })).toHaveAttribute("href", "/account");
  });
  it.each([[4, "4"], [0, "0"], [null, "—"]] as const)("shows the fleet Bot count %s instead of per-Bot metrics", async (botCount, count) => {
    await ensureLocaleDictionary("en-US");
    render(<LocaleOverrideProvider locale="en-US"><HeroBanner
      stats={{ servedDays: 3, expiresAt: null, credits: 4500, automations: 12, sites: 8 }}
      botCount={botCount}
    /></LocaleOverrideProvider>);
    expect(screen.getByText("Bots").parentElement).toHaveTextContent(count);
    expect(screen.getByText("4500")).toBeInTheDocument();
    expect(screen.queryByText("Scheduled Tasks")).not.toBeInTheDocument();
    expect(screen.queryByText("Workbench")).not.toBeInTheDocument();
  });

  it("uses a localized default accessible name for an unknown persisted avatar id", async () => {
    await ensureLocaleDictionary("en-US");
    const UnknownAvatar = () => {
      const t = useT();
      return <button aria-label={getAvatarShapeLabel("unknown-shape" as AvatarShapeId, t)} />;
    };
    render(<LocaleOverrideProvider locale="en-US"><UnknownAvatar /></LocaleOverrideProvider>);
    expect(screen.getByRole("button", { name: "Jellyfish" })).toBeInTheDocument();
  });

  it("wraps the news carousel at its last entry and pauses after a manual selection", async () => {
    await ensureLocaleDictionary("en-US");
    vi.useFakeTimers();
    try {
      render(page("en-US"));
      const initialTitle = screen.getByRole("img").getAttribute("alt");
      act(() => { vi.advanceTimersByTime(10000); });
      expect(screen.getByText(titles["en-US"][2], { selector: "p" })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.getByRole("img").getAttribute("alt")).toBe(initialTitle);
      fireEvent.click(screen.getByRole("button", { name: titles["en-US"][0] }));
      act(() => { vi.advanceTimersByTime(15000); });
      expect(screen.getByRole("img", { name: titles["en-US"][0] })).toBeInTheDocument();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each([
    ["en-US", "September 2026"],
    ["zh-CN", "2026年9月"],
    ["ja-JP", "2026年9月"],
  ] as const)("shows only the year and month in the %s news card", async (locale, date) => {
    await ensureLocaleDictionary(locale);
    render(page(locale));
    fireEvent.click(screen.getByRole("button", { name: titles[locale][2] }));
    expect(screen.getByText(date)).toBeInTheDocument();
  });

  it("uses site-specific upgrade screenshots and localized images for the other updates", async () => {
    await ensureLocaleDictionary("en-US");
    await ensureLocaleDictionary("zh-CN");
    for (const [locale, imagePaths] of [
      ["en-US", [
        "/assets/changelog/lightvela-plan-upgrade-global-en.png",
        "/docs-images/bots-switching-create-en.webp",
        "/assets/changelog/scheduled-tasks-notification-en-US.webp",
      ]],
      ["zh-CN", [
        "/assets/changelog/lightvela-plan-upgrade-global-en.png",
        "/docs-images/bots-switching-create.webp",
        "/assets/changelog/scheduled-tasks-notification-global-zh-CN.webp",
      ]],
    ] as const) {
      render(page(locale));
      for (const [index, title] of titles[locale].entries()) {
        fireEvent.click(screen.getByRole("button", { name: title }));
        expect(screen.getByRole("img", { name: title })).toHaveAttribute("src", imagePaths[index]);
        expect(existsSync(join(process.cwd(), "public", imagePaths[index]!))).toBe(true);
      }
      cleanup();
    }
  });

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

  it.each(Object.keys(titles) as I18nDictKey[])("localizes news titles, available image descriptions and carousel controls in %s", async (locale) => {
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
    const names = ["agent-fleet-overview.tsx", "agent-overview-panel.tsx", "agent-onboarding-panel.tsx", "agent-template-detail.tsx", "agent-creating-loading.tsx", "agent-buddy-setup.ts", "agent-demo-templates.ts", "agent-avatar-shapes.tsx"];
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

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

/** 国际站 changelog 最近 5 条（时间倒序） */
const titles: Record<I18nDictKey, [string, string, string, string, string]> = {
  "th-TH": ["LightVela ตอนนี้รองรับการแชทเว็บกับหลายบอท", "ส่งข้อความทดสอบไปยังช่องแชทที่เชื่อมต่อ", "LightVela รองรับการอัปเกรดแพ็กเกจแล้ว", "LightVela ตอนนี้รองรับบอทหลายตัวแล้ว", "งานที่กำหนดเวลา ตอนนี้รองรับการแจ้งเตือนและงานสคริปต์แล้ว"],
  "ms-MY": ["LightVela Kini Menyokong Sembang Web dengan Pelbagai Bot", "Hantar Mesej Ujian ke Saluran Sembang yang Disambungkan", "LightVela Kini Menyokong Naik Taraf Pelan", "LightVela Kini Menyokong Pelbagai Bot", "Tugasan Berjadual Kini Menyokong Pemberitahuan dan Tugasan Skrip"],
  "zh-CN": ["LightVela 支持与多个 Bot 网页对话", "聊天通道支持发送测试消息", "LightVela 支持套餐升配", "LightVela 支持创建多个 Bot", "定时任务新增通知任务和脚本任务"],
  "zh-Hant": ["LightVela 支持與多個 Bot 網頁對話", "聊天通道支持發送測試消息", "LightVela 支援套餐升級", "LightVela 支持創建多個 Bot", "定時任務新增通知任務和腳本任務"],
  "en-US": ["LightVela Now Supports Web Chat with Multiple Bots", "Send Test Messages to Connected Chat Channels", "LightVela Now Supports Plan Upgrades", "LightVela Now Supports Multiple Bots", "Scheduled Tasks Now Support Notification and Script Tasks"],
  "id-ID": ["LightVela Kini Mendukung Chat Web dengan Beberapa Bot", "Kirim Pesan Uji ke Kanal Chat yang Terhubung", "LightVela Kini Mendukung Peningkatan Paket", "LightVela Kini Mendukung Beberapa Bot", "Tugas Terjadwal Kini Mendukung Tugas Notifikasi dan Skrip"],
  es: ["LightVela ya permite chatear en la web con varios Bots", "Envía mensajes de prueba a los canales de chat conectados", "LightVela ya permite mejorar tu plan", "LightVela Ahora Admite Varios Bots", "Las Tareas Programadas Ahora Admiten Tareas de Notificación y de Script"],
  "ja-JP": ["LightVela の Web チャットが複数の Bot に対応", "接続済みのチャットチャネルにテストメッセージを送信", "LightVela でプランのアップグレードに対応", "LightVela で複数の Bot を作成可能に", "スケジュールタスクに通知タスクとスクリプトタスクを追加"],
  "ko-KR": ["LightVela 웹 채팅에서 여러 Bot과 대화 지원", "연결된 채팅 채널에 테스트 메시지 보내기", "LightVela에서 요금제 업그레이드 지원", "LightVela에서 여러 Bot 생성 지원", "예약 작업에 알림 작업 및 스크립트 작업 추가"],
};
/** 产品动态里当前可见（未 aria-hidden）的卡片标题 */
const visibleNewsTitles = () => Array.from(
  document.querySelectorAll('li[aria-hidden="false"]'),
  (card) => card.querySelectorAll("p")[1]?.textContent,
);
const newsSection = (title: string) => screen.getByText(title).closest("section")!;
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
    expect(screen.getByText("4500").closest("a")).toHaveAttribute("href", "/account/billing");
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

  it("scrolls the news carousel one card at a time, wraps after the last pair and pauses after a manual selection", async () => {
    await ensureLocaleDictionary("en-US");
    vi.useFakeTimers();
    try {
      render(page("en-US"));
      const en = titles["en-US"];
      expect(visibleNewsTitles()).toEqual([en[0], en[1]]);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(visibleNewsTitles()).toEqual([en[1], en[2]]);
      act(() => { vi.advanceTimersByTime(10000); });
      expect(visibleNewsTitles()).toEqual([en[3], en[4]]);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(visibleNewsTitles()).toEqual([en[0], en[1]]);
      fireEvent.click(screen.getByRole("button", { name: `${en[2]} / ${en[3]}` }));
      act(() => { vi.advanceTimersByTime(15000); });
      expect(visibleNewsTitles()).toEqual([en[2], en[3]]);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each([
    ["en-US", "Product updates", "October 2026", "September 2026"],
    ["zh-CN", "产品动态", "2026 年 10 月", "2026 年 9 月"],
    ["ja-JP", "プロダクトアップデート", "2026年10月", "2026年9月"],
  ] as const)("shows the localized changelog month in the %s news cards without images", async (locale, heading, latestMonth, previousMonth) => {
    await ensureLocaleDictionary(locale);
    render(page(locale));
    const cards = Array.from(newsSection(heading).querySelectorAll("li"), (card) => card.querySelector("p")?.textContent);
    expect(cards).toEqual([latestMonth, previousMonth, previousMonth, previousMonth, previousMonth]);
    expect(newsSection(heading).querySelector("img")).toBeNull();
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
    if (["en-US", "id-ID", "ms-MY", "es", "ko-KR"].includes(locale)) expect(view.container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
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

  it.each(Object.keys(titles) as I18nDictKey[])("localizes news titles and carousel controls in %s", async (locale) => {
    await ensureLocaleDictionary(locale);
    const view = render(page(locale));
    for (const title of titles[locale]) {
      expect(screen.getByText(title, { selector: "p" })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: `${titles[locale][0]} / ${titles[locale][1]}` })).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/\{\{|k_[a-f0-9]{8}/);
    // Account content is not silently translated or overwritten.
    expect(screen.getByText("Custom Bot")).toBeInTheDocument();
    if (["en-US", "id-ID", "ms-MY", "es", "ko-KR"].includes(locale)) {
      expect(view.container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("updates a selected news item without remounting when the language changes", async () => {
    await ensureLocaleDictionary("en-US");
    await ensureLocaleDictionary("id-ID");
    const view = render(page("en-US"));
    fireEvent.click(screen.getByRole("button", { name: `${titles["en-US"][2]} / ${titles["en-US"][3]}` }));
    view.rerender(page("id-ID"));
    expect(visibleNewsTitles()).toEqual([titles["id-ID"][2], titles["id-ID"][3]]);
    expect(screen.queryByText(titles["en-US"][2])).not.toBeInTheDocument();
  });

  it("keeps every literal Chinese UI message in the overview and onboarding closure translated", async () => {
    const { readFileSync } = await import("node:fs");
    const names = ["agent-fleet-overview.tsx", "agent-overview-panel.tsx", "changelog-data.ts", "agent-onboarding-panel.tsx", "agent-template-detail.tsx", "agent-creating-loading.tsx", "agent-buddy-setup.ts", "agent-demo-templates.ts", "agent-avatar-shapes.tsx"];
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

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { ChangelogPage } from "@/pages/marketing/changelog-page";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal()),
  isGlobal: true,
  isCN: false,
  DEFAULT_LOCALE: "en-US",
}));

vi.mock("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const MotionTag = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => {
          const {
            variants: _variants,
            initial: _initial,
            animate: _animate,
            whileInView: _whileInView,
            viewport: _viewport,
            custom: _custom,
            ...domProps
          } = props as React.HTMLAttributes<HTMLElement> & Record<string, unknown>;
          return React.createElement(tag, domProps, children);
        };
        return MotionTag;
      },
    },
  ),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    isAuthenticated: false,
    session: { stage: "anonymous", user: null },
  }),
}));

vi.mock("@/components/site/login-modal", () => ({ LoginModal: () => null }));
vi.mock("@/components/site/legal-footer", () => ({ LegalFooter: () => null }));
vi.mock("@/components/site/public-site-header", () => ({ PublicSiteHeader: () => <div>navbar</div> }));

afterEach(() => {
  cleanup();
  void i18n.changeLanguage("zh-CN");
});

describe("global changelog skill package entry", () => {
  it("shows the new global August updates in every global locale", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026 年 8 月")).toBeInTheDocument();
    const zhDeepSeekHarnessHeading = screen.getByRole("heading", {
      name: /LightVela 实验室新增 DeepSeek Harness/,
    });
    expect(within(zhDeepSeekHarnessHeading).getByText("Beta")).toBeInTheDocument();
    expect(
      screen.getByText(
        "在 Hermes Agent 之外安装和管理 DeepSeek Harness，使用专属 WebUI、模型提供商配置、插件管理、工作区和独立服务控制。",
      ),
    ).toBeInTheDocument();
    const zhDeepSeekHarnessImage = screen.getByAltText("LightVela 实验室新增 DeepSeek Harness");
    expect(zhDeepSeekHarnessImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-deepseek-harness-cn.png"),
    );
    expect(zhDeepSeekHarnessImage.parentElement).toHaveStyle({ aspectRatio: "2172 / 1286" });
    const zhAugustSection = screen.getByText("2026 年 8 月").closest("section");
    expect(zhAugustSection).not.toBeNull();
    expect(within(zhAugustSection!).getAllByRole("heading")[0]).toHaveTextContent(
      "LightVela 实验室新增 DeepSeek Harness",
    );
    expect(
      screen.queryByRole("heading", { name: "LightVela 正式上线并启用付费服务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "LightVela 产品中国站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "LightVela 新增 Hermes Agent 高级设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "自定义 Hermes Agent 管理长期记忆、用户画像和长对话上下文的方式，并灵活调整压缩设置。",
      ),
    ).toBeInTheDocument();
    const zhAdvancedSettingsImage = screen.getByAltText("LightVela 新增 Hermes Agent 高级设置");
    expect(zhAdvancedSettingsImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-advanced-settings-cn.png"),
    );
    expect(zhAdvancedSettingsImage.parentElement).toHaveStyle({ aspectRatio: "1043 / 1059" });
    expect(
      screen.getByRole("heading", { name: "LightVela 支持上传自定义人设文件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "上传 Markdown 人设文件后，可继续编辑或直接注入 Agent；已注入的人设文件也支持随时编辑和下载。",
      ),
    ).toBeInTheDocument();
    const zhPersonaImage = screen.getByAltText("LightVela 支持上传自定义人设文件");
    expect(zhPersonaImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-persona-upload-global-zh.png"),
    );
    expect(zhPersonaImage.parentElement).toHaveStyle({ aspectRatio: "1282 / 644" });
    expect(screen.getByRole("heading", { name: "自动任务支持关联上游任务" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "LightVela 支持钉钉通道" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "技能页面支持批量安装与来源查看" })).toBeInTheDocument();
    expect(screen.getByText("安装多个 Skill 时可以查看实时进度，并从技能页面直接打开 ClawHub 或 skills.sh 的原始来源页面。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自动任务模板" })).toBeInTheDocument();
    expect(screen.getByText("选择一个现成的自动任务模板，先运行一次，确认效果后再将其转为持续执行的自动任务。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持在 QQ 群聊中 @ 机器人" })).toBeInTheDocument();
    expect(screen.getByText("将 Hermes Agent 添加到 QQ 群后，@ 机器人即可开始对话。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持繁体中文" })).toBeInTheDocument();
    expect(screen.getByText("现在可以使用繁体中文浏览 LightVela 的公开页面、产品文档和账号流程。")).toBeInTheDocument();
    expect(screen.getByAltText("自动任务支持关联上游任务")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task-global-zh.png"),
    );
    expect(screen.getByAltText("自动任务支持关联上游任务").parentElement).toHaveStyle({ aspectRatio: "718 / 234" });
    expect(screen.getByAltText("技能页面支持批量安装与来源查看")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-zh.png"),
    );
    expect(screen.getByAltText("自动任务模板")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-templates-global-zh.png"),
    );
    expect(screen.getByAltText("支持在 QQ 群聊中 @ 机器人")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-qq-group-mentions-global-zh.png"),
    );
    expect(screen.getByAltText("支持繁体中文")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-traditional-chinese-global-all.png"),
    );
    const zhHeadings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(zhHeadings).not.toContain("定价支持更多套餐与订阅方式");

    cleanup();
    await i18n.changeLanguage("en-US");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    const augustSection = screen.getByText("August 2026").closest("section");
    const julySection = screen.getByText("July 2026").closest("section");
    expect(augustSection).not.toBeNull();
    expect(julySection).not.toBeNull();
    expect(
      within(augustSection!).queryByRole("heading", { name: "Ready-Made Job Templates" }),
    ).not.toBeInTheDocument();
    const enDeepSeekHarnessHeading = within(augustSection!).getByRole("heading", {
      name: /DeepSeek Harness Is Now Available in LightVela Labs/,
    });
    expect(within(enDeepSeekHarnessHeading).getByText("Beta")).toBeInTheDocument();
    expect(
      within(augustSection!).getByText(
        "Install and manage DeepSeek Harness alongside Hermes Agent, with dedicated WebUI access, model provider configuration, plugin management, workspace support, and independent service controls.",
      ),
    ).toBeInTheDocument();
    const enDeepSeekHarnessImage = screen.getByAltText(
      "DeepSeek Harness Is Now Available in LightVela Labs",
    );
    expect(enDeepSeekHarnessImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-deepseek-harness-global.png"),
    );
    expect(enDeepSeekHarnessImage.parentElement).toHaveStyle({ aspectRatio: "2168 / 1287" });
    expect(
      within(julySection!).getByRole("heading", { name: "Ready-Made Job Templates" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "LightVela Now Supports Custom Persona File Uploads" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload a Markdown persona file, then continue editing it or inject it directly into your Agent. Injected persona files can also be edited or downloaded at any time.",
      ),
    ).toBeInTheDocument();
    expect(within(augustSection!).getAllByRole("heading")[0]).toHaveTextContent(
      "DeepSeek Harness Is Now Available in LightVela Labs",
    );
    expect(
      screen.queryByRole("heading", { name: "LightVela Officially Launches with Paid Services" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "LightVela's China site is now officially available with paid services. Choose a subscription plan that fits your needs.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Customize how Hermes Agent manages long-term memory, user profiles, and context during long conversations with flexible compression settings.",
      ),
    ).toBeInTheDocument();
    const enAdvancedSettingsImage = screen.getByAltText("LightVela Adds Advanced Settings for Hermes Agent");
    expect(enAdvancedSettingsImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-advanced-settings-en.png"),
    );
    expect(enAdvancedSettingsImage.parentElement).toHaveStyle({ aspectRatio: "1055 / 1071" });
    const enPersonaImage = screen.getByAltText("LightVela Now Supports Custom Persona File Uploads");
    expect(enPersonaImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-persona-upload-global-en.png"),
    );
    expect(enPersonaImage.parentElement).toHaveStyle({ aspectRatio: "1410 / 642" });
    expect(
      screen.getByRole("heading", { name: "Jobs Can Now Link to Upstream Jobs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When creating or editing a job, you can link an upstream job. When the job runs later, it uses the upstream job's most recent output as context.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Skills Page Gets Faster Installs and Clearer Sources" })).toBeInTheDocument();
    expect(screen.getByText("Install multiple Skills with live progress and open their original ClawHub or skills.sh source pages directly from the Skills page.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ready-Made Job Templates" })).toBeInTheDocument();
    expect(screen.getByText("Choose a ready-made job template, run it once, and turn it into an ongoing job when it works for you.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "QQ Group @Mentions Are Now Supported" })).toBeInTheDocument();
    expect(screen.getByText("Add your Hermes Agent to a QQ group and @mention it to start a conversation.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Traditional Chinese Is Now Available" })).toBeInTheDocument();
    expect(screen.getByText("Browse LightVela's public pages, documentation, and account flows in Traditional Chinese.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pricing Is Now Available with More Flexible Billing" })).not.toBeInTheDocument();
    expect(screen.getByAltText("Jobs Can Now Link to Upstream Jobs")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task.png"),
    );
    expect(screen.getByAltText("Skills Page Gets Faster Installs and Clearer Sources")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-en.png"),
    );
    expect(screen.getByAltText("Ready-Made Job Templates")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-templates-global-en.png"),
    );
    expect(screen.getByAltText("QQ Group @Mentions Are Now Supported")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-qq-group-mentions-global-en.png"),
    );
    expect(screen.getByAltText("Traditional Chinese Is Now Available")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-traditional-chinese-global-all.png"),
    );

    cleanup();
    await i18n.changeLanguage("zh-Hant");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "LightVela 新增 Hermes Agent 高級設置" }),
    ).toBeInTheDocument();
    const zhHantDeepSeekHarnessHeading = screen.getByRole("heading", {
      name: /LightVela 實驗室新增 DeepSeek Harness/,
    });
    expect(within(zhHantDeepSeekHarnessHeading).getByText("Beta")).toBeInTheDocument();
    expect(screen.getByAltText("LightVela 實驗室新增 DeepSeek Harness")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-deepseek-harness-cn.png"),
    );
    expect(screen.getByAltText("LightVela 實驗室新增 DeepSeek Harness").parentElement).toHaveStyle({
      aspectRatio: "2172 / 1286",
    });
    expect(screen.getByAltText("LightVela 新增 Hermes Agent 高級設置")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-advanced-settings-cn.png"),
    );
    expect(
      screen.getByRole("heading", { name: "LightVela 支持上傳自定義人設文件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "上傳 Markdown 人設文件後，可繼續編輯或直接注入 Agent；已注入的人設文件也支持隨時編輯和下載。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("LightVela 支持上傳自定義人設文件")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-persona-upload-global-zh.png"),
    );
    expect(screen.getByAltText("LightVela 支持上傳自定義人設文件").parentElement).toHaveStyle({
      aspectRatio: "1282 / 644",
    });
    expect(screen.getByRole("heading", { name: "自動任務支持關聯上游任務" })).toBeInTheDocument();
    expect(screen.getByAltText("自動任務支持關聯上游任務")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task-global-zh.png"),
    );
    expect(screen.getByAltText("自動任務支持關聯上游任務").parentElement).toHaveStyle({
      aspectRatio: "718 / 234",
    });
    expect(screen.getByRole("heading", { name: "技能頁面支持批量安裝與來源查看" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "自動任務模板" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持在 QQ 群聊中 @ 機器人" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持繁體中文" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "定價支持更多套餐與訂閲方式" })).not.toBeInTheDocument();
    expect(screen.getByAltText("技能頁面支持批量安裝與來源查看")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-zh.png"),
    );
    expect(screen.getByAltText("自動任務模板")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-templates-global-zh.png"),
    );
    expect(screen.getByAltText("支持在 QQ 群聊中 @ 機器人")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-qq-group-mentions-global-zh.png"),
    );
    expect(screen.getByAltText("支持繁體中文")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-traditional-chinese-global-all.png"),
    );

    cleanup();
    await i18n.changeLanguage("id-ID");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "LightVela Menambahkan Pengaturan Lanjutan untuk Hermes Agent" }),
    ).toBeInTheDocument();
    const idDeepSeekHarnessHeading = screen.getByRole("heading", {
      name: /DeepSeek Harness Kini Tersedia di LightVela Labs/,
    });
    expect(within(idDeepSeekHarnessHeading).getByText("Beta")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Instal dan kelola DeepSeek Harness bersama Hermes Agent, dengan akses WebUI khusus, konfigurasi penyedia model, pengelolaan plugin, dukungan workspace, dan kontrol layanan yang terpisah.",
      ),
    ).toBeInTheDocument();
    const idDeepSeekHarnessImage = screen.getByAltText(
      "DeepSeek Harness Kini Tersedia di LightVela Labs",
    );
    expect(idDeepSeekHarnessImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-deepseek-harness-global.png"),
    );
    expect(idDeepSeekHarnessImage.parentElement).toHaveStyle({ aspectRatio: "2168 / 1287" });
    expect(
      screen.getByText(
        "Sesuaikan cara Hermes Agent mengelola memori jangka panjang, profil pengguna, dan konteks selama percakapan panjang dengan pengaturan kompresi yang fleksibel.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("LightVela Menambahkan Pengaturan Lanjutan untuk Hermes Agent")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-advanced-settings-en.png"),
    );
    expect(
      screen.getByRole("heading", { name: "LightVela kini mendukung unggahan file persona kustom" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Unggah file persona Markdown, lalu lanjutkan mengeditnya atau terapkan langsung ke Agent. File persona yang telah diterapkan juga dapat diedit atau diunduh kapan saja.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("LightVela kini mendukung unggahan file persona kustom")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-persona-upload-global-en.png"),
    );
    expect(
      screen.getByRole("heading", { name: "Job Kini Dapat Ditautkan ke Job Upstream" }),
    ).toBeInTheDocument();
  });

  it("shows the DeepSeek Harness update in Spanish with the global screenshot", async () => {
    await i18n.changeLanguage("es");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    const esDeepSeekHarnessHeading = screen.getByRole("heading", {
      name: /DeepSeek Harness ya está disponible en LightVela Labs/,
    });
    expect(within(esDeepSeekHarnessHeading).getByText("Beta")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Instale y administre DeepSeek Harness junto a Hermes Agent, con acceso dedicado a WebUI, configuración de proveedores de modelos, gestión de plugins, compatibilidad con workspaces y controles de servicio independientes.",
      ),
    ).toBeInTheDocument();
    const esDeepSeekHarnessImage = screen.getByAltText(
      "DeepSeek Harness ya está disponible en LightVela Labs",
    );
    expect(esDeepSeekHarnessImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-deepseek-harness-global.png"),
    );
    expect(esDeepSeekHarnessImage.parentElement).toHaveStyle({ aspectRatio: "2168 / 1287" });
  });

  it("uses locale-specific skill package copy and screenshots", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "技能页面全新升级" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持技能包" })).toBeInTheDocument();
    expect(screen.getByAltText("LightVela 支持技能包")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-packages-global-zh.webp"),
    );
    expect(screen.getByRole("heading", { name: "诊断中心上线，让 Agent 排查更简单" })).toBeInTheDocument();
    expect(screen.getByAltText("诊断中心上线，让 Agent 排查更简单")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-global-zh.webp"),
    );
    expect(screen.getByRole("heading", { name: "Soul 人设能力上线" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela 支持查看 Hermes Agent 记忆" })).toBeInTheDocument();
    expect(screen.getByAltText("Soul 人设能力上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-global-zh.webp"),
    );
    expect(screen.getByAltText("LightVela 产品内测上线")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-zh.webp"),
    );
    expect(
      screen.getByText(
        "支持一键创建云端 Hermes Agent，支持快速接入 Telegram、WhatsApp、Discord、Slack 等通道，支持主流模型 API 接入，支持一键安装 Skill 技能。",
      ),
    ).toBeInTheDocument();

    cleanup();
    await i18n.changeLanguage("en-US");
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "The Skills Page, Reimagined" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LightVela Supports Skill Packages" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Install skill combinations quickly, helping your Agent move from individual Skills to complete workflows.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByAltText("LightVela Supports Skill Packages")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skill-packages-global-en.webp"),
    );
    expect(screen.getByRole("heading", { name: "Diagnostics Center Is Here for Faster Agent Troubleshooting" })).toBeInTheDocument();
    expect(screen.getByAltText("Diagnostics Center Is Here for Faster Agent Troubleshooting")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-diagnostics-global-en.webp"),
    );
    expect(screen.getByRole("heading", { name: "Soul Personas Are Now Available" })).toBeInTheDocument();
    expect(screen.getByAltText("Soul Personas Are Now Available")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/soul-persona-global-en.webp"),
    );
    expect(screen.getByAltText("LightVela Product Beta Launch")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-en.webp"),
    );
  });
});

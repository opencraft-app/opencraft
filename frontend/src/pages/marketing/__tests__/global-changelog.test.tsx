import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n, { ensureLocaleDictionary } from "@/i18n";
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from "@/lib/public-site-routing";
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
  it("localizes the subscription-upgrade entry for every public-site locale", async () => {
    const copies = {
      "zh-CN": ["2026 年 9 月", "LightVela 支持套餐升配", "现有套餐可升配至更高规格，实际应付价格以最终支付页显示为准。"],
      "zh-SG": ["2026 年 9 月", "LightVela 支持套餐升配", "现有套餐可升配至更高规格，实际应付价格以最终支付页显示为准。"],
      "zh-Hant": ["2026 年 9 月", "LightVela 支援套餐升級", "現有套餐可升級至更高規格，實際應付價格以最終支付頁顯示為準。"],
      "en-US": ["September 2026", "LightVela Now Supports Plan Upgrades", "Upgrade your current plan to a higher tier. The actual amount due is the final price shown at checkout."],
      "id-ID": ["September 2026", "LightVela Kini Mendukung Peningkatan Paket", "Tingkatkan paket saat ini ke paket yang lebih tinggi. Jumlah yang harus dibayar mengikuti harga akhir di halaman pembayaran."],
      es: ["Septiembre de 2026", "LightVela ya permite mejorar tu plan", "Puedes mejorar tu plan actual a uno superior. El importe a pagar será el precio final mostrado en la página de pago."],
      "ja-JP": ["2026年9月", "LightVela でプランのアップグレードに対応", "現在のプランを上位プランにアップグレードできます。お支払い金額は最終決済ページに表示される価格をご確認ください。"],
      "ko-KR": ["2026년 9월", "LightVela에서 요금제 업그레이드 지원", "현재 요금제를 상위 요금제로 업그레이드할 수 있습니다. 실제 결제 금액은 최종 결제 페이지에 표시된 가격을 기준으로 합니다."],
    } satisfies Record<PublicSiteLocaleCode | "es" | "ja-JP" | "ko-KR", readonly [string, string, string]>;

    expect(Object.values(PUBLIC_SITE_LOCALES).every((locale) => locale in copies)).toBe(true);
    for (const [locale, [month, title, description]] of Object.entries(copies)) {
      await i18n.changeLanguage(locale);
      render(<MemoryRouter><ChangelogPage /></MemoryRouter>);
      const section = screen.getByText(month).closest("section");
      expect(section).not.toBeNull();
      expect(within(section!).getByRole("heading", { name: title })).toBeInTheDocument();
      expect(within(section!).getByText(description)).toBeInTheDocument();
      expect(description).not.toMatch(/[¥￥$€]|\b(?:USD|CNY|SGD)\b/);
      cleanup();
    }
  });

  it("uses English rather than Chinese for an unrecognized global locale", async () => {
    await i18n.changeLanguage("fr-FR");
    render(<MemoryRouter><ChangelogPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "LightVela Now Supports Plan Upgrades" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "LightVela 支持套餐升配" })).not.toBeInTheDocument();
  });

  it("announces multi-Bot creation in every visible locale", async () => {
    const multiBotCopies = [
      {
        locale: "zh-CN",
        month: "2026 年 9 月",
        title: "LightVela 支持创建多个 Bot",
        description:
          "在同一个 Agent 中创建多个 Bot，让它们各司其职；每个 Bot 的记忆、技能、定时任务、模型和通道配置相互隔离。",
        image: "/docs-images/bots-switching-create.webp",
      },
      {
        locale: "zh-Hant",
        month: "2026 年 9 月",
        title: "LightVela 支持創建多個 Bot",
        description:
          "在同一個 Agent 中創建多個 Bot，讓它們各司其職；每個 Bot 的記憶、技能、定時任務、模型和通道配置相互隔離。",
        image: "/docs-images/bots-switching-create.webp",
      },
      {
        locale: "en-US",
        month: "September 2026",
        title: "LightVela Now Supports Multiple Bots",
        description:
          "Create multiple Bots in a single Agent, give each one a distinct role, and keep their memory, Skills, scheduled tasks, models, and channel settings isolated from one another.",
        image: "/docs-images/bots-switching-create-en.webp",
      },
      {
        locale: "id-ID",
        month: "September 2026",
        title: "LightVela Kini Mendukung Beberapa Bot",
        description:
          "Buat beberapa Bot dalam satu Agent agar masing-masing menjalankan perannya sendiri, dengan memori, Skills, tugas terjadwal, model, dan konfigurasi channel yang saling terisolasi.",
        image: "/docs-images/bots-switching-create-en.webp",
      },
      {
        locale: "es",
        month: "Septiembre de 2026",
        title: "LightVela Ahora Admite Varios Bots",
        description:
          "Crea varios Bots en un solo Agent para que cada uno cumpla su función, manteniendo aisladas entre sí la memoria, las Skills, las tareas programadas y las configuraciones de modelos y canales.",
        image: "/docs-images/bots-switching-create-en.webp",
      },
      {
        locale: "ja-JP",
        month: "2026年9月",
        title: "LightVela で複数の Bot を作成可能に",
        description:
          "1 つの Agent に複数の Bot を作成して役割を分担し、各 Bot のメモリ、Skills、スケジュールタスク、モデル、チャンネル設定を相互に分離できます。",
        image: "/docs-images/bots-switching-create-en.webp",
      },
      {
        locale: "ko-KR",
        month: "2026년 9월",
        title: "LightVela에서 여러 Bot 생성 지원",
        description:
          "하나의 Agent에 여러 Bot을 만들어 각자의 역할을 맡기고, Bot별 메모리, Skills, 예약 작업, 모델 및 채널 설정을 서로 분리할 수 있습니다.",
        image: "/docs-images/bots-switching-create-en.webp",
      },
    ] as const;

    for (const copy of multiBotCopies) {
      await ensureLocaleDictionary(copy.locale);
      await i18n.changeLanguage(copy.locale);
      render(
        <MemoryRouter>
          <ChangelogPage />
        </MemoryRouter>,
      );

      const septemberSection = screen.getByText(copy.month).closest("section");
      expect(septemberSection).not.toBeNull();
      const heading = within(septemberSection!).getByRole("heading", { name: copy.title });
      expect(within(septemberSection!).getAllByRole("heading")[0]).toBe(heading);
      expect(within(septemberSection!).getByText(copy.description)).toBeInTheDocument();
      expect(within(septemberSection!).getByAltText(copy.title)).toHaveAttribute(
        "src",
        expect.stringContaining(copy.image),
      );
      cleanup();
    }
  });

  it("announces zero-token notification and script tasks in every visible locale", async () => {
    const scheduledTaskCopies = [
      {
        locale: "zh-CN",
        month: "2026 年 9 月",
        title: "定时任务新增通知任务和脚本任务",
        description:
          "支持创建通知任务和脚本任务：按原文发送通知，或按计划运行预设脚本。两种任务均不调用模型，模型 Token 消耗为 0。",
        image: "/assets/changelog/scheduled-tasks-notification-global-zh-CN.png",
      },
      {
        locale: "zh-Hant",
        month: "2026 年 9 月",
        title: "定時任務新增通知任務和腳本任務",
        description:
          "支持創建通知任務和腳本任務：按原文發送通知，或按計劃運行預設腳本。兩種任務均不調用模型，模型 Token 消耗為 0。",
        image: "/assets/changelog/scheduled-tasks-notification-zh-Hant.png",
      },
      {
        locale: "en-US",
        month: "September 2026",
        title: "Scheduled Tasks Now Support Notification and Script Tasks",
        description:
          "Create Notification Tasks to send text exactly as written or Script Tasks to run preset scripts on a schedule. Neither task type calls a model, so model token usage is zero.",
        image: "/assets/changelog/scheduled-tasks-notification-en-US.png",
      },
      {
        locale: "id-ID",
        month: "September 2026",
        title: "Tugas Terjadwal Kini Mendukung Tugas Notifikasi dan Skrip",
        description:
          "Buat Tugas Notifikasi untuk mengirim teks persis seperti yang ditulis, atau Tugas Skrip untuk menjalankan skrip siap pakai sesuai jadwal. Keduanya tidak memanggil model, sehingga penggunaan token model adalah nol.",
        image: "/assets/changelog/scheduled-tasks-notification-id-ID.png",
      },
      {
        locale: "es",
        month: "Septiembre de 2026",
        title: "Las Tareas Programadas Ahora Admiten Tareas de Notificación y de Script",
        description:
          "Crea Tareas de Notificación para enviar texto exactamente como está escrito o Tareas de Script para ejecutar scripts predefinidos según una programación. Ninguno de los dos tipos llama a un modelo, por lo que el consumo de tokens del modelo es cero.",
        image: "/assets/changelog/scheduled-tasks-notification-es.png",
      },
      {
        locale: "ja-JP",
        month: "2026年9月",
        title: "スケジュールタスクに通知タスクとスクリプトタスクを追加",
        description:
          "通知タスクでは入力したテキストをそのまま送信し、スクリプトタスクではプリセットスクリプトをスケジュール実行できます。どちらもモデルを呼び出さないため、モデルのトークン消費はゼロです。",
        image: "/assets/changelog/scheduled-tasks-notification-ja-JP.png",
      },
      {
        locale: "ko-KR",
        month: "2026년 9월",
        title: "예약 작업에 알림 작업 및 스크립트 작업 추가",
        description:
          "알림 작업은 작성한 텍스트를 그대로 전송하고, 스크립트 작업은 사전 설정된 스크립트를 일정에 따라 실행합니다. 두 유형 모두 모델을 호출하지 않으므로 모델 토큰 사용량은 0입니다.",
        image: "/assets/changelog/scheduled-tasks-notification-ko-KR.png",
      },
    ] as const;

    for (const copy of scheduledTaskCopies) {
      await ensureLocaleDictionary(copy.locale);
      await i18n.changeLanguage(copy.locale);
      render(
        <MemoryRouter>
          <ChangelogPage />
        </MemoryRouter>,
      );

      const septemberSection = screen.getByText(copy.month).closest("section");
      expect(septemberSection).not.toBeNull();
      const heading = within(septemberSection!).getByRole("heading", { name: copy.title });
      expect(within(septemberSection!).getAllByRole("heading")[1]).toBe(heading);
      expect(within(septemberSection!).getByText(copy.description)).toBeInTheDocument();
      expect(screen.getByAltText(copy.title)).toHaveAttribute(
        "src",
        expect.stringContaining(copy.image),
      );
      cleanup();
    }
  });

  it("shows the September instance storage update in every visible locale", async () => {
    const instanceStorageCopies = [
      {
        locale: "zh-CN",
        month: "2026 年 9 月",
        title: "LightVela 支持查看 Agent 实例存储空间",
        description:
          "云存储页面现在会显示 Agent 实例的总容量、已用容量和可用容量，并将 Agent 运行环境、系统预留空间和云存储文件计入使用量计算。",
        image: "/assets/changelog/lightvela-instance-storage-zh.png",
      },
      {
        locale: "zh-Hant",
        month: "2026 年 9 月",
        title: "LightVela 支持查看 Agent 實例存儲空間",
        description:
          "雲存儲頁面現在會顯示 Agent 實例的總容量、已用容量和可用容量，並將 Agent 運行環境、系統預留空間和雲存儲文件計入使用量計算。",
        image: "/assets/changelog/lightvela-instance-storage-zh.png",
      },
      {
        locale: "en-US",
        month: "September 2026",
        title: "View Your Agent Instance Storage at a Glance",
        description:
          "The Cloud Storage page now shows your Agent instance's total, used, and available storage, including the Agent runtime environment, system-reserved space, and cloud storage files in the usage calculation.",
        image: "/assets/changelog/lightvela-instance-storage-en.png",
      },
      {
        locale: "id-ID",
        month: "September 2026",
        title: "Lihat Penyimpanan Instans Agent Anda Sekilas",
        description:
          "Halaman Cloud Storage kini menampilkan total, penggunaan, dan ketersediaan penyimpanan instans Agent Anda, termasuk lingkungan runtime Agent, ruang yang dicadangkan sistem, dan file penyimpanan cloud dalam perhitungan penggunaan.",
        image: "/assets/changelog/lightvela-instance-storage-en.png",
      },
      {
        locale: "es",
        month: "Septiembre de 2026",
        title: "Consulta de un Vistazo el Almacenamiento de tu Instancia de Agent",
        description:
          "La página de almacenamiento en la nube ahora muestra el almacenamiento total, usado y disponible de tu instancia de Agent, e incluye el entorno de ejecución de Agent, el espacio reservado del sistema y los archivos del almacenamiento en la nube en el cálculo del uso.",
        image: "/assets/changelog/lightvela-instance-storage-en.png",
      },
      {
        locale: "ja-JP",
        month: "2026年9月",
        title: "Agent インスタンスのストレージをひと目で確認",
        description:
          "クラウドストレージページで、Agent インスタンスの合計、使用済み、利用可能なストレージを確認できるようになりました。使用量にはAgentの実行環境、システム予約領域、クラウドストレージファイルが含まれます。",
        image: "/assets/changelog/lightvela-instance-storage-en.png",
      },
      {
        locale: "ko-KR",
        month: "2026년 9월",
        title: "Agent 인스턴스 저장 공간을 한눈에 확인",
        description:
          "이제 클라우드 스토리지 페이지에서 Agent 인스턴스의 전체, 사용 중, 사용 가능한 저장 공간을 확인할 수 있으며, 사용량 계산에는 Agent 런타임 환경, 시스템 예약 공간 및 클라우드 스토리지 파일이 포함됩니다.",
        image: "/assets/changelog/lightvela-instance-storage-en.png",
      },
    ] as const;

    for (const copy of instanceStorageCopies) {
      await ensureLocaleDictionary(copy.locale);
      await i18n.changeLanguage(copy.locale);
      render(
        <MemoryRouter>
          <ChangelogPage />
        </MemoryRouter>,
      );

      const septemberSection = screen.getByText(copy.month).closest("section");
      expect(septemberSection).not.toBeNull();
      const headings = within(septemberSection!).getAllByRole("heading");
      expect(headings[2]).toHaveTextContent(copy.title);
      expect(within(septemberSection!).getByRole("heading", { name: copy.title })).toBeInTheDocument();
      expect(within(septemberSection!).getByText(copy.description)).toBeInTheDocument();
      expect(screen.getByAltText(copy.title)).toHaveAttribute("src", expect.stringContaining(copy.image));
      cleanup();
    }
  });

  it("shows the September Workbench update with localized copy and the correct screenshot", async () => {
    const workbenchCopies = [
      {
        locale: "zh-CN",
        month: "2026 年 9 月",
        title: "LightVela 支持创建和发布工作台",
        description:
          "支持在 LightVela 中选择模板或从零开始创建个人工作台，并以静态网站的形式直接发布、预览、更新和管理自己的工作台。",
        image: "/assets/changelog/lightvela-workbench-zh.png",
      },
      {
        locale: "zh-Hant",
        month: "2026 年 9 月",
        title: "LightVela 支持創建和發佈工作台",
        description:
          "支持在 LightVela 中選擇模板或從零開始創建個人工作台，並以靜態網站的形式直接發佈、預覽、更新和管理自己的工作台。",
        image: "/assets/changelog/lightvela-workbench-zh.png",
      },
      {
        locale: "en-US",
        month: "September 2026",
        title: "LightVela Supports Building and Publishing Workbenches",
        description:
          "Build a personal workbench in LightVela from a template or from scratch, then publish, preview, update, and manage it directly as a static website.",
        image: "/assets/changelog/lightvela-workbench-global-en.png",
      },
      {
        locale: "id-ID",
        month: "September 2026",
        title: "LightVela Mendukung Pembuatan dan Publikasi Workbench",
        description:
          "Buat workbench pribadi di LightVela dari templat atau dari nol, lalu publikasikan, pratinjau, perbarui, dan kelola langsung sebagai situs web statis.",
        image: "/assets/changelog/lightvela-workbench-global-en.png",
      },
      {
        locale: "es",
        month: "Septiembre de 2026",
        title: "LightVela Permite Crear y Publicar Workbenches",
        description:
          "Crea un workbench personal en LightVela a partir de una plantilla o desde cero, y publícalo, previsualízalo, actualízalo y gestiónalo directamente como un sitio web estático.",
        image: "/assets/changelog/lightvela-workbench-global-en.png",
      },
      {
        locale: "ja-JP",
        month: "2026年9月",
        title: "LightVelaでワークベンチの作成と公開に対応",
        description:
          "LightVelaでテンプレートを選ぶかゼロから個人用ワークベンチを作成し、静的Webサイトとして直接公開、プレビュー、更新、管理できます。",
        image: "/assets/changelog/lightvela-workbench-global-en.png",
      },
      {
        locale: "ko-KR",
        month: "2026년 9월",
        title: "LightVela에서 워크벤치 생성 및 게시 지원",
        description:
          "LightVela에서 템플릿을 선택하거나 처음부터 개인 워크벤치를 만들고, 정적 웹사이트 형태로 직접 게시, 미리보기, 업데이트 및 관리할 수 있습니다.",
        image: "/assets/changelog/lightvela-workbench-global-en.png",
      },
    ] as const;

    for (const copy of workbenchCopies) {
      await ensureLocaleDictionary(copy.locale);
      await i18n.changeLanguage(copy.locale);
      render(
        <MemoryRouter>
          <ChangelogPage />
        </MemoryRouter>,
      );

      const septemberSection = screen.getByText(copy.month).closest("section");
      expect(septemberSection).not.toBeNull();
      const heading = within(septemberSection!).getByRole("heading", { name: `${copy.title}Beta` });
      expect(heading).toBeInTheDocument();
      expect(within(septemberSection!).getByText(copy.description)).toBeInTheDocument();
      expect(within(heading.closest("article")!).getByText("Beta")).toBeInTheDocument();
      expect(screen.getByAltText(copy.title)).toHaveAttribute("src", expect.stringContaining(copy.image));
      cleanup();
    }
  });

  const globalLaunchCopies = [
    {
      locale: "zh-CN",
      publicBetaTitle: "LightVela 产品公测上线",
      indonesianTitle: "LightVela 支持印度尼西亚语",
      indonesianDescription:
        "现在可以使用印度尼西亚语浏览 LightVela 的公开页面、产品文档和账号流程。",
      launchTitle: "LightVela 正式上线并启用付费服务",
      launchDescription:
        "LightVela 国际站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。",
    },
    {
      locale: "zh-Hant",
      publicBetaTitle: "LightVela 產品公測上線",
      indonesianTitle: "LightVela 支持印度尼西亞語",
      indonesianDescription:
        "現在可以使用印度尼西亞語瀏覽 LightVela 的公開頁面、產品文檔和賬號流程。",
      launchTitle: "LightVela 正式上線並啓用付費服務",
      launchDescription:
        "LightVela 國際站正式上線，同步啓用付費服務。你可以根據使用需求選擇合適的訂閲套餐。",
    },
    {
      locale: "en-US",
      publicBetaTitle: "LightVela Public Beta Launch",
      indonesianTitle: "Indonesian Is Now Available",
      indonesianDescription:
        "Browse LightVela's public pages, documentation, and account flows in Indonesian.",
      launchTitle: "LightVela Officially Launches with Paid Services",
      launchDescription:
        "LightVela is now officially available globally with paid services. Choose a subscription plan that fits your needs.",
    },
    {
      locale: "id-ID",
      publicBetaTitle: "Peluncuran Beta Publik LightVela",
      indonesianTitle: "Bahasa Indonesia Kini Tersedia",
      indonesianDescription:
        "Sekarang Anda dapat menjelajahi halaman publik, dokumentasi produk, dan alur akun LightVela dalam Bahasa Indonesia.",
      launchTitle: "LightVela Resmi Diluncurkan dengan Layanan Berbayar",
      launchDescription:
        "LightVela kini resmi tersedia secara global dengan layanan berbayar. Pilih paket langganan yang sesuai dengan kebutuhan Anda.",
    },
    {
      locale: "es",
      publicBetaTitle: "Lanzamiento de la beta pública de LightVela",
      indonesianTitle: "El indonesio ya está disponible",
      indonesianDescription:
        "Ahora puedes explorar las páginas públicas, la documentación del producto y los flujos de cuenta de LightVela en indonesio.",
      launchTitle: "LightVela se lanza oficialmente y activa los servicios de pago",
      launchDescription:
        "LightVela ya está disponible oficialmente a nivel global con servicios de pago. Elige el plan de suscripción que mejor se adapte a tus necesidades.",
    },
  ] as const;

  it("describes the April launch as a public beta in every visible global dictionary", async () => {
    for (const copy of globalLaunchCopies) {
      await i18n.changeLanguage(copy.locale);
      render(
        <MemoryRouter>
          <ChangelogPage />
        </MemoryRouter>,
      );

      expect(screen.getByRole("heading", { name: copy.publicBetaTitle })).toBeInTheDocument();
      cleanup();
    }
  });

  it("ends the global August changelog with Indonesian support and the paid launch", async () => {
    for (const copy of globalLaunchCopies) {
      await i18n.changeLanguage(copy.locale);
      render(
        <MemoryRouter>
          <ChangelogPage />
        </MemoryRouter>,
      );

      const indonesianHeading = screen.getByRole("heading", { name: copy.indonesianTitle });
      const launchHeading = screen.getByRole("heading", { name: copy.launchTitle });
      const augustSection = launchHeading.closest("section");
      expect(augustSection).not.toBeNull();
      expect(within(augustSection!).getAllByRole("heading").slice(-2)).toEqual([
        indonesianHeading,
        launchHeading,
      ]);
      expect(within(augustSection!).getByText(copy.indonesianDescription)).toBeInTheDocument();
      expect(within(augustSection!).getByText(copy.launchDescription)).toBeInTheDocument();
      expect(indonesianHeading.closest("article")?.querySelector("img")).toBeNull();
      expect(launchHeading.closest("article")?.querySelector("img")).toBeNull();
      cleanup();
    }
  });

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
    expect(zhAdvancedSettingsImage.parentElement).toHaveStyle({ aspectRatio: "1043 / 1282" });
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
    expect(screen.getByRole("heading", { name: "定时任务支持关联上游任务" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "创建或编辑定时任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "LightVela 支持钉钉通道" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "技能页面支持批量安装与来源查看" })).toBeInTheDocument();
    expect(screen.getByText("安装多个 Skill 时可以查看实时进度，并从技能页面直接打开 ClawHub 或 skills.sh 的原始来源页面。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "定时任务模板" })).toBeInTheDocument();
    expect(screen.getByText("选择一个现成的定时任务模板，先运行一次，确认效果后再将其转为持续执行的定时任务。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持在 QQ 群聊中 @ 机器人" })).toBeInTheDocument();
    expect(screen.getByText("将 Hermes Agent 添加到 QQ 群后，@ 机器人即可开始对话。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持繁体中文" })).toBeInTheDocument();
    expect(screen.getByText("现在可以使用繁体中文浏览 LightVela 的公开页面、产品文档和账号流程。")).toBeInTheDocument();
    expect(screen.getByAltText("定时任务支持关联上游任务")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task-global-zh.png"),
    );
    expect(screen.getByAltText("定时任务支持关联上游任务").parentElement).toHaveStyle({ aspectRatio: "718 / 234" });
    expect(screen.getByAltText("技能页面支持批量安装与来源查看")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-zh.png"),
    );
    expect(screen.getByAltText("定时任务模板")).toHaveAttribute(
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
    const zhTestRunHeading = within(zhAugustSection!).getByRole("heading", {
      name: "定时任务支持测试运行",
    });
    const zhAugustHeadings = within(zhAugustSection!).getAllByRole("heading");
    expect(zhAugustHeadings[1]).toBe(zhTestRunHeading);
    expect(
      within(zhAugustSection!).getByText(
        "创建或编辑定时任务时，可以先运行一次当前任务内容，无需保存即可确认执行效果，再决定是否创建或更新任务。",
      ),
    ).toBeInTheDocument();
    expect(zhTestRunHeading.closest("article")?.querySelector("img")).toBeNull();
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
      within(augustSection!).queryByRole("heading", { name: "Scheduled Task Templates" }),
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
      within(julySection!).getByRole("heading", { name: "Scheduled Task Templates" }),
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
    expect(enAdvancedSettingsImage.parentElement).toHaveStyle({ aspectRatio: "1055 / 1285" });
    const enPersonaImage = screen.getByAltText("LightVela Now Supports Custom Persona File Uploads");
    expect(enPersonaImage).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-persona-upload-global-en.png"),
    );
    expect(enPersonaImage.parentElement).toHaveStyle({ aspectRatio: "1410 / 642" });
    expect(
      screen.getByRole("heading", { name: "Scheduled Tasks Can Now Link to Upstream Scheduled Tasks" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When creating or editing a scheduled task, you can link an upstream scheduled task. When the scheduled task runs later, it uses the upstream scheduled task's most recent output as context.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Skills Page Gets Faster Installs and Clearer Sources" })).toBeInTheDocument();
    expect(screen.getByText("Install multiple Skills with live progress and open their original ClawHub or skills.sh source pages directly from the Skills page.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scheduled Task Templates" })).toBeInTheDocument();
    expect(screen.getByText("Choose a ready-made scheduled task template, run it once, and turn it into an ongoing scheduled task when it works for you.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "QQ Group @Mentions Are Now Supported" })).toBeInTheDocument();
    expect(screen.getByText("Add your Hermes Agent to a QQ group and @mention it to start a conversation.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Traditional Chinese Is Now Available" })).toBeInTheDocument();
    expect(screen.getByText("Browse LightVela's public pages, documentation, and account flows in Traditional Chinese.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pricing Is Now Available with More Flexible Billing" })).not.toBeInTheDocument();
    expect(screen.getByAltText("Scheduled Tasks Can Now Link to Upstream Scheduled Tasks")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task.png"),
    );
    expect(screen.getByAltText("Skills Page Gets Faster Installs and Clearer Sources")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-en.png"),
    );
    expect(screen.getByAltText("Scheduled Task Templates")).toHaveAttribute(
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
    const enTestRunHeading = within(augustSection!).getByRole("heading", {
      name: "Scheduled Tasks Now Support Test Runs",
    });
    expect(within(augustSection!).getAllByRole("heading")[1]).toBe(enTestRunHeading);
    expect(
      within(augustSection!).getByText(
        "When creating or editing a scheduled task, you can run the current scheduled task once without saving it, review the result, and then decide whether to create or update the scheduled task.",
      ),
    ).toBeInTheDocument();
    expect(enTestRunHeading.closest("article")?.querySelector("img")).toBeNull();
    expect(document.body).not.toHaveTextContent("Automations");

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
    expect(screen.getByRole("heading", { name: "定時任務支持關聯上游任務" })).toBeInTheDocument();
    expect(screen.getByAltText("定時任務支持關聯上游任務")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-automation-upstream-task-global-zh.png"),
    );
    expect(screen.getByAltText("定時任務支持關聯上游任務").parentElement).toHaveStyle({
      aspectRatio: "718 / 234",
    });
    expect(screen.getByRole("heading", { name: "技能頁面支持批量安裝與來源查看" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "定時任務模板" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持在 QQ 群聊中 @ 機器人" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "支持繁體中文" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "定價支持更多套餐與訂閲方式" })).not.toBeInTheDocument();
    expect(screen.getByAltText("技能頁面支持批量安裝與來源查看")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-skills-bulk-install-global-zh.png"),
    );
    expect(screen.getByAltText("定時任務模板")).toHaveAttribute(
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
      screen.getByRole("heading", { name: "Tugas Terjadwal Kini Dapat Ditautkan ke Tugas Terjadwal Upstream" }),
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
    expect(screen.getByAltText("LightVela 产品公测上线")).toHaveAttribute(
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
    expect(screen.getByAltText("LightVela Public Beta Launch")).toHaveAttribute(
      "src",
      expect.stringContaining("/assets/changelog/lightvela-launch-global-en.webp"),
    );
  });
});

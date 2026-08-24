import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 国际站（isGlobal）专属用例。
   与 subscribe-page.test.tsx（国内站，不 mock region）分文件维护 ——
   vi.mock 是模块级全局的，同一文件无法让 isCN / isGlobal 两种语义并存：
   国内站用例断言 `{isCN && ...}` 渲染的「退款规则」链接，
   而本文件的支付回跳用例依赖 `if (!isGlobal) return;` 才能进入接管逻辑。
   拆分方式参照 login-modal.test.tsx / login-modal.global.test.tsx。 */

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: ({ authControls }: { authControls?: ReactNode }) => (
    <header>{authControls}</header>
  ),
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer />,
}));

/* 可变的 agent-context 桩：支付回跳用例需要「已登录 + 未发货 → 发货」的状态迁移。 */
const openClawState = {
  isLoggedIn: false,
  isSubscribed: false,
  subscribe: vi.fn(),
  addBot: vi.fn(),
  bots: [] as { id: string; status: string }[],
  user: null as unknown,
  refreshPasses: vi.fn(),
  activePass: null as unknown,
  latestPass: null as unknown,
};

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => openClawState,
}));

const sessionState = {
  authReady: true,
  isAuthenticated: false,
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: sessionState.authReady,
    isAuthenticated: sessionState.isAuthenticated,
    session: {
      stage: sessionState.isAuthenticated ? "authenticated" : "anonymous",
      user: null,
    },
  }),
}));

/* 登录态会走 listBundles 拉真实套餐；回跳用例要靠它拿到 planList 才能解析 pay_plan。 */
const listBundlesMock = vi.fn();
const createPassOrderMock = vi.fn();
const getPassOrderUrlMock = vi.fn();
const createDianshiPassOrderAndPayMock = vi.fn();

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      /* master 新版 LoginModal 会在渲染时读取国际站 OAuth 地址；本组用例不触发登录跳转。 */
      getOAuthStartUrl: vi.fn((provider: string) =>
        `https://lightvela.ai/auth/oauth/${provider}/start`,
      ),
    },
    plans: {
      listBundles: listBundlesMock,
      createPassOrder: createPassOrderMock,
      getPassOrderUrl: getPassOrderUrlMock,
      createDianshiPassOrderAndPay: createDianshiPassOrderAndPayMock,
    },
  }),
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => true,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/i18n/t", () => ({
  useLocaleOverride: () => null,
  useT: () => (zh: string, opts?: Record<string, unknown>) =>
    zh.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
      opts?.[key] == null ? placeholder : String(opts[key]),
    ),
}));

const navigateMock = vi.fn();

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useAppNavigate: () => navigateMock,
}));

/* 必须完整列出被依赖链引用的导出：vi.mock 会整体替换模块，
   只给 isGlobal 会让 constants/legal.ts 等的 `import { isCN }` 抛
   「No "isCN" export is defined」并导致组件渲染失败。
   导出清单与 login-modal.global.test.tsx 保持一致。 */
vi.mock("@/lib/region", () => ({
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
  readLocaleFromPath: () => null,
  localizedPath: (path: string) => path,
  switchLocaleInPath: (path: string) => path,
  langPrefixRedirectTarget: () => null,
}));

const buildBundle = (bundleId: string, bundleName: string) => ({
  bundle_id: bundleId,
  bundle_name: bundleName,
  bundle_state: "ONLINE" as const,
  bundle_type: "ai",
  time_unit: "m" as const,
  time_span: 1,
  price: 4900,
  total_cost: 4900,
  real_total_cost: 4900,
  currency: "USD",
  credit: 10000,
  bundle_sales_available_count: 100,
  bundle_sales_total_count: 100,
});

const buildBillingError = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * 组件按嵌套结构读 bundle.price（见 BundlePrice 类型），金额用例必须用嵌套 mock
 * 才能走到真实计费分支。
 * 口径（后端 2692ca1ca 询价税费拆分，四字段直接下发）：
 *   price=原价；total_cost=折后价（税前）；tax_price=税费；real_total_cost=税后价（= total + tax）。
 * 本构造：price=5100（原价 $51）、total_cost=4800（折后 $48）、tax_price=400（$4）、
 * real_total_cost=5200（税后 $52 = 4800 + 400），字段间满足恒等关系。
 * 卡片价/小计 = total_cost → $48.00；误用 real_total_cost（税后）会显示 $52.00、
 * 误用 price（原价）会显示 $51.00，均被断言抓住。
 */
const buildNestedBundle = () => ({
  ...buildBundle("bundle_cruise_ai_01", "巡游 Cruise"),
  price: {
    price: 5100,
    total_cost: 4800,
    real_total_cost: 5200,
    currency: "USD",
    discount: 4800 / 5100,
    tax_price: 400,
  },
});

const resetState = () => {
  openClawState.isLoggedIn = false;
  openClawState.isSubscribed = false;
  openClawState.subscribe = vi.fn();
  openClawState.addBot = vi.fn();
  openClawState.bots = [];
  openClawState.refreshPasses = vi.fn().mockResolvedValue(undefined);
  openClawState.activePass = null;
  openClawState.latestPass = null;
  sessionState.authReady = true;
  sessionState.isAuthenticated = false;
  listBundlesMock.mockReset();
  createPassOrderMock.mockReset();
  getPassOrderUrlMock.mockReset();
  createDianshiPassOrderAndPayMock.mockReset();
  /* listBundles 直接返回 Bundle[]，不是 { bundles } 包装。 */
  listBundlesMock.mockResolvedValue([buildBundle("bundle_cruise_ai_01", "巡游 Cruise")]);
  createPassOrderMock.mockResolvedValue({ deal_names: ["deal-01"], auth_code: "auth-01" });
  getPassOrderUrlMock.mockResolvedValue({
    need_charge: 1,
    pay_url: "https://pay.example.com/order-01",
  });
  createDianshiPassOrderAndPayMock.mockResolvedValue({ deal_name: "deal-zero-01" });
  navigateMock.mockReset();
  window.history.replaceState({}, "", "/subscribe");
};

describe("SubscribePage paid billing visibility", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  it("shows the paid plans immediately without a reveal gate", async () => {
    (globalThis as { React?: typeof React }).React = React;

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 全量放开后不再有 reveal 门禁：未登录直接展示付费套餐
       （静态定价 + 可点击 CTA），「即将上线」占位卡消失。 */
    expect(await screen.findByText("巡游 Cruise")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "即将上线" })).not.toBeInTheDocument();
  });

  it("shows the international paid order flow by default", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 全量放开：登录后无需 show() 即展示付费时长与可订阅 CTA。 */
    expect(await screen.findByRole("tablist", { name: "付费时长" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即订阅" })).toBeEnabled();
  });
});

/**
 * 国际站 AI 增强版档位促销标签。
 *
 * 背景：定价页是 2 张卡（启航 / 巡游），标准版与 AI 增强版是**卡内积分档位切换**
 * （启航 100 ⇄ 4500、巡游 200 ⇄ 10000），切换即整份 PlanInfo 替换，promoTag 随之联动。
 *
 * 改动前国际站 AI 档位无任何标签，成因两处：
 *   1. `if (!isGlobal)` 把国际站排除在硬编码 AI 标签之外；
 *   2. 后端 discount 单位不一致（`0<d<1` 与 `50` 两套口径），百分数下发时两分支均不命中。
 *
 * 现口径：国际站付费已全量放开（无 reveal 门禁），未登录使用静态美元价；
 * 国际站启航 AI「首单免费 3 天」、巡游 AI「首月 6 折」，登录后仍使用后端询价。
 */
describe("SubscribePage intl AI promo tags", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  const getCreditTab = (credit: string) => {
    const tab = screen
      .getAllByRole("tab")
      .find((item) => (item.textContent?.trim() ?? "").startsWith(credit));
    if (!tab) throw new Error(`Missing ${credit} credit tab`);
    return tab;
  };

  const getTierCard = (name: string): HTMLElement => {
    const heading = screen.getByRole("heading", { name });
    const cardContent = heading.parentElement?.parentElement?.parentElement;
    if (!cardContent) throw new Error(`Missing ${name} card content`);
    return cardContent;
  };

  const expectTierPrice = (
    card: HTMLElement,
    displayedPrice: string,
    originalPrice: string,
  ): void => {
    expect(card).toHaveTextContent(displayedPrice);
    expect(card).toHaveTextContent(originalPrice);
  };

  /* 已登录询价 mock：入参为「折后价」（新用户实付，税前）。按后端四字段口径构造：
     price=1000（原价 $10）、total_cost=折后价、real_total_cost=折后价（无税场景税后=折后）、tax_price=0。
     零元新用户单也会带 tax_price: 0，刻意带上锁定「零元 + 有税字段」时免费订阅链路
     （ConfirmOrderModal 零元确认弹窗、点石零元下单）不被税费展示改动波及。 */
  const buildLaunchAiQuote = (discountedTotalCost: number) => ({
    ...buildBundle("bundle_launch_ai_01", "启航 Launch"),
    credit: 4500,
    price: {
      price: 1000,
      total_cost: discountedTotalCost,
      real_total_cost: discountedTotalCost,
      currency: "USD",
      discount: discountedTotalCost / 1000,
      tax_price: 0,
    },
  });

  /* 标准版询价 mock：入参为折后价，口径同 buildLaunchAiQuote（price=650 原价 / total=real=折后 / 无税）。 */
  const buildLaunchStandardQuote = (discountedTotalCost: number) => ({
    ...buildBundle("bundle_launch_01", "启航 Launch"),
    bundle_type: "general",
    credit: 100,
    price: {
      price: 650,
      total_cost: discountedTotalCost,
      real_total_cost: discountedTotalCost,
      currency: "USD",
      discount: discountedTotalCost / 650,
      tax_price: 0,
    },
  });

  const renderLoggedPricing = async (expectedPrice: string): Promise<void> => {
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    await waitFor(() => expect(listBundlesMock).toHaveBeenCalled());
    /* 等真实询价就绪，避免后续否定断言在 loading 阶段假绿。 */
    await waitFor(() => expect(getTierCard("启航 Launch")).toHaveTextContent(expectedPrice));
  };

  /* 未登录不请求后端，月付四档全部消费前端静态美元表。 */
  it("shows the anonymous monthly static pricing matrix", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await waitFor(() => expect(getCreditTab("4500")).toBeInTheDocument());
    expect(listBundlesMock).not.toHaveBeenCalled();

    const launchCard = getTierCard("启航 Launch");
    const cruiseCard = getTierCard("巡游 Cruise");

    /* 默认标准版：启航新用户 14 天免费；巡游首购 5 折。 */
    expectTierPrice(launchCard, "$0.00", "$6.50");
    expect(within(launchCard).getByText("首单免费 14 天")).toBeInTheDocument();
    expectTierPrice(cruiseCard, "$7.00", "$14.00");
    expect(within(cruiseCard).getByText("首月 5 折")).toBeInTheDocument();

    /* AI 版：启航新用户 3 天免费；巡游首购 6 折。 */
    await user.click(getCreditTab("4500"));
    await user.click(getCreditTab("10000"));
    await waitFor(() => {
      expectTierPrice(launchCard, "$0.00", "$10.00");
      expectTierPrice(cruiseCard, "$13.80", "$23.00");
    });
    expect(within(launchCard).getByText("首单免费 3 天")).toBeInTheDocument();
    expect(within(cruiseCard).getByText("首月 6 折")).toBeInTheDocument();
  });

  /* 季付四档只展示静态季付折后价，不继承月付首期免费/首购标签。 */
  it("shows the anonymous quarterly static pricing matrix", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await user.click(await screen.findByRole("tab", { name: "季付" }));

    const launchCard = getTierCard("启航 Launch");
    const cruiseCard = getTierCard("巡游 Cruise");
    await waitFor(() => {
      expectTierPrice(launchCard, "$18.07", "$19.50");
      expectTierPrice(cruiseCard, "$38.92", "$42.00");
    });
    expect(within(launchCard).getByText("9.3折")).toBeInTheDocument();
    expect(within(cruiseCard).getByText("9.3折")).toBeInTheDocument();

    await user.click(getCreditTab("4500"));
    await user.click(getCreditTab("10000"));
    await waitFor(() => {
      expectTierPrice(launchCard, "$29.43", "$30.00");
      expectTierPrice(cruiseCard, "$67.69", "$69.00");
    });
    expect(within(launchCard).getByText("9.8折")).toBeInTheDocument();
    expect(within(cruiseCard).getByText("9.8折")).toBeInTheDocument();
    expect(listBundlesMock).not.toHaveBeenCalled();
  });

  /* 启航 AI 档位 CTA 与同卡标准版档位对齐为「免费订阅」（en-US 显示 "Free Trial"）；
     巡游 AI 档位不在此范围，维持「立即订阅」。 */
  it("aligns the Launch AI tier CTA with the standard tier", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 启航标准版档位基线：CTA 已为「免费订阅」 */
    await waitFor(() => expect(getCreditTab("4500")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "免费订阅" })).toBeInTheDocument();

    /* 切到启航 AI 档位：CTA 仍为「免费订阅」，不得回落到「立即订阅」 */
    await user.click(getCreditTab("4500"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "免费订阅" })).toBeInTheDocument(),
    );
    expect(await screen.findByText("首单免费 3 天")).toBeInTheDocument();

    /* 巡游 AI 档位不对齐「免费订阅」，维持「立即订阅」 */
    await user.click(getCreditTab("10000"));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "立即订阅" }).length).toBeGreaterThan(0),
    );
  });

  /* 切回标准版档位后标签必须还原，避免 promoTag 残留。 */
  it("restores the standard tier label when switching back", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await waitFor(() => expect(getCreditTab("4500")).toBeInTheDocument());

    await user.click(getCreditTab("4500"));
    expect(await screen.findByText("首单免费 3 天")).toBeInTheDocument();

    await user.click(getCreditTab("100"));
    await waitFor(() =>
      expect(screen.queryByText("首单免费 3 天")).not.toBeInTheDocument(),
    );
  });

  /**
   * 季付无首期免费试用（季付价即实付价），CTA 必须收口为「立即订阅」，
   * 且不展示免费试用 hover 提示；月付促销标签也不得出现。
   */
  it("drops the free-trial CTA on the quarterly duration", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 月付基线：启航标准版为「免费订阅」 */
    expect(await screen.findByRole("button", { name: "免费订阅" })).toBeInTheDocument();

    /* 切季付：全部卡 CTA 收口为「立即订阅」，不得再有「免费订阅」 */
    await user.click(screen.getByRole("tab", { name: "季付" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "免费订阅" })).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole("button", { name: "立即订阅" }).length).toBeGreaterThan(0);

    /* 季付不得出现月付首期促销标签 */
    expect(screen.queryByText("首单免费 3 天")).not.toBeInTheDocument();
    expect(screen.queryByText("首单免费 14 天")).not.toBeInTheDocument();

    /* 切到启航 AI 档位，季付下同样不得回落到「免费订阅」 */
    await user.click(getCreditTab("4500"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "免费订阅" })).not.toBeInTheDocument(),
    );
  });

  /**
   * 折扣角标必须走 i18n，不能用模板字符串拼中文「折」。
   * 本文件 useT 桩直接回显中文 key，故断言 key 形态 `{{discount}}折` 已被插值，
   * 且不出现未经 t() 处理的裸中文折扣（改动前为 `9.8折` 这类硬编码）。
   */
  it("routes the quarterly discount tag through i18n", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await waitFor(() => expect(getCreditTab("4500")).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "季付" }));

    /* 源码不得再出现 `${...}折` 这类模板字符串拼接（会绕过 i18n 直接输出中文）。
       只匹配插值紧接「折」的形态，避免误伤注释里的「季付统一享 8.5 折优惠」等说明文字。 */
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "next-site/subscribe-page.tsx"), "utf8");
    expect(source).not.toMatch(/\$\{[^}]*\}折/);
    /* 折扣角标改为经 t() 的插值 key */
    expect(source).toContain('t("{{discount}}折"');
    /* 中文折扣率必须保留 1 位小数（×100/10），不得写成 ×1000/100 引入第 2 位小数：
       否则会出现「9.83折」这类与改动前不一致的展示精度。 */
    expect(source).toContain("discount: Math.round(rate * 100) / 10");
    expect(source).not.toContain("Math.round(rate * 1000) / 100");
  });

  /**
   * 已登录态：走后端询价。后端下发**百分数** discount=60 —— 改动前该值
   * 既不命中 `0<d<1` 分支、也不命中 `=== 50` 分支，落到 else 后被 `!isGlobal` 拦掉，
   * 导致巡游 AI 丢标签。现在标签不依赖 discount，必须稳定展示。
   */
  it("labels the Cruise AI tier regardless of the backend discount unit", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    listBundlesMock.mockResolvedValue([
      {
        ...buildBundle("bundle_cruise_ai_01", "巡游 Cruise"),
        price: {
          /* 新口径：price=原价 4900、total_cost=折后 2940（6 折）、real=税后（无税=折后）。
             discount 刻意用百分数口径（60），标签计算不依赖它。 */
          price: 4900,
          total_cost: 2940,
          real_total_cost: 2940,
          currency: "USD",
          discount: 60,
          tax_price: 0,
        },
      },
    ]);

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    expect(await screen.findByText("首月 6 折")).toBeInTheDocument();
  });

  it("does not promise a free trial for a chargeable logged-in Launch AI quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();
    listBundlesMock.mockResolvedValue([buildLaunchAiQuote(1000)]);

    await renderLoggedPricing("10.00");

    const subscribeButton = await screen.findByRole("button", { name: "立即订阅" });
    expect(subscribeButton).toBeEnabled();
    expect(screen.queryByText("首单免费 3 天")).not.toBeInTheDocument();
    await user.click(subscribeButton);
    expect(await screen.findByText("信用卡")).toBeInTheDocument();
    expect(createDianshiPassOrderAndPayMock).not.toHaveBeenCalled();
  });

  it("keeps the free-trial label and zero-order confirmation for a zero-amount Launch AI quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();
    listBundlesMock.mockResolvedValue([buildLaunchAiQuote(0)]);

    await renderLoggedPricing("0.00");

    expect(await screen.findByText("首单免费 3 天")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "免费订阅" }));
    expect(await screen.findByRole("button", { name: "确认开通" })).toBeInTheDocument();
    expect(screen.queryByText("信用卡")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认开通" }));
    await waitFor(() => expect(createDianshiPassOrderAndPayMock).toHaveBeenCalledWith({
      bundle_id: "bundle_launch_ai_01",
      period: 1,
      time_unit: "m",
    }));
    expect(createPassOrderMock).not.toHaveBeenCalled();
  });

  it("does not invent a discount for a subscribed full-price Launch AI quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    openClawState.isSubscribed = true;
    listBundlesMock.mockResolvedValue([buildLaunchAiQuote(1000)]);

    await renderLoggedPricing("10.00");

    expect(screen.queryByText("首单免费 3 天")).not.toBeInTheDocument();
    expect(screen.queryByText("首月 6 折")).not.toBeInTheDocument();
  });

  it("keeps a real backend discount for a subscribed Launch AI quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    openClawState.isSubscribed = true;
    listBundlesMock.mockResolvedValue([buildLaunchAiQuote(600)]);

    await renderLoggedPricing("6.00");

    expect(screen.queryByText("首单免费 3 天")).not.toBeInTheDocument();
    expect(await screen.findByText("首月 6 折")).toBeInTheDocument();
  });

  it("does not invent a first-order benefit for a subscribed full-price standard quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    openClawState.isSubscribed = true;
    listBundlesMock.mockResolvedValue([buildLaunchStandardQuote(650)]);

    await renderLoggedPricing("6.50");

    expect(screen.queryByText("首单免费 14 天")).not.toBeInTheDocument();
    expect(screen.queryByText("5折")).not.toBeInTheDocument();
  });

  it("falls back to paid checkout for a chargeable new-user standard quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();
    listBundlesMock.mockResolvedValue([buildLaunchStandardQuote(650)]);

    await renderLoggedPricing("6.50");

    const subscribeButton = screen.getByRole("button", { name: "立即订阅" });
    expect(screen.queryByText("首单免费 14 天")).not.toBeInTheDocument();
    await user.click(subscribeButton);
    expect(await screen.findByText("信用卡")).toBeInTheDocument();
  });

  it("guides global isolated pass users to manage the plan instead of renewing", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();
    listBundlesMock.mockResolvedValue([buildLaunchAiQuote(1000)]);
    createPassOrderMock.mockRejectedValueOnce(buildBillingError("PASS_ISOLATED", "pass isolated"));

    await renderLoggedPricing("10.00");

    await user.click(await screen.findByRole("button", { name: "立即订阅" }));
    expect(await screen.findByText("信用卡")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "支付 $10.00" }));

    expect(await screen.findByText("当前套餐已进入隔离期，请在账号页管理套餐，销毁后可重新购买。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "管理套餐" })).toHaveAttribute("href", "/account");
    expect(screen.queryByRole("link", { name: "前往续费" })).not.toBeInTheDocument();
  });

  it("does not promise renewal for global expired pass users", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const user = userEvent.setup();
    listBundlesMock.mockResolvedValue([buildLaunchAiQuote(1000)]);
    createPassOrderMock.mockRejectedValueOnce(buildBillingError("PASS_EXPIRED", "pass expired"));

    await renderLoggedPricing("10.00");

    await user.click(await screen.findByRole("button", { name: "立即订阅" }));
    expect(await screen.findByText("信用卡")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "支付 $10.00" }));

    expect(await screen.findByText("当前套餐已到期，续费功能敬请期待；请在账号页查看套餐，销毁后可重新购买。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "管理套餐" })).toHaveAttribute("href", "/account");
    expect(screen.queryByRole("link", { name: "前往续费" })).not.toBeInTheDocument();
  });

  it("keeps a real backend discount for a subscribed standard quote", async () => {
    (globalThis as { React?: typeof React }).React = React;
    openClawState.isSubscribed = true;
    listBundlesMock.mockResolvedValue([buildLaunchStandardQuote(325)]);

    await renderLoggedPricing("3.25");

    expect(await screen.findByText("5折")).toBeInTheDocument();
    expect(screen.queryByText("首单免费 14 天")).not.toBeInTheDocument();
  });
});

describe("SubscribePage confirm order amounts", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  /**
   * 卡片价口径（价签模式：卡片标折后价税前，付款实付含税）：
   *   卡片展示价 = total_cost（折后价），后端直接下发、前端不做换算。
   *
   * buildNestedBundle：price=5100（原价）、total_cost=4800（折后）、tax_price=400、real=5200（税后）。
   *   误用 real_total_cost（税后价）会让卡片显示 $52.00；
   *   误用 price（原价）会显示 $51.00。均被否定断言抓住。
   */
  it("shows the tax-exclusive discounted price on the plan card", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    listBundlesMock.mockResolvedValue([buildNestedBundle()]);

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 等套餐列表渲染完成（listBundles 异步，套餐卡片非同步出现） */
    await screen.findByText("巡游 Cruise");

    /**
     * 卡片价口径锁定：折后价（total_cost）而非税后价（real_total_cost）。
     * 卡片价格渲染为「$ 符号 + 数字」分离节点（formatYuan 拼接），故断言纯数字文本。
     * 弹窗三行用 fmt() 生成完整 "$48.00" 文本，与卡片的分离节点格式不同——两处口径
     * 分别由本用例与「renders subtotal, tax and total」用例锁定。
     */
    expect(screen.getByText("48.00")).toBeInTheDocument();
    expect(screen.queryByText("52.00")).not.toBeInTheDocument();
    expect(screen.queryByText("51.00")).not.toBeInTheDocument();
  });

  /**
   * 税费展示三行口径（产品确认，后端 2692ca1ca 四字段直接下发）：
   *   小计 ← total_cost（折后价，税前）
   *   税费 ← tax_price（缺失视为 0）
   *   合计 ← real_total_cost（税后价）直接展示，不做前端加总
   * 折扣体现在原价 price 与折后价 total_cost 之间（删除线），不单列折扣行。
   */
  it("renders subtotal, tax and total from the backend price fields", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    listBundlesMock.mockResolvedValue([buildNestedBundle()]);

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    fireEvent.click(await screen.findByRole("button", { name: "立即订阅" }));

    expect(await screen.findByText("确认订单")).toBeInTheDocument();
    /* 小计 = total_cost 4800 分 → $48.00；套餐行同为折后价，共两处 */
    expect(screen.getAllByText("$48.00").length).toBeGreaterThanOrEqual(2);
    /* 税费 = tax_price 400 分 → $4.00 */
    expect(screen.getByText("$4.00")).toBeInTheDocument();
    /* 合计 = real_total_cost 5200 分 → $52.00（税后价直显 = 4800 + 400，不做前端加总） */
    expect(screen.getByText("$52.00")).toBeInTheDocument();
    /* $45.00 不再是任何合法字段值，防实现回退到旧的「total_cost=税前原价」口径 */
    expect(screen.queryByText("$45.00")).not.toBeInTheDocument();
  });

  it("treats a missing tax field as zero tax", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    listBundlesMock.mockResolvedValue([
      {
        ...buildNestedBundle(),
        price: {
          /* tax_price 缺失：视为税额 0；无税场景 real_total_cost = total_cost（折后价） */
          price: 5100,
          total_cost: 4800,
          real_total_cost: 4800,
          currency: "USD",
          discount: 4800 / 5100,
        },
      },
    ]);

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    fireEvent.click(await screen.findByRole("button", { name: "立即订阅" }));

    expect(await screen.findByText("确认订单")).toBeInTheDocument();
    /* 税费行兜底 $0.00 */
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    /* 小计 = total_cost $48.00；合计 = real_total_cost（无税 = 折后价）同为 $48.00 */
    expect(screen.getAllByText("$48.00").length).toBeGreaterThanOrEqual(2);
  });
});

describe("SubscribePage payment return", () => {
  beforeEach(resetState);
  /* 必须显式卸载：上一个用例的 paying 弹窗若残留在 document 里，
     后续用例的「不应出现开通提示」断言会误判。 */
  afterEach(cleanup);

  /**
   * 弹窗被拦截时支付走 window.location.assign，付款后 return_url 回到全新页面，
   * 原窗口的 paying 轮询已销毁。带 pay_return 标记才能重新接棒等发货。
   */
  it("resumes the activation wait when returning from the hosted payment page", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    window.history.replaceState({}, "", "/subscribe?pay_return=1&pay_plan=bundle_cruise_ai_01");

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 进入等发货态：既没有二维码也没有 pay_url，展示「正在开通套餐」 */
    expect(await screen.findByText("正在开通套餐")).toBeInTheDocument();
    expect(screen.getByText("正在确认支付结果并开通套餐，完成后将自动跳转")).toBeInTheDocument();
    /* 回跳场景无支付页可重开，不能渲染死按钮 */
    expect(screen.queryByRole("button", { name: "重新打开支付页" })).not.toBeInTheDocument();
    /* query 必须被清掉，避免刷新重复触发轮询 */
    expect(window.location.search).toBe("");
  });

  it("ignores the marker when the plan cannot be resolved but still refreshes passes", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    window.history.replaceState({}, "", "/subscribe?pay_return=1&pay_plan=not-a-real-plan");

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await waitFor(() => {
      expect(openClawState.refreshPasses).toHaveBeenCalled();
    });
    /* 找不到套餐时不进 paying，避免卡在一个永远等不到结果的弹窗里 */
    expect(screen.queryByText("正在开通套餐")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("does not resume without the payment return marker", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    /* 关键：带上 pay_plan 但**不带** pay_return。
       若只断言「不进 paying」，删掉 pay_return 校验后本用例仍会通过
       （因为无标记时 pay_plan 也为空，同样走不进 paying），断言就失去了鉴别力。
       这里让 plan 可解析，从而把「标记校验」变成唯一的区分条件。 */
    window.history.replaceState({}, "", "/subscribe?pay_plan=bundle_cruise_ai_01");

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await screen.findByText("巡游 Cruise");

    expect(screen.queryByText("正在开通套餐")).not.toBeInTheDocument();
    expect(openClawState.addBot).not.toHaveBeenCalled();
    /* 没有回跳标记时不应清理 query，说明 effect 完全没接管。 */
    expect(window.location.search).toBe("?pay_plan=bundle_cruise_ai_01");
  });
});

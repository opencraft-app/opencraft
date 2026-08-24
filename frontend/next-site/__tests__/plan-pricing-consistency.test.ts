import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 套餐价格一致性契约测试
 * ──────────────────────────────────────────────────────────────
 * 背景：同一个「价格」事实散落在 4 个位置，历史上已发生漂移
 *（公告页写「敬请期待」而文档已写 ¥68；JSON-LD 曾声明 price:'0'）。
 * 详见 `wiki/product-state/geo-fact-table.md` 第 1.2 / 2.3 / 4.1 节。
 *
 * 本测试把 `subscribe-page.tsx` 的静态价表作为**代码内解析基准**
 *（它与后端询价口径对齐，是最接近唯一来源「订阅后台」的一处），
 * 再反向校验其余三处必须与之一致：
 *   1. next-site/subscribe-page.tsx  ← 基准
 *   2. next-site/seo.tsx             （JSON-LD AggregateOffer）
 *   3. src/content/docs/plans.md     （对外权威价格页）
 *   4. src/content/docs/01-overview.md
 *   5. src/content/docs/announcements/public-beta.md
 *
 * 后端调价时：先改 subscribe-page.tsx，本测试会逐一指出还有哪些位置没同步。
 *
 * 注意：`/subscribe` 页面是 noindex + 纯客户端渲染，对搜索引擎和 AI 爬虫不可见
 *（事实表 4.2），因此 `docs/plans.md` 承担对外权威价格页职责，必须准确。
 */

const FRONTEND_ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(FRONTEND_ROOT, relativePath), "utf8");
}

const subscribeSource = read("next-site/subscribe-page.tsx");
const seoSource = read("next-site/seo.tsx");
const plansDoc = read("src/content/docs/plans.md");
const overviewDoc = read("src/content/docs/01-overview.md");
const announcementDoc = read("src/content/docs/announcements/public-beta.md");

/* ── 基准解析：从 subscribe-page.tsx 提取静态价表与折扣常量 ── */

/** 截取 `const <name> ... = { ... };` 的对象字面量块，避免跨常量误匹配。 */
function objectBlockOf(source: string, constName: string): string {
  const start = source.indexOf(`const ${constName}`);
  if (start === -1) {
    throw new Error(`未找到常量 ${constName}，价格基准解析失败`);
  }
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n};", open);
  if (open === -1 || end === -1) {
    throw new Error(`常量 ${constName} 的对象字面量结构无法解析`);
  }
  return source.slice(open, end);
}

interface TierPrice {
  monthly: number;
  quarterly: number;
}

function parseTierPrice(block: string, tier: "launch" | "cruise"): TierPrice {
  const pattern = new RegExp(
    `${tier}:\\s*\\{\\s*monthly:\\s*([\\d.]+),\\s*quarterly:\\s*([\\d.]+)\\s*\\}`,
  );
  const matched = block.match(pattern);
  if (!matched) {
    throw new Error(`无法从静态价表解析 ${tier} 的月付 / 季付价格`);
  }
  return { monthly: Number(matched[1]), quarterly: Number(matched[2]) };
}

function parseNumericConst(source: string, constName: string): number {
  const matched = source.match(new RegExp(`const ${constName}\\s*=\\s*([\\d.]+)`));
  if (!matched) {
    throw new Error(`无法解析常量 ${constName}`);
  }
  return Number(matched[1]);
}

const standardBlock = objectBlockOf(subscribeSource, "STATIC_TIER_PRICE_YUAN");
const aiBlock = objectBlockOf(subscribeSource, "STATIC_AI_TIER_PRICE_YUAN");

/** 四档套餐基准价（元）。key 与文档表格首列一一对应。 */
const BASELINE = {
  launch: parseTierPrice(standardBlock, "launch"),
  cruise: parseTierPrice(standardBlock, "cruise"),
  launchAi: parseTierPrice(aiBlock, "launch"),
  cruiseAi: parseTierPrice(aiBlock, "cruise"),
} as const;

const QUARTERLY_DISCOUNT = parseNumericConst(subscribeSource, "STATIC_QUARTERLY_DISCOUNT");
const AI_MONTHLY_DISCOUNT = parseNumericConst(subscribeSource, "STATIC_AI_MONTHLY_DISCOUNT");
const AI_QUARTERLY_DISCOUNT = parseNumericConst(subscribeSource, "STATIC_AI_QUARTERLY_DISCOUNT");

/** 巡游标准版月付「首月 5 折」是内联系数（subscribe-page.tsx 的 realPriceYuan * 0.5）。 */
const CRUISE_FIRST_MONTH_DISCOUNT = 0.5;

/** 保留 2 位小数，与 `buildStaticPrice` / 展示层的 toFixed(2) 口径一致。 */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

/* ── Markdown 表格解析 ── */

type TableRow = string[];

/**
 * 截取指定标题下的小节内容（到下一个任意级别标题为止）。
 *
 * 必须按小节定位：同一篇文档里多张表可能有相同首列标签
 *（如 plans.md 的「套餐权益」「套餐定价」「优惠与首购价」三表都有「启航 Launch」行），
 * 只按标签全等匹配会命中错误的表。
 */
function sectionOf(markdown: string, heading: string): string {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(`未找到小节标题「${heading}」，文档结构可能已变更`);
  }
  const rest = markdown.slice(headingIndex + heading.length);
  const nextHeading = rest.search(/\n#{1,6}\s/);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function parseTableRows(markdown: string): TableRow[] {
  return markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/**
 * 按首列精确匹配表格行。
 * 用全等而非 includes，避免「启航 Launch」误命中「启航 Launch AI」这类前缀包含。
 */
function rowByLabel(rows: TableRow[], label: string): TableRow {
  const row = rows.find((cells) => cells[0] === label);
  if (!row) {
    throw new Error(`未找到表格行「${label}」，文档结构可能已变更`);
  }
  return row;
}

/** 从单元格提取人民币金额；「¥0」返回 0，无金额返回 null。 */
function yuanIn(cell: string): number | null {
  const matched = cell.match(/¥\s*([\d.]+)/);
  return matched ? Number(matched[1]) : null;
}

/** 剥离 TS 行注释与块注释，避免注释里的示例文本干扰源码断言。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("套餐价格一致性（防止价格事实在多处漂移）", () => {
  it("基准价表可解析，且为预期的四档结构", () => {
    // 结构性断言：若静态价表被重构成别的形状，这里先失败，提示更新本测试
    expect(Object.keys(BASELINE)).toEqual(["launch", "cruise", "launchAi", "cruiseAi"]);
    for (const [tier, price] of Object.entries(BASELINE)) {
      expect(price.monthly, `${tier} 月付价应为正数`).toBeGreaterThan(0);
      expect(price.quarterly, `${tier} 季付价应为正数`).toBeGreaterThan(0);
    }
    expect(QUARTERLY_DISCOUNT).toBeGreaterThan(0);
    expect(QUARTERLY_DISCOUNT).toBeLessThanOrEqual(1);
    expect(AI_MONTHLY_DISCOUNT).toBeGreaterThan(0);
    expect(AI_MONTHLY_DISCOUNT).toBeLessThanOrEqual(1);
    expect(AI_QUARTERLY_DISCOUNT).toBeGreaterThan(0);
    expect(AI_QUARTERLY_DISCOUNT).toBeLessThanOrEqual(1);
  });

  it("季付原价 = 月付 × 3", () => {
    for (const [tier, price] of Object.entries(BASELINE)) {
      expect(price.quarterly, `${tier} 季付原价应为月付的 3 倍`).toBe(price.monthly * 3);
    }
  });

  it("巡游标准版「首月 5 折」系数仍内联在订阅页逻辑中", () => {
    // 该折扣未抽成常量，只能断言表达式存在；若被改动，需同步本测试与文档首购价
    expect(subscribeSource).toContain(`realPriceYuan * ${CRUISE_FIRST_MONTH_DISCOUNT}`);
  });

  describe("docs/plans.md 套餐定价表", () => {
    const rows = parseTableRows(sectionOf(plansDoc, "### 套餐定价"));
    const cases = [
      ["启航 Launch", BASELINE.launch],
      ["巡游 Cruise", BASELINE.cruise],
      ["启航 Launch AI", BASELINE.launchAi],
      ["巡游 Cruise AI", BASELINE.cruiseAi],
    ] as const;

    for (const [label, price] of cases) {
      it(`${label} 的月付 / 季付原价与基准一致`, () => {
        const row = rowByLabel(rows, label);
        expect(yuanIn(row[1] ?? ""), `${label} 月付原价`).toBe(price.monthly);
        expect(yuanIn(row[2] ?? ""), `${label} 季付原价`).toBe(price.quarterly);
      });
    }
  });

  describe("docs/plans.md 优惠与首购价表", () => {
    // 列序：套餐 | 月付首购价 | 月付优惠说明 | 季付折后价 | 季付折扣
    const rows = parseTableRows(sectionOf(plansDoc, "### 优惠与首购价"));

    it("启航 Launch 首购价为 ¥0（首单免费 14 天）", () => {
      const row = rowByLabel(rows, "启航 Launch");
      expect(yuanIn(row[1] ?? "")).toBe(0);
      expect(row[2] ?? "").toContain("首单免费");
    });

    it("巡游 Cruise 首购价 = 月付原价 × 首月 5 折", () => {
      const row = rowByLabel(rows, "巡游 Cruise");
      expect(yuanIn(row[1] ?? "")).toBe(
        round2(BASELINE.cruise.monthly * CRUISE_FIRST_MONTH_DISCOUNT),
      );
    });

    it("AI 版首购价 = 月付原价 × 首月 6 折", () => {
      const aiCases = [
        ["启航 Launch AI", BASELINE.launchAi],
        ["巡游 Cruise AI", BASELINE.cruiseAi],
      ] as const;

      for (const [label, price] of aiCases) {
        const row = rowByLabel(rows, label);
        expect(yuanIn(row[1] ?? ""), `${label} 首购价`).toBe(
          round2(price.monthly * AI_MONTHLY_DISCOUNT),
        );
      }
    });

    it("季付折后价 = 季付原价 × 对应折扣（标准版 8.5 折 / AI 版 9 折）", () => {
      const quarterlyCases = [
        ["启航 Launch", BASELINE.launch, QUARTERLY_DISCOUNT],
        ["巡游 Cruise", BASELINE.cruise, QUARTERLY_DISCOUNT],
        ["启航 Launch AI", BASELINE.launchAi, AI_QUARTERLY_DISCOUNT],
        ["巡游 Cruise AI", BASELINE.cruiseAi, AI_QUARTERLY_DISCOUNT],
      ] as const;

      for (const [label, price, discount] of quarterlyCases) {
        const row = rowByLabel(rows, label);
        expect(yuanIn(row[3] ?? ""), `${label} 季付折后价`).toBe(
          round2(price.quarterly * discount),
        );
      }
    });
  });

  describe("docs/01-overview.md 套餐表", () => {
    const rows = parseTableRows(sectionOf(overviewDoc, "## 关于套餐"));
    const cases = [
      ["启航 Launch", BASELINE.launch],
      ["巡游 Cruise", BASELINE.cruise],
      ["启航 Launch AI", BASELINE.launchAi],
      ["巡游 Cruise AI", BASELINE.cruiseAi],
    ] as const;

    for (const [label, price] of cases) {
      it(`${label} 的月付 / 季付原价与基准一致`, () => {
        const row = rowByLabel(rows, label);
        expect(yuanIn(row[1] ?? ""), `${label} 月付原价`).toBe(price.monthly);
        expect(yuanIn(row[2] ?? ""), `${label} 季付原价`).toBe(price.quarterly);
      });
    }
  });

  describe("docs/announcements/public-beta.md 付费方案表", () => {
    const rows = parseTableRows(announcementDoc);
    const cases = [
      ["启航版 Launch", BASELINE.launch],
      ["巡游版 Cruise", BASELINE.cruise],
      ["启航版 Launch AI", BASELINE.launchAi],
      ["巡游版 Cruise AI", BASELINE.cruiseAi],
    ] as const;

    for (const [label, price] of cases) {
      it(`${label} 的月付 / 季付原价与基准一致`, () => {
        const row = rowByLabel(rows, label);
        expect(yuanIn(row[1] ?? ""), `${label} 月付原价`).toBe(price.monthly);
        expect(yuanIn(row[2] ?? ""), `${label} 季付原价`).toBe(price.quarterly);
      });
    }

    it("不再出现「敬请期待」占位价（AI 版已可售）", () => {
      // 回归防护：AI 版曾在公告页写「敬请期待」而文档已给出确切价（事实表 C3）
      const aiRows = rows.filter((cells) => cells[0]?.includes("AI"));
      expect(aiRows.length).toBeGreaterThan(0);
      for (const row of aiRows) {
        expect(row.slice(1, 3).join(" "), `${row[0]} 不应含占位文案`).not.toContain("敬请期待");
      }
    });
  });

  describe("JSON-LD AggregateOffer（next-site/seo.tsx）", () => {
    const cnBlock = (() => {
      const block = objectBlockOf(seoSource, "PLAN_OFFERS_BY_SEO_REGION");
      const cnStart = block.indexOf("cn:");
      const globalStart = block.indexOf("global:");
      return block.slice(cnStart, globalStart === -1 ? undefined : globalStart);
    })();

    function fieldIn(block: string, field: string): string {
      const matched = block.match(new RegExp(`${field}:\\s*'?([\\w.:/]+)'?`));
      if (!matched) {
        throw new Error(`无法从 JSON-LD 解析字段 ${field}`);
      }
      return matched[1] ?? "";
    }

    it("使用 AggregateOffer 而非声明单一 price（回归防护：曾错误声明 price:'0'）", () => {
      expect(cnBlock).toContain("AggregateOffer");
      // 剥离注释后再匹配：注释中记录了历史错误写法，不应被判为违规
      expect(stripComments(seoSource)).not.toMatch(/\bprice:\s*'0'/);
    });

    it("highPrice = 四档套餐中最高月付原价", () => {
      const maxMonthly = Math.max(...Object.values(BASELINE).map((p) => p.monthly));
      expect(Number(fieldIn(cnBlock, "highPrice"))).toBe(maxMonthly);
    });

    it("lowPrice = 0，对应启航版首单免费体验", () => {
      expect(Number(fieldIn(cnBlock, "lowPrice"))).toBe(0);
    });

    it("offerCount = 套餐档位数", () => {
      expect(Number(fieldIn(cnBlock, "offerCount"))).toBe(Object.keys(BASELINE).length);
    });

    it("币种为 CNY", () => {
      expect(fieldIn(cnBlock, "priceCurrency")).toBe("CNY");
    });
  });
});

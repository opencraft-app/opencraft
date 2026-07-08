import { AGENT_SECTION_ID_BY_SLUG, AGENTS_HOME_PATH, type AgentSectionId } from "@/lib/agent-routes";
import { DATONG_PAGE_IDS, type DatongPageId } from "@/observability/datong";

/**
 * 大同页面 pgid 路由匹配。
 *
 * 供 `DatongPageEffect` 在客户端根据 `location.pathname` + `location.search` 计算当前页面 pgid，
 * 从而自动上报 dt_pgin / dt_pgout。业务代码不需要为每个页面手动调用埋点 API。
 *
 * 与 [agent-platform-frontend-plan-2026070209.md](../../../../dt_tracking_plan/agent-platform-frontend-plan-2026070209.md)
 * 的第三章"页面 dt_pgid 命名映射"严格对齐。
 */

/** section slug → pgid 映射（用于 /agents/<slug> 路径解析）。 */
const AGENT_SECTION_PGID: Record<AgentSectionId, DatongPageId> = {
  channel: DATONG_PAGE_IDS.AGENT_CHANNELS,
  model: DATONG_PAGE_IDS.AGENT_MODELS,
  skill: DATONG_PAGE_IDS.AGENT_SKILLS,
  buddy: DATONG_PAGE_IDS.AGENT_PERSONA,
  automations: DATONG_PAGE_IDS.AGENT_AUTOMATIONS,
  diagnostics: DATONG_PAGE_IDS.AGENT_DIAGNOSTICS,
  memory: DATONG_PAGE_IDS.AGENT_MEMORY,
  files: DATONG_PAGE_IDS.AGENT_FILES,
  chat: DATONG_PAGE_IDS.AGENT_CHAT,
  workbench: DATONG_PAGE_IDS.AGENT_WORKBENCH,
  // 以下三项方案文档中作为兜底 pgid 归到 workbench，避免上报到未定义的 pgid。
  browser: DATONG_PAGE_IDS.AGENT_WORKBENCH,
  terminal: DATONG_PAGE_IDS.AGENT_WORKBENCH,
  achievement: DATONG_PAGE_IDS.AGENT_WORKBENCH,
};

/** 顶级路径前缀 → pgid，命中后立即返回。 */
const STATIC_PATH_MAP: ReadonlyArray<[RegExp, DatongPageId]> = [
  // 本地化路由（/[lang]/...）
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/?$/i, DATONG_PAGE_IDS.HOME],
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/about\b/i, DATONG_PAGE_IDS.ABOUT],
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/changelog\b/i, DATONG_PAGE_IDS.CHANGELOG],
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/docs(?:\/|$)/i, DATONG_PAGE_IDS.DOCS],
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/cookie-policy\b/i, DATONG_PAGE_IDS.COOKIE_POLICY],
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/privacy-policy\b/i, DATONG_PAGE_IDS.PRIVACY_POLICY],
  [/^\/(zh|en|zh-CN|en-US|zh-cn|en-us)\/open-source-licenses\b/i, DATONG_PAGE_IDS.OPEN_SOURCE_LICENSES],
  // 非本地化路由
  [/^\/about\b/, DATONG_PAGE_IDS.ABOUT],
  [/^\/changelog\b/, DATONG_PAGE_IDS.CHANGELOG],
  [/^\/docs(?:\/|$)/, DATONG_PAGE_IDS.DOCS],
  [/^\/cookie-policy\b/, DATONG_PAGE_IDS.COOKIE_POLICY],
  [/^\/privacy-policy\b/, DATONG_PAGE_IDS.PRIVACY_POLICY],
  [/^\/open-source-licenses\b/, DATONG_PAGE_IDS.OPEN_SOURCE_LICENSES],
  [/^\/plans\/select\b/, DATONG_PAGE_IDS.PLAN_SELECT],
  [/^\/plans\b/, DATONG_PAGE_IDS.PLANS],
  [/^\/subscribe\b/, DATONG_PAGE_IDS.SUBSCRIBE],
  [/^\/account\/orders\b/, DATONG_PAGE_IDS.ACCOUNT_ORDERS],
  [/^\/account\b/, DATONG_PAGE_IDS.ACCOUNT],
];

/**
 * 根据当前 URL 计算大同 pgid。
 *
 * 优先级：
 *   1. `/agents?creating=...` → `agent_creating`
 *   2. `/agents/<slug>` → 通过 AGENT_SECTION_ID_BY_SLUG 解析
 *   3. `/agents` 兜底 → `agents_home`
 *   4. 静态映射表命中 → 对应 pgid
 *   5. 首页兜底：pathname 为 `/` 时归到 `home`
 *   6. 其余返回 `null`（该路由未纳入埋点，SDK 不上报）
 */
export function resolveDatongPageId(pathname: string, search = ""): DatongPageId | null {
  if (!pathname) return null;
  const normalized = pathname.replace(/\/+$/, "") || "/";

  // Agents 相关
  if (normalized === AGENTS_HOME_PATH) {
    if (typeof search === "string" && /(\?|&)creating=/.test(search)) {
      return DATONG_PAGE_IDS.AGENT_CREATING;
    }
    return DATONG_PAGE_IDS.AGENTS_HOME;
  }
  if (normalized.startsWith(`${AGENTS_HOME_PATH}/`)) {
    const slug = normalized.slice(AGENTS_HOME_PATH.length + 1).split("/", 1)[0];
    const sectionId = AGENT_SECTION_ID_BY_SLUG[slug];
    if (sectionId) return AGENT_SECTION_PGID[sectionId];
    return DATONG_PAGE_IDS.AGENTS_HOME;
  }

  for (const [pattern, pgid] of STATIC_PATH_MAP) {
    if (pattern.test(normalized)) return pgid;
  }

  if (normalized === "/") return DATONG_PAGE_IDS.HOME;

  return null;
}

/** 从 URL 上抽取该 pgid 关注的 dt-params，用于 pgin 时携带上下文。 */
export function resolvePagePrivateParams(pgid: DatongPageId, pathname: string, search = ""): Record<string, string | undefined> {
  switch (pgid) {
    case DATONG_PAGE_IDS.DOCS: {
      const slug = pathname.replace(/^\/docs\/?/, "").replace(/\/+$/, "");
      return slug ? { doc_slug: slug } : {};
    }
    case DATONG_PAGE_IDS.SUBSCRIBE: {
      const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
      const plan = params.get("plan") ?? undefined;
      const billing = params.get("billing_period") ?? params.get("period") ?? undefined;
      return { plan, billing_period: billing };
    }
    case DATONG_PAGE_IDS.AGENT_CREATING: {
      const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
      const entry = params.get("entry") ?? params.get("from") ?? undefined;
      return { entry };
    }
    default:
      return {};
  }
}

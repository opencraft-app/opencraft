/**
 * 微信委托划扣 — 支付链路编排（v1.7.31 + CodeBuddy AuthCode 安全模型）
 *
 * v1.7.31 起后端把下单拆成两阶段；为了对齐 CodeBuddy 的二维码安全模型，
 * 前端把"拉支付 URL"这一步**整体下沉到中转页**：
 *
 *   阶段一（PC 端）：POST /v1/passes/order
 *     → 返 { deal_names, auth_code }
 *       - deal_names：jifei 订单号
 *       - auth_code ：CodeBuddy 同款一次性鉴权 ticket（TTL ≤10 分钟）
 *
 *   阶段二（中转页）：POST /v1/passes/order-url
 *     入参：{ deal_names, platform: "mobile", wx_code, auth_code }
 *     返：  { pay_url, token_id, midas_app_id, need_charge, ... }
 *
 *   阶段三（中转页）：@tencent/tcb-jssdk wxSign 拉起委托划扣
 *
 * **为什么把阶段二下沉到中转页（与 CodeBuddy 完全一致）**：
 *   - jifei pay_url 生成时绑定 wx_open_id；PC 端没有 wx_open_id，提前调只能拿到错误的 url
 *   - 用户扫码 → 微信 OAuth 拿 wx_code → 中转页用 wx_code + auth_code 调阶段二
 *     → 后端用 wx_code 换 wx_open_id、用 auth_code 反查 user_id 后调 jifei
 *
 * **安全模型（对齐 CodeBuddy 二维码 URL）**：
 *   - 二维码里**只有 deal_name + auth_code + expires_at**：无 Bearer token、无 pay_url
 *   - auth_code 是一次性 ticket、绑定 user_id + deal_name，截图泄漏的最坏后果是
 *     "10 分钟内攻击者替受害者发起一次支付"，无法转走、无法续费、无法越权
 *   - PC 端无需写 authToken 进 query，主站 Bearer 鉴权链路保持完全独立
 *
 * 关于零元订单：need_charge 字段只能在阶段二拿到，PC 端无法提前判定。
 * 中转页拿到响应后从 need_charge === 0 路径直接显示「已完成」即可。
 *
 * 联调文档：codesign/ctl-frontend-billing-api.md §2.1 / §2.2 / §3.2 / §3.3
 */

/* ─── 公开类型 ─── */

/** 支付计划：当前实现下永远 needCharge=true（need_charge 由中转页判定）。 */
export interface PayPlan {
  /**
   * 是否需要发起支付。
   *
   * 注意：当前 CodeBuddy 模式下 PC 端拿不到 need_charge，本字段恒为 true；
   * 零元订单由中转页在拿到 getPassOrderUrl 响应后直接显示「已完成」。
   * 该字段保留是为兼容老调用方，不再作为 PC 端跳过二维码的判断依据。
   */
  needCharge: boolean;
  /** 中转页绝对 URL；用作二维码 value */
  bridgeUrl: string;
  /** 二维码过期时间（unix ms，仅前端校验提示用，与 auth_code TTL 对齐） */
  expiresAt: number;
}

export interface BuildPayPlanInput {
  /** 阶段一下单返回的 jifei 订单号（取 deal_names[0]） */
  dealName: string;
  /**
   * 阶段一下单返回的一次性鉴权 ticket（CodeBuddy 同款 AuthCode）。
   *
   * 后端要求：当中转页阶段二请求 body 携带 auth_code 时，可绕过 Bearer 鉴权，
   * 用 auth_code 反查 user_id；TTL ≤10 分钟，建议与 expiresAt 对齐。
   *
   * 后端尚未实现该字段时为空字符串/undefined：buildPayPlan 仍会生成 bridgeUrl，
   * 中转页拿到 query 中的 authCode 为空时会回退到老链路（透传 wx_code 让后端
   * 自行处理鉴权），便于灰度切换。
   */
  authCode?: string;
  /** 二维码有效期，毫秒；默认 9 分钟（前端 buffer：比后端 auth_code TTL 短 1 分钟） */
  ttlMs?: number;
  /**
   * 中转页绝对 URL 基址。
   * 默认从 `process.env.NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL` 读取；未配置时回退到
   * `${window.location.origin}/auth/wechat-pay`。
   *
   * 注意：必须是绝对地址（含 https://），因为它会被微信 oauth2/authorize 当作
   * redirect_uri 使用，相对路径会让授权回跳失败。
   */
  bridgeBaseUrl?: string;
  /** 调试用：是否在 bridge URL 上附加 sandbox=1 标记，供中转页切换沙箱环境 */
  sandbox?: boolean;
  /**
   * 套餐/产品名（用于中转页主标题展示，如「专业版签约」）。
   * 可选；缺省时中转页会用通用文案兜底。仅展示用途，不参与鉴权。
   */
  bundleName?: string;
  /**
   * 续费场景必填：用于中转页拼出 `/v1/passes/{passId}/renew/order-url` 路径。
   * 新购场景留空。
   */
  passId?: string;
}

/* ─── 编码协议（中转页 query 字段）─── */

/**
 * 中转页 query 字段名 — 短键名仅为缩短二维码 URL 长度（二维码越短越好扫）。
 * 中转页 wechat-pay-page 按相同字段名解码。任何字段变更都需要中转页同步。
 *
 * **CodeBuddy AuthCode 模型**：
 *   - 不再携带 pay_url / token_id / midas_app_id（这些字段在中转页阶段二再拉取）
 *   - 只携带 deal_name + auth_code + expires_at（最小必要支付上下文）
 *   - 携带 passId 用于区分新购/续费路由（pid 为空 → 新购；非空 → 续费）
 */
export const BRIDGE_QUERY_KEYS = {
  dealName: "d",    // jifei 订单号（中转页阶段二回传给后端拉 pay_url）
  authCode: "ac",   // CodeBuddy 同款一次性鉴权 ticket（无主站 token 时用）
  expiresAt: "e",   // unix ms（前端 UX 提示用，与 auth_code TTL 对齐）
  passId: "pid",    // 续费场景的 pass_id；新购场景为空
  sandbox: "sb",    // "1" 表示沙箱
  bundleName: "n",  // 套餐/产品名，用于中转页主标题展示（仅 UI，无鉴权语义）
} as const;

/**
 * 默认二维码 TTL：9 分钟。
 *
 * 后端 auth_code 在 Redis 的实际 TTL 是 10 分钟（authcode.DefaultTTL = 600s），
 * 这里前端故意比后端少 1 分钟，作为时延 buffer：覆盖时钟漂移、OAuth 网络延迟、
 * 用户授权迟疑等场景，避免出现「前端 expiresAt 校验通过、后端 ticket 已过期」
 * 而抛出 401 AUTH_CODE_INVALID 的临界条件。
 */
export const DEFAULT_BRIDGE_TTL_MS = 9 * 60 * 1000;

/* ─── 主入口 ─── */

/**
 * 根据阶段一 createPassOrder/createRenewOrder 的响应生成支付计划（二维码 URL）。
 *
 * 不会触发任何 SDK / 网络 / DOM 副作用，纯函数。
 *
 * @throws dealName 缺失时抛错（这是必填字段）
 */
export function buildPayPlan(input: BuildPayPlanInput): PayPlan {
  const ttlMs = input.ttlMs ?? DEFAULT_BRIDGE_TTL_MS;
  const expiresAt = Date.now() + ttlMs;

  if (!input.dealName) {
    throw new Error("buildPayPlan: dealName 不能为空");
  }

  const bridgeUrl = buildBridgeUrl({ ...input, expiresAt });
  /* CodeBuddy 模式下 need_charge 在中转页判定，PC 端恒认为需要支付（渲染二维码） */
  return { needCharge: true, bridgeUrl, expiresAt };
}

/* ─── 内部工具 ─── */

function buildBridgeUrl(input: BuildPayPlanInput & { expiresAt: number }): string {
  const baseUrl = resolveBridgeBaseUrl(input.bridgeBaseUrl);
  const sandbox = input.sandbox ?? readSandboxFromEnv();
  const params = new URLSearchParams();
  params.set(BRIDGE_QUERY_KEYS.dealName, input.dealName);
  params.set(BRIDGE_QUERY_KEYS.expiresAt, String(input.expiresAt));
  if (input.authCode) params.set(BRIDGE_QUERY_KEYS.authCode, input.authCode);
  if (input.passId) params.set(BRIDGE_QUERY_KEYS.passId, input.passId);
  if (sandbox) params.set(BRIDGE_QUERY_KEYS.sandbox, "1");
  if (input.bundleName) params.set(BRIDGE_QUERY_KEYS.bundleName, input.bundleName);
  return `${baseUrl}?${params.toString()}`;
}

function resolveBridgeBaseUrl(override?: string): string {
  if (override) return override;
  const fromEnv = trimPublicEnv(
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL : undefined,
  );
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    return `${window.location.origin}/auth/wechat-pay`;
  }
  /* SSR / Node 测试场景兜底；调用方可通过 options 覆盖 */
  return "https://localhost/auth/wechat-pay";
}

function readSandboxFromEnv(): boolean {
  return trimPublicEnv(
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MIDAS_SANDBOX : undefined,
  ) === "true";
}

function trimPublicEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Base64-URL 编码：保留导出供未来扩展使用（当前二维码已不再编 pay_url，
 * 但 wxSign 在中转页拉起时仍可能需要编码长字符串，例如 callback 链接）。
 */
export function encodeBase64Url(input: string): string {
  if (!input) return "";
  /* btoa 不支持 unicode；先转 utf-8 再编码 */
  const utf8 = unescape(encodeURIComponent(input));
  // eslint-disable-next-line no-restricted-globals
  const b64 = typeof btoa === "function" ? btoa(utf8) : Buffer.from(utf8, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(input: string): string {
  if (!input) return "";
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  // eslint-disable-next-line no-restricted-globals
  const utf8 = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
  try {
    return decodeURIComponent(escape(utf8));
  } catch {
    return utf8;
  }
}

/**
 * 微信支付中转页 — `/auth/wechat-pay`（v1.7.31 + CodeBuddy AuthCode 安全模型）
 *
 * PC 端订阅页/续费页生成二维码（value 是本页绝对 URL + dealName / authCode / passId /
 * expiresAt / bundleName / sandbox），用户在微信内扫码后跳到本页。本页职责：
 *
 *   1. 解析 query：dealName / authCode / passId / expiresAt / bundleName / sandbox
 *   2. 校验 expiresAt：已过期则提示用户回到 PC 端重新生成
 *   3. 校验 UA：必须在微信 H5 内（MicroMessenger），否则提示用户切换到微信再扫
 *   4. 通过后端中转 OAuth（GET /auth/oauth/wechat/start）拿 wx_openid：未带 openid
 *      则跳到后端 OAuth 起点；后端用 appsecret 换 openid 后回跳 ?openid=...
 *   5. 用 { wx_open_id, auth_code, deal_names } 调 lightclaw 后端 order-url 接口
 *      （pass_id 非空走 renew/order-url；空走 passes/order-url）拿
 *      { pay_url, token_id, midas_app_id, need_charge }
 *   6. need_charge === 0 → 显示「已完成支付」，PC 端通过轮询 listMyPasses 接棒
 *      need_charge === 1 → 调 @tencent/tcb-jssdk wxSign 拉起委托划扣
 *
 * **安全模型（对齐 CodeBuddy）**：
 *   - 二维码里**没有 Bearer token、没有 pay_url**：截图泄漏后攻击者顶多替受害者
 *     发起一次 10 分钟内的支付，无法转账、无法续费、无法越权
 *   - 中转页用 auth_code 作为鉴权 ticket 调 lightclaw 后端，不依赖主站 cookie/token
 *   - openid 由后端用 appsecret 换取（前端不持有 secret），更安全
 *
 * **UI 模型（对齐 CodeBuddy）**：
 *   - 深色整屏背景 + 居中文案，无白色卡片
 *   - 状态机 5 态：loading / needs-wechat / expired / success / error
 *   - 标题取自 query 的 bundleName（产品名/套餐名），缺省时兜底「微信支付签约」
 *
 * 路由：`/auth/wechat-pay` 注册到 RootLayout 下，**不需要登录态**（微信内可能无法
 * 携带主站 cookie/token，所有支付参数均从二维码 query 透传）。
 *
 * 兼容降级：当二维码 query 缺失（dealName / expiresAt 为空）时，回退到「OpenID 占位」
 * 视图，用于联调期前端独立调试拿 openid 的链路。
 *
 * 环境变量：
 *   VITE_WECHAT_PAY_AUTH_BASE_URL  后端 OAuth 起点的域名（缺省 https://lightclaw.tech）
 *   VITE_WX_PAY_BRIDGE_BASE_URL    PC 端生成二维码用的中转页绝对 URL
 *   VITE_WX_BUY_HOST               米大师 H5 中转页域名
 *   VITE_WX_PAY_PRODUCT_ID         签约模板 productId
 *   VITE_WX_PAY_PROCESS_VERSION    签约版本（可选）
 *   VITE_MIDAS_SANDBOX             "true" 启用沙箱
 *
 * 联调文档：codesign/ctl-frontend-billing-api.md §2.2 / §3.3
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import type { WXSignOption } from "@tencent/tcb-jssdk/lib/saasSdk/wxSign";

import { redirectToOAuthStart } from "@/lib/oauth";
import { BRIDGE_QUERY_KEYS } from "@/lib/wx-pay";
import { createRepositories } from "@/repositories/http-repositories";
import type { CreatePassOrderUrlResult } from "@/domain/types";

/* ─── 公开类型 ─── */

/**
 * 中转页状态机：
 *   - loading：默认态，覆盖 UA 校验、获取 openid、order-url 请求、wxSign 拉起、跳转兜底等
 *   - expired：二维码已过期
 *   - success：零元订单已完成（need_charge === 0）
 *   - error：任何环节失败
 *   - openid-only：query 无 dealName 时的联调占位态，仅展示 openid（兼容跑通版老行为）
 *
 * **关于非微信浏览器**：对齐跑通版（commit 82e35e22），非微信浏览器**不阻塞**——
 * OAuth effect 直接 short-circuit 不触发跳转，业务 effect 因没有 openid 也不会跑，
 * UI 停在 loading 态由文案兜底；不再有专门的 needs-wechat 态。
 */
type BridgeStage = "loading" | "expired" | "success" | "error" | "openid-only";

/** 从二维码 query 解析出的支付上下文（CodeBuddy AuthCode 模型，最小必要字段） */
interface BridgeOrder {
  /** jifei 订单号（来自 PC 端 createPassOrder/createRenewOrder 返回的 deal_names[0]） */
  dealName: string;
  /** CodeBuddy 同款一次性鉴权 ticket（PC 端阶段一返回；后端未实现时为空，由后端兼容处理） */
  authCode: string;
  /** 续费场景的 pass_id；新购场景为空字符串 */
  passId: string;
  /** 二维码过期时间（unix ms） */
  expiresAt: number;
  /** 是否走米大师沙箱 */
  sandbox: boolean;
  /** 套餐/产品名，仅 UI 展示，缺省时由组件兜底 */
  bundleName: string;
}

/** 主标题兜底文案（query 未带 bundleName 时使用） */
const DEFAULT_TITLE = "LightVela 购买";

/** 兼容微信回跳带回的多种 openid 字段命名 */
const OPEN_ID_PARAM_NAMES = ["openid", "open_id", "openId", "wx_openid", "wxOpenId"];
const DEFAULT_WECHAT_PAY_AUTH_BASE_URL = "https://lightclaw.tech";
const OPEN_ID_AUTH_ATTEMPTED_PARAM = "openid_auth_attempted";

/* ─── 主组件 ─── */

export const WeChatPayPage = () => {
  const location = useLocation();
  const [stage, setStage] = useState<BridgeStage>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentStarted, setPaymentStarted] = useState(false);

  /* 解析 query：随 location 变更重算 */
  const order = useMemo(() => parseBridgeOrder(location.search), [location.search]);
  const openId = useMemo(
    () => readOpenId(location.search, location.hash),
    [location.hash, location.search],
  );

  const oauthError = useMemo(
    () => new URLSearchParams(location.search).get("oauth_error"),
    [location.search],
  );
  const openIdAuthAttempted = useMemo(
    () => new URLSearchParams(location.search).get(OPEN_ID_AUTH_ATTEMPTED_PARAM) === "1",
    [location.search],
  );

  const inWeChat = useMemo(() => isMicroMessenger(), []);

  /**
   * Effect ①：拿 openid 的 OAuth 链路（**对齐跑通版 commit 82e35e22 逐字一致**）。
   *
   * 单一职责：在微信内、还没 openid、没出错、没尝试过时，跳后端 OAuth 起点；其它情况都
   * short-circuit。**不被是否有完整订单 query 影响**——无论联调占位场景还是完整支付链路，
   * 都用同一段 OAuth 逻辑，避免重复实现导致行为漂移。
   */
  useEffect(() => {
    if (!inWeChat || openId || oauthError || openIdAuthAttempted) {
      return;
    }
    redirectToOAuthStart(buildWeChatPayOpenIdStartUrl(window.location.href));
  }, [inWeChat, oauthError, openId, openIdAuthAttempted]);

  /**
   * Effect ②：业务编排（订单过期校验 / 占位态 / order-url / wxSign）。
   *
   * 仅依赖 query 解析结果与 openid 状态，不再插手 OAuth 跳转——把业务和 OAuth 解耦后，
   * 不会出现「order 是否就绪」打断 OAuth effect 的副作用。
   */
  useEffect(() => {
    /* 兼容降级：query 没有 dealName 时停在「OpenID 占位」态，仅供联调期展示 openid */
    if (!order) {
      if (oauthError) {
        setStage("error");
        setErrorMessage("微信授权失败，请重试。");
        return;
      }
      /* 已经拿到 openid，或已经尝试过 OAuth 仍无 openid，或非微信浏览器 → 都进占位态由文案兜底 */
      if (openId || openIdAuthAttempted || !inWeChat) {
        setStage("openid-only");
      }
      /* 否则保持 loading 等 OAuth effect 跳转 */
      return;
    }

    /* 完整支付链路 */
    if (Date.now() > order.expiresAt) {
      setStage("expired");
      return;
    }

    if (oauthError) {
      setStage("error");
      setErrorMessage("微信授权失败，请重试。");
      return;
    }

    /* 还没有 openid：保持 loading，等 OAuth effect 跳转或回跳后再触发本 effect */
    if (!openId) {
      return;
    }

    /* openid 已就绪 → 调 order-url 拉 pay_url，再决定零元/wxSign */
    if (paymentStarted) return;
    setPaymentStarted(true);
    const run = async (): Promise<void> => {
      const orderUrl = await fetchOrderUrl(order, openId);
      if (orderUrl.need_charge === 0) {
        setStage("success");
        return;
      }
      await launchWxSign(order, orderUrl, openId);
    };
    void run().catch((err) => {
      console.error("[wechat-pay] payment flow failed", err);
      if (isAuthCodeInvalidError(err)) {
        /* 后端 ticket 不存在 / 已过期 / 已被消费（典型场景：扫码晚于二维码 TTL，或重复扫描同一二维码）
           按设计稿映射为 expired 态，提示用户回 PC 端重新生成二维码 */
        setStage("expired");
        setErrorMessage(null);
        return;
      }
      setStage("error");
      setErrorMessage(err instanceof Error ? err.message : "支付授权失败，请重试。");
    });
  }, [order, openId, oauthError, openIdAuthAttempted, inWeChat, paymentStarted]);

  const onRetry = useRetryHandler();

  const trimmedBundleName = order?.bundleName?.trim();
  const title = trimmedBundleName ? `LightVela ${trimmedBundleName} 购买` : DEFAULT_TITLE;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "#1A1A20",
        color: "#FFFFFF",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
        textAlign: "center",
      }}
    >
      <BridgeStageView
        stage={stage}
        title={title}
        errorMessage={errorMessage}
        openId={openId}
        onRetry={onRetry}
      />
    </div>
  );
};

export default WeChatPayPage;

/* ─── 子视图 ─── */

const BridgeStageView = ({
  stage,
  title,
  errorMessage,
  openId,
  onRetry,
}: {
  stage: BridgeStage;
  title: string;
  errorMessage: string | null;
  openId: string | null;
  onRetry: () => void;
}) => {
  if (stage === "expired") {
    return (
      <>
        <ClockIcon />
        <Title color="#FFB020">二维码已失效</Title>
        <Body>请返回 PC 端重新扫码。</Body>
      </>
    );
  }

  if (stage === "success") {
    return (
      <>
        <CheckIcon />
        <Title color="#34C759">已完成</Title>
        <Body>本次订单无需支付。请回到 PC 端继续后续流程。</Body>
      </>
    );
  }

  if (stage === "error") {
    return (
      <>
        <Title>支付遇到问题</Title>
        <Body>{errorMessage ?? "未知错误，请稍后重试。"}</Body>
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 24,
            padding: "10px 24px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            color: "#FFFFFF",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          重试
        </button>
      </>
    );
  }

  if (stage === "openid-only") {
    /* 联调占位：query 没带 dealName 时停在这里，仅展示当前的 openid，供后端联调使用 */
    return (
      <>
        <Title>微信支付联调</Title>
        <Body>{openId ? "已获取 OpenID，等待 PC 端发起订单。" : "未能获取到 OpenID，请重新打开支付页面重试。"}</Body>
        {openId ? <OpenIdBlock value={openId} /> : null}
      </>
    );
  }

  /* loading：覆盖 UA 校验中、OAuth 跳转中、wxSign 拉起中、跳转兜底 */
  return (
    <>
      <Spinner />
      <Title>{title}</Title>
      <Body>正在准备支付...</Body>
    </>
  );
};

const Title = ({ children, color }: { children: React.ReactNode; color?: string }) => (
  <h2
    style={{
      fontSize: 18,
      fontWeight: 600,
      margin: "16px 0 8px",
      color: color ?? "#FFFFFF",
    }}
  >
    {children}
  </h2>
);

const Body = ({ children }: { children: React.ReactNode }) => (
  <p
    style={{
      fontSize: 14,
      lineHeight: 1.6,
      color: "rgba(255,255,255,0.6)",
      margin: 0,
    }}
  >
    {children}
  </p>
);

const Spinner = () => (
  <div
    style={{
      width: 48,
      height: 48,
      borderRadius: "50%",
      border: "3px solid rgba(255,255,255,0.12)",
      borderTopColor: "rgba(255,255,255,0.85)",
      animation: "wechat-pay-spin 0.9s linear infinite",
      margin: "0 auto",
    }}
  >
    <style>{`@keyframes wechat-pay-spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

/** 黄色时钟图标：用于「二维码已失效」态，对齐 CodeBuddy 视觉 */
const ClockIcon = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#FFB020"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ display: "block", margin: "0 auto" }}
  >
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15 14" />
  </svg>
);

/** 绿色对勾图标：用于「已完成」态（零元订单） */
const CheckIcon = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#34C759"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ display: "block", margin: "0 auto" }}
  >
    <circle cx="12" cy="12" r="9" />
    <polyline points="8 12.5 11 15.5 16 9.5" />
  </svg>
);

const OpenIdBlock = ({ value }: { value: string }) => (
  <div
    style={{
      marginTop: 24,
      padding: "12px 16px",
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.12)",
      background: "rgba(255,255,255,0.04)",
      maxWidth: 320,
      wordBreak: "break-all",
    }}
  >
    <p
      style={{
        margin: 0,
        fontSize: 11,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.45)",
      }}
    >
      当前 OpenID
    </p>
    <p style={{ margin: "6px 0 0", fontSize: 14, fontWeight: 500, color: "#FFFFFF" }}>{value}</p>
  </div>
);

/* ─── 工具函数 ─── */

/**
 * 识别 fetchOrderUrl 抛出的「auth_code 已过期 / 已被消费 / 不存在」错误。
 *
 * 后端 errcode.ErrAuthCodeInvalid 的 HTTP 形态：
 *   status=401, code="AUTH_CODE_INVALID", message="auth_code invalid or expired"
 *
 * RepositoryError 类没有从 http-repositories 导出，这里用 duck-typing 判断
 * （name + status + code）避免侵入 repositories 层；命中后中转页直接进入 `expired`
 * 态，提示用户回 PC 端重新生成二维码（与设计稿"二维码过期"行为对齐）。
 */
function isAuthCodeInvalidError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; status?: unknown; code?: unknown };
  if (e.name !== "RepositoryError") return false;
  if (e.status !== 401) return false;
  return e.code === "AUTH_CODE_INVALID";
}

function isMicroMessenger(): boolean {
  if (typeof navigator === "undefined") return false;
  return /MicroMessenger/i.test(navigator.userAgent);
}

function parseBridgeOrder(search: string): BridgeOrder | null {
  const params = new URLSearchParams(search);
  const dealName = params.get(BRIDGE_QUERY_KEYS.dealName);
  const expiresAtRaw = params.get(BRIDGE_QUERY_KEYS.expiresAt);
  /* dealName + expiresAt 必填（authCode 后端未实现时可缺，passId 仅续费场景填） */
  if (!dealName || !expiresAtRaw) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

  return {
    dealName,
    authCode: params.get(BRIDGE_QUERY_KEYS.authCode) ?? "",
    passId: params.get(BRIDGE_QUERY_KEYS.passId) ?? "",
    expiresAt,
    sandbox: params.get(BRIDGE_QUERY_KEYS.sandbox) === "1",
    bundleName: params.get(BRIDGE_QUERY_KEYS.bundleName) ?? "",
  };
}

const readOpenIdFromParams = (params: URLSearchParams) => {
  for (const name of OPEN_ID_PARAM_NAMES) {
    const value = params.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
};

const readOpenId = (search: string, hash: string) => {
  const fromSearch = readOpenIdFromParams(new URLSearchParams(search));
  if (fromSearch) {
    return fromSearch;
  }
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const hashQuery = rawHash.includes("?") ? rawHash.slice(rawHash.indexOf("?") + 1) : rawHash;
  return readOpenIdFromParams(new URLSearchParams(hashQuery));
};

const resolveWeChatPayAuthBaseUrl = () => {
  const configured = import.meta.env.VITE_WECHAT_PAY_AUTH_BASE_URL?.trim();
  return (configured && configured.length > 0
    ? configured
    : DEFAULT_WECHAT_PAY_AUTH_BASE_URL
  ).replace(/\/$/, "");
};

const buildWeChatPayOpenIdStartUrl = (returnTo: string) => {
  const authBaseURL = resolveWeChatPayAuthBaseUrl();
  const base =
    typeof window !== "undefined" ? window.location.origin : DEFAULT_WECHAT_PAY_AUTH_BASE_URL;
  const returnToURL = new URL(returnTo, base);
  returnToURL.searchParams.set(OPEN_ID_AUTH_ATTEMPTED_PARAM, "1");
  const startURL = new URL(`${authBaseURL.replace(/\/$/, "")}/auth/oauth/wechat/start`, base);
  startURL.searchParams.set("mode", "official_account");
  startURL.searchParams.set("scope", "base");
  startURL.searchParams.set("return_to", returnToURL.toString());
  return startURL.toString();
};

/**
 * 调 lightclaw 后端 order-url 接口拉 pay_url（CodeBuddy 同款下沉到中转页）。
 *
 * - 新购：POST /v1/passes/order-url
 * - 续费：POST /v1/passes/{passId}/renew/order-url
 *
 * 鉴权策略：
 *   - 中转页通常无主站 token；body 携带 auth_code，让后端绕过 Bearer 鉴权用 auth_code 反查 user_id
 *   - body 同时带 wx_open_id（已经由后端中转 OAuth 换好），让后端拼装 jifei 入参
 */
async function fetchOrderUrl(
  order: BridgeOrder,
  openId: string,
): Promise<CreatePassOrderUrlResult> {
  const repositories = createRepositories();
  const baseInput = {
    deal_names: [order.dealName],
    platform: "mobile" as const,
    wx_open_id: openId,
    auth_code: order.authCode || undefined,
  };

  if (order.passId) {
    return repositories.plans.getRenewOrderUrl(order.passId, baseInput);
  }
  return repositories.plans.getPassOrderUrl(baseInput);
}

/** BuyHost 兜底：探测失败时按「env → 硬编码默认值」依次回落 */
const DEFAULT_WX_BUY_HOST = "test.buy.cloud.tencent.com";

/**
 * 解析 wxSign 需要的 BuyHost：
 *   1. 优先调 SDK detectAvailableBuyDomain() 拿运行时探测出的可用域名（依赖 @tencent/i18n/hostPlugin 副作用）
 *   2. 探测返回 undefined（无 i18nHostPlugin / 全部探测失败 / SDK 内部异常）→ 回落 VITE_WX_BUY_HOST
 *   3. env 也未配 → 回落硬编码 buy.cloud.tencent.com（SDK 注释中给出的默认值）
 *
 * SDK 内部对探测结果做了模块级缓存，重复调用不会重复发请求，无需在外层缓存。
 */
async function resolveBuyHost(): Promise<string> {
  const fromEnv = (import.meta.env.VITE_WX_BUY_HOST as string | undefined)?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    /* 副作用导入：注入 window.i18nHostPlugin，detectAvailableBuyDomain 仅在该全局存在时才会真正探测。
       保持动态导入，避免微信支付 SDK 进入站点公共 vendor chunk。 */
    await import("@tencent/i18n/hostPlugin");
    const { detectAvailableBuyDomain } = await import("@tencent/tcb-jssdk");
    const domains = await detectAvailableBuyDomain();
    if (domains?.buy && domains.buy.length > 0) {
      return domains.buy;
    }
  } catch (err) {
    /* SDK 内部承诺不抛异常，这里仅作防御 */
    console.warn("[wechat-pay] detectAvailableBuyDomain threw", err);
  }
  return DEFAULT_WX_BUY_HOST;
}

/**
 * 调用 @tencent/tcb-jssdk wxSign 拉起微信委托划扣。
 *
 * 入参映射依据 SDK 类型定义：BuyHost / Url / OpenId / AppId / ProductId 必填。
 * BuyHost 通过 detectAvailableBuyDomain 运行时探测，env / 硬编码作为兜底。
 *
 * **OpenId 字段**：使用后端 order-url 响应里的 uin（来自 trade_order，腾讯云用户标识），
 * 而非微信 OAuth 换出来的 wx_openid —— 米大师 wxSign 需要的是腾讯云体系内的用户 id。
 * wx_openid 仍然作为 order-url 入参（让后端拼装 jifei 订单时绑定微信身份），但 SDK 入参不用它。
 */
async function launchWxSign(
  order: BridgeOrder,
  orderUrl: CreatePassOrderUrlResult,
  openId: string,
): Promise<void> {
  const buyHost = await resolveBuyHost();
  const productId = (import.meta.env.VITE_WX_PAY_PRODUCT_ID as string | undefined) ?? "";
  // const processVersion =
  //   (import.meta.env.VITE_WX_PAY_PROCESS_VERSION as string | undefined) ?? undefined;
  if (!orderUrl.pay_url || !orderUrl.midas_app_id || !orderUrl.token_id) {
    console.error("[wechat-pay] order-url 响应缺少 pay_url / midas_app_id / token_id", orderUrl);
    throw new Error("支付参数获取失败，请稍后重试");
  }
  /* uin 是米大师 wxSign 必填的 OpenId 字段，由后端 order-url 在 trade_order 内回填。
     如果后端没返回（例如灰度未上、字段被清空），直接报错 —— 否则 SDK 内部行为不可预期。 */
  const uin = orderUrl.uin?.trim();
  if (!uin) {
    console.error("[wechat-pay] order-url 响应缺少 uin", orderUrl, { openId });
    throw new Error("支付参数获取失败，请稍后重试");
  }
  const wxSignParams: WXSignOption = {
    BuyHost: buyHost,
    Url: orderUrl.pay_url,
    OpenId: uin,
    /* WxOpenId：微信 OAuth 换出来的 openid，透传给 SDK 让米大师同时持有微信身份。
       与 OpenId（腾讯云 uin）并存：OpenId 用于腾讯云体系内的用户标识，WxOpenId 用于微信支付绑定。 */
    // WxOpenId: openId,
    AppId: orderUrl.midas_app_id,
    ProductId: productId,
    // ProcessVersion: processVersion,
    /* iOS 微信（WKWebView）会拦截非用户手势栈中的 window.open，
       _blank 会让 SDK 内部走 window.open 路径导致弹窗被静默拦截、UI 卡在 loading；
       改为 _self 走当前页跳转，Android / iOS 行为一致 */
    Target: "_self",
    Close: true,
    // OnlySign: false,
    Sandbox: order.sandbox,
  };

  const { wxSign } = await import("@tencent/tcb-jssdk/lib/saasSdk/wxSign");
  wxSign(wxSignParams);
}

function useRetryHandler(): () => void {
  return useCallback(() => {
    if (typeof window === "undefined") return;
    /* 重试：清掉 openid / oauth_error / openid_auth_attempted 等中间态参数，重跑流程 */
    const url = new URL(window.location.href);
    for (const name of OPEN_ID_PARAM_NAMES) {
      url.searchParams.delete(name);
    }
    url.searchParams.delete("oauth_error");
    url.searchParams.delete(OPEN_ID_AUTH_ATTEMPTED_PARAM);
    url.hash = "";
    window.location.replace(url.toString());
  }, []);
}

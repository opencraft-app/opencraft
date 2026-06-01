import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { CheckCircle2, MessageCircle, ShieldCheck, Smartphone, Wallet } from "lucide-react";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { redirectToOAuthStart } from "@/lib/oauth";
import { useT } from "@/i18n/t";

const isWeChatBrowser = (userAgent: string) => userAgent.toLowerCase().includes("micromessenger");

const OPEN_ID_PARAM_NAMES = ["openid", "open_id", "openId", "wx_openid", "wxOpenId"];
const DEFAULT_WECHAT_PAY_AUTH_BASE_URL = "https://lightclaw.tech";

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

const buildWeChatPayOpenIdStartUrl = (returnTo: string) => {
  const authBaseURL = resolveConfiguredAuthApiBaseUrl() ?? DEFAULT_WECHAT_PAY_AUTH_BASE_URL;
  const base = typeof window !== "undefined" ? window.location.origin : DEFAULT_WECHAT_PAY_AUTH_BASE_URL;
  const startURL = new URL(`${authBaseURL.replace(/\/$/, "")}/auth/oauth/wechat/start`, base);
  startURL.searchParams.set("mode", "official_account");
  startURL.searchParams.set("scope", "base");
  startURL.searchParams.set("return_to", returnTo);
  return startURL.toString();
};

export const WeChatPayPage = () => {
  const location = useLocation();
  const t = useT();
  const inWeChat = useMemo(() => isWeChatBrowser(window.navigator.userAgent), []);
  const openId = useMemo(() => readOpenId(location.search, location.hash), [location.hash, location.search]);
  const oauthError = useMemo(() => new URLSearchParams(location.search).get("oauth_error"), [location.search]);

  useEffect(() => {
    if (!inWeChat || openId || oauthError) {
      return;
    }
    redirectToOAuthStart(buildWeChatPayOpenIdStartUrl(window.location.href));
  }, [inWeChat, oauthError, openId]);

  return (
    <main className="min-h-dvh bg-[#f4f8f5] px-5 py-6 text-[#17231b]">
      <section className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-[28rem] flex-col">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-8 place-items-center rounded-full bg-[#08c05f] text-white">
              <MessageCircle className="size-4" />
            </span>
            <span>{t("微信支付")}</span>
          </div>
          <span className="rounded-full border border-[#c9ded0] bg-white px-3 py-1 text-xs font-medium text-[#526257]">
            {t("LightVela")}
          </span>
        </div>

        <div className="flex flex-1 flex-col justify-center py-10">
          <div className="rounded-[1.75rem] border border-[#d8e8dd] bg-white p-6 shadow-[0_22px_70px_-48px_rgba(23,35,27,0.45)]">
            <div className="space-y-4">
              <div className="grid size-14 place-items-center rounded-2xl bg-[#ecfbf2] text-[#08a94f]">
                {inWeChat ? <Wallet className="size-7" /> : <Smartphone className="size-7" />}
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold leading-tight tracking-normal">
                  {inWeChat ? t("确认微信支付") : t("请在微信内打开")}
                </h1>
                <p className="text-sm leading-7 text-[#5d6b62]">
                  {inWeChat
                    ? t("正在通过微信静默授权获取 OpenID，完成后会回到本页。")
                    : t("当前页面需要微信环境来获取 OpenID，请复制链接后在微信中打开。")}
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3 rounded-2xl bg-[#f7faf7] p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#08a94f]" />
                <p className="text-sm leading-6 text-[#445249]">
                  {t("页面不会在前端处理支付结果，最终状态以后端订单查询为准。")}
                </p>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#08a94f]" />
                <p className="text-sm leading-6 text-[#445249]">{t("等待后端支付参数接入。")}</p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-[#d8e8dd] bg-[#fbfdfb] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-normal text-[#6d7b71]">{t("当前 OpenID")}</p>
              <p className="mt-1 break-all text-sm font-semibold leading-6 text-[#223127]">
                {openId ?? (inWeChat ? t("正在获取 OpenID") : t("尚未获取到 OpenID"))}
              </p>
            </div>

            <button
              type="button"
              disabled
              className="mt-6 h-12 w-full rounded-full bg-[#dfe9e2] text-sm font-semibold text-[#6f7d73]"
            >
              {inWeChat ? t("支付能力接入中") : t("等待微信内打开")}
            </button>
          </div>
        </div>

        <p className="pb-2 text-center text-xs leading-6 text-[#7f8d84]">
          {t("本页面仅作为微信 H5 支付承接页，占位期间不会发起扣款。")}
        </p>
      </section>
    </main>
  );
};

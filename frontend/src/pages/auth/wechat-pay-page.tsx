import { useMemo } from "react";
import { CheckCircle2, MessageCircle, ShieldCheck, Smartphone, Wallet } from "lucide-react";
import { useT } from "@/i18n/t";

const isWeChatBrowser = (userAgent: string) => userAgent.toLowerCase().includes("micromessenger");

export const WeChatPayPage = () => {
  const t = useT();
  const inWeChat = useMemo(() => isWeChatBrowser(window.navigator.userAgent), []);

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
                    ? t("支付承接页已就绪，后续会在这里获取 OpenID 并唤起米大师收银台。")
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

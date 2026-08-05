/**
 * LightVela 落地页 CTA 区底部三链接组件
 *
 * 抽离自 imports/Frame2147230025/sections/CtaSection.tsx，目的：
 *   1. 让"链接 + 二维码"等业务逻辑独立于 Figma 自动生成代码
 *      避免下次 Figma 重新导出 CtaSection 时被整体覆盖。
 *   2. 复用 legal-footer 的策略：
 *      - 隐私政策：国际站走内部 /privacy-policy 路由；国内站走外链
 *      - 服务条款：国内站走腾讯云协议外链
 *      - 加入用户交流群：hover 显示二维码（国内 community-qr / 国际 Discord）
 *
 * 二维码弹层挂在触发文本下，使用 group-hover 让它固定在文字上方居中。
 */
import { CN_PRIVACY_POLICY_URL, CN_TERMS_OF_SERVICE_URL } from "@/constants/legal";
import {
  CN_COMMUNITY_QR_IMAGE,
  DISCORD_INVITE_URL,
  DISCORD_QR_IMAGE,
} from "@/constants/community";
import { isGlobal } from "@/lib/region";
import { useT } from "@/i18n/t";

const linkClassName = "transition-colors hover:text-black";

export function LandingCtaFooterLinks() {
  const t = useT();

  if (isGlobal) {
    return null;
  }

  return (
    <p
      className="mt-6 text-[14px] font-['PingFang_SC:Regular',sans-serif] leading-6 lv-reveal lv-delay-200 flex items-center gap-x-2"
      style={{ height: "44px", paddingTop: "12px", paddingBottom: "12px", color: "#00000080" }}
    >
      {isGlobal ? (
        <a href="/privacy-policy" className={linkClassName}>
          {t("隐私政策")}
        </a>
      ) : (
        <a
          href={CN_PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClassName}
        >
          {t("隐私政策")}
        </a>
      )}
      <span aria-hidden="true">·</span>
      <a
        href={CN_TERMS_OF_SERVICE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
      >
        {t("服务条款")}
      </a>
      {/* 国际站：开源声明（现网 footer 有，国内站无）。 */}
      {isGlobal && (
        <>
          <span aria-hidden="true">·</span>
          <a href="/open-source-licenses" className={linkClassName}>
            {t("开源声明")}
          </a>
        </>
      )}
      {/* 加入用户交流群：hover 显示二维码（国内微信群 / 国际 Discord）。
          现网两站 footer 均有此入口（国际站 hover 引导进入 Discord，
          文案与二维码同时可点击直达邀请链接）。 */}
      <span aria-hidden="true">·</span>
      <span
        className={`group relative cursor-pointer ${linkClassName}`}
      >
        {isGlobal ? (
          <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
            {t("加入交流群")}
          </a>
        ) : (
          t("加入交流群")
        )}
        <span className="pointer-events-none absolute left-1/2 top-0 z-[9999] flex w-[200px] -translate-x-1/2 -translate-y-[calc(100%+12px)] flex-col items-center gap-2 rounded-xl bg-white p-4 opacity-0 shadow-lg transition-all duration-200 ease-out group-hover:pointer-events-auto group-hover:-translate-y-[calc(100%+16px)] group-hover:opacity-100">
          {isGlobal ? (
            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2"
            >
              <img
                src={DISCORD_QR_IMAGE}
                alt={t("加入交流群二维码")}
                className="h-[168px] w-[168px] rounded-lg"
              />
              <span className="whitespace-nowrap text-[11px] tracking-wider text-black/50">
                {t("扫码加入 Discord 交流群")}
              </span>
            </a>
          ) : (
            <>
              <img
                src={CN_COMMUNITY_QR_IMAGE}
                alt={t("加入交流群二维码")}
                className="h-[168px] w-[168px] rounded-lg"
              />
              <span className="whitespace-nowrap text-[11px] tracking-wider text-black/50">
                {t("扫码加入交流群")}
              </span>
            </>
          )}
        </span>
      </span>
    </p>
  );
}

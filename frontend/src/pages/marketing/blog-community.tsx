import { QRCodeSVG } from "qrcode.react";

import { CN_COMMUNITY_QR_IMAGE, DISCORD_INVITE_URL, WHATSAPP_INVITE_URL } from "@/constants/community";
import { isGlobal } from "@/lib/region";
import { blogContentLanguage, type BlogLocale } from "./blog-content";

/** Language follows the article; available communities follow the site region. */
export function BlogCommunity({ locale }: { locale?: BlogLocale }) {
  const language = blogContentLanguage(locale);
  const chinese = language !== "en";
  const traditional = language === "zh-Hant";
  return (
    <section aria-labelledby="blog-community-heading" className="mt-12 border-t border-black/10 pt-6">
      <h2 id="blog-community-heading" className="text-xl font-semibold">
        {chinese ? "加入 LightVela 交流群" : "Join the LightVela community"}
      </h2>
      <p className="mt-3 text-base leading-7 text-black/75">
        {!chinese
          ? "Scan a QR code or follow a link below to explore cloud agents with the community."
          : isGlobal
            ? traditional ? "掃碼或點擊連結加入社群，一起探索雲端 Agent 的更多玩法。" : "扫码或点击链接加入社群，一起探索云端 Agent 的更多玩法。"
            : "扫码加入微信交流群，一起交流使用经验，探索云端 Agent 的更多玩法。"}
      </p>
      <div className="mt-6 flex flex-wrap gap-8">
        {isGlobal ? [
          { name: "Discord", href: DISCORD_INVITE_URL },
          { name: "WhatsApp", href: WHATSAPP_INVITE_URL },
        ].map(({ name, href }) => (
          <a
            key={name}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col items-center gap-3 rounded-md p-1 text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40"
          >
            <QRCodeSVG value={href} size={168} includeMargin role="img" aria-label={chinese ? `${name} ${traditional ? "社群二維碼" : "社群二维码"}` : `${name} community QR code`} />
            <span>{chinese ? `加入 ${name}` : `Join on ${name}`}</span>
          </a>
        )) : (
          <figure className="flex flex-col items-center gap-3">
            <img src={CN_COMMUNITY_QR_IMAGE} alt="微信交流群二维码" width={168} height={168} loading="lazy" className="size-42 object-contain" />
            <figcaption className="text-sm text-black/65">微信交流群</figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}

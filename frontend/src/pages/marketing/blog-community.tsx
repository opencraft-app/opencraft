import { QRCodeSVG } from "qrcode.react";

import { CN_COMMUNITY_QR_IMAGE, DISCORD_INVITE_URL, WHATSAPP_INVITE_URL } from "@/constants/community";
import { isGlobal } from "@/lib/region";
import { blogContentLanguage, type BlogContentLanguage, type BlogLocale } from "./blog-content";

const COMMUNITY_COPY = {
  en: { title: "Join the LightVela community", description: "Scan a QR code or follow a link below to explore cloud agents with the community.", join: "Join on {name}", qr: "{name} community QR code" },
  "zh-CN": { title: "加入 LightVela 交流群", description: "扫码或点击链接加入社群，一起探索云端 Agent 的更多玩法。", join: "加入 {name}", qr: "{name} 社群二维码" },
  "zh-Hant": { title: "加入 LightVela 交流群", description: "掃碼或點擊連結加入社群，一起探索雲端 Agent 的更多玩法。", join: "加入 {name}", qr: "{name} 社群二維碼" },
  "id-ID": { title: "Bergabung dengan komunitas LightVela", description: "Pindai kode QR atau buka tautan di bawah untuk menjelajahi agen cloud bersama komunitas.", join: "Bergabung di {name}", qr: "Kode QR komunitas {name}" },
  es: { title: "Únete a la comunidad de LightVela", description: "Escanea un código QR o abre uno de los enlaces para explorar los agentes en la nube con la comunidad.", join: "Únete en {name}", qr: "Código QR de la comunidad de {name}" },
  "ja-JP": { title: "LightVela コミュニティに参加", description: "QR コードを読み取るか、下のリンクから参加して、クラウドエージェントの活用方法を一緒に探しましょう。", join: "{name} に参加", qr: "{name} コミュニティの QR コード" },
  "ko-KR": { title: "LightVela 커뮤니티에 참여하세요", description: "QR 코드를 스캔하거나 아래 링크를 열어 커뮤니티와 함께 클라우드 에이전트를 활용해 보세요.", join: "{name}에서 참여하기", qr: "{name} 커뮤니티 QR 코드" },
} satisfies Record<BlogContentLanguage, { title: string; description: string; join: string; qr: string }>;

/** Language follows the article; available communities follow the site region. */
export function BlogCommunity({ locale }: { locale?: BlogLocale }) {
  const language = blogContentLanguage(locale);
  const copy = COMMUNITY_COPY[language];
  return (
    <section aria-labelledby="blog-community-heading" className="mt-12 border-t border-black/10 pt-6">
      <h2 id="blog-community-heading" className="text-xl font-semibold">
        {copy.title}
      </h2>
      <p className="mt-3 text-base leading-7 text-black/75">
        {isGlobal ? copy.description : "扫码加入微信交流群，一起交流使用经验，探索云端 Agent 的更多玩法。"}
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
            <QRCodeSVG value={href} size={168} includeMargin role="img" aria-label={copy.qr.replace("{name}", name)} />
            <span>{copy.join.replace("{name}", name)}</span>
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

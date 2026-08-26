import { ArrowUpRight } from "lucide-react";
import { imgHeroAvatars, imgHeroElement01, imgHeroElement02, imgHeroElement03 } from "../assets";
import { useT } from "@/i18n/t";
import { isCN } from "@/lib/region";
import { cn } from "@/lib/utils";

const heroBackground = [
  "radial-gradient(ellipse at 54% 38%, rgba(255,255,255,0.96) 0%, rgba(250,252,255,0.9) 32%, rgba(255,255,255,0) 58%)",
  "radial-gradient(ellipse at 8% 14%, rgba(104,139,255,0.46) 0%, rgba(176,195,255,0.28) 28%, rgba(255,255,255,0) 60%)",
  "radial-gradient(ellipse at 88% 52%, rgba(244,178,225,0.5) 0%, rgba(236,204,250,0.34) 34%, rgba(255,255,255,0) 68%)",
  "radial-gradient(ellipse at 40% 88%, rgba(150,169,255,0.34) 0%, rgba(255,255,255,0) 56%)",
  "linear-gradient(110deg, #a6bbff 0%, #eef1ff 43%, #f8e7fb 78%, #d89ae8 100%)",
].join(", ");

interface HeroSectionProps {
  /** 主按钮点击回调；不传时按钮仍可点击但无业务行为 */
  onCreateClick?: () => void;
  /** 主按钮文案；未登录/未订阅默认「免费试用」，已登录已订阅由上层传入「立即创建」「我的智能体伙伴」 */
  ctaLabel?: string;
}

export default function HeroSection({ onCreateClick, ctaLabel }: HeroSectionProps = {}) {
  const t = useT();
  const buttonLabel = ctaLabel ?? t("免费试用");

  return (
    <section
      className="relative h-dvh w-full overflow-hidden bg-white"
      style={{ background: heroBackground }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-white/24 via-white/10 to-transparent"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-[2vw] top-[31%] z-0 w-[clamp(88px,11vw,220px)]"
      >
        <img
          alt=""
          src={imgHeroElement02}
          className="block h-auto w-full select-none"
          draggable={false}
        />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[-42px] left-[-170px] z-0 w-[clamp(420px,48vw,820px)] sm:left-[-92px] lg:left-[-28px]"
      >
        <img
          alt=""
          src={imgHeroElement01}
          className="block h-auto w-full select-none"
          draggable={false}
        />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[-96px] right-[-152px] z-0 w-[clamp(280px,27vw,520px)] sm:right-[-112px] lg:right-[-58px]"
      >
        <img
          alt=""
          src={imgHeroElement03}
          className="block h-auto w-full select-none"
          draggable={false}
        />
      </div>

      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center px-5 pt-20 text-center sm:px-8">
        <div className="mb-7 flex max-w-full flex-col items-center justify-center gap-3 text-pretty text-[15px] leading-6 text-black/75 sm:flex-row sm:text-lg sm:leading-7">
          <img
            alt=""
            src={imgHeroAvatars}
            className="h-8 w-auto shrink-0 select-none"
            draggable={false}
          />
          <p className="m-0 max-w-[270px] break-words [word-break:normal] sm:max-w-[620px]">
            {isCN
              ? "LightVela · Hermes Agent"
              : t("云端托管 Hermes Agent，越聊越懂你的智能伙伴")}
          </p>
        </div>

        <h1
          className={cn(
            "m-0 w-full max-w-[320px] min-w-0 break-words text-balance font-['PingFang_SC','HarmonyOS_Sans_SC',sans-serif] text-[30px] font-semibold leading-[1.2] text-black/90 sm:max-w-[960px]",
            isCN ? "sm:text-[48px] lg:text-[56px]" : "sm:text-[52px] lg:text-[64px]",
          )}
        >
          {isCN
            ? "越用越懂你，长期在线的 AI 伙伴"
            : t("灵感随时发生，思考自由流动")}
        </h1>

        <button
          type="button"
          onClick={onCreateClick}
          aria-label={buttonLabel}
          className="relative mt-16 inline-flex h-[60px] max-w-[calc(100vw-48px)] cursor-pointer items-center justify-center gap-5 rounded-full border-0 bg-[#1a1a1a] px-8 pr-[72px] font-['PingFang_SC','HarmonyOS_Sans_SC',sans-serif] text-base font-medium text-white shadow-sm transition-transform duration-200 ease-out hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black/40 active:translate-y-0 sm:mt-[72px] sm:text-lg"
        >
          <span className="whitespace-nowrap">{buttonLabel}</span>
          <span className="absolute right-3 flex size-9 items-center justify-center rounded-full bg-white text-black">
            <ArrowUpRight className="size-4" strokeWidth={2.2} aria-hidden="true" />
          </span>
        </button>
      </div>
    </section>
  );
}

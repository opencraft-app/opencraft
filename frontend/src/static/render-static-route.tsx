import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import { HeaderSectionContent } from "@/imports/Frame2147230025/sections/HeaderSection";
import HeroSection from "@/imports/Frame2147230025/sections/HeroSection";
import "@/pages/marketing/landing-page-isolation.css";

type StaticRouteInput = {
  route: {
    kind: string;
    path: string;
  };
  /**
   * 当前渲染的目标 locale。国际站 prerender 会按 ["en-US", "zh-CN"] 各渲一次；
   * 必须在每次渲染前显式切到目标 locale，否则 i18n 单例只 init 一次（默认
   * en-US），导致 dist/zh/index.html 的 React DOM 也是英文，与 <html lang="zh-CN">
   * 矛盾，hreflang 集群被搜索引擎判为低质量。
   *
   * 国内站 prerender 只有 zh-CN，传入也无害。未传时不切换（向后兼容旧调用）。
   */
  locale?: string;
};

const noop = () => undefined;

function StaticLandingPage() {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <div className="lw-landing-root w-full bg-white overflow-x-hidden">
        <div className="relative">
          <HeaderSectionContent
            onLoginClick={noop}
            onCreateClick={noop}
            authSnapshot={{ authReady: false, isAuthenticated: false }}
          />
          <HeroSection onCreateClick={noop} />
        </div>
      </div>
    </MemoryRouter>
  );
}

export async function renderStaticRoute({ route, locale }: StaticRouteInput): Promise<string | null> {
  if (route.kind !== "home") return null;
  /* i18n.changeLanguage 在已 init 的实例上是同步切换 + 异步 emit，
     这里 await 拿到 emit 完成后再 renderToString，确保所有 useTranslation
     订阅者读到的是目标 locale 的文案。 */
  if (locale && i18n.language !== locale) {
    await i18n.changeLanguage(locale);
  }
  return renderToString(<StaticLandingPage />);
}

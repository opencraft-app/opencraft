"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LegalFooter } from "@/components/site/legal-footer";
import { AppLink } from "@/lib/app-navigation";

type CookieTableRow = {
  cookie: string;
  name: string;
  purpose: string;
  duration: string;
};

type CookieSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  tableTitle?: string;
  tableIntro?: string[];
  tableRows?: CookieTableRow[];
};

type CookiePolicyCopy = {
  backHome: string;
  brand: string;
  title: string;
  intro: string[];
  sections: CookieSection[];
  tableHeaders: {
    cookie: string;
    name: string;
    purpose: string;
    duration: string;
  };
};

const en: CookiePolicyCopy = {
  backHome: "Back to Home",
  brand: "LightVela",
  title: "Cookies Policy",
  tableHeaders: {
    cookie: "Cookie",
    name: "Cookie Name",
    purpose: "Purpose",
    duration: "Duration",
  },
  intro: [
    "This Cookies Policy applies to the LightVela website (the “Services”). When you use the Services, we may use cookies, log files, pixel tags, web beacons, scripts, eTags, mobile device IDs, plugins, local storage and similar files or technologies (collectively, “cookies”) to collect and store information we automatically collect about your device and use of the Services. This Cookies Policy explains what cookies are, what kind of cookies may be used in our Services and how you can manage cookies.",
    "For the purposes of this Cookies Policy, “we”, “us” and “our” means Tencent Cloud International Pte. Limited, a company incorporated in Singapore with registered address 10 Anson Road, #21-07, International Plaza, Singapore 079903. For the purpose of any personal data we collect through cookies, we are the data controller. Our data protection officer can be contacted here.",
  ],
  sections: [
    {
      title: "1. WHAT ARE COOKIES?",
      paragraphs: [
        "Cookies are files which are placed on your device when a website is loaded on your browser. They are widely used in order to make websites work or work more efficiently, as well as to provide information to the owner of the site or to another site that recognizes that cookie.",
        "First-party and third-party cookies\n\nCookies can be first-party or third-party. A first-party cookie is set directly by us to your device, whereas a third-party cookie is set by a third party (such as analytics providers and our advertisers and business partners).",
        "Persistent and session cookies\n\nCookies can be persistent or session cookies depending on the time that they remain on your device. A persistent cookie is stored on your device even after your web browser is closed or after your session ends. It can be used by the Services to recognize your device when you open your browser and use the Services again. A session cookie exists temporarily on your device while your browser is open. It is deleted automatically once you leave the website or close your browser.",
        "If you do not accept the use of cookies, please disable them using the instructions below and changing your browser settings so that cookies cannot be placed on your device.",
      ],
    },
    {
      title: "2. WHAT KIND OF COOKIES DO WE USE?",
      paragraphs: ["The tables below explain the cookies used by us and our partners in connection with the Services."],
    },
    {
      title: "Strictly Necessary Cookies",
      paragraphs: [
        "These cookies are essential to the functioning of the Services, to provide a service requested by you or to comply with the law (e.g., security requirements of data protection laws). These cookies will be collected once our website is loaded on your browser and cannot be turned off as we cannot provide the Services without them.",
      ],
    },
    {
      title: "Functionality Cookies",
      paragraphs: ["These cookies allow us to remember your preferences and choices you make on the site."],
      tableRows: [
        { cookie: "github.com\n(Third-party)", name: "_gh_sess", purpose: "This cookie is used for temporary application and framework state between pages like what step the user is on in a multiple step form.", duration: "Session" },
        { cookie: "github.com\n(Third-party)", name: "cpu_bucket", purpose: "This cookie is used for load-management or feature-assignment.", duration: "Session" },
        { cookie: "github.com\n(Third-party)", name: "tz", purpose: "This cookie allows us to customize timestamps to your time zone.", duration: "Session" },
        { cookie: "github.com\n(Third-party)", name: "_device_id", purpose: "This cookie is used to track recognized devices for security purposes.", duration: "1 Year" },
        { cookie: "github.com\n(Third-party)", name: "preferred_color_mode", purpose: "This cookie is used to indicate the user selected theme preference.", duration: "Session" },
        { cookie: "github.com\n(Third-party)", name: "logged_in", purpose: "This cookie is used to signal to us that the user is already logged in.", duration: "1 Year" },
        { cookie: "github.com\n(Third-party)", name: "_octo", purpose: "This cookie is used for session management including caching of dynamic content, conditional feature access, support request metadata, and first party analytics.", duration: "1 Year" },
      ],
    },
    {
      title: "Performance Cookies",
      paragraphs: [
        "These cookies allow us to collect information about your online activity, including behavioral data and content engagement. They allow us to provide you with a better user experience and to maintain, operate and continually improve the Services.",
      ],
      tableRows: [
        { cookie: "lightclaw.tech\n(Third-party)", name: "lc_session", purpose: "This cookie is used to understand site visits, form activity, and referral context if you accept optional tracking.", duration: "Session" },
      ],
    },
    {
      title: "Marketing Cookies",
      paragraphs: [
        "These cookies may be set through the Services by us and/or our advertising partners to deliver a more personalized service, execute advertising campaigns, show you relevant ads, and measure the effectiveness of advertising campaigns. They may also be used to show you relevant adverts on other sites. They do not store directly personal information but are based on uniquely identifying your browser and internet device.",
      ],
    },
    {
      title: "3. HOW TO MANAGE OR DELETE COOKIES?",
      paragraphs: [
        "We use cookies when providing our Services to make sure you can use and enjoy our Services easily. Some of the cookies are essential and we cannot provide our Services without them, but there are others that can be turned off. You have the right to choose whether or not to accept non-essential cookies and we have explained how you can exercise this right below. However, please note that if you choose to refuse or, at a later stage, opt out of certain cookies or other locally stored data, you may not be able to use the full functionality of the Services.",
        "Most devices (in the case of mobile applications) and browsers (in the case of web apps and pages) allow you to change your cookie settings. These settings will typically be found in the “options” or “preferences” menu of your browser. This lets you control your cookie settings so that you can:",
      ],
      bullets: [
        "see what cookies or other locally stored data are used and delete them on an individual basis",
        "block third-party cookies",
        "block cookies from particular sites",
        "block all cookies from being set",
        "delete all cookies when you close your browser",
      ],
    },
    {
      title: "For more information on how to manage popular browsers, please see below:",
      bullets: [
        "Cookie settings in Chrome for web",
        "Cookie settings in Chrome for Android",
        "Cookie settings in Safari web",
        "Cookie settings in Safari iOS",
        "Cookie settings in Internet Explorer",
        "Cookie settings in Firefox",
      ],
      paragraphs: [
        "You can change the settings for the cookies we use in our Services at any time in our preference center.",
        "How to opt out of third-party cookie use\n\nIf you want to reduce your settings at any time (for example, if you accept all cookies, but later decide you do not want a certain type of cookie) you can use your browser settings to remove any third-party cookies or similar technologies dropped on your previous visit. To opt out of Google Analytics’ use of cookies, a Chrome browser add-on is available.",
        "If you would like to find out more about cookies and their use on the Internet, you may find the following link useful: All About Cookies.",
      ],
    },
    {
      title: "4. CHANGES TO THIS COOKIES POLICY",
      paragraphs: [
        "We will update this Cookies Policy to reflect changes in our practices and services. When we post changes to this Cookies Policy, we will revise the \"Last Updated\" date at the top of this Cookies Policy. If we make any material changes in the way we collect, use, and/or share information held in cookies, we will notify you by prominently posting notice of the changes when you log in to or use the Services. We recommend that you check this page from time to time to inform yourself of any changes to this Cookies Policy.",
      ],
    },
    {
      title: "5. COOKIES THAT HAVE BEEN SET IN THE PAST",
      paragraphs: [
        "If you have disabled one or more cookies, we may still use information collected from cookies prior to your disabled preference being set, however, we will stop using the disabled cookie to collect any further information.",
      ],
    },
    {
      title: "6. CONTACT US",
      paragraphs: ["If you have any questions or comments about this Cookies Policy, please contact us at lightvela@tencent.com."],
    },
  ],
};

const zh: CookiePolicyCopy = {
  backHome: "返回首页",
  brand: "LightVela",
  title: "Cookies 政策",
  tableHeaders: {
    cookie: "Cookie",
    name: "Cookie 名称",
    purpose: "用途",
    duration: "期限",
  },
  intro: [
    "本 Cookies 政策适用于 LightVela 网站（“服务”）。当您使用服务时，我们可能使用 cookies、日志文件、像素标签、网络信标、脚本、eTags、移动设备 ID、插件、本地存储以及类似文件或技术（统称为“cookies”），以收集并存储我们自动收集的关于您的设备和服务使用情况的信息。本 Cookies 政策说明什么是 cookies、我们的服务中可能使用哪些 cookies，以及您如何管理 cookies。",
    "就本 Cookies 政策而言，“我们”指 Tencent Cloud International Pte. Limited，这是一家在新加坡注册成立的公司，注册地址为 10 Anson Road, #21-07, International Plaza, Singapore 079903。对于我们通过 cookies 收集的任何个人数据，我们是数据控制者。您可以在此联系我们的数据保护官。",
  ],
  sections: [
    {
      title: "1. 什么是 Cookies？",
      paragraphs: [
        "Cookies 是当网站在您的浏览器中加载时放置在您设备上的文件。它们被广泛用于使网站正常工作或更高效地工作，并向网站所有者或识别该 cookie 的其他网站提供信息。",
        "第一方和第三方 cookies\n\nCookies 可以是第一方或第三方 cookies。第一方 cookie 由我们直接设置到您的设备上，而第三方 cookie 由第三方设置，例如分析服务提供商、广告商和业务合作伙伴。",
        "持久性和会话 cookies\n\nCookies 可以是持久性 cookies 或会话 cookies，取决于它们在您设备上保留的时间。持久性 cookie 会在浏览器关闭或会话结束后继续存储在您的设备上，可用于服务在您再次打开浏览器并使用服务时识别您的设备。会话 cookie 在浏览器打开期间临时存在于您的设备上，并会在您离开网站或关闭浏览器后自动删除。",
        "如果您不接受 cookies 的使用，请按照下文说明禁用 cookies，并更改浏览器设置，使 cookies 无法放置在您的设备上。",
      ],
    },
    {
      title: "2. 我们使用哪些 Cookies？",
      paragraphs: ["下表说明我们及合作伙伴在服务相关场景中使用的 cookies。"],
    },
    {
      title: "严格必要 Cookies",
      paragraphs: [
        "这些 cookies 对服务运行、提供您请求的服务或遵守法律（例如数据保护法律的安全要求）而言必不可少。当我们的网站在您的浏览器中加载时，这些 cookies 会被收集，且无法关闭，因为没有它们我们无法提供服务。",
      ],
    },
    {
      title: "功能性 Cookies",
      paragraphs: ["这些 cookies 使我们能够记住您在网站上的偏好和选择。"],
      tableRows: [
        { cookie: "github.com\n（第三方）", name: "_gh_sess", purpose: "该 cookie 用于页面之间的临时应用和框架状态，例如多步骤表单中用户所处的步骤。", duration: "会话" },
        { cookie: "github.com\n（第三方）", name: "cpu_bucket", purpose: "该 cookie 用于负载管理或功能分配。", duration: "会话" },
        { cookie: "github.com\n（第三方）", name: "tz", purpose: "该 cookie 允许我们根据您的时区自定义时间戳。", duration: "会话" },
        { cookie: "github.com\n（第三方）", name: "_device_id", purpose: "该 cookie 用于出于安全目的跟踪已识别设备。", duration: "1 年" },
        { cookie: "github.com\n（第三方）", name: "preferred_color_mode", purpose: "该 cookie 用于表示用户选择的主题偏好。", duration: "会话" },
        { cookie: "github.com\n（第三方）", name: "logged_in", purpose: "该 cookie 用于向我们表明用户已经登录。", duration: "1 年" },
        { cookie: "github.com\n（第三方）", name: "_octo", purpose: "该 cookie 用于会话管理，包括动态内容缓存、条件功能访问、支持请求元数据和第一方分析。", duration: "1 年" },
      ],
    },
    {
      title: "性能 Cookies",
      paragraphs: [
        "这些 cookies 允许我们收集有关您在线活动的信息，包括行为数据和内容互动情况。它们使我们能够为您提供更好的用户体验，并维护、运营和持续改进服务。",
      ],
      tableRows: [
        { cookie: "lightclaw.tech\n（第三方）", name: "lc_session", purpose: "如果您接受可选跟踪，该 cookie 用于了解网站访问、表单活动和来源上下文。", duration: "会话" },
      ],
    },
    {
      title: "营销 Cookies",
      paragraphs: [
        "这些 cookies 可能由我们和/或广告合作伙伴通过服务设置，用于提供更个性化的服务、执行广告活动、向您展示相关广告并衡量广告活动效果。它们也可能用于在其他网站上向您展示相关广告。它们不会直接存储个人信息，而是基于对您的浏览器和互联网设备的唯一识别。",
      ],
    },
    {
      title: "3. 如何管理或删除 Cookies？",
      paragraphs: [
        "我们在提供服务时使用 cookies，以确保您能够轻松使用和享受服务。部分 cookies 是必要的，没有它们我们无法提供服务；但也有其他 cookies 可以关闭。您有权选择是否接受非必要 cookies，我们在下文说明您如何行使该权利。但请注意，如果您选择拒绝或之后选择退出某些 cookies 或其他本地存储数据，您可能无法使用服务的全部功能。",
        "大多数设备（对于移动应用）和浏览器（对于网页应用和页面）都允许您更改 cookie 设置。这些设置通常可在浏览器的“选项”或“偏好设置”菜单中找到。您可以通过这些设置控制 cookies，以便：",
      ],
      bullets: [
        "查看正在使用哪些 cookies 或其他本地存储数据，并逐项删除；",
        "阻止第三方 cookies；",
        "阻止特定网站的 cookies；",
        "阻止所有 cookies 设置；",
        "在关闭浏览器时删除所有 cookies。",
      ],
    },
    {
      title: "有关如何管理常见浏览器的更多信息，请参见下方：",
      bullets: [
        "Chrome 网页版 Cookie 设置",
        "Chrome Android 版 Cookie 设置",
        "Safari 网页版 Cookie 设置",
        "Safari iOS 版 Cookie 设置",
        "Internet Explorer 的 Cookie 设置",
        "Firefox 的 Cookie 设置",
      ],
      paragraphs: [
        "您可以随时在我们的偏好中心更改服务中使用的 cookies 设置。",
        "如何退出第三方 cookie 使用\n\n如果您希望随时降低设置（例如您接受了全部 cookies，但之后决定不希望使用某类 cookies），可以使用浏览器设置移除您此前访问时留下的任何第三方 cookies 或类似技术。若要退出 Google Analytics 对 cookies 的使用，可以使用 Chrome 浏览器插件。",
        "如果您希望了解更多关于 cookies 及其在互联网上使用的信息，可以参考以下链接：All About Cookies。",
      ],
    },
    {
      title: "4. 本 Cookies 政策的变更",
      paragraphs: [
        "我们会更新本 Cookies 政策，以反映我们的实践和服务变化。当我们发布本 Cookies 政策的变更时，会修订本政策顶部的“最后更新”日期。如果我们对收集、使用和/或共享 cookies 中保存的信息的方式作出任何重大变更，我们会在您登录或使用服务时以醒目方式发布变更通知。我们建议您不时查看本页面，以了解本 Cookies 政策的任何变更。",
      ],
    },
    {
      title: "5. 过去设置的 Cookies",
      paragraphs: [
        "如果您禁用了一个或多个 cookies，我们仍可能使用在您设置禁用偏好之前通过 cookies 收集的信息；但我们将停止使用被禁用的 cookie 收集任何进一步信息。",
      ],
    },
    {
      title: "6. 联系我们",
      paragraphs: ["如果您对本 Cookies 政策有任何问题或意见，请通过 lightvela@tencent.com 联系我们。"],
    },
  ],
};

const blueLinkStyle = { color: "#2563EB", WebkitTextFillColor: "#2563EB", textDecorationColor: "#2563EB" };

const browserLinks: Record<string, string> = {
  "Cookie settings in Chrome for web": "https://support.google.com/chrome/answer/95647?co=GENIE.Platform%3DDesktop&hl=en",
  "Cookie settings in Chrome for Android": "https://support.google.com/chrome/answer/95647?co=GENIE.Platform%3DAndroid&hl=en",
  "Cookie settings in Safari web": "https://support.apple.com/guide/safari/manage-cookies-sfri11471/mac",
  "Cookie settings in Safari iOS": "https://support.apple.com/kb/HT1677",
  "Cookie settings in Internet Explorer": "https://windows.microsoft.com/en-gb/windows7/how-to-manage-cookies-in-internet-explorer-9",
  "Cookie settings in Firefox": "https://support.mozilla.org/en-US/kb/cookies",
  "Chrome 网页版 Cookie 设置": "https://support.google.com/chrome/answer/95647?co=GENIE.Platform%3DDesktop&hl=en",
  "Chrome Android 版 Cookie 设置": "https://support.google.com/chrome/answer/95647?co=GENIE.Platform%3DAndroid&hl=en",
  "Safari 网页版 Cookie 设置": "https://support.apple.com/guide/safari/manage-cookies-sfri11471/mac",
  "Safari iOS 版 Cookie 设置": "https://support.apple.com/kb/HT1677",
  "Internet Explorer 的 Cookie 设置": "https://windows.microsoft.com/en-gb/windows7/how-to-manage-cookies-in-internet-explorer-9",
  "Firefox 的 Cookie 设置": "https://support.mozilla.org/en-US/kb/cookies",
};

const renderInlineLinks = (text: string): ReactNode[] => {
  const tokenPattern = /(lightvela@tencent\.com|here|在此|Chrome browser add-on|Chrome 浏览器插件|All About Cookies|Cookie settings in Chrome for web|Cookie settings in Chrome for Android|Cookie settings in Safari web|Cookie settings in Safari iOS|Cookie settings in Internet Explorer|Cookie settings in Firefox|Chrome 网页版 Cookie 设置|Chrome Android 版 Cookie 设置|Safari 网页版 Cookie 设置|Safari iOS 版 Cookie 设置|Internet Explorer 的 Cookie 设置|Firefox 的 Cookie 设置)/g;
  return text.split(tokenPattern).filter(Boolean).map((part, index) => {
    if (part === "lightvela@tencent.com" || part === "here" || part === "在此") {
      return (
        <a key={`${part}-${index}`} href="mailto:lightvela@tencent.com" className="font-semibold underline underline-offset-2 hover:opacity-80" style={blueLinkStyle}>
          {part}
        </a>
      );
    }
    if (part === "All About Cookies") {
      return (
        <a key={`${part}-${index}`} href="https://allaboutcookies.org/" target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2 hover:opacity-80" style={blueLinkStyle}>
          {part}
        </a>
      );
    }
    if (part === "Chrome browser add-on" || part === "Chrome 浏览器插件") {
      return (
        <a key={`${part}-${index}`} href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2 hover:opacity-80" style={blueLinkStyle}>
          {part}
        </a>
      );
    }
    const href = browserLinks[part];
    if (href) {
      return (
        <a key={`${part}-${index}`} href={href} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2 hover:opacity-80" style={blueLinkStyle}>
          {part}
        </a>
      );
    }
    return part;
  });
};

const RichParagraph = ({ text }: { text: string }) => {
  if (text.includes("\n\n")) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {text.split("\n\n").map((paragraph) => (
          <p key={paragraph} style={{ margin: 0 }}>
            {renderInlineLinks(paragraph)}
          </p>
        ))}
      </div>
    );
  }
  return <>{renderInlineLinks(text)}</>;
};

const CookieTable = ({ copy, rows }: { copy: CookiePolicyCopy; rows: CookieTableRow[] }) => (
  <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="overflow-x-auto">
      <table className="min-w-[860px] border-collapse text-left text-[15px] leading-8">
        <thead className="bg-[#0B2E70] text-white">
          <tr>
            <th className="w-[22%] px-4 py-3 font-semibold">{copy.tableHeaders.cookie}</th>
            <th className="w-[18%] px-4 py-3 font-semibold">{copy.tableHeaders.name}</th>
            <th className="px-4 py-3 font-semibold">{copy.tableHeaders.purpose}</th>
            <th className="w-[14%] px-4 py-3 font-semibold">{copy.tableHeaders.duration}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.cookie}-${row.name}`} className="border-t border-slate-200 align-top odd:bg-white even:bg-slate-50/70">
              <td className="whitespace-pre-line px-4 py-5 font-medium text-slate-900">{row.cookie}</td>
              <td className="px-4 py-5 font-mono text-sm text-slate-900">{row.name}</td>
              <td className="px-4 py-5 text-slate-700"><RichParagraph text={row.purpose} /></td>
              <td className="px-4 py-5 text-slate-700">{row.duration}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

export const CookiePolicyPage = () => {
  const { i18n } = useTranslation();
  const copy = i18n.language === "zh-CN" ? zh : en;

  return (
    <div className="min-h-dvh bg-[#F7F8FA] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <AppLink to="/" className="text-xl font-semibold tracking-[-0.04em] text-slate-950">
            {copy.brand}
          </AppLink>
          <AppLink to="/" className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-950">
            {copy.backHome}
          </AppLink>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:py-16">
        <article className="rounded-[2rem] border border-slate-200 bg-white px-5 py-8 shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)] sm:px-8 sm:py-10 lg:px-12">
          <div className="border-b border-slate-200 pb-12 sm:pb-14">
            <h1 className="text-4xl font-semibold tracking-[-0.06em] text-slate-950 sm:text-5xl">{copy.title}</h1>
            <div className="mt-12 space-y-6">
              {copy.intro.map((paragraph) => (
                <p key={paragraph} className="text-base leading-9 text-slate-700">
                  <RichParagraph text={paragraph} />
                </p>
              ))}
            </div>
          </div>

          {copy.sections.map((section) => (
            <section key={section.title} className="border-t border-slate-200 py-12 sm:py-14 first:border-t-0">
              <h2 className="text-2xl font-semibold tracking-[-0.04em] text-slate-950">{section.title}</h2>
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph} className="mt-6 text-base leading-9 text-slate-700">
                  <RichParagraph text={paragraph} />
                </p>
              ))}
              {section.bullets ? (
                <ul className="mt-7 space-y-4 pl-5 text-base leading-9 text-slate-700">
                  {section.bullets.map((bullet) => (
                    <li key={bullet} className="list-disc">
                      <RichParagraph text={bullet} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {section.tableRows ? <CookieTable copy={copy} rows={section.tableRows} /> : null}
            </section>
          ))}
        </article>
      </main>

      <LegalFooter />
    </div>
  );
};

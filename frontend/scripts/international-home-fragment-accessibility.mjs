import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const FRAGMENT_FILE_PATTERN = /^index-fragment(?:\..+)?\.html$/;

/* 工作台轮播六张模板图的 alt。图片本身是「AI 生成的页面」示例，
   所以 alt 要说清这是什么页面，而不是重复卡片标题。 */
const WORKSPACE_SLIDE_ALT_BY_LOCALE = {
  "en-US": {
    anniversary: "Anniversary page generated in the LightVela workbench",
    resume: "Résumé page generated in the LightVela workbench",
    thesis: "Thesis page generated in the LightVela workbench",
    event: "Event page generated in the LightVela workbench",
    product: "Product page generated in the LightVela workbench",
    travel: "Travel plan page generated in the LightVela workbench",
  },
  "zh-CN": {
    anniversary: "LightVela 工作台生成的周年纪念页",
    resume: "LightVela 工作台生成的简历页",
    thesis: "LightVela 工作台生成的论文页",
    event: "LightVela 工作台生成的活动页",
    product: "LightVela 工作台生成的产品介绍页",
    travel: "LightVela 工作台生成的旅行计划页",
  },
  "zh-SG": {
    anniversary: "LightVela 工作台生成的周年纪念页",
    resume: "LightVela 工作台生成的简历页",
    thesis: "LightVela 工作台生成的论文页",
    event: "LightVela 工作台生成的活动页",
    product: "LightVela 工作台生成的产品介绍页",
    travel: "LightVela 工作台生成的旅行计划页",
  },
  "zh-Hant": {
    anniversary: "LightVela 工作台生成的週年紀念頁",
    resume: "LightVela 工作台生成的履歷頁",
    thesis: "LightVela 工作台生成的論文頁",
    event: "LightVela 工作台生成的活動頁",
    product: "LightVela 工作台生成的產品介紹頁",
    travel: "LightVela 工作台生成的旅行計畫頁",
  },
  "id-ID": {
    anniversary: "Halaman anniversary yang dibuat di workbench LightVela",
    resume: "Halaman resume yang dibuat di workbench LightVela",
    thesis: "Halaman tesis yang dibuat di workbench LightVela",
    event: "Halaman acara yang dibuat di workbench LightVela",
    product: "Halaman produk yang dibuat di workbench LightVela",
    travel: "Halaman rencana perjalanan yang dibuat di workbench LightVela",
  },
  es: {
    anniversary: "Página de aniversario generada en el espacio de trabajo de LightVela",
    resume: "Página de currículum generada en el espacio de trabajo de LightVela",
    thesis: "Página de tesis generada en el espacio de trabajo de LightVela",
    event: "Página de evento generada en el espacio de trabajo de LightVela",
    product: "Página de producto generada en el espacio de trabajo de LightVela",
    travel: "Página de plan de viaje generada en el espacio de trabajo de LightVela",
  },
  "ja-JP": {
    anniversary: "LightVela のワークベンチで生成した記念日のページ",
    resume: "LightVela のワークベンチで生成した履歴書のページ",
    thesis: "LightVela のワークベンチで生成した論文のページ",
    event: "LightVela のワークベンチで生成したイベントのページ",
    product: "LightVela のワークベンチで生成した製品紹介のページ",
    travel: "LightVela のワークベンチで生成した旅行計画のページ",
  },
  "ko-KR": {
    anniversary: "LightVela 워크벤치에서 만든 기념일 페이지",
    resume: "LightVela 워크벤치에서 만든 이력서 페이지",
    thesis: "LightVela 워크벤치에서 만든 논문 페이지",
    event: "LightVela 워크벤치에서 만든 행사 페이지",
    product: "LightVela 워크벤치에서 만든 제품 소개 페이지",
    travel: "LightVela 워크벤치에서 만든 여행 계획 페이지",
  },
};

/* 平台图标的 alt 用品牌自己的拉丁写法：中文站点的可见标签本来就是中文，
   但 id-ID / es 等拉丁语种的产出里不允许残留汉字（见 international-home-page
   .test.tsx 的 CJK 断言），所以这里按语种取名字，而不是照抄相邻可见文字。 */
const CHANNEL_NAME_BY_FILE = {
  "whatsapp.svg": "WhatsApp",
  "telegram.svg": "Telegram",
  "discord.svg": "Discord",
  "slack.svg": "Slack",
  "qq.png": "QQ",
  "wecom.png": "WeCom",
  "wechat.png": "WeChat",
  "feishu.png": "Feishu",
  "dingtalk.png": "DingTalk",
};
const CHANNEL_NAME_ZH_BY_FILE = {
  "wechat.png": "微信",
  "feishu.png": "飞书",
  "dingtalk.png": "钉钉",
  "wecom.png": "企业微信",
};

function channelAlt(locale, fileName) {
  if (locale.startsWith("zh")) {
    return CHANNEL_NAME_ZH_BY_FILE[fileName] ?? CHANNEL_NAME_BY_FILE[fileName] ?? null;
  }
  return CHANNEL_NAME_BY_FILE[fileName] ?? null;
}

function workspaceSlideAlt(locale, fileName) {
  const key = fileName.replace(/\.zh-CN(?=\.(png|jpe?g|webp)$)/i, "").replace(/\.(png|jpe?g|webp)$/i, "");
  const byLocale = WORKSPACE_SLIDE_ALT_BY_LOCALE[locale] || WORKSPACE_SLIDE_ALT_BY_LOCALE["en-US"];
  return byLocale[key] ?? null;
}

function textOf(element) {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/* 给图片补 alt：
   - 能取到名字的（频道 logo、平台图标、头像）用名字；
   - 工作台轮播用本地化的页面描述；
   - 其余确实是装饰图的，显式标 aria-hidden，让辅助技术跳过。 */
function resolveImageAlt(img, locale) {
  const src = img.getAttribute("src") ?? "";
  const fileName = src.split("/").pop()?.split("?")[0] ?? "";

  if (img.classList.contains("workspace-carousel__slide")) {
    return workspaceSlideAlt(locale, fileName);
  }
  if (fileName === "lightvela-logo.svg") return "LightVela";

  const channelName = channelAlt(locale, fileName);
  if (channelName) return channelName;

  const namedHost = img.closest(".chnloop__item, .hero__tabs label, label[for]");
  const hostName = textOf(namedHost);
  if (hostName) return hostName;

  const isAvatar =
    img.closest(".av-c") !== null ||
    fileName.startsWith("voice-") ||
    fileName.startsWith("vela-brand-character") ||
    fileName.startsWith("lightvela-reply-avatar");
  if (isAvatar) {
    const host = img.closest(".tcard, .chat-row, .peer, .bub, li");
    const nameElement = host?.querySelector("b, .bub__name, h4, strong") ?? null;
    const name = textOf(nameElement);
    return name || null;
  }

  return null;
}

/* 片段里同一个 <img> 原样出现几十次（例如品牌头像），但它们所在的会话不同、
   名字也不同。用 replaceAll 会把第一次算出的 alt 套到所有副本上，读屏就会念错
   名字，所以这里只替换当前这一处，按文档顺序逐个消化。 */
function replaceFirstOccurrence(html, from, to) {
  const index = html.indexOf(from);
  if (index === -1) return html;
  return html.slice(0, index) + to + html.slice(index + from.length);
}

export async function initializeInternationalHomeFragmentAccessibility(homeRoot) {
  const resolvedHomeRoot = path.resolve(homeRoot);
  const fragmentNames = (await readdir(resolvedHomeRoot))
    .filter((name) => FRAGMENT_FILE_PATTERN.test(name))
    .sort();
  let buttons = 0;
  let images = 0;
  let decorativeImages = 0;

  for (const fragmentName of fragmentNames) {
    const fragmentPath = path.join(resolvedHomeRoot, fragmentName);
    const html = await readFile(fragmentPath, "utf8");
    const dom = new JSDOM(html);
    const document = dom.window.document;
    let rewrittenHtml = html;

    const locale = document.querySelector("[data-locale]")?.getAttribute("data-locale") ?? "en-US";

    for (const button of document.querySelectorAll(".scene__sub")) {
      const originalMarkup = button.outerHTML;
      button.setAttribute("aria-pressed", button.classList.contains("on") ? "true" : "false");
      rewrittenHtml = replaceFirstOccurrence(rewrittenHtml, originalMarkup, button.outerHTML);
      buttons += 1;
    }

    for (const img of document.querySelectorAll("img")) {
      if ((img.getAttribute("alt") ?? "").trim()) continue;
      const originalMarkup = img.outerHTML;
      const alt = resolveImageAlt(img, locale);
      if (alt) {
        img.setAttribute("alt", alt);
        images += 1;
      } else if (!img.hasAttribute("aria-hidden")) {
        img.setAttribute("aria-hidden", "true");
        decorativeImages += 1;
      }
      if (img.outerHTML === originalMarkup) continue;
      rewrittenHtml = replaceFirstOccurrence(rewrittenHtml, originalMarkup, img.outerHTML);
    }

    if (rewrittenHtml !== html) await writeFile(fragmentPath, rewrittenHtml);
  }

  return { buttons, images, decorativeImages, fragments: fragmentNames.length };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const homeRoot = process.argv[2];
  if (!homeRoot) {
    throw new Error(
      "Usage: node scripts/international-home-fragment-accessibility.mjs <international-home-root>",
    );
  }
  const summary = await initializeInternationalHomeFragmentAccessibility(homeRoot);
  console.log(
    `[international-home-fragment-accessibility] ${summary.fragments} fragment(s): ${summary.buttons} scene button(s), ${summary.images} image alt(s) added, ${summary.decorativeImages} decorative image(s) marked aria-hidden`,
  );
}

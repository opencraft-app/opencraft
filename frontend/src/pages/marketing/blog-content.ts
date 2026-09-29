import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { localeDefinition } from "@/i18n/locales.config";
import { isGlobal } from "@/lib/region";
import REGIONAL_TRANSLATIONS from "./blog-content-regional-translations.json";

export type BlogLocale = PublicSiteLocale;
export type BlogContentLanguage = keyof typeof REGIONAL_TRANSLATIONS;

const CONTENT_LANGUAGE_BY_LOCALE = {
  "en-US": "en", "zh-CN": "zh-CN", "zh-SG": "zh-CN", "zh-Hant": "zh-Hant",
  "id-ID": "id-ID", es: "es", "ja-JP": "ja-JP", "ko-KR": "ko-KR",
} satisfies Record<BlogLocale, BlogContentLanguage>;

export type BlogInline =
  | string
  | {
      type: "link";
      label: string;
      href: string;
    };

export type BlogBlock =
  | {
      type: "paragraph";
      content: readonly BlogInline[];
      emphasis?: boolean;
    }
  | {
      type: "heading";
      text: string;
    }
  | {
      type: "image";
      src: string | null;
      alt: string;
      size?: "narrow";
    }
  | {
      type: "ordered-list";
      ariaLabel: string;
      items: readonly (readonly BlogInline[])[];
    }
  | {
      type: "unordered-list";
      items: readonly (readonly BlogInline[])[];
    }
  | {
      type: "code";
      content: string;
    };

export const BLOG_AUTHORS = ["Cassidy Shi", "Walker Cao", "Jasmin Zhao"] as const;
export type BlogAuthor = (typeof BLOG_AUTHORS)[number];

export type BlogPost = {
  slug: string;
  category: "announcement" | "product" | "use-case";
  author: BlogAuthor;
  title: string;
  excerpt: string;
  publishedAt: string;
  coverImage: string | null;
  coverPosition?: "left" | "center" | "right";
  /** Language of this source or translated article version. */
  language?: BlogContentLanguage;
  content: readonly BlogBlock[];
};

export function cleanBlogTrialUrl(value: string): string {
  if (!/^https?:\/\/(?:www\.)?lightvela\.(?:ai|com)(?:[/?#]|$)/i.test(value)) return value;
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(from|ref|source|utm_.+)$/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname === "/") url.hostname = isGlobal ? "lightvela.ai" : "lightvela.com";
  return url.toString();
}

export function blogArticleLocale(locale: BlogLocale = isGlobal ? "en-US" : "zh-CN"): BlogLocale {
  if (!isGlobal) return "zh-CN";
  return locale === "zh-CN" ? "zh-SG" : locale;
}

export function blogContentLanguage(locale?: BlogLocale): BlogContentLanguage {
  return CONTENT_LANGUAGE_BY_LOCALE[blogArticleLocale(locale)];
}

export function blogCanonicalPath(slug: string, locale: BlogLocale = isGlobal ? "en-US" : "zh-CN"): string {
  const articleLocale = blogArticleLocale(locale);
  const prefix = !isGlobal || articleLocale === "en-US" ? "" : `/${localeDefinition(articleLocale).urlLang}`;
  return `${prefix}/blog/${slug}`;
}

export function localizeBlogPost(post: BlogPost, locale: BlogLocale = isGlobal ? "en-US" : "zh-CN"): BlogPost {
  const language = blogContentLanguage(locale);
  const translations: Readonly<Record<string, string>> = REGIONAL_TRANSLATIONS[language];
  const translate = (text: string) => (translations[text] ?? text).replace(
    /https?:\/\/(?:www\.)?lightvela\.(?:ai|com)[^\s"<>，。；）]*/gi,
    cleanBlogTrialUrl,
  );
  const inline = (part: BlogInline): BlogInline => {
    if (typeof part === "string") return translate(part);
    return { ...part, label: translate(part.label), href: cleanBlogTrialUrl(part.href) };
  };
  return {
    ...post,
    language,
    title: translate(post.title),
    excerpt: translate(post.excerpt),
    content: post.content.map((block): BlogBlock => {
      switch (block.type) {
        case "paragraph": return { ...block, content: block.content.map(inline) };
        case "heading": return { ...block, text: translate(block.text) };
        case "code": return { ...block, content: translate(block.content) };
        case "ordered-list": return { ...block, ariaLabel: translate(block.ariaLabel), items: block.items.map((item) => item.map(inline)) };
        case "unordered-list": return { ...block, items: block.items.map((item) => item.map(inline)) };
        case "image": return block;
      }
    }),
  };
}

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    "slug": "lightvela-personal-ai-cloud-now-live",
    "language": "en",
    "title": "LightVela: Your Personal AI in the Cloud Is Now Live",
    "excerpt": "LightVela is a personal AI assistant that runs independently in the cloud, stays online, remembers your habits, and takes initiative.",
    "coverImage": "/assets/blog/lightvela-personal-ai-cloud-now-live/cover.webp",
    "coverPosition": "left",
    "content": [
      {
        "type": "image",
        "src": "/assets/blog/lightvela-personal-ai-cloud-now-live/cover.webp",
        "alt": "LightVela: Your Personal AI"
      },
      {
        "type": "paragraph",
        "content": [
          "LightVela began with the wave of interest in personal AI sparked by OpenClaw."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "In March this year, we hosted our first free OpenClaw installation event at Tencent Tower in Shenzhen, quickly drawing attention from across China."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "In April, based on cloud agent, we launched LightVela, built on Hermes Agent, with Chinese and international sites going live simultaneously. We took care of deployment, configuration, and maintenance, making it possible for anyone to create an always-on personal AI assistant in just 10 seconds."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "New users now get:"
        ]
      },
      {
        "type": "unordered-list",
        "items": [
          [
            "1 month free trial"
          ],
          [
            "A dedicated cloud computer with at least 2 vCPU + 8GB RAM"
          ],
          [
            "Includes 4,500 AI credits"
          ]
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Invite a friend to sign up and activate LightVela, and you’ll both receive 500 AI credits. No limit on referral rewards!"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "You can assign tasks to LightVela anytime through the messaging apps you already use. It keeps running in the cloud, remembers your preferences, and gathers news, tracks updates, and sends reminders on schedule."
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/lightvela-personal-ai-cloud-now-live/homepage.webp",
        "alt": "LightVela homepage showing its always-on AI companion and messaging channels"
      },
      {
        "type": "heading",
        "text": "Not Sure What AI Can Do for You? Start with a Bot"
      },
      {
        "type": "paragraph",
        "content": [
          "When you create your LightVela agent, you can choose from ready-made Bot templates designed around everyday needs, including a parenting advisor, a health manager, an industry researcher, and a growth experimenter."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "We selected and combined popular skills from ",
          {
            "type": "link",
            "label": "Skills.sh",
            "href": "https://skills.sh"
          },
          " or Github into practical templates, with personas, skills, memory, and scheduled tasks already configured. No additional setup is needed. Just click to get started."
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/lightvela-personal-ai-cloud-now-live/create-agent.webp",
        "alt": "LightVela agent creation screen with suggested Bot templates"
      },
      {
        "type": "heading",
        "text": "Every Agent Has Its Own Cloud Environment"
      },
      {
        "type": "paragraph",
        "content": [
          "LightVela is built on the open-source agent framework Hermes Agent. Each agent also gets its own independent cloud environment, allowing it to carry out recurring tasks such as:"
        ]
      },
      {
        "type": "unordered-list",
        "items": [
          [
            "Putting together an industry news briefing every morning."
          ],
          [
            "Checking stocks, websites, or competitor updates on a schedule."
          ],
          [
            "Reminding you to log your meals and exercise in the evening."
          ]
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Background tasks keep running even when your computer is turned off. This is supported by Tencent Cloud’s established cloud server infrastructure and its experience operating cloud-based Agent CPU clusters spanning millions of cores."
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/lightvela-personal-ai-cloud-now-live/hermes-meetup.webp",
        "alt": "Online meetup co-hosted by LightVela with universities in Singapore and Hermes core team member Tommy"
      },
      {
        "type": "paragraph",
        "content": [
          "LightVela co-hosted an online meetup with universities in Singapore, joined by Hermes core team member Tommy."
        ]
      },
      {
        "type": "heading",
        "text": "Use It Your Way, with Support for Multiple Bots"
      },
      {
        "type": "paragraph",
        "content": [
          "LightVela lets you customize your agent’s soul, memory, skills, and scheduled tasks. It continuously adapts to your preferences, habits, and communication style, getting to know you better the more you use it."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "When there is more to do, you can create multiple Bots: one for industry research, one for travel planning, and another for everyday errands. Each maintains its own memory, skills, and tasks, keeping their contexts separate."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Different Bots can connect to channels such as Telegram, Discord and so on. They can also join the same group chat, forming your own AI team."
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/lightvela-personal-ai-cloud-now-live/telegram.webp",
        "alt": "LightVela responding in Telegram with recent local news about Sicily"
      },
      {
        "type": "heading",
        "text": "Build a website and Share It Directly"
      },
      {
        "type": "paragraph",
        "content": [
          "Beyond conversations and task execution, LightVela also provides a workbench."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Choose a template or build a page from scratch, then publish, preview, update, and manage it. Travel plans, personal homepages, project pages, and information dashboards can all be shared through publicly accessible links."
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/lightvela-personal-ai-cloud-now-live/workbench.webp",
        "alt": "LightVela Workbench with starter templates and published web projects"
      },
      {
        "type": "heading",
        "text": "Try LightVela Today"
      },
      {
        "type": "paragraph",
        "content": [
          "LightVela is a personal AI assistant that runs independently in the cloud, stays online, remembers your habits, and takes initiative."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "New users currently receive a one-month free trial, including a cloud computer with 2 CPU cores and 8 GB of RAM, plus 4,500 AI credits. Invite a friend to sign up and activate their account, and you will each receive an additional 500 AI credits. There is no limit to referral rewards."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Visit the official website to get started: ",
          {
            "type": "link",
            "label": "https://lightvela.ai/",
            "href": "https://lightvela.ai/"
          }
        ]
      }
    ],
    "author": "Jasmin Zhao",
    "category": "product",
    "publishedAt": "2026-09-28T16:28:57+08:00"
  },
  {
    "slug": "dsh-revived-broken-hermes-agent",
    "language": "zh-CN",
    "title": "只花 0.25 元，就让 DSH 救活了 Hermes Agent",
    "excerpt": "上一篇文章里，我尝试让两个 Agent 在同一个云端环境中配合工作：",
    "coverImage": "/assets/blog/dsh-revived-broken-hermes-agent/cover-source.webp",
    "content": [
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/cover-source.webp",
        "alt": "DSH 修复 Hermes Agent 的文章封面"
      },
      {
        "type": "paragraph",
        "content": [
          "上一篇文章里，我尝试让两个 Agent 在同一个云端环境中配合工作："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Hermes Agent 担任领航员，负责理解需求、设计方案和检查结果；DeepSeek Harness（后文简称 DSH）担任驾驶员，进入具体工作区完成代码编写与验证。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          {
            "type": "link",
            "label": "别再让Agent单干了！我让Hermes和DSH组队后，效率提升了10倍",
            "href": "/blog/hermes-deepseek-harness-10x-efficiency"
          }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "一个新问题的出现，让这套组合给了我一个新的灵感。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "问题的起因是近来有数位社群内小伙伴的 Hermes Agent 出现了如下的一些报错："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "第一种：No reply: the turn was stopped because session storage could not be written (the transcript would have been lost on restart). Check the state database health (hermes doctor), then send your message again."
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "第二种：Session storage was temporarily unavailable, so this turn was stopped to protect yourconversation history. Your message should already be saved - please send it again in amoment."
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-02.webp",
        "alt": "Hermes Agent 会话存储异常报错"
      },
      {
        "type": "paragraph",
        "content": [
          "究其原因都是因为 Hermes Agent 的一个文件（state.db）因为种种原因导致无法写入或读取，Hermes Agent 为了确保已有的数据不受影响，由此会限制后续的对话。更蛋疼的是，LightVela 诊断中心中的重建 Agent 也无法解决这个问题。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "这个情况在此之前是非常棘手的，直到有了同一个环境下的 DeepSeek Harness（后文简称 DSH）。"
        ]
      },
      {
        "type": "heading",
        "text": "为什么 DSH 可以？"
      },
      {
        "type": "paragraph",
        "content": [
          "要解决前面的问题，使用 Hermes Agent 原生的修复机制即可完成，棘手的地方是需要在 Hermes Agent 的运行环境中发起这个修复流程。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "DSH 与 Hermes Agent 运行在同一个环境下，它能够接触 Hermes 的进程、日志、配置和文件，当然也可以执行命令。所以我们可以直接把修复任务交给它。"
        ]
      },
      {
        "type": "heading",
        "text": "具体怎么做？"
      },
      {
        "type": "paragraph",
        "content": [
          "你可以参考上一篇推文，先在 LightVela 中安装并配置好 DSH："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          {
            "type": "link",
            "label": "别再让Agent单干了！我让Hermes和DSH组队后，效率提升了10倍",
            "href": "/blog/hermes-deepseek-harness-10x-efficiency"
          }
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-03.webp",
        "alt": "LightVela 中已经安装并配置的 DeepSeek Harness"
      },
      {
        "type": "paragraph",
        "content": [
          "注意，这里让 DSH 解决问题时，需要确保在 /home/agentuser/ 这个目录中。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-04.webp",
        "alt": "将 DSH 工作目录设置为 home agentuser"
      },
      {
        "type": "paragraph",
        "content": [
          "这里有一步可选的增强配置，就是先给 DSH 一本 Hermes Agent 的操作手册，这样可以省去很多 DSH 自己挖掘 Hermes Agent 如何配置的过程。如果需要安装的话，在 DSH 的对话框中输入以下内容即可："
        ]
      },
      {
        "type": "code",
        "content": "请根据 https://skillhub.cn/install/skillhub.md，安装 @user_70854421/hermes-agent-skill-for-dsh。"
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-05.webp",
        "alt": "在 DSH 中安装 Hermes Agent 操作技能"
      },
      {
        "type": "paragraph",
        "content": [
          "安装完成之后，先让它来做第一步："
        ]
      },
      {
        "type": "code",
        "content": "你当前的运行环境中，存在一个 Hermes Agent，你先找到它的安装位置，我需要你帮我参考刚刚安装的技能，排查并解决一个问题。"
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-06.webp",
        "alt": "让 DSH 查找 Hermes Agent 安装位置并开始排查"
      },
      {
        "type": "paragraph",
        "content": [
          "当然，如果你想要稍微稳一点，可以这样告诉它："
        ]
      },
      {
        "type": "code",
        "content": "你当前的运行环境中，存在一个 Hermes Agent，你先找到它的安装位置，我需要你帮我参考刚刚安装的技能，排查并解决我的问题：\n{在这里描述你的问题}。\n\n你先帮我排查问题原因，然后设计修复方案，先不要执行。"
      },
      {
        "type": "paragraph",
        "content": [
          "等它告诉你实际的修复方案，如果拿不准可以在交流群里问问群友（文末扫码可以加入）。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "我这里进行得比较顺利，我的 DSH 在查找 Hermes Agent 之后就已经发现了 state.db 损坏的问题，并且已经规划出了修复的方案及步骤，然后继续开干了："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-07.webp",
        "alt": "DSH 识别 state db 损坏并规划修复步骤"
      },
      {
        "type": "paragraph",
        "content": [
          "并且在数分钟内已经最终修复完了："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-08.webp",
        "alt": "DSH 完成 Hermes Agent 状态数据库修复"
      },
      {
        "type": "paragraph",
        "content": [
          "Token 消耗的情况大概是，全程消耗了 2.6M Token（输入）、31.3K Token（输出），缓存命中率 97%（非常高的水平了），这里我用的是DeepSeek-V4 Flash，所以最后大概只花了 0.25 元左右，相比于找其他大佬或者自己死磕，成本是非常低的。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "当然，最后我们还是要回到 Hermes Agent 的对话窗口内，来确定问题是否真的修复："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/dsh-revived-broken-hermes-agent/source-09.webp",
        "alt": "回到 Hermes Agent 对话窗口验证修复结果"
      }
    ],
    "author": "Walker Cao",
    "category": "use-case",
    "publishedAt": "2026-09-28T16:28:57+08:00"
  },
  {
    "slug": "hermes-dsh-pelican-cup",
    "language": "zh-CN",
    "title": "我的两个 Agent，结伴参与了“鹈鹕杯”",
    "excerpt": "我在 LightVela 中让 Hermes Agent 与 DSH 组队，生成并提交鹈鹕骑自行车的动画作品。",
    "coverImage": "/assets/blog/hermes-dsh-pelican-cup/cover-source.webp",
    "content": [
      {
        "type": "image",
        "src": "/assets/blog/hermes-dsh-pelican-cup/cover-source.webp",
        "alt": "Hermes Agent 与 DSH 共同制作鹈鹕作品"
      },
      {
        "type": "paragraph",
        "content": [
          "图源：Codex 生成"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "鹈鹕测试最初是由社区开发者针对可能存在的大模型“降智”问题，提出的一个非正式模型能力测试方法，核心任务是让 Agent 纯靠代码来画出一只正在骑自行车的鹈鹕，以最终实现的细节来判定大模型是否被“降智”。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "在 OpenAI 发布 GPT-6 Astra 之后，鹈鹕测试最近又火起来了，更有开发者在社区里发起了鹈鹕杯比赛，被各大科技媒体争相报道。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "不过看了一圈好像也没有教大家怎么样具体参与，于是想到了前几天在 LightVela 里给 Hermes Agent 和 DSH 组了个队，在这个用代码参加比赛的场景下更合适。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "如果你也想按照我的思路参加鹈鹕杯，不妨先参考这篇推文，来组起这个队伍来："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          {
            "type": "link",
            "label": "别再让Agent单干了！我让Hermes和DSH组队后，效率提升了10倍",
            "href": "/blog/hermes-deepseek-harness-10x-efficiency"
          }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "当然，如果你嫌麻烦，只在 LightVela 里创建一个 Hermes Agent，然后跟它对话来参与也完全 OK。"
        ]
      },
      {
        "type": "heading",
        "text": "准备工作"
      },
      {
        "type": "paragraph",
        "content": [
          "你在这里，你可以先安装我的skill，我把LightVela参与鹈鹕杯提交作品的过程整理成了一个skill，方便大家使用，把下面的话发给自己的 Agent 就行："
        ]
      },
      {
        "type": "code",
        "content": "请根据 https://skillhub.cn/install/skillhub.md，安装 @user_70854421/pelican-cup-for-vela。"
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-dsh-pelican-cup/source-02.webp",
        "alt": "Hermes Agent 正在安装 Pelican Cup For Vela 技能"
      },
      {
        "type": "paragraph",
        "content": [
          "当然，这里为了确保比赛的公平性，本身SVG的打磨还是由模型自己来决断，技能中就没有包含这部分了。"
        ]
      },
      {
        "type": "heading",
        "text": "关键一步"
      },
      {
        "type": "paragraph",
        "content": [
          "其实我的提示词很简单，完全让模型发挥自己的水准和审美："
        ]
      },
      {
        "type": "code",
        "content": "调用 DSH 创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画（可基于题面自由创作、多轮打磨，满意后由你使用Pelican Cup For Vela这个技能，来帮我提交到https://codexradar.com/cup/）"
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-dsh-pelican-cup/source-03.webp",
        "alt": "Hermes Agent 调用 DSH 创建鹈鹕骑自行车动画"
      },
      {
        "type": "paragraph",
        "content": [
          "在它俩精妙的配合下，大概用了 20 分钟左右，花了 5 块钱左右的 Token，一共打磨两轮之后，提交了作品。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-dsh-pelican-cup/source-04.webp",
        "alt": "Hermes Agent 完成鹈鹕杯作品提交、打磨与部署"
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-dsh-pelican-cup/source-05.webp",
        "alt": "鹈鹕杯作品提交成功后生成的参赛凭证"
      },
      {
        "type": "paragraph",
        "content": [
          "emm 并没有我想象得那么好，但距离网络上的一些大师作品还是相去甚远，看来我有必要以后换更好的模型了哈哈。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "我的作品：",
          {
            "type": "link",
            "label": "https://ws-870756eab22a4c27.lightvela.site/",
            "href": "https://ws-870756eab22a4c27.lightvela.site/"
          }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "为了方便大家真实地感受我的参赛作品，我在 LightVela 上也把它发布出来了，可以通过域名来访问。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "要实现起来也很简单，给你的 Agent 发送以下内容即可 Get 同款："
        ]
      },
      {
        "type": "code",
        "content": "使用 website-builder Skill 帮我部署下刚刚这个鹈鹕的 HTML。"
      },
      {
        "type": "paragraph",
        "content": [
          "不得不说这就是云端的好处之一，有一些前端生成的小项目，随时随地就能放在云上让大家都来访问。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "不过需要提醒大家，如果大家是 LightVela 国内版，那么这个链接是只有你自己可以访问的，dddd。"
        ]
      },
      {
        "type": "heading",
        "text": "奇思妙想"
      },
      {
        "type": "paragraph",
        "content": [
          "鹈鹕测试的初衷是为了长期观测对比模型的生成效果，社区中有玩家甚至会每天生成一份留存下来，然后看哪天的效果会有明显的波动，则证明模型的智慧在这天受到了影响。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "那我是不是可以创建一个定时任务，让我的 Agent 小分队每天都生成一次，过一段时间没准就能窥见一斑我日常用的模型水平究竟怎么样了。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "先埋个坑，过段时间发出来看看效果。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-dsh-pelican-cup/source-06.webp",
        "alt": "GPT-6 与 GPT-5.6 不同推理强度下的 SVG 鹈鹕生成效果对比"
      },
      {
        "type": "paragraph",
        "content": [
          "图源社区，侵删"
        ]
      }
    ],
    "author": "Walker Cao",
    "category": "use-case",
    "publishedAt": "2026-09-28T16:28:57+08:00"
  },
  {
    "slug": "hermes-deepseek-harness-10x-efficiency",
    "language": "zh-CN",
    "title": "别再让Agent单干了！我让Hermes和DSH组队后，效率提升了10倍",
    "excerpt": "结对编程让一个人写代码、另一个人审阅，从而提升设计质量。我尝试把同样的协作方式用在 Agent 身上。",
    "coverImage": "/assets/blog/hermes-deepseek-harness-10x-efficiency/cover-supplied.webp",
    "content": [
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/cover-supplied.webp",
        "alt": "两位协作者在同一台电脑前结对编程"
      },
      {
        "type": "paragraph",
        "content": [
          "刚开始学习软件工程的时候，课本中的概念告诉我们结对编程相比于程序员独立工作，往往能够提升设计的质量，以写出更好的程序。在结对编程中，输入代码的人一般被称作驾驶员，审查代码的人被称作观察员。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-01.webp",
        "alt": "结对编程"
      },
      {
        "type": "paragraph",
        "content": [
          "图源：Codex生成"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "这种协作模式在拉力比赛中同样存在，每辆赛车内有一名驾驶员和一名领航员，相互配合，并且基于路书来完成复杂赛道的导航。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-02.webp",
        "alt": "拉力赛车中的领航员与驾驶员"
      },
      {
        "type": "paragraph",
        "content": [
          "图源：Codex生成"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "结对编程和拉力赛展现了相似的协作思路：让一个角色专注眼前执行，另一个角色持续观察全局、预判下一步并及时纠偏；双方共享现场、持续同步，从而降低复杂任务中的认知负担与失误成本。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "沿着这个思路，当 Hermes Agent 和 DeepSeek Harness能够在 LightVela 的同一任务环境中共享上下文、分工协作并交接控制时，Agent 也可以形成类似的双角色配合。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "LightVela 现已提供了在同一云端环境下同时运行 Hermes Agent 和 DeepSeek Harness （后文简写为DSH）的能力，以期探索上述的协作模式："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "Hermes Agent 的明显优势是“持续理解一个人和一件事”。它可以保留用户偏好与项目知识，通过 Skills 沉淀工作方法，并能够从聊天通道中持续接收任务。相较而言 Hermes Agent 适合扮演“领航员”的角色。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "DSH 的明显特点是对具体的工作区负责，并在此基础上可以读取和修改文件、修改文件、运行测试、处理异常等等，那么它更适合作为“驾驶员”的角色。"
        ]
      },
      {
        "type": "heading",
        "text": "如何实现：准备工作"
      },
      {
        "type": "paragraph",
        "content": [
          "先叠个甲，实现协作需要安装一个技能和工具来完成，属于一种探索型的方案，适用于 AI 时代的探险家们，愿意折腾的可以玩玩，成熟的产品方案还在设计当中。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "如果你接着往下看，那么我认为你会想要试试它的效果，不过丑话说在前面，因为 AI 本身的不确定性，所以即使从头到尾做完了，还是有概率不成功，这个时候善于让自己的 AI 来解决就好了，你也是协作的一份子～"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "首先你需要在 LightVela 中首先建一个自己的 Agent，不过不需要担心有太高的门槛，中国站支持微信/QQ/手机登录，国际站支持Google邮箱和GitHub登录，并且拥有免费的体验期，可以无痛上手。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "这里个人推荐直接选 4500 积分的版本，亲测很耐蹬。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-03.webp",
        "alt": "LightVela 套餐选择页面"
      },
      {
        "type": "paragraph",
        "content": [
          "订阅完成后，来到探索页面，可以看到 DeepSeek Harness 的入口，进入页面后直接安装即可。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-04.webp",
        "alt": "LightVela 探索页中的 DeepSeek Harness 安装入口"
      },
      {
        "type": "paragraph",
        "content": [
          "安装过程大概1-3分钟，实测很快，大概1分钟左右："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-05.webp",
        "alt": "DeepSeek Harness 安装进度"
      },
      {
        "type": "paragraph",
        "content": [
          "安装完成后，可以在同一页面内给 DSH 配置模型、访问 WebUI 等："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "编者按：这里的产品体验还不足够好，需要给 DSH 配置自己的模型，目前我们还没找到太优雅的方案能够同步模型配置，亟待优化。"
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-06.webp",
        "alt": "DeepSeek Harness 模型配置与 WebUI 入口"
      },
      {
        "type": "paragraph",
        "content": [
          "这里我就直接配 DeepSeek 的官方模型了，新出的 DeepSeek V4.1 Flash，原生支持多模态，成本也还 OK ，很不错，具体方法不赘述，链接贴这儿了："
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "DeepSeek API Platform：",
          {
            "type": "link",
            "label": "https://platform.deepseek.com/api_keys",
            "href": "https://platform.deepseek.com/api_keys"
          }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "如果想配置更多模型的话，也可以直接去 WebUI 里配置，也很简单。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "访问 WebUI，这里的地址也不需要担心别人拿到了可以访问，我们给大家分配了一个专属的域名，然后也做了一层鉴权，只有你自己能用："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-07.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "heading",
        "text": "如何实现：关键一步"
      },
      {
        "type": "paragraph",
        "content": [
          "简单来说，这一步是要安装一个技能，安装动作会完成两件事情：把 DSH 注册为一个 Hermes Agent 的工具、告诉 Hermes Agent 如何调用 DSH。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "这个方案只是目前基于 Hermes Agent 已有机制的设想之一，技能和工具是我自己 Vibe 出来的，如果有可用性相关的问题，或者有更好的方案建议，欢迎加入 LightVela 的交流群一起探讨。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "将以下这段话复制并发给 LightVela 里的 Hermes Agent，即可完成初始化："
        ]
      },
      {
        "type": "code",
        "content": "请根据 https://skillhub.cn/install/skillhub.md，安装 @user_70854421/dsh-pilot。"
      },
      {
        "type": "paragraph",
        "content": [
          "如果你懒得配聊天通道，那也可以在“对话”页面直接发送给 Hermes Agent："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-08.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "paragraph",
        "content": [
          "安装完成后的效果大致如下，一般会需要检查一下 DSH 的状态，Agent 问的话回复确认或者需要就行："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-09.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "paragraph",
        "content": [
          "然后注册完成后，还需要让 Hermes Agent 把新注册的工具设置为可用状态："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-10.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "paragraph",
        "content": [
          "开启完成后 Agent 也会告诉你："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-11.webp",
        "alt": "别再让Agent单干了！我让Hermes和DSH组队后，效率提升了10倍：步骤截图 11"
      },
      {
        "type": "heading",
        "text": "如何使用：各显其能"
      },
      {
        "type": "paragraph",
        "content": [
          "个人建议可以搭配 LightVela 里的工作台使用。工作台提供了一个静态网页托管的能力，支持把 Agent 生成的项目直接部署在云端，后续也会拓展部署后端服务的能力。"
        ]
      },
      {
        "type": "paragraph",
        "content": [
          "这里仅作简单演示，你可以尝试把下面的话复制并发给你的 Hermes Agent："
        ]
      },
      {
        "type": "code",
        "content": "使用刚刚安装的技能，帮我实现一个简单的静态博客页面，你来设计方案，由 DeepSeek Harness 完成代码编写，然后由你来审阅。\n\n实现完成后，使用 website-builder Skill 进行部署。"
      },
      {
        "type": "paragraph",
        "content": [
          "按正常的情况，它俩开始协作的效果类似这样："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-12.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "paragraph",
        "content": [
          "成功完成一次任务后应该是这样的："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-13.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "paragraph",
        "content": [
          "它当然是可以访问的，只是略显简陋："
        ]
      },
      {
        "type": "image",
        "src": "/assets/blog/hermes-deepseek-harness-10x-efficiency/source-14.webp",
        "alt": "DeepSeek Harness Personal Site 鉴权确认页"
      },
      {
        "type": "paragraph",
        "content": [
          "更多的场景玩法就留给大家来探索吧，本文仅作为思路上的抛砖引玉。"
        ]
      }
    ],
    "author": "Walker Cao",
    "category": "use-case",
    "publishedAt": "2026-09-28T16:28:57+08:00"
  }
];

export function getBlogPosts(locale: BlogLocale = isGlobal ? "en-US" : "zh-CN"): readonly BlogPost[] {
  return BLOG_POSTS.map((post) => localizeBlogPost(post, locale));
}

export function getBlogPost(slug: string, locale: BlogLocale = isGlobal ? "en-US" : "zh-CN"): BlogPost | undefined {
  const post = BLOG_POSTS.find((candidate) => candidate.slug === slug);
  return post ? localizeBlogPost(post, locale) : undefined;
}

export function formatBlogPublishedAt(publishedAt: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(publishedAt));
}

export function formatBlogPublishedDate(publishedAt: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date(publishedAt));
}

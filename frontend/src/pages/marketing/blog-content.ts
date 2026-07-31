/**
 * Blog（科普）内容数据源
 *
 * 设计原则：
 * - 与 changelog 保持一致的数据驱动风格：文章元信息 + 分节内容全部在 TS 常量里。
 * - 三语言并列（zh-CN 简中 / zh-SG 繁中 / en-US 英文），运行时按 PublicSiteLocale 选一份。
 * - 单向可扩展：未来增加新分类只需向 BLOG_CATEGORIES / BLOG_ARTICLES 追加条目。
 * - 内容主要为 Hermes Agent 机制拆解科普，同时软性关联 LightVela 能力。
 */
import type { PublicSiteLocale } from "@/lib/public-site-navigation";

/* ─────────────────────────────────────────────────────────────
 * 基础类型
 * ───────────────────────────────────────────────────────────── */

export type BlogLocaleText = Record<PublicSiteLocale, string>;

/**
 * 文章内的一节。
 * - heading：段落小标题（可选）；
 * - paragraphs：正文段落（简单文本；富格式保留后续扩展空间）。
 */
export type BlogSection = {
  heading?: BlogLocaleText;
  paragraphs: readonly BlogLocaleText[];
};

export type BlogArticle = {
  /** slug 用于 /blog/[slug] 路由，语言无关。 */
  slug: string;
  /** 分类 id（对应 BLOG_CATEGORIES 中的一项）。 */
  categoryId: string;
  /** 发布日期，YYYY-MM-DD。 */
  date: string;
  title: BlogLocaleText;
  summary: BlogLocaleText;
  sections: readonly BlogSection[];
};

export type BlogCategory = {
  id: string;
  label: BlogLocaleText;
  description: BlogLocaleText;
};

/* ─────────────────────────────────────────────────────────────
 * 分类列表
 * ───────────────────────────────────────────────────────────── */

export const BLOG_CATEGORIES: readonly BlogCategory[] = [
  {
    id: "hermes-explainer",
    label: {
      "zh-CN": "Hermes 科普",
      "zh-SG": "Hermes 科普",
      "en-US": "Hermes Explainer",
    },
    description: {
      "zh-CN": "拆解 Hermes Agent 的记忆、技能与人格机制，看清下一代 Agent 是怎么被造出来的。",
      "zh-SG": "拆解 Hermes Agent 的记忆、技能与人格机制，看清下一代 Agent 是怎么被造出来的。",
      "en-US":
        "Break down how Hermes Agent's memory, skills, and persona actually work — and how the next generation of agents is being built.",
    },
  },
];

export function getBlogCategoryById(id: string): BlogCategory | undefined {
  return BLOG_CATEGORIES.find((c) => c.id === id);
}

/* ─────────────────────────────────────────────────────────────
 * 文章列表
 *
 * 每篇文章按 sections 分节，方便渲染层用统一样式。
 * 若某种语言暂时缺失文案，请显式回填，不要让运行时出现空字符串。
 * ───────────────────────────────────────────────────────────── */

/** 用于把长段中文（简）转成一份"占位繁体"。当前简繁差异极小，
 *  我们采用与简中相同的正文，仅在标题/关键术语层面做少量繁体化处理。
 *  这样能同时保证三语言路由都能渲染，未来再单独精修繁体版。 */

export const BLOG_ARTICLES: readonly BlogArticle[] = [
  {
    slug: "hermes-vs-openclaw",
    categoryId: "hermes-explainer",
    date: "2026-07-30",
    title: {
      "zh-CN": "Hermes Agent 与 OpenClaw 有什么不同？",
      "zh-SG": "Hermes Agent 與 OpenClaw 有什麼不同？",
      "en-US": "How Is Hermes Agent Different From OpenClaw?",
    },
    summary: {
      "zh-CN":
        "从架构定位、记忆机制、可扩展性和工程落地四个维度，拆解 Hermes Agent 与 OpenClaw 的核心差异，并聊聊它们分别适合什么样的场景。",
      "zh-SG":
        "從架構定位、記憶機制、可擴展性與工程落地四個維度，拆解 Hermes Agent 與 OpenClaw 的核心差異，並聊聊它們分別適合什麼樣的場景。",
      "en-US":
        "Compare Hermes Agent and OpenClaw across four dimensions — positioning, memory, extensibility, and engineering — and see which one fits which scenario.",
    },
    sections: [
      {
        paragraphs: [
          {
            "zh-CN":
              "如果你最近关注 AI Agent 领域，一定听过两个名字：Hermes Agent 和 OpenClaw。它们经常被放在一起比较，但很多人其实并不清楚——这俩到底是不是一个赛道的东西？",
            "zh-SG":
              "如果你最近關注 AI Agent 領域，一定聽過兩個名字：Hermes Agent 和 OpenClaw。它們經常被放在一起比較，但很多人其實並不清楚——這倆到底是不是一個賽道的東西？",
            "en-US":
              "If you've been following the AI agent space, you've almost certainly heard two names: Hermes Agent and OpenClaw. They're often compared side by side — but most people never really answer the underlying question: are they even the same kind of thing?",
          },
          {
            "zh-CN":
              "先给一个不严谨但足够直观的类比：OpenClaw 更像一台开箱即用的工作站——它擅长在单次任务里把事情做完；Hermes Agent 更像一位会成长的搭档——它不仅能干活，还会记住你是谁、你在做什么、你偏好什么，跨越会话持续演化。",
            "zh-SG":
              "先給一個不嚴謹但足夠直觀的類比：OpenClaw 更像一台開箱即用的工作站——它擅長在單次任務裡把事情做完；Hermes Agent 更像一位會成長的夥伴——它不僅能幹活，還會記住你是誰、你在做什麼、你偏好什麼，跨越會話持續演化。",
            "en-US":
              "A rough but useful analogy: OpenClaw is more like a ready-to-use workstation — it's built to finish a single task well. Hermes Agent is more like a partner that grows — it not only does the work, it remembers who you are, what you're working on, and what you prefer, evolving across sessions.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "一、架构定位：任务型 vs 陪伴型",
          "zh-SG": "一、架構定位：任務型 vs 陪伴型",
          "en-US": "1. Positioning: task-driven vs companion",
        },
        paragraphs: [
          {
            "zh-CN":
              "OpenClaw 的核心叙事是通用编码 Agent：给它一个仓库和目标，它会自己规划、调用工具、写文件、跑测试，任务结束基本 reset。",
            "zh-SG":
              "OpenClaw 的核心敘事是通用編碼 Agent：給它一個倉庫與目標，它會自己規劃、呼叫工具、寫檔、跑測試，任務結束基本 reset。",
            "en-US":
              "OpenClaw's core narrative is being a general-purpose coding agent: give it a repo and a goal, and it plans, calls tools, writes files, and runs tests — then largely resets when the task ends.",
          },
          {
            "zh-CN":
              "Hermes Agent 则明确要构建一个具备长期记忆和人格的通用 Agent。它在 CLI 之上多做了两件事：稳定的自我描述（SOUL.md），以及稳定的用户建模（USER.md）。",
            "zh-SG":
              "Hermes Agent 則明確要建立一個具備長期記憶與人格的通用 Agent。它在 CLI 之上多做了兩件事：穩定的自我描述（SOUL.md），以及穩定的使用者建模（USER.md）。",
            "en-US":
              "Hermes Agent explicitly aims to be a general-purpose agent with long-term memory and persona. On top of a CLI, it adds two things: a stable self-description (SOUL.md) and a stable user model (USER.md).",
          },
          {
            "zh-CN":
              "一句话：OpenClaw 优化的是这次任务能不能做好，Hermes 优化的是这个 Agent 能不能长期陪你把事做好。",
            "zh-SG":
              "一句話：OpenClaw 最佳化的是這次任務能不能做好，Hermes 最佳化的是這個 Agent 能不能長期陪你把事做好。",
            "en-US":
              "In one line: OpenClaw optimizes whether this task gets done well; Hermes optimizes whether the agent can keep helping you well over time.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "二、记忆机制：短上下文 vs 持久记忆",
          "zh-SG": "二、記憶機制：短上下文 vs 持久記憶",
          "en-US": "2. Memory: short context vs persistent memory",
        },
        paragraphs: [
          {
            "zh-CN":
              "OpenClaw 走的是当下主流的路线：大上下文 + RAG。当前任务需要什么就塞什么，跨任务的东西大多要用户自己粘贴，或者靠外部记忆插件。",
            "zh-SG":
              "OpenClaw 走的是當下主流的路線：大上下文 + RAG。當前任務需要什麼就塞什麼，跨任務的東西大多要使用者自己貼上，或者靠外部記憶外掛。",
            "en-US":
              "OpenClaw follows today's mainstream approach: a big context window plus RAG. Whatever the current task needs is stuffed into context, and cross-task recall mostly relies on the user pasting things back in or on external memory add-ons.",
          },
          {
            "zh-CN":
              "Hermes Agent 把长期记忆做成一等公民：记忆分为事实性、用户画像、程序性技能等多种类型，分别落到不同文件与索引；写入由 Agent 在 compression / checkpoint / 显式指令等时机主动组织；召回同时结合结构化文件 + 全文索引（FTS5）+ LLM 摘要；还引入 Honcho 这类关系型用户建模组件专门抽取用户画像。",
            "zh-SG":
              "Hermes Agent 把長期記憶做成一等公民：記憶分為事實性、使用者畫像、程序性技能等多種類型，分別落到不同檔案與索引；寫入由 Agent 在 compression / checkpoint / 顯式指令等時機主動組織；召回同時結合結構化檔案 + 全文索引（FTS5）+ LLM 摘要；還引入 Honcho 這類關係型使用者建模元件專門抽取使用者畫像。",
            "en-US":
              "Hermes Agent treats long-term memory as a first-class concern: memories are split into factual notes, user profile, and procedural skills, stored in different files and indexes; writes are curated by the agent at compression, checkpoints, or explicit instructions; recall combines structured files, full-text search (FTS5), and LLM summarization; and a component like Honcho performs dialectic user modeling to keep the user profile sharp.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "三、可扩展性：工具 vs 技能",
          "zh-SG": "三、可擴展性：工具 vs 技能",
          "en-US": "3. Extensibility: tools vs skills",
        },
        paragraphs: [
          {
            "zh-CN":
              "OpenClaw 的扩展模型主要围绕工具（Tools）：加 MCP、加命令、加内置能力。Hermes Agent 在工具之外还有一层关键抽象——Skills（技能）。Skill 是一段程序性记忆：不是我记住了这个事实，而是我记住了做这件事的标准流程。当 Agent 遇到匹配场景时，Skill 会被自动装载为高优先级 prompt。",
            "zh-SG":
              "OpenClaw 的擴展模型主要圍繞工具（Tools）：加 MCP、加命令、加內建能力。Hermes Agent 在工具之外還有一層關鍵抽象——Skills（技能）。Skill 是一段程序性記憶：不是我記住了這個事實，而是我記住了做這件事的標準流程。當 Agent 遇到匹配場景時，Skill 會被自動裝載為高優先級 prompt。",
            "en-US":
              "OpenClaw's extension story revolves around tools: add an MCP, add a command, add a built-in capability. Hermes Agent adds another layer on top of tools — Skills. A skill is procedural memory: not \"I remember this fact\" but \"I remember the standard procedure for doing this.\" When the agent sees a matching situation, the skill is auto-loaded as a high-priority prompt.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "四、工程落地：单机 CLI vs Agent 平台雏形",
          "zh-SG": "四、工程落地：單機 CLI vs Agent 平台雛形",
          "en-US": "4. Engineering shape: single-user CLI vs agent platform in the making",
        },
        paragraphs: [
          {
            "zh-CN":
              "OpenClaw 主要形态是通用编码 CLI，上下文单位是单次任务，扩展方式是 Tools / MCP，用户建模较弱；Hermes Agent 是通用 Agent 运行时（CLI + 长期记忆 + 技能），上下文单位是跨会话的用户 & Agent，扩展方式是 Tools + Skills，用户建模强（USER.md + Honcho）。",
            "zh-SG":
              "OpenClaw 主要形態是通用編碼 CLI，上下文單位是單次任務，擴展方式是 Tools / MCP，使用者建模較弱；Hermes Agent 是通用 Agent 執行時（CLI + 長期記憶 + 技能），上下文單位是跨會話的使用者 & Agent，擴展方式是 Tools + Skills，使用者建模強（USER.md + Honcho）。",
            "en-US":
              "OpenClaw is primarily a general coding CLI with tasks as the context unit and tools/MCPs as the extension surface — user modeling is weak. Hermes Agent is a general agent runtime (CLI + long-term memory + skills) whose context unit is the (user, agent) pair across sessions, extended via tools AND skills, with strong user modeling (USER.md + Honcho).",
          },
          {
            "zh-CN":
              "一句话总结：OpenClaw 让 AI 会干活，Hermes Agent 让 AI 会成长。",
            "zh-SG":
              "一句話總結：OpenClaw 讓 AI 會幹活，Hermes Agent 讓 AI 會成長。",
            "en-US":
              "In one line: OpenClaw makes AI capable of doing work; Hermes Agent makes AI capable of growing.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "从 Hermes 反观：LightVela 在做什么？",
          "zh-SG": "從 Hermes 反觀：LightVela 在做什麼？",
          "en-US": "Looking back through Hermes: what is LightVela building?",
        },
        paragraphs: [
          {
            "zh-CN":
              "长期记忆 + 技能沉淀这条路线，并不是 Hermes 独有。LightVela 内部构建的 Agent 体系走的正是能成长的搭档这一方向：同样把用户画像与事实记忆分层，一方沉淀你是谁，一方沉淀我们一起做过什么；同样区分知识（memory）与流程（skill），知识可查可引用，流程可复用可版本化；并在此之上把能力产品化——让个人和团队都能低门槛训练自己的 Agent，而不是只停留在开发者 CLI。",
            "zh-SG":
              "長期記憶 + 技能沉澱這條路線，並非 Hermes 獨有。LightVela 內部建構的 Agent 體系走的正是能成長的夥伴這一方向：同樣把使用者畫像與事實記憶分層，一方沉澱你是誰，一方沉澱我們一起做過什麼；同樣區分知識（memory）與流程（skill），知識可查可引用，流程可複用可版本化；並在此之上把能力產品化——讓個人與團隊都能低門檻訓練自己的 Agent，而不是只停留在開發者 CLI。",
            "en-US":
              "The \"long-term memory plus skill accumulation\" route is not unique to Hermes. LightVela's agent stack takes the same \"grow-with-you companion\" direction: split user profile from factual memories (one captures \"who you are,\" the other captures \"what we've done together\"), separate knowledge (memory) from procedure (skill), and then productize the whole thing so that individuals and teams can train their own agents without living inside a developer CLI.",
          },
          {
            "zh-CN":
              "Hermes Agent 给了我们一个很好的参考：一个真正好用的 Agent，不能只有聪明的当下，还必须有稳定的长期。LightVela 想做的，正是把这份长期做成每个人都用得起来的产品体验。",
            "zh-SG":
              "Hermes Agent 給了我們一個很好的參考：一個真正好用的 Agent，不能只有聰明的當下，還必須有穩定的長期。LightVela 想做的，正是把這份長期做成每個人都用得起來的產品體驗。",
            "en-US":
              "Hermes Agent gives us a great reference point: a genuinely useful agent cannot just be \"smart in the moment,\" it must also be \"stable over the long run.\" LightVela's ambition is to turn that \"long run\" into a product experience everyone can actually use.",
          },
        ],
      },
    ],
  },

  {
    slug: "why-hermes-remembers-you",
    categoryId: "hermes-explainer",
    date: "2026-07-30",
    title: {
      "zh-CN": "Hermes Agent 为什么能\"记住你\"？拆解长期记忆系统的工作原理",
      "zh-SG": "Hermes Agent 為什麼能「記住你」？拆解長期記憶系統的運作原理",
      "en-US": "Why Hermes Agent Actually Remembers You — Inside the Long-Term Memory System",
    },
    summary: {
      "zh-CN":
        "从写入触发、存储分层、召回策略到用户建模，一步步拆解 Hermes Agent 长期记忆系统的运作机制，看它到底是怎么\"记住你\"的。",
      "zh-SG":
        "從寫入觸發、儲存分層、召回策略到使用者建模，一步步拆解 Hermes Agent 長期記憶系統的運作機制，看它到底是怎麼「記住你」的。",
      "en-US":
        "From write triggers and layered storage to hybrid recall and user modeling, walk through exactly how Hermes Agent's long-term memory actually \"remembers you.\"",
    },
    sections: [
      {
        paragraphs: [
          {
            "zh-CN":
              "大部分 AI 助手让人失望的第一个瞬间，往往不是它答错了什么，而是——你上次不是刚跟我说过吗？上下文窗口越来越大，但记住你这件事，从来不是靠塞更多 token 能解决的。",
            "zh-SG":
              "大部分 AI 助手讓人失望的第一個瞬間，往往不是它答錯了什麼，而是——你上次不是剛跟我說過嗎？上下文視窗越來越大，但記住你這件事，從來不是靠塞更多 token 能解決的。",
            "en-US":
              "The first disappointing moment most people experience with an AI assistant isn't a wrong answer — it's the follow-up question: \"Didn't I just tell you this last time?\" Context windows keep growing, but genuinely remembering you was never a token problem.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "一、什么叫\"记住\"？",
          "zh-SG": "一、什麼叫「記住」？",
          "en-US": "1. What does \"remember\" actually mean?",
        },
        paragraphs: [
          {
            "zh-CN":
              "在人类语境里，记住你至少包含三层意思：知道你是谁（名字、职业、偏好、常用工具链）；知道我们一起做过什么（之前聊过的项目、给过的结论、踩过的坑）；知道该怎么和你打交道（喜欢简短还是详细、先结论还是先过程）。",
            "zh-SG":
              "在人類語境裡，記住你至少包含三層意思：知道你是誰（姓名、職業、偏好、常用工具鏈）；知道我們一起做過什麼（之前聊過的專案、給過的結論、踩過的坑）；知道該怎麼和你打交道（喜歡簡短還是詳細、先結論還是先過程）。",
            "en-US":
              "In everyday terms, \"remembering you\" contains at least three layers: knowing who you are (name, role, preferences, common tooling); knowing what we've done together (past projects, decisions we've made, mistakes we've hit); and knowing how to work with you (concise vs detailed, conclusion-first vs analysis-first).",
          },
          {
            "zh-CN":
              "一个只有大上下文窗口的模型，能在一次对话内同时做到这三点；但只要会话一断，第 1、3 点就重置了。Hermes 的思路是：把这三层分别落到不同的持久层里，各自用最合适的方式维护。",
            "zh-SG":
              "一個只有大上下文視窗的模型，能在一次對話內同時做到這三點；但只要會話一斷，第 1、3 點就重置了。Hermes 的思路是：把這三層分別落到不同的持久層裡，各自用最合適的方式維護。",
            "en-US":
              "A big-context model can pull off all three inside a single conversation, but the moment the session ends, points 1 and 3 reset. Hermes's approach is to persist each layer separately, using whatever mechanism fits best.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "二、写入：记忆不是\"随手记\"",
          "zh-SG": "二、寫入：記憶不是「隨手記」",
          "en-US": "2. Writes: memory is curated, not logged",
        },
        paragraphs: [
          {
            "zh-CN":
              "Hermes 的长期记忆不是每说一句话就记一条，而是由 Agent 在几个明确时机主动组织并落盘：Compression（上下文接近上限时抽取值得保留的信息）、Checkpoint（关键节点主动记一次）、Nudges（周期性提示 Agent 复盘）、以及用户显式指令。关键在于：决定是否写入长期记忆的是 Agent 自己，而不是全量落盘——这一步过滤，正是记忆质量的第一道闸门。",
            "zh-SG":
              "Hermes 的長期記憶不是每說一句話就記一條，而是由 Agent 在幾個明確時機主動組織並落盤：Compression（上下文接近上限時抽取值得保留的資訊）、Checkpoint（關鍵節點主動記一次）、Nudges（週期性提示 Agent 複盤）、以及使用者明確指令。關鍵在於：決定是否寫入長期記憶的是 Agent 自己，而不是全量落盤——這一步過濾，正是記憶品質的第一道閘門。",
            "en-US":
              "Hermes doesn't persist every utterance. The agent curates memory at a few well-defined moments: compression (extract what's worth keeping when the window fills up), checkpoints (snapshot at meaningful moments), nudges (periodic prompts to reflect), and explicit user instructions. Crucially, the agent — not blind logging — decides what gets written down. That filter is the first gate for memory quality.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "三、存储：多种记忆，分层落地",
          "zh-SG": "三、儲存：多種記憶，分層落地",
          "en-US": "3. Storage: multiple memory types, in separate layers",
        },
        paragraphs: [
          {
            "zh-CN":
              "Hermes 把长期记忆拆成几种：USER.md 存结构化的用户画像；MEMORY.md / memories/ 存事实性记忆；skills/ 存程序性记忆（做事的流程模板）；SOUL.md 存 Agent 自己的\"人格描述\"。所有这些之外，还维护全文索引（FTS5），让所有历史记忆可按关键词精确召回。",
            "zh-SG":
              "Hermes 把長期記憶拆成幾種：USER.md 存結構化的使用者畫像；MEMORY.md / memories/ 存事實性記憶；skills/ 存程序性記憶（做事的流程模板）；SOUL.md 存 Agent 自己的「人格描述」。所有這些之外，還維護全文索引（FTS5），讓所有歷史記憶可依關鍵字精確召回。",
            "en-US":
              "Hermes splits long-term memory into several kinds: USER.md holds the structured user profile; MEMORY.md / memories/ hold factual memories; skills/ hold procedural memories (procedures for how to do things); SOUL.md holds the agent's own persona. On top of these, a full-text index (FTS5) allows precise keyword recall across all historical memories.",
          },
          {
            "zh-CN":
              "Hermes 还引入了 Honcho 组件做 dialectic user modeling——从对话里不断抽取关于用户的可复用陈述，反哺 USER.md。这一层是纯 LLM 驱动的用户理解，弥补了结构化文件不擅长的隐性偏好。",
            "zh-SG":
              "Hermes 還引入了 Honcho 元件做 dialectic user modeling——從對話裡不斷抽取關於使用者的可複用陳述，反哺 USER.md。這一層是純 LLM 驅動的使用者理解，彌補了結構化檔案不擅長的隱性偏好。",
            "en-US":
              "Hermes also uses a component called Honcho for dialectic user modeling — continually extracting reusable statements about the user from conversation and feeding them back into USER.md. This LLM-driven layer captures the implicit preferences a structured file struggles to hold.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "四、召回：结构化 + 全文 + 语义，三条腿走路",
          "zh-SG": "四、召回：結構化 + 全文 + 語義，三條腿走路",
          "en-US": "4. Recall: structured + keyword + semantic, working together",
        },
        paragraphs: [
          {
            "zh-CN":
              "传统 RAG 方案很依赖向量相似度，但只用向量会遇到两个老大难：你重要不代表你和 query 相似；细节被稀释在整段里。Hermes 的召回是混合检索：每次对话启动时默认整份加载 USER.md、SOUL.md 等高价值信息；面对具体问题走 FTS5 精确关键词命中；跨条目整合走 LLM 摘要 & 语义匹配。这三层配合，才让记住你不只停留在向量相似，而是我真的知道你说过什么。",
            "zh-SG":
              "傳統 RAG 方案很依賴向量相似度，但只用向量會遇到兩個老大難：你重要不代表你和 query 相似；細節被稀釋在整段裡。Hermes 的召回是混合檢索：每次對話啟動時預設整份載入 USER.md、SOUL.md 等高價值資訊；面對具體問題走 FTS5 精確關鍵字命中；跨條目整合走 LLM 摘要 & 語義比對。這三層配合，才讓記住你不只停留在向量相似，而是我真的知道你說過什麼。",
            "en-US":
              "Classical RAG leans on vector similarity, which has two chronic issues: important isn't the same as similar, and details get diluted inside long passages. Hermes uses hybrid retrieval: high-value files like USER.md and SOUL.md are loaded in full at session start; specific questions go through FTS5 keyword matching; cross-entry synthesis uses LLM summarization and semantic matching. Together, these turn \"remembering you\" from \"vectors happen to be close\" into \"I actually know what you said.\"",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "五、更新：记忆是活的",
          "zh-SG": "五、更新：記憶是活的",
          "en-US": "5. Updates: memory is alive, not an append-only log",
        },
        paragraphs: [
          {
            "zh-CN":
              "Hermes 更接近编辑一份活的档案，而不是追加日记：新的事实和旧的事实冲突时优先更新而不是并列写入，避免分裂人格；长期没被引用的条目会被判定为低价值逐步降权；用户明确否认的信息会被立刻删除，而不是记录一条相反的。",
            "zh-SG":
              "Hermes 更接近編輯一份活的檔案，而不是追加日記：新事實與舊事實衝突時優先更新而不是並列寫入，避免分裂人格；長期沒被引用的條目會被判定為低價值逐步降權；使用者明確否認的資訊會被立即刪除，而不是記錄一條相反的。",
            "en-US":
              "Hermes treats memory more like editing a living document than appending to a diary: when new facts contradict old ones, it prefers to update rather than store both (avoiding \"split personalities\"); rarely-recalled entries are down-weighted as low value; and information the user explicitly denies is deleted rather than kept as a contradictory record.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "六、LightVela 的实践视角",
          "zh-SG": "六、LightVela 的實踐視角",
          "en-US": "6. Where LightVela takes this next",
        },
        paragraphs: [
          {
            "zh-CN":
              "Hermes Agent 是一个非常好的记忆系统参考实现，但要把这份能力真正带到普通用户和团队面前，还需要几件事：可视化的记忆管理，普通用户不该去改 Markdown 文件；多端一致的记忆，Web、移动端、IDE 内的 Agent 应共享同一份你是谁；团队维度的记忆，不只是 Agent 记得我，还要 Agent 记得我们团队的规矩。这正是 LightVela 在构建的方向：把研究级别的记忆系统抽象成用户画像 + 事实记忆 + 团队上下文三层，做成人人可用的能力。",
            "zh-SG":
              "Hermes Agent 是一個非常好的記憶系統參考實作，但要把這份能力真正帶到一般使用者與團隊面前，還需要幾件事：可視化的記憶管理，一般使用者不該去改 Markdown 檔；多端一致的記憶，Web、行動端、IDE 內的 Agent 應共享同一份你是誰；團隊維度的記憶，不只是 Agent 記得我，還要 Agent 記得我們團隊的規矩。這正是 LightVela 在建構的方向：把研究級別的記憶系統抽象成使用者畫像 + 事實記憶 + 團隊上下文三層，做成人人可用的能力。",
            "en-US":
              "Hermes Agent is a great reference implementation of a memory system, but bringing that capability to everyday users and teams requires more: visual memory management so people don't need to edit Markdown files; cross-device consistency so web, mobile, and IDE agents share the same \"who you are\"; and team-level memory so the agent also remembers your team's conventions, not just yours. That's exactly the direction LightVela is building — abstracting a research-grade memory system into three layers (user profile, factual memory, team context) and turning it into a capability anyone can use.",
          },
        ],
      },
    ],
  },

  {
    slug: "user-md-vs-memory-md",
    categoryId: "hermes-explainer",
    date: "2026-07-30",
    title: {
      "zh-CN": "为什么 Hermes Agent 要把记忆分成两类？USER.md 与 MEMORY.md 的职责",
      "zh-SG": "為什麼 Hermes Agent 要把記憶分成兩類？USER.md 與 MEMORY.md 的職責",
      "en-US": "Why Hermes Agent Splits Memory in Two: USER.md vs MEMORY.md",
    },
    summary: {
      "zh-CN":
        "Hermes Agent 用 USER.md 和 MEMORY.md 承载两种截然不同的长期记忆。这篇讲清楚它们各自的职责、写入方式和使用场景，以及为什么合并成一份其实是坏主意。",
      "zh-SG":
        "Hermes Agent 用 USER.md 與 MEMORY.md 承載兩種截然不同的長期記憶。這篇講清楚它們各自的職責、寫入方式與使用場景，以及為什麼合併成一份其實是壞主意。",
      "en-US":
        "Hermes Agent uses USER.md and MEMORY.md for two very different kinds of long-term memory. This piece explains their responsibilities, write patterns, use cases — and why merging them is a bad idea.",
    },
    sections: [
      {
        heading: {
          "zh-CN": "一、USER.md：一份\"关于你是谁\"的画像",
          "zh-SG": "一、USER.md：一份「關於你是誰」的畫像",
          "en-US": "1. USER.md — a profile of who you are",
        },
        paragraphs: [
          {
            "zh-CN":
              "USER.md 的定位是持久的、结构化的用户画像：姓名 / 称呼；角色 / 职业；常用技术栈、工具链；沟通偏好（简洁 vs 详细、先结论 vs 先分析）；长期目标 / 关注领域；团队与协作关系。它的两个关键特征：稳定（内容变化频率极低）；默认加载（每次会话启动都整份被喂给模型，作为对话底色）。因为要每次都加载，USER.md 必须短、准、结构化。",
            "zh-SG":
              "USER.md 的定位是持久的、結構化的使用者畫像：姓名 / 稱呼；角色 / 職業；常用技術棧、工具鏈；溝通偏好（簡潔 vs 詳細、先結論 vs 先分析）；長期目標 / 關注領域；團隊與協作關係。它的兩個關鍵特徵：穩定（內容變化頻率極低）；預設載入（每次會話啟動都整份被餵給模型，作為對話底色）。因為要每次都載入，USER.md 必須短、準、結構化。",
            "en-US":
              "USER.md is meant to hold a persistent, structured user profile: name, role, common tech stack, communication preferences (concise vs detailed, conclusion-first vs analysis-first), long-term goals, team and collaboration context. Its two defining traits: it's stable (very low change rate) and it's loaded by default at every session start. Because it's loaded every time, USER.md must be short, precise, and structured.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "二、MEMORY.md：一份\"我们一起经历了什么\"的档案",
          "zh-SG": "二、MEMORY.md：一份「我們一起經歷了什麼」的檔案",
          "en-US": "2. MEMORY.md — a log of what we've been through together",
        },
        paragraphs: [
          {
            "zh-CN":
              "MEMORY.md（以及 memories/ 目录）承担事实性记忆：具体发生过的事件、结论、决定、用户明确要 Agent 记住的知识点、项目相关的上下文、之前踩过的坑与解决方案。它的特点和 USER.md 正好相反：易变（条目持续新增、更新、淘汰）、按需召回（通过全文索引 / 摘要 / 语义匹配按当前话题命中相关片段）。",
            "zh-SG":
              "MEMORY.md（以及 memories/ 目錄）承擔事實性記憶：具體發生過的事件、結論、決定、使用者明確要 Agent 記住的知識點、專案相關的上下文、之前踩過的坑與解決方案。它的特點與 USER.md 正好相反：易變（條目持續新增、更新、淘汰）、按需召回（透過全文索引 / 摘要 / 語義比對按當前話題命中相關片段）。",
            "en-US":
              "MEMORY.md (and the memories/ directory) carries factual memory: specific events, conclusions, decisions, knowledge the user explicitly asks to remember, project-specific context, past pitfalls and their fixes. Its properties are the mirror image of USER.md: mutable (entries are added, updated, and retired over time) and recalled on demand (matched to the current topic via full-text index, summarization, or semantic matching).",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "三、为什么不能合成一份？",
          "zh-SG": "三、為什麼不能合成一份？",
          "en-US": "3. Why merging them is a bad idea",
        },
        paragraphs: [
          {
            "zh-CN":
              "加载策略不同：USER.md 每次必载，MEMORY.md 按需召回。合并后要么 context 被历史事实撑爆、要么 Agent 常常想不起你是谁。",
            "zh-SG":
              "載入策略不同：USER.md 每次必載，MEMORY.md 按需召回。合併後要麼 context 被歷史事實撐爆、要麼 Agent 常常想不起你是誰。",
            "en-US":
              "Loading strategies differ. USER.md is loaded every time; MEMORY.md is recalled on demand. Merge them and you either blow the context budget on historical facts or lose the agent's basic knowledge of who you are.",
          },
          {
            "zh-CN":
              "更新策略不同：USER.md 的更新逻辑是编辑同一段（新版本覆盖旧版本，保证画像自洽）；MEMORY.md 是追加条目 + 老条目降权（历史事件不能被凭空抹掉，但可以被标记为过时）。混在一起，画像会被写成日记，或者日记被写成画像。",
            "zh-SG":
              "更新策略不同：USER.md 的更新邏輯是編輯同一段（新版本覆蓋舊版本，保證畫像自洽）；MEMORY.md 是追加條目 + 舊條目降權（歷史事件不能被憑空抹掉，但可以被標記為過時）。混在一起，畫像會被寫成日記，或者日記被寫成畫像。",
            "en-US":
              "Update strategies differ. USER.md is edited in place (new versions overwrite old ones to keep the profile self-consistent). MEMORY.md appends new entries and down-weights old ones (history can't be erased, but it can be marked as stale). Mix them together and profiles get written like diaries — or diaries get written like profiles.",
          },
          {
            "zh-CN":
              "用户体验不同：想看 Agent 对我的印象——需要 USER.md；想找上次我们决定用哪个方案——需要 MEMORY.md 里的具体条目。两类信息一旦搅在一起，前端就没法给用户提供清晰的记忆管理能力。",
            "zh-SG":
              "使用者體驗不同：想看 Agent 對我的印象——需要 USER.md；想找上次我們決定用哪個方案——需要 MEMORY.md 裡的具體條目。兩類資訊一旦攪在一起，前端就沒法給使用者提供清晰的記憶管理能力。",
            "en-US":
              "User experience differs. \"What does the agent think of me?\" → USER.md. \"What did we decide last time?\" → a specific entry in MEMORY.md. Once these get tangled together, no product can offer a clean memory-management surface.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "四、一个具体例子",
          "zh-SG": "四、一個具體例子",
          "en-US": "4. A concrete example",
        },
        paragraphs: [
          {
            "zh-CN":
              "假设你告诉 Agent：我叫 Jasmin，是一名前端工程师，喜欢结论先行的沟通风格。最近在做 mono2 项目的国际站，用 Next.js。上周我们把 hero 区改成了动态渐变。一个训练良好的 Hermes Agent 会拆成两处：USER.md 记 Identity（Name: Jasmin，Role: 前端工程师）和 Preferences（沟通风格：结论先行，常用技术栈：Next.js）；MEMORY.md 记 [2026-07-30] mono2 项目：国际站 hero 区改为动态渐变；相关项目：mono2 / 国际站（global region）。你是什么样的人进画像，我们一起做了什么进档案。分开写，才能各自演化。",
            "zh-SG":
              "假設你告訴 Agent：我叫 Jasmin，是一名前端工程師，喜歡結論先行的溝通風格。最近在做 mono2 專案的國際站，用 Next.js。上週我們把 hero 區改成了動態漸變。一個訓練良好的 Hermes Agent 會拆成兩處：USER.md 記 Identity（Name: Jasmin，Role: 前端工程師）和 Preferences（溝通風格：結論先行，常用技術棧：Next.js）；MEMORY.md 記 [2026-07-30] mono2 專案：國際站 hero 區改為動態漸變；相關專案：mono2 / 國際站（global region）。你是什麼樣的人進畫像，我們一起做了什麼進檔案。分開寫，才能各自演化。",
            "en-US":
              "Suppose you tell the agent: \"I'm Jasmin, a frontend engineer, I like conclusions first. I'm working on the global site of the mono2 project with Next.js. Last week we changed the hero into a dynamic gradient.\" A well-trained Hermes Agent splits this in two: USER.md records Identity (Name: Jasmin, Role: frontend engineer) and Preferences (Style: conclusion-first, Stack: Next.js); MEMORY.md records \"[2026-07-30] mono2 project: hero of the global site became a dynamic gradient; related projects: mono2 / global region.\" Who you are goes into the profile; what we did goes into the record. Keep them apart, and each layer can evolve on its own.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "五、LightVela 是怎么做的？",
          "zh-SG": "五、LightVela 是怎麼做的？",
          "en-US": "5. How LightVela puts this into product",
        },
        paragraphs: [
          {
            "zh-CN":
              "LightVela 内部的 Agent 记忆体系借鉴了这种分层思路，并做了两点产品化落地：画像层可视化，用户能在界面上直接看到 Agent 记得我的哪些画像、这些画像来自哪次对话，并支持一键修正，画像不再是黑盒；事实层可组织，事实记忆能被打上项目、任务、时间等标签，方便召回与清理，团队场景下还能把团队记忆和个人记忆分层管理。",
            "zh-SG":
              "LightVela 內部的 Agent 記憶體系借鑑了這種分層思路，並做了兩點產品化落地：畫像層可視化，使用者能在介面上直接看到 Agent 記得我的哪些畫像、這些畫像來自哪次對話，並支援一鍵修正，畫像不再是黑盒；事實層可組織，事實記憶能被打上專案、任務、時間等標籤，方便召回與清理，團隊場景下還能把團隊記憶和個人記憶分層管理。",
            "en-US":
              "LightVela's agent memory borrows exactly this layering, with two productization moves: the profile layer is visualized — you can see which parts of your profile the agent remembers, which conversation each came from, and correct them in one click; the factual layer is organizable — memories can be tagged by project, task, and time for easy recall and cleanup, and in team scenarios personal memory and team memory can be layered separately.",
          },
        ],
      },
    ],
  },

  {
    slug: "hermes-memory-curation",
    categoryId: "hermes-explainer",
    date: "2026-07-30",
    title: {
      "zh-CN": "记忆不是越多越好：Hermes Agent 如何筛选、整理和更新长期记忆",
      "zh-SG": "記憶不是越多越好：Hermes Agent 如何篩選、整理與更新長期記憶",
      "en-US": "More Memory Isn't Better: How Hermes Agent Filters, Organizes, and Updates Long-Term Memory",
    },
    summary: {
      "zh-CN":
        "长期记忆的关键不是记得多，而是记得对。这篇拆解 Hermes Agent 在写入、整理、更新、淘汰四个阶段的记忆策略，并聊聊为什么少而准是好 Agent 的底层素养。",
      "zh-SG":
        "長期記憶的關鍵不是記得多，而是記得對。這篇拆解 Hermes Agent 在寫入、整理、更新、淘汰四個階段的記憶策略，並聊聊為什麼少而準是好 Agent 的底層素養。",
      "en-US":
        "The point of long-term memory isn't \"remember more\" — it's \"remember right.\" This piece breaks down Hermes Agent's four-stage strategy: write, organize, update, retire.",
    },
    sections: [
      {
        paragraphs: [
          {
            "zh-CN":
              "有一个常见的误解：AI 助手记得越多越聪明。事实恰恰相反——记得多而杂，会让 Agent 变笨，它开始把你临时的、错误的、过时的信息，当成关于你的稳定事实。真正好用的长期记忆系统，一定是少而准的。",
            "zh-SG":
              "有一個常見的誤解：AI 助手記得越多越聰明。事實恰恰相反——記得多而雜，會讓 Agent 變笨，它開始把你臨時的、錯誤的、過時的資訊，當成關於你的穩定事實。真正好用的長期記憶系統，一定是少而準的。",
            "en-US":
              "There's a common misconception: the more an AI assistant remembers, the smarter it is. The reality is the opposite — the more it remembers indiscriminately, the dumber it gets, treating your temporary, incorrect, or stale information as stable facts about you. A genuinely useful long-term memory system is one that remembers less, but more accurately.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "一、写入：不是所有信息都值得进入长期记忆",
          "zh-SG": "一、寫入：不是所有資訊都值得進入長期記憶",
          "en-US": "1. Write: not everything deserves long-term memory",
        },
        paragraphs: [
          {
            "zh-CN":
              "Hermes 的第一道门是写入过滤。它不会把每一句话都存下来，而是在几种明确的时机由 Agent 自己判断要不要写：Compression（压缩时抽取值得跨会话保留的信息）、Checkpoint（关键节点盘点记忆）、Nudges（周期性提醒 Agent 复盘）、用户显式指令。判断标准通常包括：可复用性、稳定性（暂时 vs 长期）、具体性（模糊态度 vs 可复用事实）。一个训练良好的 Hermes Agent，宁可少记，也不乱记。",
            "zh-SG":
              "Hermes 的第一道門是寫入過濾。它不會把每一句話都存下來，而是在幾種明確的時機由 Agent 自己判斷要不要寫：Compression（壓縮時抽取值得跨會話保留的資訊）、Checkpoint（關鍵節點盤點記憶）、Nudges（週期性提醒 Agent 複盤）、使用者顯式指令。判斷標準通常包括：可複用性、穩定性（暫時 vs 長期）、具體性（模糊態度 vs 可複用事實）。一個訓練良好的 Hermes Agent，寧可少記，也不亂記。",
            "en-US":
              "The first gate is write-time filtering. Hermes doesn't persist every utterance — the agent itself decides whether to write at specific moments: compression, checkpoints, periodic nudges, and explicit user instructions. Criteria usually include reusability, stability (temporary vs long-term), and specificity (fuzzy attitude vs actionable fact). A well-trained Hermes Agent would rather remember less than remember loosely.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "二、整理：把碎片写成条目",
          "zh-SG": "二、整理：把碎片寫成條目",
          "en-US": "2. Organize: rewrite fragments into proper entries",
        },
        paragraphs: [
          {
            "zh-CN":
              "即便通过了写入过滤，进来的信息也往往是碎片。Hermes 会把碎片重写成规范条目——抽事实、补主语、加时间、可检索。举个例子：\"哦对了，我们那个 API 后来改成走 gateway 了，不再直连服务了，是上个礼拜的事\" → \"[~2026-07-24] Project X 的 API 已从直连改为经由 gateway 路由\"。结构化整理之后，记忆条目才具备几个月后被再次召回的可能。",
            "zh-SG":
              "即便通過了寫入過濾，進來的資訊也往往是碎片。Hermes 會把碎片重寫成規範條目——抽事實、補主詞、加時間、可檢索。舉個例子：「哦對了，我們那個 API 後來改成走 gateway 了，不再直連服務了，是上個禮拜的事」→「[~2026-07-24] Project X 的 API 已從直連改為經由 gateway 路由」。結構化整理之後，記憶條目才具備幾個月後被再次召回的可能。",
            "en-US":
              "Even after passing the write filter, incoming information often arrives as fragments. Hermes rewrites fragments into normalized entries — extract the fact, add the subject, add a timestamp, make it searchable. Example: \"Oh right, that API — we switched it to go through the gateway, not direct anymore, last week\" → \"[~2026-07-24] Project X: API now routes through the gateway instead of hitting services directly.\" Only after this normalization does the entry stand a chance of being recalled months later.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "三、更新：优先\"修改\"，而不是\"追加相反\"",
          "zh-SG": "三、更新：優先「修改」，而不是「追加相反」",
          "en-US": "3. Update: prefer editing over appending contradictions",
        },
        paragraphs: [
          {
            "zh-CN":
              "朴素做法是再记一条，结果 Agent 里同时存在用户偏好 Vue、用户后来换成了 React、用户又回到了 Vue——三条并列，模型自己都不知道该信谁。Hermes 的做法：用户画像里的偏好类字段倾向于覆盖旧值；事实记忆里历史事件保留但当前状态字段被更新，并保留一个简短的版本迁移痕迹；用户明确否认的内容会被删除而不是记录成用户否认了 X。核心目的是让 Agent 的世界模型保持自洽。",
            "zh-SG":
              "簡單做法是再記一條，結果 Agent 裡同時存在使用者偏好 Vue、使用者後來換成了 React、使用者又回到了 Vue——三條並列，模型自己都不知道該信誰。Hermes 的做法：使用者畫像裡的偏好類欄位傾向於覆蓋舊值；事實記憶裡歷史事件保留但目前狀態欄位被更新，並保留一段簡短的版本遷移痕跡；使用者明確否認的內容會被刪除而不是記錄成使用者否認了 X。核心目的是讓 Agent 的世界模型保持自洽。",
            "en-US":
              "A naive approach is to append another entry — and you end up with \"user prefers Vue,\" \"user switched to React,\" and \"user is back on Vue\" all coexisting, leaving the model unsure which to trust. Hermes prefers to overwrite preference fields in the profile; keep historical events in factual memory but update the \"current state\" fields (with a short version-migration note); and delete content the user explicitly denies instead of storing \"user denied X.\" The point is to keep the agent's world model self-consistent.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "四、淘汰：让低价值记忆自然衰减",
          "zh-SG": "四、淘汰：讓低價值記憶自然衰減",
          "en-US": "4. Retire: let low-value memory decay naturally",
        },
        paragraphs: [
          {
            "zh-CN":
              "即使写入很克制、整理很规范，长期下来记忆也会膨胀。Hermes 用几种机制让低价值记忆自然衰减：访问频率降权（长期没被召回的条目在后续检索里排名下降）、主题聚合（一堆相似条目被 LLM 摘要合并成一条更概括的记忆）、过期标记（绑定时间语义的条目在时间点之后被标记过时）。效果是：你几个月前的碎碎念不会一直污染 Agent 对你的判断，但真正长期重要的信息会被反复强化。",
            "zh-SG":
              "即使寫入很克制、整理很規範，長期下來記憶也會膨脹。Hermes 用幾種機制讓低價值記憶自然衰減：存取頻率降權（長期沒被召回的條目在後續檢索裡排名下降）、主題聚合（一堆相似條目被 LLM 摘要合併成一條更概括的記憶）、過期標記（綁定時間語義的條目在時間點之後被標記過時）。效果是：你幾個月前的碎碎念不會一直污染 Agent 對你的判斷，但真正長期重要的資訊會被反覆強化。",
            "en-US":
              "Even with disciplined writes and clean organization, memory bloats over time. Hermes uses several mechanisms to let low-value memory fade: access-frequency down-ranking (rarely-recalled entries fall in retrieval), topic clustering (many similar entries get summarized into one broader memory), and expiration tagging (time-bounded entries get marked stale after their date). The result: your grumbling from months ago doesn't keep polluting the agent's picture of you, while truly important, long-lived information gets reinforced.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "五、一个反直觉的结论",
          "zh-SG": "五、一個反直覺的結論",
          "en-US": "5. A counterintuitive conclusion",
        },
        paragraphs: [
          {
            "zh-CN":
              "很多产品宣传 AI 记忆能力时强调记住的条目数量和支持多大记忆库。但站在使用者角度，你真正关心的是：它有没有记住真正重要的东西？它有没有把已经不成立的信息及时更新掉？它会不会因为记了一堆无关的东西反而变得更啰嗦、更容易搞错？能回答什么不该记的记忆系统，才是好的记忆系统。",
            "zh-SG":
              "很多產品宣傳 AI 記憶能力時強調記住的條目數量與支援多大記憶庫。但站在使用者角度，你真正關心的是：它有沒有記住真正重要的東西？它有沒有把已經不成立的資訊及時更新掉？它會不會因為記了一堆無關的東西反而變得更囉唆、更容易搞錯？能回答什麼不該記的記憶系統，才是好的記憶系統。",
            "en-US":
              "Many products advertise AI memory as \"number of items remembered\" or \"how big the memory bank is.\" But from a user's point of view, what really matters is: did it remember what actually mattered? did it drop information that no longer holds? did it get noisier or more error-prone because of all the irrelevant things it kept? A memory system that can answer \"what shouldn't be remembered\" is the one worth having.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "六、LightVela：把\"记忆治理\"变成产品能力",
          "zh-SG": "六、LightVela：把「記憶治理」變成產品能力",
          "en-US": "6. LightVela: turning memory governance into a product capability",
        },
        paragraphs: [
          {
            "zh-CN":
              "Hermes 的这一整套筛选 / 整理 / 更新 / 淘汰机制，对开发者而言是清晰的，但对普通用户还是黑盒。LightVela 想做的一件事，就是把这层记忆治理变成用户可感知、可控制的产品能力：可见的记忆列表，每条记忆可查看、编辑、删除；可信度可视化，每条记忆背后的对话来源和更新时间都清晰可查；主动的记忆审阅，周期性地把新记住的画像和事实整理成一份小报告让你花一分钟确认或修正。这一步，正是把 Hermes 内部的 nudge + compression 流程产品化成人类看得懂的动作。",
            "zh-SG":
              "Hermes 的這一整套篩選 / 整理 / 更新 / 淘汰機制，對開發者而言是清晰的，但對一般使用者還是黑盒。LightVela 想做的一件事，就是把這層記憶治理變成使用者可感知、可控制的產品能力：可見的記憶清單，每條記憶可查看、編輯、刪除；可信度視覺化，每條記憶背後的對話來源與更新時間都清晰可查；主動的記憶審閱，週期性地把新記住的畫像和事實整理成一份小報告讓你花一分鐘確認或修正。這一步，正是把 Hermes 內部的 nudge + compression 流程產品化成人類看得懂的動作。",
            "en-US":
              "Hermes's full filter/organize/update/retire pipeline is transparent to developers but still a black box to end users. LightVela's move is to turn that memory governance into user-visible, user-controllable product features: a visible memory list (each entry viewable, editable, deletable); source and update-time transparency for every entry; and proactive memory review — a periodic short report of \"what I've newly learned about you\" that you can confirm or correct in a minute. That's Hermes's internal nudge-and-compression loop, productized into an action a human can actually take.",
          },
        ],
      },
    ],
  },

  {
    slug: "memory-vs-skill",
    categoryId: "hermes-explainer",
    date: "2026-07-30",
    title: {
      "zh-CN": "Memory 不是 Skill：Hermes Agent 的事实记忆与程序性记忆有何不同？",
      "zh-SG": "Memory 不是 Skill：Hermes Agent 的事實記憶與程序性記憶有何不同？",
      "en-US": "Memory Is Not Skill: Declarative vs Procedural Memory in Hermes Agent",
    },
    summary: {
      "zh-CN":
        "在 Hermes Agent 里，Memory 和 Skill 是两种完全不同的长期记忆。这篇解释事实记忆（陈述性）和程序性记忆的差别，并聊聊为什么一个成熟的 Agent 一定要同时具备这两条腿。",
      "zh-SG":
        "在 Hermes Agent 裡，Memory 和 Skill 是兩種完全不同的長期記憶。這篇解釋事實記憶（陳述性）和程序性記憶的差別，並聊聊為什麼一個成熟的 Agent 一定要同時具備這兩條腿。",
      "en-US":
        "Inside Hermes Agent, Memory and Skill are two very different kinds of long-term memory. Here's the difference between declarative and procedural memory — and why any mature agent needs both.",
    },
    sections: [
      {
        heading: {
          "zh-CN": "一、认知心理学早就分好了",
          "zh-SG": "一、認知心理學早就分好了",
          "en-US": "1. Cognitive psychology already made this split",
        },
        paragraphs: [
          {
            "zh-CN":
              "心理学早就区分过两类长期记忆：陈述性记忆（可以说出来的事实，如我住在北京、React 18 引入了并发渲染）和程序性记忆（会做但未必说得清楚的技能，如骑自行车、盲打、写一封结构合理的 PR 描述）。这两类记忆的存储方式、调用方式、更新方式都不同。Hermes Agent 直接把这个区分搬进了系统设计：Memory（memories/、MEMORY.md）承担 Agent 的陈述性记忆，Skill（skills/）承担 Agent 的程序性记忆。",
            "zh-SG":
              "心理學早就區分過兩類長期記憶：陳述性記憶（可以說出來的事實，如我住在北京、React 18 引入了併發渲染）和程序性記憶（會做但未必說得清楚的技能，如騎腳踏車、盲打、寫一封結構合理的 PR 描述）。這兩類記憶的儲存方式、呼叫方式、更新方式都不同。Hermes Agent 直接把這個區分搬進了系統設計：Memory（memories/、MEMORY.md）承擔 Agent 的陳述性記憶，Skill（skills/）承擔 Agent 的程序性記憶。",
            "en-US":
              "Cognitive psychology has long distinguished two kinds of long-term memory: declarative memory (facts you can state — \"I live in Beijing,\" \"React 18 introduced concurrent rendering\") and procedural memory (skills you can perform without necessarily articulating — riding a bike, touch-typing, writing a well-structured PR description). They're stored, invoked, and updated differently. Hermes Agent lifted the distinction straight into its system design: Memory (memories/, MEMORY.md) carries the agent's declarative memory; Skill (skills/) carries the agent's procedural memory.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "二、Memory：Agent 会\"讲\"的东西",
          "zh-SG": "二、Memory：Agent 會「講」的東西",
          "en-US": "2. Memory: what the agent can say",
        },
        paragraphs: [
          {
            "zh-CN":
              "Memory 系统里存的是事实、事件、结论、偏好：Jasmin 在做 mono2 项目的国际站；上周把 hero 区改成了动态渐变；该项目跑在 Next.js 上。特点：陈述性（以短句、条目形式存在，能直接被引用进 prompt）；按需召回（Agent 遇到相关话题时把匹配的条目拉进来）；易变（新条目会追加，旧条目会被更新或淘汰）。可以把 Memory 想成 Agent 的笔记本。",
            "zh-SG":
              "Memory 系統裡存的是事實、事件、結論、偏好：Jasmin 在做 mono2 專案的國際站；上週把 hero 區改成了動態漸變；該專案跑在 Next.js 上。特點：陳述性（以短句、條目形式存在，能直接被引用進 prompt）；按需召回（Agent 遇到相關話題時把匹配的條目拉進來）；易變（新條目會追加，舊條目會被更新或淘汰）。可以把 Memory 想成 Agent 的筆記本。",
            "en-US":
              "The memory system stores facts, events, conclusions, preferences: \"Jasmin is working on the global site of the mono2 project,\" \"last week we changed the hero to a dynamic gradient,\" \"the project runs on Next.js.\" Characteristics: declarative (short entries or sentences that can be quoted directly into a prompt), recall-on-demand (matched entries are pulled in when the topic comes up), and mutable (new entries added, old ones updated or retired). Think of Memory as the agent's notebook.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "三、Skill：Agent 会\"做\"的事",
          "zh-SG": "三、Skill：Agent 會「做」的事",
          "en-US": "3. Skill: what the agent knows how to do",
        },
        paragraphs: [
          {
            "zh-CN":
              "Skill 系统存的是做某类事的标准流程：接到线上故障时先拉时间线、再定位到最近一次部署、最后决定是否回滚；写周报时按 progress / blocker / next 三段结构组织；处理国际站文案时轻量云一律翻译成 Lighthouse。特点：程序性（以\"何时触发 + 怎么做\"的形式存在，接近一段可复用的 SOP）；按场景触发（Agent 识别到匹配场景时 Skill 会被自动装载成高优先级 prompt）；相对稳定（Skill 一旦沉淀通常长期不变，变的是绑定它的场景与素材）。可以把 Skill 想成 Agent 的肌肉记忆。",
            "zh-SG":
              "Skill 系統存的是做某類事的標準流程：接到線上故障時先拉時間線、再定位到最近一次部署、最後決定是否回滾；寫週報時按 progress / blocker / next 三段結構組織；處理國際站文案時輕量雲一律翻譯成 Lighthouse。特點：程序性（以「何時觸發 + 怎麼做」的形式存在，接近一段可重複使用的 SOP）；按場景觸發（Agent 識別到匹配場景時 Skill 會被自動裝載成高優先級 prompt）；相對穩定（Skill 一旦沉澱通常長期不變，變的是綁定它的場景與素材）。可以把 Skill 想成 Agent 的肌肉記憶。",
            "en-US":
              "The skill system stores standard procedures for kinds of tasks: \"on-call incident → pull the timeline, locate the latest deploy, then decide whether to roll back\"; \"weekly report → structured as progress / blocker / next\"; \"global-site copy → translate 轻量云 as Lighthouse.\" Characteristics: procedural (structured as \"when to trigger + how to do it,\" close to a reusable SOP), scenario-triggered (auto-loaded as a high-priority prompt when a matching situation is detected), and relatively stable (once a skill is captured, it usually stays put — what changes is the surrounding context). Think of Skill as the agent's muscle memory.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "四、为什么合并会坏事？",
          "zh-SG": "四、為什麼合併會壞事？",
          "en-US": "4. Why merging them breaks things",
        },
        paragraphs: [
          {
            "zh-CN":
              "触发方式不同：Memory 是被 query 命中就召回，Skill 是被场景匹配就装载（通常带触发条件）。合并后 Agent 会分不清是要引用一条事实还是要按照一段流程去做。",
            "zh-SG":
              "觸發方式不同：Memory 是被 query 命中就召回，Skill 是被場景匹配就裝載（通常帶觸發條件）。合併後 Agent 會分不清是要引用一條事實還是要按照一段流程去做。",
            "en-US":
              "Triggering differs. Memory is recalled when a query hits; Skill is loaded when a scenario matches (usually with explicit trigger conditions). Merged, the agent can't tell whether a piece of text is background to quote or a procedure to execute.",
          },
          {
            "zh-CN":
              "表达形式不同：Memory 是短句、事实、条目；Skill 是流程、模板、约束，往往包含步骤 1 / 2 / 3 这类顺序结构。塞在一起，Agent 无法判断这段话是背景还是我此刻要照着执行。",
            "zh-SG":
              "表達形式不同：Memory 是短句、事實、條目；Skill 是流程、範本、約束，往往包含步驟 1 / 2 / 3 這類順序結構。塞在一起，Agent 無法判斷這段話是背景還是我此刻要照著執行。",
            "en-US":
              "Format differs. Memory is short sentences and entries; Skill is procedures, templates, constraints — often with ordered steps 1 / 2 / 3. Mixed together, the agent can't tell whether a passage is background context or a script to follow right now.",
          },
          {
            "zh-CN":
              "演化速度不同：Memory 每天都在变；Skill 一旦定型可能几个月不动。放在一起会让稳定的 SOP 被高频变化的事实条目冲刷掉。",
            "zh-SG":
              "演化速度不同：Memory 每天都在變；Skill 一旦定型可能幾個月不動。放在一起會讓穩定的 SOP 被高頻變化的事實條目沖刷掉。",
            "en-US":
              "Evolution speed differs. Memory changes daily; a stable Skill may not change for months. Stored together, high-churn facts drown out the stable SOPs.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "五、举个真实场景",
          "zh-SG": "五、舉個真實場景",
          "en-US": "5. A concrete scenario",
        },
        paragraphs: [
          {
            "zh-CN":
              "假设你和 Agent 说：以后我们团队写 PR 描述都按这个格式：一句话总结、变更点、影响范围、测试情况。另外你要记住，这次的项目叫 mono2，前端跑在 5174 端口。一个训练良好的 Hermes Agent 应该这样处理：前半句 → 写入一个新的 Skill：pr-description-format.md，触发条件是用户要写 PR 描述时；后半句 → 写入一条 Memory：mono2 项目：前端 dev server 端口 5174。下次你说帮我写个 PR 描述，Agent 会匹配到 Skill（装载 PR 描述格式）+ 匹配到 Memory（知道当前项目叫 mono2 跑在 5174），二者结合输出一个既符合团队规范又贴合具体项目的 PR 描述。记住事实 + 记住流程一起用，效果才会 1 + 1 > 2。",
            "zh-SG":
              "假設你和 Agent 說：以後我們團隊寫 PR 描述都按這個格式：一句話總結、變更點、影響範圍、測試情況。另外你要記住，這次的專案叫 mono2，前端跑在 5174 埠。一個訓練良好的 Hermes Agent 應該這樣處理：前半句 → 寫入一個新的 Skill：pr-description-format.md，觸發條件是使用者要寫 PR 描述時；後半句 → 寫入一條 Memory：mono2 專案：前端 dev server 埠 5174。下次你說幫我寫個 PR 描述，Agent 會比對到 Skill（裝載 PR 描述格式）+ 比對到 Memory（知道目前專案叫 mono2 跑在 5174），兩者結合輸出一個既符合團隊規範又貼合具體專案的 PR 描述。記住事實 + 記住流程一起用，效果才會 1 + 1 > 2。",
            "en-US":
              "Say you tell the agent: \"From now on our team writes PR descriptions with this format: one-line summary, changes, impact scope, test status. And remember, this project is called mono2 — the frontend runs on port 5174.\" A well-trained Hermes Agent should split this: the first sentence → new Skill (pr-description-format.md, triggered when the user wants to write a PR description); the second → new Memory (\"mono2 project: frontend dev server port 5174\"). Next time you say \"draft me a PR description,\" the agent hits both — Skill for the format, Memory for the project specifics — and produces a PR description that follows team convention and fits the actual project. Facts plus procedures is where 1 + 1 > 2.",
          },
        ],
      },
      {
        heading: {
          "zh-CN": "六、LightVela：把 Memory 和 Skill 都做成\"用户资产\"",
          "zh-SG": "六、LightVela：把 Memory 和 Skill 都做成「使用者資產」",
          "en-US": "6. LightVela: turning Memory and Skill into user-owned assets",
        },
        paragraphs: [
          {
            "zh-CN":
              "LightVela 的思路，是把这一层从技术特性抬升为用户资产：个人 Skill 库——用户可以像收藏 prompt 一样收藏、编辑、分享自己的 Skill（工作流），并绑定触发场景；个人 Memory 库——Agent 关于你的一切事实性记忆对你透明，可以查看、修正、删除；团队级复用——Skill 和 Memory 都支持团队维度沉淀，新人一进团队就自动拥有团队的共同记忆和共同方法。你在 LightVela 上训练一个 Agent，本质上是在同时积累两份资产：一份是关于你的 Memory，一份是你的 Skill 集合——这两份资产才是长期属于你的东西，比模型本身更重要。",
            "zh-SG":
              "LightVela 的思路，是把這一層從技術特性抬升為使用者資產：個人 Skill 庫——使用者可以像收藏 prompt 一樣收藏、編輯、分享自己的 Skill（工作流），並綁定觸發場景；個人 Memory 庫——Agent 關於你的一切事實性記憶對你透明，可以查看、修正、刪除；團隊級複用——Skill 和 Memory 都支援團隊維度沉澱，新人一進團隊就自動擁有團隊的共同記憶和共同方法。你在 LightVela 上訓練一個 Agent，本質上是在同時累積兩份資產：一份是關於你的 Memory，一份是你的 Skill 集合——這兩份資產才是長期屬於你的東西，比模型本身更重要。",
            "en-US":
              "LightVela's move is to elevate this layer from technical feature to user-owned asset: a personal Skill library — you can save, edit, and share your own skills (workflows) like you would prompts, tied to specific trigger scenarios; a personal Memory library — every factual thing the agent remembers about you is transparent, editable, deletable; and team-level reuse — both Skills and Memories can be pooled at the team level, so new joiners inherit both the team's shared memory and its shared methodology on day one. Training an agent on LightVela is really about accumulating two kinds of assets in parallel: the Memory about you and your Skill library. Those are what stay yours in the long run — more so than the model itself.",
          },
        ],
      },
    ],
  },
];

/* ─────────────────────────────────────────────────────────────
 * 查询工具
 * ───────────────────────────────────────────────────────────── */

export function getBlogArticleBySlug(slug: string): BlogArticle | undefined {
  return BLOG_ARTICLES.find((a) => a.slug === slug);
}

export function getBlogArticlesByCategory(categoryId: string): BlogArticle[] {
  return BLOG_ARTICLES.filter((a) => a.categoryId === categoryId);
}

/** 展示用：按发布日期倒序排。相同日期时保持原声明顺序。 */
export function getSortedBlogArticles(): BlogArticle[] {
  return [...BLOG_ARTICLES].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 服务端安全的 slug 列表；供 sitemap / generateStaticParams 使用。 */
export function listBlogArticleSlugs(): string[] {
  return getSortedBlogArticles().map((a) => a.slug);
}

/** 在给定 locale 下取本地化文案，缺失时回退到 zh-CN，再回退到 en-US。 */
export function pickBlogText(text: BlogLocaleText, locale: PublicSiteLocale): string {
  return text[locale] || text["zh-CN"] || text["en-US"] || "";
}

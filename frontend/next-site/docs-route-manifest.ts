export const DOCS_ROUTE_LOCALES = ["en-us","zh-cn","zh-sg","zh-hant","id-id","es"] as const;

export type DocsRouteLocale = (typeof DOCS_ROUTE_LOCALES)[number];

export const DOCS_ROUTE_SLUGS = {
  "en-us": [
    [],
    [
      "overview"
    ],
    [
      "quickstart"
    ],
    [
      "core-concepts"
    ],
    [
      "who-is-lightvela-for"
    ],
    [
      "plans"
    ],
    [
      "announcements",
      "public-beta"
    ],
    [
      "credits"
    ],
    [
      "create-first-hermes"
    ],
    [
      "configuration"
    ],
    [
      "configuration",
      "model"
    ],
    [
      "configuration",
      "channel-telegram"
    ],
    [
      "configuration",
      "channel-whatsapp"
    ],
    [
      "configuration",
      "channel-discord"
    ],
    [
      "configuration",
      "channel-slack"
    ],
    [
      "configuration",
      "channel-wechat"
    ],
    [
      "configuration",
      "channel-qq"
    ],
    [
      "configuration",
      "channel-wecom"
    ],
    [
      "configuration",
      "channel-feishu"
    ],
    [
      "configuration",
      "skill"
    ],
    [
      "configuration",
      "personality"
    ],
    [
      "configuration",
      "memory"
    ],
    [
      "configuration",
      "automation"
    ],
    [
      "configuration",
      "files"
    ],
    [
      "configuration",
      "agent-chat"
    ],
    [
      "configuration",
      "diagnostics"
    ],
    [
      "configuration",
      "advanced-settings"
    ],
    [
      "configuration",
      "multiple-models"
    ],
    [
      "configuration",
      "deepseek-harness"
    ],
    [
      "use-cases",
      "personal-ai-assistant"
    ],
    [
      "use-cases",
      "chinese-messaging-channels"
    ],
    [
      "use-cases",
      "telegram-persona-agent"
    ],
    [
      "use-cases",
      "whatsapp-persona-agent"
    ],
    [
      "use-cases",
      "im-agent-persona-soul-md"
    ],
    [
      "use-cases",
      "im-agent-skill-scenarios"
    ],
    [
      "use-cases",
      "multi-channel-personality-memory"
    ],
    [
      "use-cases",
      "telegram-group-community-assistant"
    ],
    [
      "use-cases",
      "whatsapp-24-7-customer-service"
    ],
    [
      "use-cases",
      "lifelike-im-agent-rhythm-social-memory"
    ],
    [
      "use-cases",
      "telegram-whatsapp-safety-boundaries"
    ],
    [
      "use-cases",
      "daily-summary"
    ],
    [
      "use-cases",
      "hermes-agent-24-7"
    ],
    [
      "use-cases",
      "memory-and-knowledge"
    ],
    [
      "use-cases",
      "discord-community-agent"
    ],
    [
      "use-cases",
      "discord-event-agent"
    ],
    [
      "compare",
      "lightvela-vs-localhost-ai-agent"
    ],
    [
      "compare",
      "lightvela-vs-hostinger"
    ],
    [
      "compare",
      "lightvela-vs-manus"
    ],
    [
      "compare",
      "lightvela-vs-chatgpt"
    ],
    [
      "compare",
      "lightvela-vs-genspark"
    ],
    [
      "compare",
      "lightvela-vs-grok-bot"
    ],
    [
      "compare",
      "lightvela-vs-mira"
    ],
    [
      "compare",
      "lightvela-vs-viktor"
    ],
    [
      "compare",
      "lightvela-vs-today-ai"
    ],
    [
      "hermes-agent",
      "hermes-vs-openclaw"
    ],
    [
      "hermes-agent",
      "why-hermes-remembers-you"
    ],
    [
      "hermes-agent",
      "user-md-vs-memory-md"
    ],
    [
      "hermes-agent",
      "hermes-memory-curation"
    ],
    [
      "hermes-agent",
      "memory-vs-skill"
    ],
    [
      "hermes-agent",
      "model-vs-agent-layer"
    ],
    [
      "hermes-agent",
      "message-gateway"
    ],
    [
      "hermes-agent",
      "automation-scheduling"
    ],
    [
      "hermes-agent",
      "model-switching-memory"
    ],
    [
      "hermes-agent",
      "persona-user-memory"
    ],
    [
      "hermes-agent",
      "workspace-context-storage"
    ],
    [
      "hermes-agent",
      "skills-self-improvement"
    ],
    [
      "contact-us"
    ]
  ],
  "zh-cn": [
    [],
    [
      "overview"
    ],
    [
      "quickstart"
    ],
    [
      "core-concepts"
    ],
    [
      "who-is-lightvela-for"
    ],
    [
      "account"
    ],
    [
      "announcements",
      "public-beta"
    ],
    [
      "plans"
    ],
    [
      "credits"
    ],
    [
      "create-first-hermes"
    ],
    [
      "configuration"
    ],
    [
      "configuration",
      "model"
    ],
    [
      "configuration",
      "channel-wechat"
    ],
    [
      "configuration",
      "channel-qq"
    ],
    [
      "configuration",
      "channel-wecom"
    ],
    [
      "configuration",
      "channel-feishu"
    ],
    [
      "configuration",
      "skill"
    ],
    [
      "configuration",
      "personality"
    ],
    [
      "configuration",
      "memory"
    ],
    [
      "configuration",
      "automation"
    ],
    [
      "configuration",
      "files"
    ],
    [
      "configuration",
      "agent-chat"
    ],
    [
      "configuration",
      "diagnostics"
    ],
    [
      "configuration",
      "advanced-settings"
    ],
    [
      "configuration",
      "multiple-models"
    ],
    [
      "configuration",
      "deepseek-harness"
    ],
    [
      "hermes-agent",
      "hermes-vs-openclaw"
    ],
    [
      "hermes-agent",
      "why-hermes-remembers-you"
    ],
    [
      "hermes-agent",
      "user-md-vs-memory-md"
    ],
    [
      "hermes-agent",
      "hermes-memory-curation"
    ],
    [
      "hermes-agent",
      "memory-vs-skill"
    ],
    [
      "hermes-agent",
      "model-vs-agent-layer"
    ],
    [
      "hermes-agent",
      "message-gateway"
    ],
    [
      "hermes-agent",
      "automation-scheduling"
    ],
    [
      "hermes-agent",
      "model-switching-memory"
    ],
    [
      "hermes-agent",
      "persona-user-memory"
    ],
    [
      "hermes-agent",
      "workspace-context-storage"
    ],
    [
      "hermes-agent",
      "skills-self-improvement"
    ],
    [
      "compare",
      "lightvela-vs-manus"
    ],
    [
      "compare",
      "lightvela-vs-localhost-ai-agent"
    ],
    [
      "compare",
      "lightvela-vs-ai-chatbot"
    ],
    [
      "faq"
    ],
    [
      "contact-us"
    ]
  ],
  "zh-sg": [
    [],
    [
      "overview"
    ],
    [
      "quickstart"
    ],
    [
      "core-concepts"
    ],
    [
      "who-is-lightvela-for"
    ],
    [
      "plans"
    ],
    [
      "announcements",
      "public-beta"
    ],
    [
      "credits"
    ],
    [
      "create-first-hermes"
    ],
    [
      "configuration"
    ],
    [
      "configuration",
      "model"
    ],
    [
      "configuration",
      "channel-telegram"
    ],
    [
      "configuration",
      "channel-whatsapp"
    ],
    [
      "configuration",
      "channel-discord"
    ],
    [
      "configuration",
      "channel-slack"
    ],
    [
      "configuration",
      "channel-wechat"
    ],
    [
      "configuration",
      "channel-qq"
    ],
    [
      "configuration",
      "channel-wecom"
    ],
    [
      "configuration",
      "channel-feishu"
    ],
    [
      "configuration",
      "skill"
    ],
    [
      "configuration",
      "personality"
    ],
    [
      "configuration",
      "memory"
    ],
    [
      "configuration",
      "automation"
    ],
    [
      "configuration",
      "files"
    ],
    [
      "configuration",
      "agent-chat"
    ],
    [
      "configuration",
      "diagnostics"
    ],
    [
      "configuration",
      "advanced-settings"
    ],
    [
      "configuration",
      "multiple-models"
    ],
    [
      "configuration",
      "deepseek-harness"
    ],
    [
      "use-cases",
      "personal-ai-assistant"
    ],
    [
      "use-cases",
      "chinese-messaging-channels"
    ],
    [
      "use-cases",
      "telegram-persona-agent"
    ],
    [
      "use-cases",
      "whatsapp-persona-agent"
    ],
    [
      "use-cases",
      "im-agent-persona-soul-md"
    ],
    [
      "use-cases",
      "im-agent-skill-scenarios"
    ],
    [
      "use-cases",
      "multi-channel-personality-memory"
    ],
    [
      "use-cases",
      "telegram-group-community-assistant"
    ],
    [
      "use-cases",
      "whatsapp-24-7-customer-service"
    ],
    [
      "use-cases",
      "lifelike-im-agent-rhythm-social-memory"
    ],
    [
      "use-cases",
      "telegram-whatsapp-safety-boundaries"
    ],
    [
      "use-cases",
      "daily-summary"
    ],
    [
      "use-cases",
      "hermes-agent-24-7"
    ],
    [
      "use-cases",
      "memory-and-knowledge"
    ],
    [
      "use-cases",
      "discord-community-agent"
    ],
    [
      "use-cases",
      "discord-event-agent"
    ],
    [
      "compare",
      "lightvela-vs-localhost-ai-agent"
    ],
    [
      "compare",
      "lightvela-vs-hostinger"
    ],
    [
      "compare",
      "lightvela-vs-manus"
    ],
    [
      "compare",
      "lightvela-vs-chatgpt"
    ],
    [
      "compare",
      "lightvela-vs-genspark"
    ],
    [
      "compare",
      "lightvela-vs-grok-bot"
    ],
    [
      "compare",
      "lightvela-vs-mira"
    ],
    [
      "compare",
      "lightvela-vs-viktor"
    ],
    [
      "compare",
      "lightvela-vs-today-ai"
    ],
    [
      "hermes-agent",
      "hermes-vs-openclaw"
    ],
    [
      "hermes-agent",
      "why-hermes-remembers-you"
    ],
    [
      "hermes-agent",
      "user-md-vs-memory-md"
    ],
    [
      "hermes-agent",
      "hermes-memory-curation"
    ],
    [
      "hermes-agent",
      "memory-vs-skill"
    ],
    [
      "hermes-agent",
      "model-vs-agent-layer"
    ],
    [
      "hermes-agent",
      "message-gateway"
    ],
    [
      "hermes-agent",
      "automation-scheduling"
    ],
    [
      "hermes-agent",
      "model-switching-memory"
    ],
    [
      "hermes-agent",
      "persona-user-memory"
    ],
    [
      "hermes-agent",
      "workspace-context-storage"
    ],
    [
      "hermes-agent",
      "skills-self-improvement"
    ],
    [
      "contact-us"
    ]
  ],
  "zh-hant": [
    [],
    [
      "overview"
    ],
    [
      "quickstart"
    ],
    [
      "core-concepts"
    ],
    [
      "who-is-lightvela-for"
    ],
    [
      "plans"
    ],
    [
      "announcements",
      "public-beta"
    ],
    [
      "credits"
    ],
    [
      "create-first-hermes"
    ],
    [
      "configuration"
    ],
    [
      "configuration",
      "model"
    ],
    [
      "configuration",
      "channel-telegram"
    ],
    [
      "configuration",
      "channel-whatsapp"
    ],
    [
      "configuration",
      "channel-discord"
    ],
    [
      "configuration",
      "channel-slack"
    ],
    [
      "configuration",
      "channel-wechat"
    ],
    [
      "configuration",
      "channel-qq"
    ],
    [
      "configuration",
      "channel-wecom"
    ],
    [
      "configuration",
      "channel-feishu"
    ],
    [
      "configuration",
      "skill"
    ],
    [
      "configuration",
      "personality"
    ],
    [
      "configuration",
      "memory"
    ],
    [
      "configuration",
      "automation"
    ],
    [
      "configuration",
      "files"
    ],
    [
      "configuration",
      "agent-chat"
    ],
    [
      "configuration",
      "diagnostics"
    ],
    [
      "configuration",
      "advanced-settings"
    ],
    [
      "configuration",
      "multiple-models"
    ],
    [
      "configuration",
      "deepseek-harness"
    ],
    [
      "use-cases",
      "personal-ai-assistant"
    ],
    [
      "use-cases",
      "chinese-messaging-channels"
    ],
    [
      "use-cases",
      "telegram-persona-agent"
    ],
    [
      "use-cases",
      "whatsapp-persona-agent"
    ],
    [
      "use-cases",
      "im-agent-persona-soul-md"
    ],
    [
      "use-cases",
      "im-agent-skill-scenarios"
    ],
    [
      "use-cases",
      "multi-channel-personality-memory"
    ],
    [
      "use-cases",
      "telegram-group-community-assistant"
    ],
    [
      "use-cases",
      "whatsapp-24-7-customer-service"
    ],
    [
      "use-cases",
      "lifelike-im-agent-rhythm-social-memory"
    ],
    [
      "use-cases",
      "telegram-whatsapp-safety-boundaries"
    ],
    [
      "use-cases",
      "daily-summary"
    ],
    [
      "use-cases",
      "hermes-agent-24-7"
    ],
    [
      "use-cases",
      "memory-and-knowledge"
    ],
    [
      "use-cases",
      "discord-community-agent"
    ],
    [
      "use-cases",
      "discord-event-agent"
    ],
    [
      "compare",
      "lightvela-vs-localhost-ai-agent"
    ],
    [
      "compare",
      "lightvela-vs-hostinger"
    ],
    [
      "compare",
      "lightvela-vs-manus"
    ],
    [
      "compare",
      "lightvela-vs-chatgpt"
    ],
    [
      "compare",
      "lightvela-vs-genspark"
    ],
    [
      "compare",
      "lightvela-vs-grok-bot"
    ],
    [
      "compare",
      "lightvela-vs-mira"
    ],
    [
      "compare",
      "lightvela-vs-viktor"
    ],
    [
      "compare",
      "lightvela-vs-today-ai"
    ],
    [
      "hermes-agent",
      "hermes-vs-openclaw"
    ],
    [
      "hermes-agent",
      "why-hermes-remembers-you"
    ],
    [
      "hermes-agent",
      "user-md-vs-memory-md"
    ],
    [
      "hermes-agent",
      "hermes-memory-curation"
    ],
    [
      "hermes-agent",
      "memory-vs-skill"
    ],
    [
      "hermes-agent",
      "model-vs-agent-layer"
    ],
    [
      "hermes-agent",
      "message-gateway"
    ],
    [
      "hermes-agent",
      "automation-scheduling"
    ],
    [
      "hermes-agent",
      "model-switching-memory"
    ],
    [
      "hermes-agent",
      "persona-user-memory"
    ],
    [
      "hermes-agent",
      "workspace-context-storage"
    ],
    [
      "hermes-agent",
      "skills-self-improvement"
    ],
    [
      "contact-us"
    ]
  ],
  "id-id": [
    [],
    [
      "overview"
    ],
    [
      "quickstart"
    ],
    [
      "core-concepts"
    ],
    [
      "who-is-lightvela-for"
    ],
    [
      "plans"
    ],
    [
      "announcements",
      "public-beta"
    ],
    [
      "credits"
    ],
    [
      "create-first-hermes"
    ],
    [
      "configuration"
    ],
    [
      "configuration",
      "model"
    ],
    [
      "configuration",
      "channel-telegram"
    ],
    [
      "configuration",
      "channel-whatsapp"
    ],
    [
      "configuration",
      "channel-discord"
    ],
    [
      "configuration",
      "channel-slack"
    ],
    [
      "configuration",
      "channel-wechat"
    ],
    [
      "configuration",
      "channel-qq"
    ],
    [
      "configuration",
      "channel-wecom"
    ],
    [
      "configuration",
      "channel-feishu"
    ],
    [
      "configuration",
      "skill"
    ],
    [
      "configuration",
      "personality"
    ],
    [
      "configuration",
      "memory"
    ],
    [
      "configuration",
      "automation"
    ],
    [
      "configuration",
      "files"
    ],
    [
      "configuration",
      "agent-chat"
    ],
    [
      "configuration",
      "diagnostics"
    ],
    [
      "configuration",
      "advanced-settings"
    ],
    [
      "configuration",
      "multiple-models"
    ],
    [
      "configuration",
      "deepseek-harness"
    ],
    [
      "use-cases",
      "personal-ai-assistant"
    ],
    [
      "use-cases",
      "chinese-messaging-channels"
    ],
    [
      "use-cases",
      "telegram-persona-agent"
    ],
    [
      "use-cases",
      "whatsapp-persona-agent"
    ],
    [
      "use-cases",
      "im-agent-persona-soul-md"
    ],
    [
      "use-cases",
      "im-agent-skill-scenarios"
    ],
    [
      "use-cases",
      "multi-channel-personality-memory"
    ],
    [
      "use-cases",
      "telegram-group-community-assistant"
    ],
    [
      "use-cases",
      "whatsapp-24-7-customer-service"
    ],
    [
      "use-cases",
      "lifelike-im-agent-rhythm-social-memory"
    ],
    [
      "use-cases",
      "telegram-whatsapp-safety-boundaries"
    ],
    [
      "use-cases",
      "daily-summary"
    ],
    [
      "use-cases",
      "hermes-agent-24-7"
    ],
    [
      "use-cases",
      "memory-and-knowledge"
    ],
    [
      "compare",
      "lightvela-vs-localhost-ai-agent"
    ],
    [
      "compare",
      "lightvela-vs-hostinger"
    ],
    [
      "compare",
      "lightvela-vs-manus"
    ],
    [
      "compare",
      "lightvela-vs-chatgpt"
    ],
    [
      "compare",
      "lightvela-vs-genspark"
    ],
    [
      "compare",
      "lightvela-vs-grok-bot"
    ],
    [
      "compare",
      "lightvela-vs-mira"
    ],
    [
      "compare",
      "lightvela-vs-viktor"
    ],
    [
      "compare",
      "lightvela-vs-today-ai"
    ],
    [
      "hermes-agent",
      "hermes-vs-openclaw"
    ],
    [
      "hermes-agent",
      "why-hermes-remembers-you"
    ],
    [
      "hermes-agent",
      "user-md-vs-memory-md"
    ],
    [
      "hermes-agent",
      "hermes-memory-curation"
    ],
    [
      "hermes-agent",
      "memory-vs-skill"
    ],
    [
      "hermes-agent",
      "model-vs-agent-layer"
    ],
    [
      "hermes-agent",
      "message-gateway"
    ],
    [
      "hermes-agent",
      "automation-scheduling"
    ],
    [
      "hermes-agent",
      "model-switching-memory"
    ],
    [
      "hermes-agent",
      "persona-user-memory"
    ],
    [
      "hermes-agent",
      "workspace-context-storage"
    ],
    [
      "hermes-agent",
      "skills-self-improvement"
    ],
    [
      "contact-us"
    ]
  ],
  "es": [
    [],
    [
      "overview"
    ],
    [
      "quickstart"
    ],
    [
      "core-concepts"
    ],
    [
      "who-is-lightvela-for"
    ],
    [
      "plans"
    ],
    [
      "announcements",
      "public-beta"
    ],
    [
      "credits"
    ],
    [
      "create-first-hermes"
    ],
    [
      "configuration"
    ],
    [
      "configuration",
      "model"
    ],
    [
      "configuration",
      "channel-telegram"
    ],
    [
      "configuration",
      "channel-whatsapp"
    ],
    [
      "configuration",
      "channel-discord"
    ],
    [
      "configuration",
      "channel-slack"
    ],
    [
      "configuration",
      "channel-wechat"
    ],
    [
      "configuration",
      "channel-qq"
    ],
    [
      "configuration",
      "channel-wecom"
    ],
    [
      "configuration",
      "channel-feishu"
    ],
    [
      "configuration",
      "skill"
    ],
    [
      "configuration",
      "personality"
    ],
    [
      "configuration",
      "memory"
    ],
    [
      "configuration",
      "automation"
    ],
    [
      "configuration",
      "files"
    ],
    [
      "configuration",
      "agent-chat"
    ],
    [
      "configuration",
      "diagnostics"
    ],
    [
      "configuration",
      "advanced-settings"
    ],
    [
      "configuration",
      "multiple-models"
    ],
    [
      "configuration",
      "deepseek-harness"
    ],
    [
      "use-cases",
      "personal-ai-assistant"
    ],
    [
      "use-cases",
      "chinese-messaging-channels"
    ],
    [
      "use-cases",
      "telegram-persona-agent"
    ],
    [
      "use-cases",
      "whatsapp-persona-agent"
    ],
    [
      "use-cases",
      "im-agent-persona-soul-md"
    ],
    [
      "use-cases",
      "im-agent-skill-scenarios"
    ],
    [
      "use-cases",
      "multi-channel-personality-memory"
    ],
    [
      "use-cases",
      "telegram-group-community-assistant"
    ],
    [
      "use-cases",
      "whatsapp-24-7-customer-service"
    ],
    [
      "use-cases",
      "lifelike-im-agent-rhythm-social-memory"
    ],
    [
      "use-cases",
      "telegram-whatsapp-safety-boundaries"
    ],
    [
      "use-cases",
      "daily-summary"
    ],
    [
      "use-cases",
      "hermes-agent-24-7"
    ],
    [
      "use-cases",
      "memory-and-knowledge"
    ],
    [
      "use-cases",
      "discord-community-agent"
    ],
    [
      "use-cases",
      "discord-event-agent"
    ],
    [
      "compare",
      "lightvela-vs-localhost-ai-agent"
    ],
    [
      "compare",
      "lightvela-vs-hostinger"
    ],
    [
      "compare",
      "lightvela-vs-manus"
    ],
    [
      "compare",
      "lightvela-vs-chatgpt"
    ],
    [
      "compare",
      "lightvela-vs-genspark"
    ],
    [
      "compare",
      "lightvela-vs-grok-bot"
    ],
    [
      "compare",
      "lightvela-vs-mira"
    ],
    [
      "compare",
      "lightvela-vs-viktor"
    ],
    [
      "compare",
      "lightvela-vs-today-ai"
    ],
    [
      "hermes-agent",
      "hermes-vs-openclaw"
    ],
    [
      "hermes-agent",
      "why-hermes-remembers-you"
    ],
    [
      "hermes-agent",
      "user-md-vs-memory-md"
    ],
    [
      "hermes-agent",
      "hermes-memory-curation"
    ],
    [
      "hermes-agent",
      "memory-vs-skill"
    ],
    [
      "hermes-agent",
      "model-vs-agent-layer"
    ],
    [
      "hermes-agent",
      "message-gateway"
    ],
    [
      "hermes-agent",
      "automation-scheduling"
    ],
    [
      "hermes-agent",
      "model-switching-memory"
    ],
    [
      "hermes-agent",
      "persona-user-memory"
    ],
    [
      "hermes-agent",
      "workspace-context-storage"
    ],
    [
      "hermes-agent",
      "skills-self-improvement"
    ],
    [
      "contact-us"
    ]
  ]
} as const satisfies Record<DocsRouteLocale, readonly (readonly string[])[]>;

/**
 * 每个文档路由的内容最后更新日期（YYYY-MM-DD），key 为 slug 段用 "/" 连接。
 *
 * ⚠️ 本常量是**生成产物**，由 `scripts/sync-fumadocs-content.mjs` 从
 * `src/content/docs/last-updated.json`（唯一真源）写出。**不要手工编辑**：
 * 下次 sync 会覆盖，且会与真源漂移。改日期请改真源后重跑 sync。
 *
 * 日期语义是「内容最后更新日」而**不是构建时间**：每天重新构建不会让它变化，
 * 只有内容真的改了才变（Google 要求 lastmod 一致准确，否则会忽略整个信号）。
 * 初始值由 `docs-last-updated.mjs --from-git` 从 git 历史逐篇生成，
 * 因此各篇日期不同、反映真实批次，而非全站同一天。
 *
 * 供 sitemap 的 `<lastmod>` 与文档页「最后更新于」共用，不存在第二处时间镜像。
 * 一致性由 `scripts/docs-last-updated.test.ts` 断言（产物 ↔ 真源逐条比对）。
 *
 * 类型用显式注解而非 `as const satisfies`：内层键是运行时拼出的 slug 字符串，
 * 字面量类型无法用 `string` 索引（TS7053），只能靠类型断言绕开。
 * 显式声明为 `Record<string, string | undefined>` 后既零断言，
 * 返回类型也诚实（key 不存在时确实是 undefined）。
 */
export const DOCS_LAST_UPDATED: Record<DocsRouteLocale, Record<string, string | undefined>> = {
  "en-us": {
    "overview": "2026-08-20",
    "quickstart": "2026-08-20",
    "core-concepts": "2026-08-20",
    "who-is-lightvela-for": "2026-08-20",
    "plans": "2026-08-24",
    "announcements/public-beta": "2026-08-20",
    "credits": "2026-08-20",
    "create-first-hermes": "2026-08-20",
    "configuration": "2026-08-20",
    "configuration/model": "2026-08-20",
    "configuration/channel-telegram": "2026-08-20",
    "configuration/channel-whatsapp": "2026-08-20",
    "configuration/channel-discord": "2026-08-20",
    "configuration/channel-slack": "2026-08-20",
    "configuration/channel-wechat": "2026-08-20",
    "configuration/channel-qq": "2026-08-20",
    "configuration/channel-wecom": "2026-08-20",
    "configuration/channel-feishu": "2026-08-20",
    "configuration/skill": "2026-08-20",
    "configuration/personality": "2026-08-24",
    "configuration/memory": "2026-08-20",
    "configuration/automation": "2026-08-20",
    "configuration/files": "2026-08-20",
    "configuration/agent-chat": "2026-08-20",
    "configuration/diagnostics": "2026-08-20",
    "configuration/advanced-settings": "2026-08-25",
    "configuration/multiple-models": "2026-08-28",
    "configuration/deepseek-harness": "2026-08-28",
    "use-cases/personal-ai-assistant": "2026-08-18",
    "use-cases/chinese-messaging-channels": "2026-08-21",
    "use-cases/telegram-persona-agent": "2026-08-17",
    "use-cases/whatsapp-persona-agent": "2026-08-17",
    "use-cases/im-agent-persona-soul-md": "2026-08-17",
    "use-cases/im-agent-skill-scenarios": "2026-08-17",
    "use-cases/multi-channel-personality-memory": "2026-08-17",
    "use-cases/telegram-group-community-assistant": "2026-08-17",
    "use-cases/whatsapp-24-7-customer-service": "2026-08-17",
    "use-cases/lifelike-im-agent-rhythm-social-memory": "2026-08-17",
    "use-cases/telegram-whatsapp-safety-boundaries": "2026-08-17",
    "use-cases/daily-summary": "2026-08-17",
    "use-cases/hermes-agent-24-7": "2026-08-18",
    "use-cases/memory-and-knowledge": "2026-08-17",
    "use-cases/discord-community-agent": "2026-08-21",
    "use-cases/discord-event-agent": "2026-08-21",
    "compare/lightvela-vs-localhost-ai-agent": "2026-08-18",
    "compare/lightvela-vs-hostinger": "2026-08-17",
    "compare/lightvela-vs-manus": "2026-08-18",
    "compare/lightvela-vs-chatgpt": "2026-08-18",
    "compare/lightvela-vs-genspark": "2026-08-31",
    "compare/lightvela-vs-grok-bot": "2026-08-31",
    "compare/lightvela-vs-mira": "2026-08-31",
    "compare/lightvela-vs-viktor": "2026-08-31",
    "compare/lightvela-vs-today-ai": "2026-08-31",
    "hermes-agent/hermes-vs-openclaw": "2026-08-03",
    "hermes-agent/why-hermes-remembers-you": "2026-08-18",
    "hermes-agent/user-md-vs-memory-md": "2026-08-12",
    "hermes-agent/hermes-memory-curation": "2026-08-18",
    "hermes-agent/memory-vs-skill": "2026-08-12",
    "hermes-agent/model-vs-agent-layer": "2026-08-12",
    "hermes-agent/message-gateway": "2026-08-20",
    "hermes-agent/automation-scheduling": "2026-08-12",
    "hermes-agent/model-switching-memory": "2026-08-12",
    "hermes-agent/persona-user-memory": "2026-08-12",
    "hermes-agent/workspace-context-storage": "2026-08-12",
    "hermes-agent/skills-self-improvement": "2026-08-12",
    "contact-us": "2026-08-20",
    "": "2026-08-20"
  },
  "zh-cn": {
    "overview": "2026-08-20",
    "quickstart": "2026-08-20",
    "core-concepts": "2026-08-20",
    "who-is-lightvela-for": "2026-08-20",
    "account": "2026-08-20",
    "announcements/public-beta": "2026-08-20",
    "plans": "2026-08-20",
    "credits": "2026-08-20",
    "create-first-hermes": "2026-08-20",
    "configuration": "2026-08-20",
    "configuration/model": "2026-08-20",
    "configuration/channel-wechat": "2026-08-20",
    "configuration/channel-qq": "2026-08-20",
    "configuration/channel-wecom": "2026-08-20",
    "configuration/channel-feishu": "2026-08-20",
    "configuration/skill": "2026-08-20",
    "configuration/personality": "2026-08-24",
    "configuration/memory": "2026-08-24",
    "configuration/automation": "2026-08-24",
    "configuration/files": "2026-08-24",
    "configuration/agent-chat": "2026-08-24",
    "configuration/diagnostics": "2026-08-24",
    "configuration/advanced-settings": "2026-08-25",
    "configuration/multiple-models": "2026-08-28",
    "configuration/deepseek-harness": "2026-08-28",
    "hermes-agent/hermes-vs-openclaw": "2026-08-12",
    "hermes-agent/why-hermes-remembers-you": "2026-08-12",
    "hermes-agent/user-md-vs-memory-md": "2026-08-12",
    "hermes-agent/hermes-memory-curation": "2026-08-12",
    "hermes-agent/memory-vs-skill": "2026-08-12",
    "hermes-agent/model-vs-agent-layer": "2026-08-12",
    "hermes-agent/message-gateway": "2026-08-12",
    "hermes-agent/automation-scheduling": "2026-08-12",
    "hermes-agent/model-switching-memory": "2026-08-12",
    "hermes-agent/persona-user-memory": "2026-08-12",
    "hermes-agent/workspace-context-storage": "2026-08-12",
    "hermes-agent/skills-self-improvement": "2026-08-12",
    "compare/lightvela-vs-manus": "2026-08-12",
    "compare/lightvela-vs-localhost-ai-agent": "2026-08-12",
    "compare/lightvela-vs-ai-chatbot": "2026-08-12",
    "faq": "2026-08-20",
    "contact-us": "2026-08-20",
    "": "2026-08-20"
  },
  "zh-sg": {
    "overview": "2026-08-20",
    "quickstart": "2026-08-20",
    "core-concepts": "2026-08-20",
    "who-is-lightvela-for": "2026-08-20",
    "plans": "2026-08-24",
    "announcements/public-beta": "2026-08-20",
    "credits": "2026-08-20",
    "create-first-hermes": "2026-08-20",
    "configuration": "2026-08-20",
    "configuration/model": "2026-08-20",
    "configuration/channel-telegram": "2026-08-20",
    "configuration/channel-whatsapp": "2026-08-20",
    "configuration/channel-discord": "2026-08-20",
    "configuration/channel-slack": "2026-08-20",
    "configuration/channel-wechat": "2026-08-20",
    "configuration/channel-qq": "2026-08-20",
    "configuration/channel-wecom": "2026-08-20",
    "configuration/channel-feishu": "2026-08-20",
    "configuration/skill": "2026-08-20",
    "configuration/personality": "2026-08-24",
    "configuration/memory": "2026-08-20",
    "configuration/automation": "2026-08-20",
    "configuration/files": "2026-08-20",
    "configuration/agent-chat": "2026-08-20",
    "configuration/diagnostics": "2026-08-20",
    "configuration/advanced-settings": "2026-08-25",
    "configuration/multiple-models": "2026-08-28",
    "configuration/deepseek-harness": "2026-08-28",
    "use-cases/personal-ai-assistant": "2026-08-18",
    "use-cases/chinese-messaging-channels": "2026-08-21",
    "use-cases/telegram-persona-agent": "2026-08-17",
    "use-cases/whatsapp-persona-agent": "2026-08-17",
    "use-cases/im-agent-persona-soul-md": "2026-08-17",
    "use-cases/im-agent-skill-scenarios": "2026-08-17",
    "use-cases/multi-channel-personality-memory": "2026-08-17",
    "use-cases/telegram-group-community-assistant": "2026-08-17",
    "use-cases/whatsapp-24-7-customer-service": "2026-08-17",
    "use-cases/lifelike-im-agent-rhythm-social-memory": "2026-08-17",
    "use-cases/telegram-whatsapp-safety-boundaries": "2026-08-17",
    "use-cases/daily-summary": "2026-08-17",
    "use-cases/hermes-agent-24-7": "2026-08-18",
    "use-cases/memory-and-knowledge": "2026-08-17",
    "use-cases/discord-community-agent": "2026-08-21",
    "use-cases/discord-event-agent": "2026-08-21",
    "compare/lightvela-vs-localhost-ai-agent": "2026-08-18",
    "compare/lightvela-vs-hostinger": "2026-08-17",
    "compare/lightvela-vs-manus": "2026-08-18",
    "compare/lightvela-vs-chatgpt": "2026-08-18",
    "compare/lightvela-vs-genspark": "2026-08-31",
    "compare/lightvela-vs-grok-bot": "2026-08-31",
    "compare/lightvela-vs-mira": "2026-08-31",
    "compare/lightvela-vs-viktor": "2026-08-31",
    "compare/lightvela-vs-today-ai": "2026-08-31",
    "hermes-agent/hermes-vs-openclaw": "2026-08-03",
    "hermes-agent/why-hermes-remembers-you": "2026-08-18",
    "hermes-agent/user-md-vs-memory-md": "2026-08-12",
    "hermes-agent/hermes-memory-curation": "2026-08-18",
    "hermes-agent/memory-vs-skill": "2026-08-12",
    "hermes-agent/model-vs-agent-layer": "2026-08-12",
    "hermes-agent/message-gateway": "2026-08-20",
    "hermes-agent/automation-scheduling": "2026-08-12",
    "hermes-agent/model-switching-memory": "2026-08-12",
    "hermes-agent/persona-user-memory": "2026-08-12",
    "hermes-agent/workspace-context-storage": "2026-08-12",
    "hermes-agent/skills-self-improvement": "2026-08-12",
    "contact-us": "2026-08-20",
    "": "2026-08-20"
  },
  "zh-hant": {
    "overview": "2026-08-20",
    "quickstart": "2026-08-20",
    "core-concepts": "2026-08-20",
    "who-is-lightvela-for": "2026-08-20",
    "plans": "2026-08-24",
    "announcements/public-beta": "2026-08-20",
    "credits": "2026-08-20",
    "create-first-hermes": "2026-08-20",
    "configuration": "2026-08-20",
    "configuration/model": "2026-08-20",
    "configuration/channel-telegram": "2026-08-20",
    "configuration/channel-whatsapp": "2026-08-20",
    "configuration/channel-discord": "2026-08-20",
    "configuration/channel-slack": "2026-08-20",
    "configuration/channel-wechat": "2026-08-20",
    "configuration/channel-qq": "2026-08-20",
    "configuration/channel-wecom": "2026-08-20",
    "configuration/channel-feishu": "2026-08-20",
    "configuration/skill": "2026-08-20",
    "configuration/personality": "2026-08-24",
    "configuration/memory": "2026-08-20",
    "configuration/automation": "2026-08-20",
    "configuration/files": "2026-08-20",
    "configuration/agent-chat": "2026-08-20",
    "configuration/diagnostics": "2026-08-20",
    "configuration/advanced-settings": "2026-08-25",
    "configuration/multiple-models": "2026-08-28",
    "configuration/deepseek-harness": "2026-08-28",
    "use-cases/personal-ai-assistant": "2026-08-18",
    "use-cases/chinese-messaging-channels": "2026-08-21",
    "use-cases/telegram-persona-agent": "2026-08-17",
    "use-cases/whatsapp-persona-agent": "2026-08-17",
    "use-cases/im-agent-persona-soul-md": "2026-08-17",
    "use-cases/im-agent-skill-scenarios": "2026-08-17",
    "use-cases/multi-channel-personality-memory": "2026-08-17",
    "use-cases/telegram-group-community-assistant": "2026-08-17",
    "use-cases/whatsapp-24-7-customer-service": "2026-08-17",
    "use-cases/lifelike-im-agent-rhythm-social-memory": "2026-08-17",
    "use-cases/telegram-whatsapp-safety-boundaries": "2026-08-17",
    "use-cases/daily-summary": "2026-08-17",
    "use-cases/hermes-agent-24-7": "2026-08-18",
    "use-cases/memory-and-knowledge": "2026-08-17",
    "use-cases/discord-community-agent": "2026-08-21",
    "use-cases/discord-event-agent": "2026-08-21",
    "compare/lightvela-vs-localhost-ai-agent": "2026-08-18",
    "compare/lightvela-vs-hostinger": "2026-08-17",
    "compare/lightvela-vs-manus": "2026-08-18",
    "compare/lightvela-vs-chatgpt": "2026-08-18",
    "compare/lightvela-vs-genspark": "2026-08-31",
    "compare/lightvela-vs-grok-bot": "2026-08-31",
    "compare/lightvela-vs-mira": "2026-08-31",
    "compare/lightvela-vs-viktor": "2026-08-31",
    "compare/lightvela-vs-today-ai": "2026-08-31",
    "hermes-agent/hermes-vs-openclaw": "2026-08-03",
    "hermes-agent/why-hermes-remembers-you": "2026-08-18",
    "hermes-agent/user-md-vs-memory-md": "2026-08-12",
    "hermes-agent/hermes-memory-curation": "2026-08-18",
    "hermes-agent/memory-vs-skill": "2026-08-12",
    "hermes-agent/model-vs-agent-layer": "2026-08-12",
    "hermes-agent/message-gateway": "2026-08-20",
    "hermes-agent/automation-scheduling": "2026-08-12",
    "hermes-agent/model-switching-memory": "2026-08-12",
    "hermes-agent/persona-user-memory": "2026-08-12",
    "hermes-agent/workspace-context-storage": "2026-08-12",
    "hermes-agent/skills-self-improvement": "2026-08-12",
    "contact-us": "2026-08-20",
    "": "2026-08-20"
  },
  "id-id": {
    "overview": "2026-08-20",
    "quickstart": "2026-08-20",
    "core-concepts": "2026-08-20",
    "who-is-lightvela-for": "2026-08-20",
    "plans": "2026-08-20",
    "announcements/public-beta": "2026-08-20",
    "credits": "2026-08-20",
    "create-first-hermes": "2026-08-20",
    "configuration": "2026-08-20",
    "configuration/model": "2026-08-20",
    "configuration/channel-telegram": "2026-08-20",
    "configuration/channel-whatsapp": "2026-08-20",
    "configuration/channel-discord": "2026-08-20",
    "configuration/channel-slack": "2026-08-20",
    "configuration/channel-wechat": "2026-08-20",
    "configuration/channel-qq": "2026-08-20",
    "configuration/channel-wecom": "2026-08-20",
    "configuration/channel-feishu": "2026-08-20",
    "configuration/skill": "2026-08-20",
    "configuration/personality": "2026-08-24",
    "configuration/memory": "2026-08-20",
    "configuration/automation": "2026-08-20",
    "configuration/files": "2026-08-20",
    "configuration/agent-chat": "2026-08-20",
    "configuration/diagnostics": "2026-08-20",
    "configuration/advanced-settings": "2026-08-25",
    "configuration/multiple-models": "2026-08-28",
    "configuration/deepseek-harness": "2026-08-28",
    "use-cases/personal-ai-assistant": "2026-08-18",
    "use-cases/chinese-messaging-channels": "2026-08-20",
    "use-cases/telegram-persona-agent": "2026-08-18",
    "use-cases/whatsapp-persona-agent": "2026-08-18",
    "use-cases/im-agent-persona-soul-md": "2026-08-18",
    "use-cases/im-agent-skill-scenarios": "2026-08-18",
    "use-cases/multi-channel-personality-memory": "2026-08-18",
    "use-cases/telegram-group-community-assistant": "2026-08-18",
    "use-cases/whatsapp-24-7-customer-service": "2026-08-18",
    "use-cases/lifelike-im-agent-rhythm-social-memory": "2026-08-18",
    "use-cases/telegram-whatsapp-safety-boundaries": "2026-08-18",
    "use-cases/daily-summary": "2026-08-18",
    "use-cases/hermes-agent-24-7": "2026-08-18",
    "use-cases/memory-and-knowledge": "2026-08-18",
    "compare/lightvela-vs-localhost-ai-agent": "2026-08-18",
    "compare/lightvela-vs-hostinger": "2026-08-18",
    "compare/lightvela-vs-manus": "2026-08-18",
    "compare/lightvela-vs-chatgpt": "2026-08-18",
    "compare/lightvela-vs-genspark": "2026-08-31",
    "compare/lightvela-vs-grok-bot": "2026-08-31",
    "compare/lightvela-vs-mira": "2026-08-31",
    "compare/lightvela-vs-viktor": "2026-08-31",
    "compare/lightvela-vs-today-ai": "2026-08-31",
    "hermes-agent/hermes-vs-openclaw": "2026-08-18",
    "hermes-agent/why-hermes-remembers-you": "2026-08-18",
    "hermes-agent/user-md-vs-memory-md": "2026-08-18",
    "hermes-agent/hermes-memory-curation": "2026-08-18",
    "hermes-agent/memory-vs-skill": "2026-08-18",
    "hermes-agent/model-vs-agent-layer": "2026-08-18",
    "hermes-agent/message-gateway": "2026-08-20",
    "hermes-agent/automation-scheduling": "2026-08-18",
    "hermes-agent/model-switching-memory": "2026-08-18",
    "hermes-agent/persona-user-memory": "2026-08-18",
    "hermes-agent/workspace-context-storage": "2026-08-18",
    "hermes-agent/skills-self-improvement": "2026-08-18",
    "contact-us": "2026-08-20",
    "": "2026-08-20"
  },
  "es": {
    "overview": "2026-08-26",
    "quickstart": "2026-08-26",
    "core-concepts": "2026-08-26",
    "who-is-lightvela-for": "2026-08-26",
    "plans": "2026-08-26",
    "announcements/public-beta": "2026-08-26",
    "credits": "2026-08-26",
    "create-first-hermes": "2026-08-26",
    "configuration": "2026-08-26",
    "configuration/model": "2026-08-26",
    "configuration/channel-telegram": "2026-08-26",
    "configuration/channel-whatsapp": "2026-08-26",
    "configuration/channel-discord": "2026-08-26",
    "configuration/channel-slack": "2026-08-26",
    "configuration/channel-wechat": "2026-08-26",
    "configuration/channel-qq": "2026-08-26",
    "configuration/channel-wecom": "2026-08-26",
    "configuration/channel-feishu": "2026-08-26",
    "configuration/skill": "2026-08-26",
    "configuration/personality": "2026-08-26",
    "configuration/memory": "2026-08-26",
    "configuration/automation": "2026-08-26",
    "configuration/files": "2026-08-26",
    "configuration/agent-chat": "2026-08-26",
    "configuration/diagnostics": "2026-08-26",
    "configuration/advanced-settings": "2026-08-26",
    "configuration/multiple-models": "2026-08-28",
    "configuration/deepseek-harness": "2026-08-28",
    "use-cases/personal-ai-assistant": "2026-08-26",
    "use-cases/chinese-messaging-channels": "2026-08-26",
    "use-cases/telegram-persona-agent": "2026-08-26",
    "use-cases/whatsapp-persona-agent": "2026-08-26",
    "use-cases/im-agent-persona-soul-md": "2026-08-26",
    "use-cases/im-agent-skill-scenarios": "2026-08-26",
    "use-cases/multi-channel-personality-memory": "2026-08-26",
    "use-cases/telegram-group-community-assistant": "2026-08-26",
    "use-cases/whatsapp-24-7-customer-service": "2026-08-26",
    "use-cases/lifelike-im-agent-rhythm-social-memory": "2026-08-26",
    "use-cases/telegram-whatsapp-safety-boundaries": "2026-08-26",
    "use-cases/daily-summary": "2026-08-26",
    "use-cases/hermes-agent-24-7": "2026-08-26",
    "use-cases/memory-and-knowledge": "2026-08-26",
    "use-cases/discord-community-agent": "2026-08-26",
    "use-cases/discord-event-agent": "2026-08-26",
    "compare/lightvela-vs-localhost-ai-agent": "2026-08-26",
    "compare/lightvela-vs-hostinger": "2026-08-26",
    "compare/lightvela-vs-manus": "2026-08-26",
    "compare/lightvela-vs-chatgpt": "2026-08-26",
    "compare/lightvela-vs-genspark": "2026-08-31",
    "compare/lightvela-vs-grok-bot": "2026-08-31",
    "compare/lightvela-vs-mira": "2026-08-31",
    "compare/lightvela-vs-viktor": "2026-08-31",
    "compare/lightvela-vs-today-ai": "2026-08-31",
    "hermes-agent/hermes-vs-openclaw": "2026-08-26",
    "hermes-agent/why-hermes-remembers-you": "2026-08-26",
    "hermes-agent/user-md-vs-memory-md": "2026-08-26",
    "hermes-agent/hermes-memory-curation": "2026-08-26",
    "hermes-agent/memory-vs-skill": "2026-08-26",
    "hermes-agent/model-vs-agent-layer": "2026-08-26",
    "hermes-agent/message-gateway": "2026-08-26",
    "hermes-agent/automation-scheduling": "2026-08-26",
    "hermes-agent/model-switching-memory": "2026-08-26",
    "hermes-agent/persona-user-memory": "2026-08-26",
    "hermes-agent/workspace-context-storage": "2026-08-26",
    "hermes-agent/skills-self-improvement": "2026-08-26",
    "contact-us": "2026-08-26",
    "": "2026-08-26"
  }
};

export function docsLastUpdated(locale: DocsRouteLocale, slug: readonly string[] = []): string | undefined {
  const key = slug.join('/');
  return DOCS_LAST_UPDATED[locale][key];
}

export function isDocsRouteSlug(locale: DocsRouteLocale, slug: readonly string[] = []) {
  const key = slug.join('/');
  return DOCS_ROUTE_SLUGS[locale].some((candidate) => candidate.join('/') === key);
}

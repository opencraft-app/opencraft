export const JAPANESE_DEFAULT_SEO_TITLE = "LightVela | あなた専用のクラウドAIエージェント";
export const JAPANESE_SEO_TITLE_SUFFIX = "LightVela · あなた専用のクラウドAIエージェント";
export const JAPANESE_SEO_DESCRIPTION =
  "LightVelaは、いつでも使える自分専用のAIエージェントをクラウド上で作成・運用できるマネージドプラットフォームです。";
export const JAPANESE_SEO_KEYWORDS = [
  "LightVela",
  "クラウドAIエージェント",
  "パーソナルAIエージェント",
  "AIアシスタント",
  "Hermes Agent",
  "AIエージェントホスティング",
  "自動化",
  "Telegramボット",
  "WhatsAppボット",
].join(", ");

export const JAPANESE_STATIC_PAGE_TITLES: Record<string, string> = {
  "/about": "LightVelaについて",
  "/account": "アカウント",
  "/account/orders": "注文履歴",
  "/auth/email-bind-result": "メール連携結果",
  "/auth/forgot-password": "パスワードを再設定",
  "/auth/invite": "招待コード",
  "/auth/sign-in": "ログイン",
  "/auth/sign-up": "アカウントを作成",
  "/auth/sign-up-code": "認証コードを確認",
  "/blog": "ブログ",
  "/changelog": "更新情報",
  "/cookie-policy": "Cookieポリシー",
  "/dashboard/create": "エージェントを作成",
  "/dashboard/setup": "初期設定",
  "/dashboard/success": "エージェントを作成しました",
  "/open-source-licenses": "オープンソースライセンス",
  "/plans/select": "プランを選択",
  "/privacy-policy": "プライバシーポリシー",
  "/subscribe": "プランを選択",
  "/support": "サポート・フィードバック",
  "/terms-of-service": "利用規約",
};

const JAPANESE_AGENT_SECTION_TITLES: Record<string, string> = {
  achievements: "実績",
  automations: "自動化",
  channels: "チャネル",
  chat: "チャット",
  files: "ファイル",
  memory: "メモリ",
  models: "モデル",
  persona: "ペルソナ",
  skills: "スキル",
  workbench: "ワークベンチ",
};

export function getJapaneseProductPageTitle(pathname: string): string | null {
  if (pathname === "/agents") return "マイエージェント";
  const agentSection = pathname.match(/^\/agents\/([^/]+)$/)?.[1];
  if (agentSection) return JAPANESE_AGENT_SECTION_TITLES[agentSection] ?? "マイエージェント";
  return JAPANESE_STATIC_PAGE_TITLES[pathname] ?? null;
}

export const JAPANESE_DOC_PAGE_TITLES: Record<string, string> = {
  "/docs": "ドキュメント",
  "/docs/overview": "LightVelaとは",
  "/docs/quickstart": "クイックスタート",
  "/docs/core-concepts": "基本概念",
  "/docs/configuration": "設定",
  "/docs/configuration/model": "モデル設定",
  "/docs/configuration/skill": "スキル設定",
  "/docs/configuration/automation": "自動化",
  "/docs/configuration/agent-chat": "チャット",
  "/docs/faq": "よくある質問",
  "/docs/plans": "料金プラン",
};

export const JAPANESE_PAGE_DESCRIPTIONS: Record<string, string> = {
  "/about":
    "LightVelaが、クラウドAIエージェントを分かりやすいマネージド体験として提供する理由と目指す未来を紹介します。",
  "/blog": "LightVelaのブログでは、クラウドでホストされるAIエージェントの製品発表、更新、活用事例を紹介します。",
  "/changelog":
    "LightVelaの新機能、製品アップデート、使いやすさの改善内容を確認できます。",
  "/cookie-policy":
    "LightVelaで使用するCookieの種類、目的、ユーザーが選べる管理方法について説明します。",
  "/open-source-licenses":
    "LightVelaで使用しているオープンソースソフトウェアの帰属表示とライセンス情報です。",
  "/privacy-policy":
    "LightVelaにおける個人データの取り扱い、保存、共有、ユーザーの権利について説明します。",
  "/subscribe": "Hermes Agentの利用方法に合ったLightVelaのプランを選択できます。",
  "/support": "LightVelaへのフィードバック、問題の報告、機能リクエストを送信できます。",
  "/terms-of-service": "LightVelaプラットフォームへのアクセスと利用に適用される利用規約です。",
  "/docs":
    "LightVelaのドキュメントです。クイックスタート、基本概念、モデル、チャネル、スキル、自動化の設定方法を確認できます。",
  "/docs/overview":
    "LightVelaがHermes Agentをクラウドでホストし、メモリと複数チャネルを備えた常時利用可能なパーソナルAIエージェントを提供する仕組みを紹介します。",
};

export type JapanesePublicRoutePath =
  | "/"
  | "/about"
  | "/blog"
  | "/changelog"
  | "/cookie-policy"
  | "/open-source-licenses"
  | "/privacy-policy"
  | "/subscribe"
  | "/terms-of-service";

/** Next 公开路由与运行时 SEO 共用的日语标题真源。 */
export function japaneseRouteTitle(path: JapanesePublicRoutePath): string {
  const title = path === "/" ? JAPANESE_DEFAULT_SEO_TITLE : JAPANESE_STATIC_PAGE_TITLES[path];
  if (!title) throw new Error(`[seo-data.ja] missing title for ${path}`);
  return title;
}

/** Next 公开路由与运行时 SEO 共用的日语描述真源。 */
export function japaneseRouteDescription(path: JapanesePublicRoutePath): string {
  const description = path === "/" ? JAPANESE_SEO_DESCRIPTION : JAPANESE_PAGE_DESCRIPTIONS[path];
  if (!description) throw new Error(`[seo-data.ja] missing description for ${path}`);
  return description;
}

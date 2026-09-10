// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { CuratedSkillOverview } from "./curated-skill-overviews";

type JapaneseSkillDefinition = {
  name: string;
  purpose: string;
  input: string;
  outcome: string;
  prompt: string;
};

function makeOverview(definition: JapaneseSkillDefinition): CuratedSkillOverview {
  const { name, purpose, input, outcome, prompt } = definition;
  return {
    overview: [
      `${name}は、${purpose}ためのスキルです。`,
      `${input}を指定すると、作業を整理し、${outcome}を得られるよう支援します。`,
    ],
    whoShouldUse: [
      { title: "実務担当者", description: `明確な手順で${purpose}必要がある人に適しています。` },
      { title: "運用チーム", description: `${input}から実際に使える成果を作りたいチームに適しています。` },
      { title: "意思決定者", description: `行動する前に${outcome}を確認したい人に適しています。` },
    ],
    problemsItSolves: [
      { title: "情報の分散", description: "必要な背景をまとめ、重要な手順の抜け漏れを防ぎます。" },
      { title: "不明確な成果", description: `${outcome}を作れるよう、作業を構造化します。` },
      { title: "繰り返し作業", description: "同じ種類の依頼に再利用できる、一貫した進め方を提供します。" },
    ],
    keyCapabilities: [
      { title: "構造化された分析", description: `${purpose}ために必要な作業を分解します。` },
      { title: "文脈に応じたガイド", description: `${input}に合わせて提案を調整します。` },
      { title: "分かりやすい成果", description: `${outcome}を確認しやすい形で提示します。` },
      { title: "再現可能な手順", description: "入力から成果まで、一貫したワークフローを保ちます。" },
    ],
    basicUsage: `${input}を伝え、重要な制約と必要な判断・成果物を説明してください。適用前に${name}の出力を確認します。`,
    examplePrompt: prompt,
  };
}

const DEFINITIONS: Record<string, JapaneseSkillDefinition> = {
  "charon-fan/agent-playbook/self-improving-agent": {
    name: "Self-Improving Agent", purpose: "過去の実行結果、失敗、修正から学ぶ", input: "実行時の状況、起きたこと、受け取ったフィードバック", outcome: "範囲が明確で、検証・再利用できる改善案", prompt: "この失敗した実行を振り返り、再利用できる教訓と、次回に適用する前の検証方法を提案してください。",
  },
  "vercel-labs/skills/find-skills": {
    name: "Find Skills", purpose: "特定のタスクに合う専門スキルを探す", input: "実行したいタスク、分野、必要な能力の制約", outcome: "関連性の高いスキル候補とインストール方法", prompt: "競合の料金ページを比較し、毎週変更点をまとめられるスキルを探してください。",
  },
  "steipete/clawdis/weather": {
    name: "Weather", purpose: "指定した場所の現在の天気と予報を確認する", input: "都市、地域、空港または座標と、知りたい日付の範囲", outcome: "予定を立てるために役立つ気象情報", prompt: "金曜から日曜までの京都の天気と、屋外散策に最も向いている午後を教えてください。",
  },
  "juliusbrussee/caveman/caveman": {
    name: "Caveman", purpose: "必要な技術情報を残したまま、長い回答を短くする", input: "通常の依頼と、希望する簡潔さのレベル", outcome: "直接的で短く、すぐ行動に移せる回答", prompt: "簡潔さを高めにして、デプロイ失敗の原因と次に実行する3つのコマンドを説明してください。",
  },
  "mattpocock/skills/to-issues": {
    name: "To Issues", purpose: "計画やPRDを実行可能なIssueに分割する", input: "元の文書、リポジトリ、Issue管理のルール", outcome: "範囲、受け入れ条件、依存関係が明確なIssue", prompt: "承認済みPRDをレビュー可能な縦割りIssueに分け、公開前に依存関係を示してください。",
  },
  "roin-orca/skills/simple": {
    name: "Simple", purpose: "実装前にアイデアを明確にして選択肢を比較する", input: "目的、利用者、制約、利用できる技術情報", outcome: "判断とトレードオフが記録された合意済みの方針", prompt: "この機能を整理し、実現可能な2案を比較して、実装前に選んだ方針を記録してください。",
  },
  "gracefullight/stock-checker/stock-analysis": {
    name: "Stock Analysis", purpose: "ファンダメンタルズと市場指標から株式を分析する", input: "銘柄、取引市場、期間、分析したい観点", outcome: "リスクを明示した構造的な投資分析", prompt: "この銘柄を業績、バリュエーション、トレンド、リスクから分析し、事実と推測を分けてください。",
  },
  "molezzz/openclaw-stock-skill/akshare-stock": {
    name: "AKShare Stock", purpose: "AKShareで取得できる金融データを調査・分析する", input: "資産、中国市場、確認したい指標や日付", outcome: "整理されたデータと検証可能な金融分析", prompt: "この企業の直近データを取得し、評価、業績、株価推移をまとめてください。",
  },
  "anthropics/financial-services-plugins/earnings-analysis": {
    name: "Earnings Analysis", purpose: "四半期決算、ガイダンス、事業シグナルを分析する", input: "決算資料、説明会の文字起こし、関連する財務文書", outcome: "予想との差、傾向、リスク、未解決事項の分析", prompt: "この四半期決算を分析し、前四半期および市場予想からの変化を強調してください。",
  },
  "okx/agent-skills/okx-sentiment-tracker": {
    name: "OKX Sentiment Tracker", purpose: "暗号資産市場に関するセンチメントの変化を追跡する", input: "対象資産、情報源、期間、監視したいしきい値", outcome: "市場背景とシグナルを含むセンチメント概要", prompt: "BTCとETHのセンチメントを7日間追跡し、急変時に考えられる原因とともに知らせてください。",
  },
  "phuryn/pm-skills/sentiment-analysis": {
    name: "Sentiment Analysis", purpose: "文章の感情を分類し、繰り返し現れるテーマを見つける", input: "コメント、レビュー、インタビュー、ユーザーメッセージ", outcome: "テーマ、感情の強さ、代表的な例", prompt: "このレビューを分析してテーマ別にまとめ、緊急の問題と軽微な好みを分けてください。",
  },
  "personamanagmentlayer/pcl/finance-expert": {
    name: "Finance Expert", purpose: "前提とリスクを明示して財務上の判断を分析する", input: "検討中の財務判断、利用できるデータ、時間軸", outcome: "シナリオと限界を含む分かりやすい財務分析", prompt: "この2つの財務案を比較し、前提を示して保守・基本・楽観の3シナリオを作ってください。",
  },
  "coreyhaines31/marketingskills/content-strategy": {
    name: "Content Strategy", purpose: "事業目標につながるコンテンツ戦略を設計する", input: "対象読者、製品、チャネル、目標、既存コンテンツ", outcome: "コンテンツの柱、優先順位、計画、評価指標", prompt: "この製品の四半期コンテンツ戦略を、テーマ、形式、配信、指標まで含めて作成してください。",
  },
  "coreyhaines31/marketingskills/social-content": {
    name: "Social Content", purpose: "SNSごとに適した投稿を企画・作成する", input: "ブランド、対象読者、プラットフォーム、トーン、キャンペーン", outcome: "バリエーションと行動喚起を含む明確な投稿案", prompt: "この発表をLinkedInとX向けの1週間分の投稿にし、同じ文章の繰り返しを避けてください。",
  },
  "composiohq/awesome-claude-skills/content-research-writer": {
    name: "Content Research Writer", purpose: "テーマを調査し、根拠のある原稿にまとめる", input: "テーマ、対象読者、情報源、編集上の要件", outcome: "根拠が追える、構造化された文章", prompt: "このテーマを調査して開発者向け記事を作り、出典と要確認の主張を示してください。",
  },
  "googleworkspace/cli/persona-content-creator": {
    name: "Persona Content Creator", purpose: "指定したペルソナと語り口に合うコンテンツを作る", input: "ペルソナ、目的、チャネル、トーン、参考資料", outcome: "対象読者と指定した個性に合うコンテンツ", prompt: "技術に詳しく慎重な読者向けに、誇張せず率直なトーンでこの告知を書いてください。",
  },
  "resciencelab/opc-skills/seo-geo": {
    name: "SEO GEO", purpose: "検索と生成AI回答での見つけやすさを監査・改善する", input: "URL、対象ページ、キーワード、競合、目標", outcome: "技術、編集、構造化データの改善優先順位", prompt: "この料金ページをSEOとGEOの観点で監査し、構造、引用、JSON-LDの改善を優先順に示してください。",
  },
  "mattpocock/skills/edit-article": {
    name: "Edit Article", purpose: "記事の明瞭さ、構成、正確さを改善する", input: "原稿、対象読者、トーン、編集上の制約", outcome: "元の主張を保った、より読みやすい記事", prompt: "先に節の並び替え案を示し、その後で技術的な主張を変えずに記事を編集してください。",
  },
  "karpathy/nanochat/read-arxiv-paper": {
    name: "Read arXiv Paper", purpose: "arXiv論文を読み、主要な貢献を分かりやすく説明する", input: "論文のURLまたはIDと、確認したい質問", outcome: "手法、結果、限界、重要概念の要約", prompt: "このarXiv論文を読み、主な貢献、手法、根拠、限界を説明してください。",
  },
  "googleworkspace/cli/persona-researcher": {
    name: "Persona Researcher", purpose: "特定のペルソナのニーズからテーマを調査する", input: "ペルソナ、問い、調査範囲、利用できる情報源", outcome: "その読者に重要な発見と不足情報", prompt: "中小企業のIT責任者の視点でこの製品カテゴリを調査し、判断基準、疑問、懸念をまとめてください。",
  },
  "nexscope-ai/amazon-skills/amazon-product-research": {
    name: "Amazon Product Research", purpose: "Amazonの商品と市場機会を調査する", input: "カテゴリ、市場、価格帯、キーワード、競合商品", outcome: "需要、競争、レビュー、リスクの比較", prompt: "このAmazonカテゴリを調査し、需要、競争、レビュー上の問題、差別化機会を比較してください。",
  },
  "coreyhaines31/marketingskills/customer-research": {
    name: "Customer Research", purpose: "顧客の声をニーズとメッセージに変換する", input: "インタビュー、レビュー、アンケート、問い合わせ、対象セグメント", outcome: "課題、顧客の表現、反論、機会の整理", prompt: "このインタビューを分析し、課題、望む成果、反論、代表的な発言をマップにしてください。",
  },
  "firecrawl/firecrawl-workflows/firecrawl-market-research": {
    name: "Firecrawl Market Research", purpose: "Web情報を収集して市場を調査する", input: "対象市場、企業、調べたい問い、確認すべきサイト", outcome: "出典と比較を含む競争環境の整理", prompt: "この市場を調査し、競合5社を比較して、各結論を裏づけるページを引用してください。",
  },
  "firecrawl/firecrawl-workflows/firecrawl-deep-research": {
    name: "Firecrawl Deep Research", purpose: "深く追跡可能なWeb調査を行う", input: "問い、範囲、最初の情報源、品質基準", outcome: "根拠、矛盾、不足情報を含む詳細な統合結果", prompt: "この問いを詳しく調査し、情報源を照合して、結論、不確実性、未解決事項を分けてください。",
  },
  "anthropics/skills/pdf": {
    name: "PDF", purpose: "PDF内の情報を読み取り、抽出・比較する", input: "対象PDFと、抽出、比較、要約などの目的", outcome: "文書内の位置と結びついた構造化情報", prompt: "この2つのPDFを比較し、条件の違いと、それぞれが記載されている節を示してください。",
  },
  "coreyhaines31/marketingskills/image": {
    name: "Image", purpose: "マーケティング用ビジュアルを企画・制作する", input: "目的、形式、対象読者、ブランド、参考ビジュアル", outcome: "画像生成に使えるビジュアル方針とプロンプト", prompt: "この発表向けに3つのビジュアル案を考え、それぞれ明確な画像生成プロンプトを作ってください。",
  },
  "github/awesome-copilot/prd": {
    name: "PRD", purpose: "製品アイデアを要件定義書にまとめる", input: "課題、利用者、目標、制約、技術的な背景", outcome: "範囲、利用ケース、受け入れ条件、未解決事項を含むPRD", prompt: "このアイデアを、目標、対象外、フロー、受け入れ条件、リスクを含む簡潔なPRDにしてください。",
  },
  "google-labs-code/stitch-skills/enhance-prompt": {
    name: "Enhance Prompt", purpose: "プロンプトを明確で制御しやすい形に改善する", input: "元のプロンプト、対象ツール、期待する成果", outcome: "制約が明示された、より構造的なプロンプト", prompt: "このUI生成プロンプトの意図を保ち、構造、状態、視覚的制約を加えて改善してください。",
  },
  "github/awesome-copilot/documentation-writer": {
    name: "Documentation Writer", purpose: "コードと背景情報から役立つ技術文書を作る", input: "コード、インターフェース、対象読者、文書の種類", outcome: "例と重要な制約を含む明確なドキュメント", prompt: "初心者向けにこのAPIを文書化し、要件、最小例、よくあるエラー、トラブル対処を含めてください。",
  },
  "wshobson/agents/data-storytelling": {
    name: "Data Storytelling", purpose: "データ分析を理解しやすい物語に変える", input: "データ、分析結果、対象読者、支援したい意思決定", outcome: "背景、根拠、推奨ビジュアル、結論を含むストーリー", prompt: "この結果を経営層向けに、背景、3つの発見、推奨グラフ、提案する判断の順でまとめてください。",
  },
};

export const CURATED_SKILL_OVERVIEWS_JA: Readonly<Record<string, CuratedSkillOverview>> =
  Object.fromEntries(Object.entries(DEFINITIONS).map(([rawId, definition]) => [rawId, makeOverview(definition)]));

// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { HermesAutomationBlueprint } from "../../lib/hermes-cron-client";

export type AutomationTemplateCategory =
  | "daily"
  | "productivity"
  | "monitoring"
  | "wellbeing"
  | "learning";

export type AutomationTemplatePreviewKind =
  | "briefing"
  | "mail"
  | "reminder"
  | "review"
  | "monitor"
  | "learning"
  | "wellbeing";

export interface AutomationTemplateSchedule {
  kind: "recurring" | "interval" | "once";
  period?: "daily" | "weekly" | "monthly";
  time?: string;
  times?: string[];
  weekday?: number;
  weekdays?: number[];
  monthday?: number;
  monthdays?: number[];
  intervalNum?: number;
  intervalUnit?: "m" | "h" | "d";
}

export interface AutomationCatalogTemplate {
  id: string;
  source: "lightvela" | "hermes";
  name: string;
  description: string;
  category: AutomationTemplateCategory;
  tags: string[];
  prompt: string;
  executionRules?: string;
  schedule: AutomationTemplateSchedule;
  scheduleLabel: string;
  deliver?: string;
  skills: string[];
  notificationPolicy: "always" | "only-when-needed";
  previewKind: AutomationTemplatePreviewKind;
}

export interface AutomationTemplateInput {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: AutomationTemplateSchedule;
  skills?: string[];
}

export const HERMES_BLUEPRINT_OVERLAPS = new Set([
  "hydration-move",
  "weekly-review",
  "workday-start",
  "news-digest",
  "bill-renewal-watch",
  "habit-checkin",
]);

function baselineBlueprint(
  key: string,
  title: string,
  description: string,
  category: string,
  scheduleHuman: string,
  schedule: string,
  prompt: string,
  skills: string[] = [],
): HermesAutomationBlueprint {
  return {
    key,
    title,
    description,
    category,
    tags: [],
    fields: [],
    scheduleHuman,
    spec: { name: title, prompt, schedule, deliver: "origin", skills },
  };
}

/**
 * Hermes 官方 Blueprint Catalog 的可用基线。
 *
 * 旧版 Agent、本地预览或瞬时网络失败时仍展示完整模板；一旦运行时返回同名
 * blueprint，下面的基线会被真实 spec 覆盖，避免前端目录与 Agent 能力脱节。
 */
export const HERMES_AUTOMATION_BLUEPRINT_BASELINE: readonly HermesAutomationBlueprint[] = [
  baselineBlueprint(
    "morning-brief",
    "Morning briefing",
    "Start the day with weather, calendar, priorities, and one practical suggestion.",
    "daily",
    "daily at 08:00",
    "0 8 * * *",
    "Create today's morning briefing with Shanghai weather, three important events, two priorities, and one action.",
    ["google-workspace"],
  ),
  baselineBlueprint(
    "important-mail",
    "Important email monitor",
    "Check the inbox and alert only when a message genuinely needs attention.",
    "monitoring",
    "every 30 minutes",
    "*/30 * * * *",
    "Check new email and alert me only when something needs a reply, decision, or action today.",
    ["email-inbox-triage"],
  ),
  baselineBlueprint(
    "custom-reminder",
    "Custom reminder",
    "Turn a short instruction into a useful recurring reminder.",
    "productivity",
    "daily at 14:00",
    "0 14 * * *",
    "Remind me to stretch for five minutes and drink a glass of water before 2 PM.",
  ),
  baselineBlueprint(
    "evening-winddown",
    "Evening wind-down",
    "Review tomorrow's schedule and prepare the few things that matter tonight.",
    "daily",
    "daily at 21:00",
    "0 21 * * *",
    "Summarize tomorrow's schedule, what I should prepare tonight, and one closing suggestion.",
    [],
  ),
  baselineBlueprint(
    "price-watch",
    "Price and availability watch",
    "Track a product, flight, or hotel and alert only when the target condition is met.",
    "monitoring",
    "every 6 hours",
    "0 */6 * * *",
    "Watch AirPods Pro and alert me when the total price falls below CNY 1,500 or stock returns.",
    ["product-price-monitor"],
  ),
  baselineBlueprint(
    "competitor-watch",
    "Competitor watch",
    "Track meaningful product, pricing, funding, and business changes.",
    "monitoring",
    "weekdays at 10:00",
    "0 10 * * 1-5",
    "Watch Alibaba Cloud, Huawei Cloud, and DigitalOcean for important product, pricing, and business changes.",
    ["competitor-news-monitor"],
  ),
  baselineBlueprint(
    "meal-plan",
    "Weekly meal plan",
    "Plan simple meals around preferences and combine everything into one shopping list.",
    "wellbeing",
    "weekly on Sunday at 18:00",
    "0 18 * * 0",
    "Plan next week's dinners for two: light, low-oil, non-spicy, under 30 minutes, with one grocery list.",
  ),
  baselineBlueprint(
    "learn-daily",
    "Daily learning",
    "Build knowledge through one short lesson, a real example, and a review question.",
    "learning",
    "daily at 20:00",
    "0 20 * * *",
    "Teach me one 10-minute AI Agent lesson with a concept, real example, and review question.",
    [],
  ),
  baselineBlueprint(
    "gratitude-journal",
    "Gratitude journal",
    "Close the day with one gentle prompt for gratitude and reflection.",
    "wellbeing",
    "daily at 21:30",
    "30 21 * * *",
    "Ask me to note one thing that went well, one thing I appreciate, and one small win today.",
  ),
  baselineBlueprint(
    "on-this-day",
    "On this day",
    "Discover one memorable historical event, science fact, or word each day.",
    "learning",
    "daily at 09:00",
    "0 9 * * *",
    "Share one technology or internet event connected to today's date and briefly explain why it matters.",
    [],
  ),
];

const HERMES_ZH_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "晨间简报",
    description: "每天汇总日历、天气和需要优先处理的事项",
    prompt: "生成今日晨间简报，包含上海天气、3 个重要日程、2 项优先事项和一句行动建议。",
  },
  "important-mail": {
    name: "重要邮件监控",
    description: "定期检查收件箱，只提醒真正需要处理的邮件",
    prompt: "检查新邮件，只提醒今天需要回复、需要决策或有明确截止时间的内容。",
  },
  "custom-reminder": {
    name: "自定义提醒",
    description: "用自己的话设置一项可重复的日常提醒",
    prompt: "提醒我今天 14:00 前起身活动 5 分钟并喝一杯水。",
  },
  "evening-winddown": {
    name: "晚间收尾",
    description: "睡前回顾明日安排和今晚需要准备的事项",
    prompt: "整理明日安排、今晚需要准备的事项和一条收尾建议。",
  },
  "price-watch": {
    name: "价格与库存监控",
    description: "持续关注商品、航班或酒店，达到目标条件再提醒",
    prompt: "监控 AirPods Pro，到手价低于 1500 元或恢复库存时提醒。",
  },
  "competitor-watch": {
    name: "竞品动态监控",
    description: "跟踪竞品发布、定价、融资和重要经营变化",
    prompt: "监控阿里云、华为云和 DigitalOcean 的产品、价格及重要经营变化。",
  },
  "meal-plan": {
    name: "每周膳食计划",
    description: "按饮食偏好生成下周菜单和合并采购清单",
    prompt: "为 2 人规划下周晚餐：清淡、少油、不吃辣，每餐 30 分钟内，并生成采购清单。",
  },
  "learn-daily": {
    name: "每日学习",
    description: "每天推送一个循序渐进的短知识点",
    prompt: "每天用 10 分钟学习 AI Agent：一个知识点、一个真实例子和一道复习题。",
  },
  "gratitude-journal": {
    name: "感恩与复盘",
    description: "每天用一个温和问题记录收获和小进步",
    prompt: "提醒我记录今天一件顺利的事、一件感恩的事和一个小进步。",
  },
  "on-this-day": {
    name: "历史上的今天",
    description: "每天发现一个历史事件、科学事实或今日词汇",
    prompt: "分享一条与今天有关的科技或互联网历史事件，并简要说明意义。",
  },
};

const HERMES_ZH_HANT_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "晨間簡報",
    description: "每天彙整日曆、天氣和需要優先處理的事項",
    prompt: "產生今日晨間簡報，包含上海天氣、3 個重要行程、2 項優先事項和一句行動建議。",
  },
  "important-mail": {
    name: "重要郵件監控",
    description: "定期檢查收件匣，只提醒真正需要處理的郵件",
    prompt: "檢查新郵件，只提醒今天需要回覆、需要決策或有明確截止時間的內容。",
  },
  "custom-reminder": {
    name: "自訂提醒",
    description: "用自己的話設定一項可重複的日常提醒",
    prompt: "提醒我今天 14:00 前起身活動 5 分鐘並喝一杯水。",
  },
  "evening-winddown": {
    name: "晚間收尾",
    description: "睡前回顧明日安排和今晚需要準備的事項",
    prompt: "整理明日安排、今晚需要準備的事項和一則收尾建議。",
  },
  "price-watch": {
    name: "價格與庫存監控",
    description: "持續關注商品、航班或飯店，達到目標條件再提醒",
    prompt: "監控 AirPods Pro，到手價低於 1500 元或恢復庫存時提醒。",
  },
  "competitor-watch": {
    name: "競品動態監控",
    description: "追蹤競品發布、定價、融資和重要營運變化",
    prompt: "監控阿里雲、華為雲和 DigitalOcean 的產品、價格及重要營運變化。",
  },
  "meal-plan": {
    name: "每週膳食計劃",
    description: "按飲食偏好產生下週菜單和合併採購清單",
    prompt: "為 2 人規劃下週晚餐：清淡、少油、不吃辣，每餐 30 分鐘內，並產生採購清單。",
  },
  "learn-daily": {
    name: "每日學習",
    description: "每天推送一個循序漸進的短知識點",
    prompt: "每天用 10 分鐘學習 AI Agent：一個知識點、一個真實例子和一道複習題。",
  },
  "gratitude-journal": {
    name: "感恩與回顧",
    description: "每天用一個溫和問題記錄收穫和小進步",
    prompt: "提醒我記錄今天一件順利的事、一件感恩的事和一個小進步。",
  },
  "on-this-day": {
    name: "歷史上的今天",
    description: "每天發現一個歷史事件、科學事實或今日詞彙",
    prompt: "分享一則與今天有關的科技或網際網路歷史事件，並簡要說明意義。",
  },
};

const HERMES_ES_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "Resumen matutino",
    description: "Empieza el día con el tiempo, el calendario, las prioridades y una sugerencia práctica.",
    prompt: "Crea el resumen de hoy con el tiempo en Shanghái, tres eventos importantes, dos prioridades y una acción.",
  },
  "important-mail": {
    name: "Monitor de correos importantes",
    description: "Revisa la bandeja de entrada y avisa solo de los correos que requieren atención.",
    prompt: "Revisa los correos nuevos y avísame solo si hoy requieren respuesta, decisión o acción.",
  },
  "custom-reminder": {
    name: "Recordatorio personalizado",
    description: "Convierte una instrucción breve en un recordatorio recurrente útil.",
    prompt: "Recuérdame levantarme cinco minutos y beber un vaso de agua antes de las 14:00.",
  },
  "evening-winddown": {
    name: "Cierre del día",
    description: "Revisa la agenda de mañana y lo que conviene preparar esta noche.",
    prompt: "Resume la agenda de mañana, lo que debo preparar esta noche y una sugerencia final.",
  },
  "price-watch": {
    name: "Monitor de precio y disponibilidad",
    description: "Sigue un producto, vuelo u hotel y avisa cuando se cumpla la condición objetivo.",
    prompt: "Vigila los AirPods Pro y avísame si el precio baja de 1.500 CNY o vuelve a haber stock.",
  },
  "competitor-watch": {
    name: "Monitor de competidores",
    description: "Sigue cambios importantes de productos, precios, financiación y negocio.",
    prompt: "Sigue los cambios importantes de productos, precios y negocio de Alibaba Cloud, Huawei Cloud y DigitalOcean.",
  },
  "meal-plan": {
    name: "Plan semanal de comidas",
    description: "Planifica comidas sencillas según tus preferencias y crea una lista de compra única.",
    prompt: "Planifica cinco cenas para dos: ligeras, con poco aceite, sin picante y listas en 30 minutos; añade una lista de compra.",
  },
  "learn-daily": {
    name: "Aprendizaje diario",
    description: "Aprende con una lección breve, un ejemplo real y una pregunta de repaso.",
    prompt: "Enséñame una lección de 10 minutos sobre agentes de IA con un concepto, un ejemplo real y una pregunta de repaso.",
  },
  "gratitude-journal": {
    name: "Diario de gratitud",
    description: "Cierra el día con una pregunta amable para agradecer y reflexionar.",
    prompt: "Pídeme anotar algo que salió bien, algo que agradezco y un pequeño logro de hoy.",
  },
  "on-this-day": {
    name: "Tal día como hoy",
    description: "Descubre cada día un hecho histórico, científico o una palabra memorable.",
    prompt: "Comparte un hecho tecnológico o de Internet relacionado con la fecha de hoy y explica brevemente su importancia.",
  },
};

const HERMES_ID_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "Ringkasan pagi",
    description: "Mulai hari dengan cuaca, kalender, prioritas, dan satu saran praktis.",
    prompt: "Buat ringkasan pagi hari ini dengan cuaca Shanghai, tiga agenda penting, dua prioritas, dan satu tindakan.",
  },
  "important-mail": {
    name: "Pantau email penting",
    description: "Periksa kotak masuk dan beri tahu hanya saat ada email yang perlu ditangani.",
    prompt: "Periksa email baru dan beri tahu hanya jika hari ini perlu balasan, keputusan, atau tindakan.",
  },
  "custom-reminder": {
    name: "Pengingat khusus",
    description: "Ubah instruksi singkat menjadi pengingat berulang yang berguna.",
    prompt: "Ingatkan saya untuk berdiri selama lima menit dan minum segelas air sebelum pukul 14.00.",
  },
  "evening-winddown": {
    name: "Penutup hari",
    description: "Tinjau jadwal besok dan hal penting yang perlu disiapkan malam ini.",
    prompt: "Ringkas jadwal besok, hal yang perlu saya siapkan malam ini, dan satu saran penutup.",
  },
  "price-watch": {
    name: "Pantau harga dan stok",
    description: "Pantau produk, penerbangan, atau hotel dan beri tahu saat target tercapai.",
    prompt: "Pantau AirPods Pro dan beri tahu jika harga turun di bawah CNY 1.500 atau stok tersedia kembali.",
  },
  "competitor-watch": {
    name: "Pantau kompetitor",
    description: "Ikuti perubahan penting pada produk, harga, pendanaan, dan bisnis kompetitor.",
    prompt: "Pantau perubahan penting pada produk, harga, dan bisnis Alibaba Cloud, Huawei Cloud, serta DigitalOcean.",
  },
  "meal-plan": {
    name: "Rencana makan mingguan",
    description: "Susun menu sederhana sesuai preferensi dan gabungkan dalam satu daftar belanja.",
    prompt: "Susun makan malam lima hari untuk dua orang: ringan, sedikit minyak, tidak pedas, maksimal 30 menit, beserta daftar belanja.",
  },
  "learn-daily": {
    name: "Belajar harian",
    description: "Bangun pengetahuan lewat pelajaran singkat, contoh nyata, dan pertanyaan ulasan.",
    prompt: "Ajari saya satu pelajaran AI Agent selama 10 menit dengan konsep, contoh nyata, dan pertanyaan ulasan.",
  },
  "gratitude-journal": {
    name: "Jurnal syukur",
    description: "Akhiri hari dengan satu pertanyaan ringan untuk bersyukur dan berefleksi.",
    prompt: "Minta saya mencatat satu hal yang berjalan baik, satu hal yang saya syukuri, dan satu pencapaian kecil hari ini.",
  },
  "on-this-day": {
    name: "Hari ini dalam sejarah",
    description: "Temukan peristiwa sejarah, fakta sains, atau kata menarik setiap hari.",
    prompt: "Bagikan satu peristiwa teknologi atau internet yang terkait dengan tanggal hari ini dan jelaskan singkat maknanya.",
  },
};

const HERMES_JA_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "朝のブリーフィング",
    description: "天気、予定、優先事項、実用的な提案で一日を始めます。",
    prompt: "上海の天気、重要な予定3件、優先事項2件、今日の行動1つを含む朝のブリーフィングを作成してください。",
  },
  "important-mail": {
    name: "重要メール監視",
    description: "受信箱を確認し、対応が必要なメールだけを通知します。",
    prompt: "新着メールを確認し、今日中に返信、判断、対応が必要なものだけ通知してください。",
  },
  "custom-reminder": {
    name: "カスタムリマインダー",
    description: "短い指示を実用的な繰り返しリマインダーにします。",
    prompt: "14時までに5分間立って体を動かし、水を一杯飲むよう知らせてください。",
  },
  "evening-winddown": {
    name: "夜の振り返り",
    description: "明日の予定と今夜準備する大切なことを確認します。",
    prompt: "明日の予定、今夜準備すべきこと、最後の提案を1つまとめてください。",
  },
  "price-watch": {
    name: "価格・在庫監視",
    description: "商品、航空券、ホテルを追跡し、条件を満たした時だけ通知します。",
    prompt: "AirPods Proを監視し、価格が1,500元未満になるか在庫が戻ったら通知してください。",
  },
  "competitor-watch": {
    name: "競合動向監視",
    description: "競合の製品、価格、資金調達、事業の重要な変化を追跡します。",
    prompt: "Alibaba Cloud、Huawei Cloud、DigitalOceanの製品、価格、事業の重要な変化を監視してください。",
  },
  "meal-plan": {
    name: "週間献立",
    description: "好みに合う簡単な献立を作り、買い物リストを1つにまとめます。",
    prompt: "2人分の平日夕食を、軽め、油少なめ、辛くせず、30分以内で作れる内容にし、買い物リストも作ってください。",
  },
  "learn-daily": {
    name: "毎日の学習",
    description: "短いレッスン、実例、復習問題で知識を積み上げます。",
    prompt: "AI Agentについて、概念、実例、復習問題を含む10分間のレッスンを1つ教えてください。",
  },
  "gratitude-journal": {
    name: "感謝日記",
    description: "感謝と振り返りのための優しい問いで一日を締めくくります。",
    prompt: "今日うまくいったこと、感謝していること、小さな達成を1つずつ尋ねてください。",
  },
  "on-this-day": {
    name: "今日は何の日",
    description: "歴史的出来事、科学の事実、印象的な言葉を毎日1つ紹介します。",
    prompt: "今日の日付に関連する技術またはインターネットの出来事を1つ紹介し、重要性を簡潔に説明してください。",
  },
};

const HERMES_KO_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "아침 브리핑",
    description: "날씨, 일정, 우선순위와 실용적인 제안으로 하루를 시작합니다.",
    prompt: "상하이 날씨, 중요한 일정 3개, 우선순위 2개, 오늘의 행동 1개를 포함한 아침 브리핑을 작성하세요.",
  },
  "important-mail": {
    name: "중요 메일 모니터",
    description: "받은편지함을 확인하고 처리가 필요한 메일만 알려줍니다.",
    prompt: "새 메일을 확인하고 오늘 답장, 결정 또는 조치가 필요한 경우에만 알려주세요.",
  },
  "custom-reminder": {
    name: "맞춤 알림",
    description: "짧은 요청을 유용한 반복 알림으로 만듭니다.",
    prompt: "오후 2시 전에 5분간 일어나 움직이고 물 한 잔을 마시도록 알려주세요.",
  },
  "evening-winddown": {
    name: "저녁 마무리",
    description: "내일 일정과 오늘 밤 준비할 중요한 일을 확인합니다.",
    prompt: "내일 일정, 오늘 밤 준비할 일, 마무리 제안 1개를 정리해주세요.",
  },
  "price-watch": {
    name: "가격 및 재고 모니터",
    description: "상품, 항공편 또는 호텔을 추적하고 목표 조건을 충족할 때만 알려줍니다.",
    prompt: "AirPods Pro를 모니터링하고 가격이 1,500위안 미만이거나 재입고되면 알려주세요.",
  },
  "competitor-watch": {
    name: "경쟁사 동향",
    description: "경쟁사의 제품, 가격, 투자 및 사업상 중요한 변화를 추적합니다.",
    prompt: "Alibaba Cloud, Huawei Cloud, DigitalOcean의 제품, 가격 및 사업상 중요한 변화를 모니터링해주세요.",
  },
  "meal-plan": {
    name: "주간 식단",
    description: "취향에 맞는 간단한 식단을 짜고 장보기 목록을 하나로 정리합니다.",
    prompt: "2인분 평일 저녁을 담백하고 기름과 매운맛은 적게, 30분 안에 만들 수 있게 계획하고 장보기 목록도 작성해주세요.",
  },
  "learn-daily": {
    name: "매일 학습",
    description: "짧은 수업, 실제 예시, 복습 질문으로 지식을 쌓습니다.",
    prompt: "AI Agent에 대해 개념, 실제 예시, 복습 질문이 포함된 10분 수업을 하나 알려주세요.",
  },
  "gratitude-journal": {
    name: "감사 일기",
    description: "감사와 성찰을 돕는 따뜻한 질문 하나로 하루를 마무리합니다.",
    prompt: "오늘 잘된 일, 감사한 일, 작은 성취를 하나씩 적도록 물어봐 주세요.",
  },
  "on-this-day": {
    name: "오늘의 역사",
    description: "기억할 만한 역사적 사건, 과학 사실 또는 단어를 매일 하나 소개합니다.",
    prompt: "오늘 날짜와 관련된 기술 또는 인터넷 사건 하나를 소개하고 왜 중요한지 간단히 설명해주세요.",
  },
};

function getHermesLocalizedCopy(locale: string) {
  const normalizedLocale = locale.toLowerCase();
  if (normalizedLocale.startsWith("zh-hant")) return HERMES_ZH_HANT_COPY;
  if (normalizedLocale.startsWith("zh")) return HERMES_ZH_COPY;
  if (normalizedLocale.startsWith("es")) return HERMES_ES_COPY;
  if (normalizedLocale.startsWith("id")) return HERMES_ID_COPY;
  if (normalizedLocale.startsWith("ja")) return HERMES_JA_COPY;
  if (normalizedLocale.startsWith("ko")) return HERMES_KO_COPY;
  return undefined;
}

const HERMES_EXECUTION_RULES_BY_KEY: Record<string, string> = {
  "morning-brief": "Use connected sources when available. If calendar or email is unavailable, provide the date and local weather, then explain how to connect it.",
  "important-mail": "Check only messages received since the previous run. Include sender, subject, why it matters, and the next action. If no message qualifies, return exactly [SILENT]. If email is not connected, explain how to connect it.",
  "custom-reminder": "Return one friendly, actionable reminder without extra explanation.",
  "evening-winddown": "Use the connected calendar when available. If it is unavailable, provide tomorrow's local weather and a brief sign-off.",
  "price-watch": "On the first run, confirm the exact item and verify one live source. Compare normalized price and stock with the last known good state, deduplicate alerts, and include current price, difference, stock, and a source link. Never replace good state with a failed fetch. If the condition is unmet and nothing important changed, return exactly [SILENT].",
  "competitor-watch": "Collect changes incrementally and report only material new developments. Deduplicate the underlying event and include its date, impact, and source links. If nothing material is new, return exactly [SILENT].",
  "meal-plan": "List each day's meal with a short method and estimated time. Finish with one consolidated grocery list grouped by aisle.",
  "learn-daily": "Build on earlier lessons without repeating them. Include one concrete example, a short preview of tomorrow, and one question that checks understanding.",
  "gratitude-journal": "Ask one warm question. If the user replies, acknowledge it kindly.",
  "on-this-day": "Use a reliable source and keep the answer to one or two useful sentences without filler.",
};

const QUIET_MONITOR_EXECUTION_RULES = "Treat this as a stateful monitor. Alert only when the condition is met or a meaningful new change appears, include essential evidence, and deduplicate equivalent results. If nothing needs attention, return exactly [SILENT].";
export const AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH = 1000;
const INTERNAL_RULES_OPEN_PREFIX = '<lightvela_internal_rules version="1" checksum="';
const INTERNAL_RULES_CLOSE = "</lightvela_internal_rules>";

function internalRulesChecksum(visiblePrompt: string, executionRules: string): string {
  let hash = 0x811c9dc5;
  const value = `${visiblePrompt}\u0000${executionRules}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function composeAutomationExecutionPrompt(visiblePrompt: string, executionRules?: string): string {
  const visible = visiblePrompt.trim();
  const rules = executionRules?.trim();
  const opening = rules
    ? `${INTERNAL_RULES_OPEN_PREFIX}${internalRulesChecksum(visible, rules)}">`
    : "";
  return rules
    ? `${visible}\n\n${opening}\n${rules}\n${INTERNAL_RULES_CLOSE}`
    : visible;
}

export function getAutomationVisiblePromptMaxLength(executionRules?: string): number {
  const rules = executionRules?.trim();
  if (!rules) return AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH;
  const envelopeLength = composeAutomationExecutionPrompt("", rules).length;
  return Math.max(0, AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH - envelopeLength);
}

export function splitAutomationExecutionPrompt(prompt: string): {
  visiblePrompt: string;
  executionRules?: string;
} {
  const normalizedPrompt = prompt.trimEnd();
  const opening = `\n\n${INTERNAL_RULES_OPEN_PREFIX}`;
  const openingEnd = `">\n`;
  const closing = `\n${INTERNAL_RULES_CLOSE}`;
  const openIndex = normalizedPrompt.lastIndexOf(opening);
  if (openIndex < 0 || !normalizedPrompt.endsWith(closing)) return { visiblePrompt: prompt };
  const checksumStart = openIndex + opening.length;
  const checksumEnd = normalizedPrompt.indexOf(openingEnd, checksumStart);
  if (checksumEnd < 0) return { visiblePrompt: prompt };
  const checksum = normalizedPrompt.slice(checksumStart, checksumEnd);
  const rulesStart = checksumEnd + openingEnd.length;
  const executionRules = normalizedPrompt.slice(rulesStart, -closing.length).trim();
  if (!executionRules) return { visiblePrompt: prompt };
  const visiblePrompt = normalizedPrompt.slice(0, openIndex).trim();
  if (checksum !== internalRulesChecksum(visiblePrompt, executionRules)) return { visiblePrompt: prompt };
  return {
    visiblePrompt,
    executionRules,
  };
}

const QUIET_BLUEPRINTS = new Set(["important-mail", "price-watch", "competitor-watch"]);
const FEATURED_RESULT_BLUEPRINTS = ["morning-brief", "price-watch", "learn-daily", "meal-plan"] as const;
const LEGACY_SKILL_ALIASES_BY_BLUEPRINT: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  "morning-brief": {
    weather: null,
    calendar: "google-workspace",
    "web-search": null,
    web_search: null,
  },
  "evening-winddown": { weather: null, calendar: null, "web-search": null, web_search: null },
  "price-watch": { "web-search": null, web_search: null },
  "competitor-watch": { "web-search": null, web_search: null },
  "learn-daily": { "web-search": null, web_search: null },
  "on-this-day": { "web-search": null, web_search: null },
};

function normalizeBlueprintSkills(blueprintKey: string, skills: readonly string[]): string[] {
  const aliases = LEGACY_SKILL_ALIASES_BY_BLUEPRINT[blueprintKey];
  const normalized = skills.flatMap((slug) => {
    const trimmed = slug.trim();
    const alias = aliases?.[trimmed.toLocaleLowerCase()];
    if (alias === null) return [];
    return [alias ?? trimmed];
  });
  return [...new Set(normalized)];
}

const CATEGORY_BY_KEY: Record<string, AutomationTemplateCategory> = {
  "morning-brief": "daily",
  "important-mail": "monitoring",
  "custom-reminder": "productivity",
  "evening-winddown": "daily",
  "price-watch": "monitoring",
  "competitor-watch": "monitoring",
  "meal-plan": "wellbeing",
  "learn-daily": "learning",
  "gratitude-journal": "wellbeing",
  "on-this-day": "learning",
};

const PREVIEW_BY_KEY: Record<string, AutomationTemplatePreviewKind> = {
  "morning-brief": "briefing",
  "important-mail": "mail",
  "custom-reminder": "reminder",
  "evening-winddown": "review",
  "price-watch": "monitor",
  "competitor-watch": "monitor",
  "meal-plan": "wellbeing",
  "learn-daily": "learning",
  "gratitude-journal": "wellbeing",
  "on-this-day": "learning",
};

const LIGHTVELA_CATEGORY_BY_ID: Record<string, AutomationTemplateCategory> = {
  "daily-summary": "productivity",
  "morning-start": "daily",
  "weekly-review": "productivity",
  "task-tidy": "productivity",
  stretch: "wellbeing",
  "news-digest": "daily",
  "medication-once": "wellbeing",
  "rent-reminder": "productivity",
  "country-fx-alert": "monitoring",
  "calorie-fitness-checkin": "wellbeing",
  "global-holiday-reminder": "monitoring",
  "stock-info-digest": "monitoring",
};

const LIGHTVELA_PREVIEW_BY_ID: Record<string, AutomationTemplatePreviewKind> = {
  "daily-summary": "review",
  "morning-start": "briefing",
  "weekly-review": "review",
  "task-tidy": "reminder",
  stretch: "wellbeing",
  "news-digest": "briefing",
  "medication-once": "wellbeing",
  "rent-reminder": "reminder",
  "country-fx-alert": "monitor",
  "calorie-fitness-checkin": "wellbeing",
  "global-holiday-reminder": "monitor",
  "stock-info-digest": "monitor",
};

const LIGHTVELA_QUIET_IDS = new Set([
  "country-fx-alert",
  "global-holiday-reminder",
  "stock-info-digest",
]);

function parseWeekdays(value: string): number[] {
  const values = new Set<number>();
  for (const part of value.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let day = start; day <= end; day += 1) values.add(day);
    } else if (/^\d$/.test(part)) {
      values.add(Number(part));
    }
  }
  return [...values].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
}

export function toAutomationTemplateSchedule(schedule: string): AutomationTemplateSchedule | null {
  const normalized = schedule.trim();
  const minuteInterval = /^\*\/(\d+) \* \* \* \*$/.exec(normalized);
  if (minuteInterval) {
    return { kind: "interval", intervalNum: Number(minuteInterval[1]), intervalUnit: "m" };
  }
  const hourInterval = /^0 \*\/(\d+) \* \* \*$/.exec(normalized);
  if (hourInterval) {
    return { kind: "interval", intervalNum: Number(hourInterval[1]), intervalUnit: "h" };
  }
  const cron = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}(?:,\d{1,2})*) \* (\*|[0-6](?:[-,][0-6])*)$/.exec(normalized);
  if (!cron) return null;
  const minute = Number(cron[1]);
  const hour = Number(cron[2]);
  if (minute > 59 || hour > 23) return null;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const monthdays = cron[3];
  const weekdays = cron[4];
  if (!monthdays || !weekdays) return null;
  if (monthdays === "*" && weekdays === "*") {
    return { kind: "recurring", period: "daily", time };
  }
  if (monthdays === "*") {
    const parsedWeekdays = parseWeekdays(weekdays);
    if (parsedWeekdays.length === 0) return null;
    return {
      kind: "recurring",
      period: "weekly",
      time,
      // Keep the legacy scalar for older form controls; `weekdays` retains the complete schedule.
      weekday: parsedWeekdays[0],
      weekdays: parsedWeekdays,
    };
  }
  if (weekdays === "*") {
    const parsedMonthdays = monthdays.split(",").map(Number).filter((day) => day >= 1 && day <= 31);
    if (parsedMonthdays.length === 0) return null;
    return {
      kind: "recurring",
      period: "monthly",
      time,
      // Keep the legacy scalar for older form controls; `monthdays` retains the complete schedule.
      monthday: parsedMonthdays[0],
      monthdays: parsedMonthdays,
    };
  }
  return null;
}

function zhScheduleLabel(schedule: AutomationTemplateSchedule): string {
  if (schedule.kind === "interval") {
    const unit = schedule.intervalUnit === "m" ? "分钟" : schedule.intervalUnit === "d" ? "天" : "小时";
    return `每 ${schedule.intervalNum ?? 1} ${unit}`;
  }
  if (schedule.period === "daily") return `每天 ${schedule.time ?? ""}`.trim();
  if (schedule.period === "weekly") return `每周定时 · ${schedule.time ?? ""}`.trim();
  if (schedule.period === "monthly") return `每月定时 · ${schedule.time ?? ""}`.trim();
  return "按计划执行";
}

function zhHantScheduleLabel(schedule: AutomationTemplateSchedule): string {
  if (schedule.kind === "interval") {
    const unit = schedule.intervalUnit === "m" ? "分鐘" : schedule.intervalUnit === "d" ? "天" : "小時";
    return `每 ${schedule.intervalNum ?? 1} ${unit}`;
  }
  if (schedule.period === "daily") return `每天 ${schedule.time ?? ""}`.trim();
  if (schedule.period === "weekly") return `每週定時 · ${schedule.time ?? ""}`.trim();
  if (schedule.period === "monthly") return `每月定時 · ${schedule.time ?? ""}`.trim();
  return "按計劃執行";
}

function enScheduleLabel(schedule: AutomationTemplateSchedule): string {
  if (schedule.kind === "interval") {
    const unit = schedule.intervalUnit === "m" ? "minutes" : schedule.intervalUnit === "d" ? "days" : "hours";
    return `Every ${schedule.intervalNum ?? 1} ${unit}`;
  }
  if (schedule.period === "daily") return `Daily at ${schedule.time ?? ""}`.trim();
  if (schedule.period === "weekly") return `Weekly · ${schedule.time ?? ""}`.trim();
  if (schedule.period === "monthly") return `Monthly · ${schedule.time ?? ""}`.trim();
  return "Runs on schedule";
}

function localizedScheduleLabel(schedule: AutomationTemplateSchedule, locale: string): string {
  const normalizedLocale = locale.toLowerCase();
  if (normalizedLocale.startsWith("zh-hant")) return zhHantScheduleLabel(schedule);
  if (normalizedLocale.startsWith("zh")) return zhScheduleLabel(schedule);
  const amount = schedule.intervalNum ?? 1;
  if (normalizedLocale.startsWith("es")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "minutos" : schedule.intervalUnit === "d" ? "días" : "horas";
      return `Cada ${amount} ${unit}`;
    }
    if (schedule.period === "daily") return `Cada día a las ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `Cada semana · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `Cada mes · ${schedule.time ?? ""}`.trim();
    return "Se ejecuta según lo programado";
  }
  if (normalizedLocale.startsWith("id")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "menit" : schedule.intervalUnit === "d" ? "hari" : "jam";
      return `Setiap ${amount} ${unit}`;
    }
    if (schedule.period === "daily") return `Setiap hari pukul ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `Setiap minggu · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `Setiap bulan · ${schedule.time ?? ""}`.trim();
    return "Berjalan sesuai jadwal";
  }
  if (normalizedLocale.startsWith("ja")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "分" : schedule.intervalUnit === "d" ? "日" : "時間";
      return `${amount}${unit}ごと`;
    }
    if (schedule.period === "daily") return `毎日 ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `毎週 · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `毎月 · ${schedule.time ?? ""}`.trim();
    return "スケジュールどおりに実行";
  }
  if (normalizedLocale.startsWith("ko")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "분" : schedule.intervalUnit === "d" ? "일" : "시간";
      return `${amount}${unit}마다`;
    }
    if (schedule.period === "daily") return `매일 ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `매주 · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `매월 · ${schedule.time ?? ""}`.trim();
    return "예약대로 실행";
  }
  return enScheduleLabel(schedule);
}

export function enrichLightVelaAutomationTemplates(
  templates: readonly AutomationTemplateInput[],
  locale: string,
): AutomationCatalogTemplate[] {
  return templates.map((template) => ({
    ...template,
    source: "lightvela",
    category: LIGHTVELA_CATEGORY_BY_ID[template.id] ?? "productivity",
    tags: [],
    scheduleLabel: localizedScheduleLabel(template.schedule, locale),
    deliver: "local",
    skills: template.skills ?? [],
    ...(LIGHTVELA_QUIET_IDS.has(template.id) ? { executionRules: QUIET_MONITOR_EXECUTION_RULES } : {}),
    notificationPolicy: LIGHTVELA_QUIET_IDS.has(template.id) ? "only-when-needed" : "always",
    previewKind: LIGHTVELA_PREVIEW_BY_ID[template.id] ?? "reminder",
  }));
}

export function mergeAutomationTemplateCatalog(
  lightvelaTemplates: readonly AutomationCatalogTemplate[],
  blueprints: readonly HermesAutomationBlueprint[],
  locale: string,
): AutomationCatalogTemplate[] {
  const localizedCopy = getHermesLocalizedCopy(locale);
  const runtimeBlueprintsByKey = new Map(blueprints.map((blueprint) => [blueprint.key, blueprint]));
  const blueprintsByKey = new Map(HERMES_AUTOMATION_BLUEPRINT_BASELINE.map((blueprint) => [blueprint.key, blueprint]));
  for (const blueprint of blueprints) blueprintsByKey.set(blueprint.key, blueprint);
  const hermesTemplates = [...blueprintsByKey.values()].flatMap((blueprint): AutomationCatalogTemplate[] => {
    if (HERMES_BLUEPRINT_OVERLAPS.has(blueprint.key)) return [];
    const schedule = toAutomationTemplateSchedule(blueprint.spec.schedule);
    if (!schedule) return [];
    const localized = localizedCopy?.[blueprint.key];
    const curatedBaseline = HERMES_AUTOMATION_BLUEPRINT_BASELINE.find((item) => item.key === blueprint.key);
    const prompt = (localized?.prompt ?? curatedBaseline?.spec.prompt ?? blueprint.spec.prompt)
      .slice(0, AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH);
    const runtimePrompt = runtimeBlueprintsByKey.get(blueprint.key)?.spec.prompt.trim();
    const curatedExecutionRules = HERMES_EXECUTION_RULES_BY_KEY[blueprint.key];
    const combinedExecutionRules = [runtimePrompt, curatedExecutionRules]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const executionRules = composeAutomationExecutionPrompt(prompt, combinedExecutionRules).length
      <= AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH
      ? combinedExecutionRules
      : curatedExecutionRules;
    return [{
      id: blueprint.key,
      source: "hermes",
      name: localized?.name ?? blueprint.title,
      description: localized?.description ?? blueprint.description,
      category: CATEGORY_BY_KEY[blueprint.key] ?? "productivity",
      tags: blueprint.tags,
      prompt,
      ...(curatedBaseline && executionRules ? { executionRules } : {}),
      schedule,
      scheduleLabel: localized ? localizedScheduleLabel(schedule, locale) : blueprint.scheduleHuman,
      deliver: blueprint.spec.deliver,
      skills: normalizeBlueprintSkills(blueprint.key, blueprint.spec.skills),
      notificationPolicy: QUIET_BLUEPRINTS.has(blueprint.key) ? "only-when-needed" : "always",
      previewKind: PREVIEW_BY_KEY[blueprint.key] ?? "reminder",
    }];
  });
  const featuredTemplates = FEATURED_RESULT_BLUEPRINTS.flatMap((id) => {
    const template = hermesTemplates.find((item) => item.id === id);
    return template ? [template] : [];
  });
  const featuredIds = new Set(featuredTemplates.map((template) => template.id));
  return [
    ...featuredTemplates,
    ...lightvelaTemplates,
    ...hermesTemplates.filter((template) => !featuredIds.has(template.id)),
  ];
}

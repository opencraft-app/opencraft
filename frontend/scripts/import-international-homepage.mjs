import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as OpenCC from "opencc-js";

import { initializeInternationalHomeFragmentAccessibility } from "./international-home-fragment-accessibility.mjs";
import { optimizeInternationalHomeVoiceAvatars } from "./international-home-voice-avatars.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, "..");
const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error("Usage: node scripts/import-international-homepage.mjs <approved-static-homepage-root>");
}

const sourceRoot = path.resolve(sourceArgument);
const targetRoot = path.join(frontendRoot, "public/lightvela-intl-home");
const preservedHarnessAssetNames = [
  "deepseek-harness-en-us.png",
  "deepseek-harness-zh-cn.png",
  "deepseek-harness-zh-sg.png",
  "deepseek-harness-zh-hant.png",
  "deepseek-harness-id-id.png",
  "deepseek-harness-es.png",
  "deepseek-harness-ja-jp.png",
  "deepseek-harness-ko-kr.png",
];
const zhHantConverter = OpenCC.Converter({ from: "cn", to: "tw" });
const supportedLocales = ["en-US", "zh-CN", "zh-SG", "zh-Hant", "id-ID", "es", "ja-JP", "ko-KR"];
const sourceFileByLocale = {
  "en-US": "index-en.html",
  "zh-CN": "index.html",
  "zh-SG": "index.html",
  "zh-Hant": "index.html",
  "id-ID": "index-en.html",
  es: "index-en.html",
  "ja-JP": "index-en.html",
  "ko-KR": "index-en.html",
};
const publicPrefixByLocale = {
  "en-US": "",
  "zh-CN": "/zh-cn",
  "zh-SG": "/zh-sg",
  "zh-Hant": "/zh-hant",
  "id-ID": "/id-id",
  es: "/es",
  "ja-JP": "/ja-jp",
  "ko-KR": "/ko-kr",
};
const publicLocalizedPaths = [
  "/",
  "/about",
  "/changelog",
  "/blog",
  "/docs",
  "/open-source-licenses",
  "/privacy-policy",
  "/subscribe",
  "/support",
  "/terms-of-service",
];
const rotatorWordsByLocale = {
  "en-US": ["knowledge base", "monitoring radar", "reminder scheduler", "business assistant", "life concierge", "work assistant"],
  "zh-CN": ["知识库", "监控雷达", "定时闹钟", "经营助手", "生活管家", "工作助理"],
  "zh-SG": ["知识库", "监控雷达", "定时闹钟", "经营助手", "生活管家", "工作助理"],
  "zh-Hant": ["知識庫", "監控雷達", "定時鬧鐘", "經營助手", "生活管家", "工作助理"],
  "id-ID": ["basis pengetahuan", "radar pemantau", "pengingat terjadwal", "asisten bisnis", "pengelola hidup", "asisten kerja"],
  es: ["base de conocimiento", "radar de monitoreo", "recordatorio programado", "asistente de negocio", "gestor personal", "asistente de trabajo"],
  "ja-JP": ["ナレッジベース", "監視レーダー", "予約リマインダー", "ビジネスアシスタント", "生活マネージャー", "仕事アシスタント"],
  "ko-KR": ["지식 베이스", "모니터링 레이더", "예약 알림", "비즈니스 어시스턴트", "생활 매니저", "업무 어시스턴트"],
};
const heroLiveCopyByLocale = {
  "en-US": {
    replyText: "Your AI companion is waiting to start. Create it in Workbench. If your plan is not active yet, go to Pricing first.",
    linkText: "Create in workbench",
    pricingText: "View pricing",
    pricingHref: "/subscribe",
    you: "You",
    justNow: "just now",
  },
  "zh-CN": {
    replyText: "你的 AI 伙伴等待启动中，请去工作台创建；如果还没有购买，先去购买页。",
    linkText: "去工作台创建",
    pricingText: "去购买页",
    pricingHref: "/subscribe",
    you: "我",
    justNow: "刚刚",
  },
  "zh-SG": {
    replyText: "你的 AI 伙伴等待启动中，请去工作台创建；如果还没有购买，先去购买页。",
    linkText: "去工作台创建",
    pricingText: "去购买页",
    pricingHref: "/zh-sg/subscribe",
    you: "我",
    justNow: "刚刚",
  },
  "zh-Hant": {
    replyText: "你的 AI 夥伴等待啟動中，請去工作臺創建；如果還沒有購買，先去購買頁。",
    linkText: "去工作臺創建",
    pricingText: "去購買頁",
    pricingHref: "/zh-hant/subscribe",
    you: "我",
    justNow: "剛剛",
  },
  "id-ID": {
    replyText: "Pendamping AI kamu siap dimulai. Buat di ruang kerja. Jika paket belum aktif, buka halaman harga lebih dulu.",
    linkText: "Buka ruang kerja",
    pricingText: "Lihat harga",
    pricingHref: "/id-id/subscribe",
    you: "Anda",
    justNow: "baru saja",
  },
  es: {
    replyText: "Tu compañero de IA está listo para empezar. Créalo en el área de trabajo. Si tu plan aún no está activo, ve primero a precios.",
    linkText: "Abrir área de trabajo",
    pricingText: "Ver precios",
    pricingHref: "/es/subscribe",
    you: "Tú",
    justNow: "ahora",
  },
  "ja-JP": {
    replyText: "あなたのAIパートナーは起動待ちです。ワークベンチで作成してください。プランがまだ有効でない場合は、先に料金ページへ進んでください。",
    linkText: "ワークベンチで作成",
    pricingText: "料金を見る",
    pricingHref: "/ja-jp/subscribe",
    you: "あなた",
    justNow: "たった今",
  },
  "ko-KR": {
    replyText: "당신의 AI 파트너가 시작을 기다리고 있습니다. 워크벤치에서 먼저 만들어 주세요. 플랜이 아직 활성화되지 않았다면 요금 페이지로 먼저 이동하세요.",
    linkText: "워크벤치에서 만들기",
    pricingText: "요금 보기",
    pricingHref: "/ko-kr/subscribe",
    you: "나",
    justNow: "방금",
  },
};
const coreCopyByLocale = {
  "en-US": {
    "Nasdaq Brief": "Market Brief",
    "Market brief is ready:": "Market brief is ready:",
    "LightVela: market brief is ready": "LightVela: market brief is ready",
    "Add Soul, Skills, and Automations so I learn faster.": "Add Automations, Workbench, and DeepSeek Harness so I learn faster.",
    Workbench: "Workbench",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.",
  },
  "zh-CN": {
    "LightVela · AI companion in the cloud": "LightVela · 云端 AI 伙伴",
    "Hand your ideas to Hermes Agent,": "把想法交给 Hermes Agent，",
    "keep them moving in the cloud.": "让它们在云端持续推进。",
    "My AI companion": "我的智能体伙伴",
    "Thank you Hermes for the technical support provided to LightVela.": "感谢 Hermes 为 LightVela 提供技术支持。",
    "Ready to set off with you at any time.": "随时准备和你一起启程。",
    "Nasdaq Brief": "市场简报",
    "Market brief is ready:": "市场简报已生成：",
    "LightVela: market brief is ready": "LightVela：市场简报已生成",
    "想让我更快学习，可以加 人设 / Skill / 自动任务": "想让我更快学习，可以加 自动任务 / 工作台 / DeepSeek Harness",
    "人设 / Skill / 自动任务": "自动任务 / 工作台 / DeepSeek Harness",
    "产品文档": "文档",
    "工作台": "工作台",
    Workbench: "工作台",
    "Workbench · Pricing · Channels": "工作台 · 购买页 · 通道",
    "AI Companion Setup": "AI 伙伴设置",
    "Plan Status": "套餐状态",
    "Ready to create.": "准备好创建。",
    "Start from Workbench": "从工作台开始",
    "Pricing check": "购买检查",
    "Channel Setup": "通道设置",
    "Channels ready": "通道已就绪",
    "Assistant Notes": "AI 伙伴笔记",
    "Preferences saved.": "偏好已保存。",
    "Cloud Status": "云端状态",
    "Running in the cloud.": "云端运行中。",
    Skills: "技能",
    "Knowledge and automations": "知识与自动化",
    "Help Digest": "帮助摘要",
    "Setup tips are ready.": "设置建议已就绪。",
    Integrations: "集成",
    "Supported channels connected.": "支持的通道已连接。",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. 版权所有。由 Tencent Lighthouse 构建。",
    Product: "产品",
    "14-day free trial": "14 天免费试用",
    Pricing: "定价",
    "WhatsApp setup guide": "接入 WhatsApp 指引",
    "Telegram setup guide": "接入 Telegram 指引",
    "Discord setup guide": "接入 Discord 指引",
    "Product Introduction": "产品介绍",
    "Scenario Examples": "场景示例",
    "How to Start": "如何开始",
    "Help & Feedback": "帮助与反馈",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVela 让你的个人 AI 伙伴在云端长期在线。",
    "Create it once, connect your channels, and let it keep learning how you work.": "创建一次，接入常用通道，让它持续学习你的工作方式。",
    Legal: "法律",
    "Privacy Policy": "隐私政策",
    "Terms of Service": "服务条款",
    "Data Processing Notice": "数据处理说明",
    "Open Source Statement": "开源声明",
    "Open Source Notice": "开源声明",
    Analysis: "分析",
    "Self-hosting analysis": "本地部署分析",
    "Hostinger analysis": "Hostinger 分析",
    "Manus analysis": "Manus 分析",
    "ChatGPT analysis": "ChatGPT 分析",
    "Genspark analysis": "Genspark 分析",
    Community: "社区",
    Company: "公司",
    "About Us": "关于我们",
    "Related products": "相关产品",
    "Tencent CloudBase": "腾讯云开发 Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
  },
  "zh-SG": {
    "LightVela · AI companion in the cloud": "LightVela · 云端 AI 伙伴",
    "Hand your ideas to Hermes Agent,": "把想法交给 Hermes Agent，",
    "keep them moving in the cloud.": "让它们在云端持续推进。",
    "My AI companion": "我的智能体伙伴",
    "Thank you Hermes for the technical support provided to LightVela.": "感谢 Hermes 为 LightVela 提供技术支持。",
    "Ready to set off with you at any time.": "随时准备和你一起启程。",
    "Nasdaq Brief": "市场简报",
    "Market brief is ready:": "市场简报已生成：",
    "LightVela: market brief is ready": "LightVela：市场简报已生成",
    "想让我更快学习，可以加 人设 / Skill / 自动任务": "想让我更快学习，可以加 自动任务 / 工作台 / DeepSeek Harness",
    "人设 / Skill / 自动任务": "自动任务 / 工作台 / DeepSeek Harness",
    "产品文档": "文档",
    "工作台": "工作台",
    Workbench: "工作台",
    "Workbench · Pricing · Channels": "工作台 · 购买页 · 通道",
    "AI Companion Setup": "AI 伙伴设置",
    "Plan Status": "套餐状态",
    "Ready to create.": "准备好创建。",
    "Start from Workbench": "从工作台开始",
    "Pricing check": "购买检查",
    "Channel Setup": "通道设置",
    "Channels ready": "通道已就绪",
    "Assistant Notes": "AI 伙伴笔记",
    "Preferences saved.": "偏好已保存。",
    "Cloud Status": "云端状态",
    "Running in the cloud.": "云端运行中。",
    Skills: "技能",
    "Knowledge and automations": "知识与自动化",
    "Help Digest": "帮助摘要",
    "Setup tips are ready.": "设置建议已就绪。",
    Integrations: "集成",
    "Supported channels connected.": "支持的通道已连接。",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. 版权所有。由 Tencent Lighthouse 构建。",
    Product: "产品",
    "14-day free trial": "14 天免费试用",
    Pricing: "定价",
    "WhatsApp setup guide": "接入 WhatsApp 指引",
    "Telegram setup guide": "接入 Telegram 指引",
    "Discord setup guide": "接入 Discord 指引",
    "Product Introduction": "产品介绍",
    "Scenario Examples": "场景示例",
    "How to Start": "如何开始",
    "Help & Feedback": "帮助与反馈",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVela 让你的个人 AI 伙伴在云端长期在线。",
    "Create it once, connect your channels, and let it keep learning how you work.": "创建一次，接入常用通道，让它持续学习你的工作方式。",
    Legal: "法律",
    "Privacy Policy": "隐私政策",
    "Terms of Service": "服务条款",
    "Data Processing Notice": "数据处理说明",
    "Open Source Statement": "开源声明",
    "Open Source Notice": "开源声明",
    Analysis: "分析",
    "Self-hosting analysis": "本地部署分析",
    "Hostinger analysis": "Hostinger 分析",
    "Manus analysis": "Manus 分析",
    "ChatGPT analysis": "ChatGPT 分析",
    "Genspark analysis": "Genspark 分析",
    Community: "社区",
    Company: "公司",
    "About Us": "关于我们",
    "Related products": "相关产品",
    "Tencent CloudBase": "腾讯云开发 Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
  },
  "zh-Hant": {
    "LightVela · AI companion in the cloud": "LightVela · 雲端 AI 夥伴",
    "Hand your ideas to Hermes Agent,": "把想法交給 Hermes Agent，",
    "keep them moving in the cloud.": "讓它們在雲端持續推進。",
    "My AI companion": "我的智能體夥伴",
    "Thank you Hermes for the technical support provided to LightVela.": "感謝 Hermes 為 LightVela 提供技術支援。",
    "Ready to set off with you at any time.": "隨時準備和你一起啟程。",
    "Nasdaq Brief": "市場簡報",
    "Market brief is ready:": "市場簡報已生成：",
    "LightVela: market brief is ready": "LightVela：市場簡報已生成",
    "想让我更快学习，可以加 人设 / Skill / 自动任务": "想讓我更快學習，可以加 自動任務 / 工作臺 / DeepSeek Harness",
    "人设 / Skill / 自动任务": "自動任務 / 工作臺 / DeepSeek Harness",
    "产品文档": "文檔",
    "產品文檔": "文檔",
    "工作台": "工作臺",
    Workbench: "工作臺",
    "Workbench · Pricing · Channels": "工作臺 · 購買頁 · 通道",
    "AI Companion Setup": "AI 夥伴設置",
    "Plan Status": "套餐狀態",
    "Ready to create.": "準備好創建。",
    "Start from Workbench": "從工作臺開始",
    "Pricing check": "購買檢查",
    "Channel Setup": "通道設置",
    "Channels ready": "通道已就緒",
    "Assistant Notes": "AI 夥伴筆記",
    "Preferences saved.": "偏好已保存。",
    "Cloud Status": "雲端狀態",
    "Running in the cloud.": "雲端運行中。",
    Skills: "技能",
    "Knowledge and automations": "知識與自動化",
    "Help Digest": "幫助摘要",
    "Setup tips are ready.": "設置建議已就緒。",
    Integrations: "集成",
    "Supported channels connected.": "支持的通道已連接。",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. 版權所有。由 Tencent Lighthouse 構建。",
    Product: "產品",
    "14-day free trial": "14 天免費試用",
    Pricing: "定價",
    "WhatsApp setup guide": "接入 WhatsApp 指引",
    "Telegram setup guide": "接入 Telegram 指引",
    "Discord setup guide": "接入 Discord 指引",
    "Product Introduction": "產品介紹",
    "Scenario Examples": "場景示例",
    "How to Start": "如何開始",
    "Help & Feedback": "幫助與反饋",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVela 讓你的個人 AI 夥伴在雲端長期在線。",
    "Create it once, connect your channels, and let it keep learning how you work.": "創建一次，接入常用通道，讓它持續學習你的工作方式。",
    Legal: "法律",
    "Privacy Policy": "隱私政策",
    "Terms of Service": "服務條款",
    "Data Processing Notice": "資料處理說明",
    "Open Source Statement": "開源聲明",
    "Open Source Notice": "開源聲明",
    Analysis: "分析",
    "Self-hosting analysis": "本地部署分析",
    "Hostinger analysis": "Hostinger 分析",
    "Manus analysis": "Manus 分析",
    "ChatGPT analysis": "ChatGPT 分析",
    "Genspark analysis": "Genspark 分析",
    Community: "社群",
    Company: "公司",
    "About Us": "關於我們",
    "Related products": "相關產品",
    "Tencent CloudBase": "騰訊雲開發 Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
  },
  "id-ID": {
    Home: "Beranda",
    Pricing: "Harga",
    Docs: "Dokumentasi",
    Changelog: "Catatan Rilis",
    About: "Tentang",
    "LightVela · AI companion in the cloud": "LightVela · pendamping AI di cloud",
    "Nasdaq Brief": "Ringkasan Pasar",
    "Market Brief": "Ringkasan Pasar",
    "LightVela: market brief is ready": "LightVela: ringkasan pasar sudah siap",
    "LightVela: Nasdaq sector brief is ready": "LightVela: ringkasan sektor Nasdaq sudah siap",
    "Market brief is ready:": "Ringkasan pasar sudah siap:",
    "Nasdaq sector brief is ready:": "Ringkasan sektor Nasdaq sudah siap:",
    "Nasdaq Sector Brief - Aug 27, 2026 Close": "Ringkasan Sektor Nasdaq - Penutupan 27 Agu 2026",
    "Market tone: tech-led, very narrow breadth": "Nada pasar: dipimpin teknologi, breadth sangat sempit",
    "I will pull conversion data this afternoon.": "Saya akan menarik data konversi sore ini.",
    "read the last week of messages. What is blocking us right now?": "baca pesan minggu lalu. Apa yang sedang menghambat kita?",
    "Done. Lin sends design a usable copy draft today; you add conversion data this afternoon; Alex books the first customer today and the other two tomorrow and Thursday. I will @ each owner before their deadline.": "Selesai. Lin mengirim draf copy yang siap dipakai hari ini; Anda menambahkan data konversi sore ini; Alex menjadwalkan pelanggan pertama hari ini dan dua lainnya besok serta Kamis. Saya akan @ tiap owner sebelum tenggat.",
    "Your AI companion—always on, always evolving with you.": "Semakin sering dipakai, semakin memahami kamu, mitra AI yang selalu aktif",
    "LightVela can become your": "LightVela dapat menjadi",
    "knowledge base": "basis pengetahuan",
    "My AI Companion": "Pendamping AI saya",
    Chats: "Chat",
    Status: "Status",
    Channels: "Kanal",
    Calls: "Panggilan",
    "Search or start a new chat": "Cari atau mulai chat baru",
    All: "Semua",
    Unread: "Belum dibaca",
    Groups: "Grup",
    Today: "Hari ini",
    Me: "Saya",
    You: "Anda",
    "Type a message": "Ketik pesan",
    "Send a message to #todo": "Kirim pesan ke #todo",
    "Message # chat": "Pesan # chat",
    Search: "Cari",
    "From first hello to trusted companion": "Dari sapaan pertama hingga pendamping tepercaya",
    "Let me learn your world": "Biarkan saya mengenal dunia Anda",
    "Connect me to supported channels such as": "Hubungkan saya ke kanal yang didukung seperti",
    "WhatsApp, Telegram, Slack, and Discord": "WhatsApp, Telegram, Slack, dan Discord",
    ", so your family, friends, and teammates can @ me where they already talk.": ", agar keluarga, teman, dan rekan tim dapat @ saya di tempat mereka biasa berbicara.",
    "I can be the person you want to talk to, or your own extension.": "Saya bisa menjadi teman bicara Anda, atau perpanjangan diri Anda sendiri.",
    "I read long group threads, summarize them, and help answer.": "Saya membaca utas grup yang panjang, merangkumnya, dan membantu menjawab.",
    "I can show up on schedule, like your best reminder.": "Saya bisa hadir sesuai jadwal, seperti pengingat terbaik Anda.",
    "Then I become your best working partner": "Lalu saya menjadi partner kerja terbaik Anda",
    "Give me your materials and I organize them myself. What you give me": "Berikan materi Anda dan saya akan menatanya. Semua yang Anda berikan",
    "belongs only to you": "hanya milik Anda",
    ", and I do not rummage through your computer.": ", dan saya tidak menelusuri komputer Anda.",
    "Drop in PDF, Word, Markdown, and more.": "Masukkan PDF, Word, Markdown, dan lainnya.",
    "Add Soul, Skills, and Automations so I learn faster.": "Tambahkan Automations, Workbench, dan DeepSeek Harness agar saya belajar lebih cepat.",
    "Long memory, quick recall, fast response.": "Memori panjang, cepat mengingat, cepat merespons.",
    "After that, I stay always on": "Setelah itu, saya tetap selalu aktif",
    "I stay available 24/7 in the cloud, so you never need to leave your computer running. Whenever you correct me, I turn your feedback into a new rule and apply it next time.": "Saya berjalan di cloud dan tersedia 24/7, jadi komputer Anda tidak perlu terus menyala. Setiap kali Anda mengoreksi saya, saya menyimpannya sebagai aturan baru dan mengikuti preferensi Anda berikutnya.",
    "I organize group context and unanswered threads.": "Saya menata konteks grup dan utas yang belum terjawab.",
    "Scheduled work runs by itself.": "Pekerjaan terjadwal berjalan sendiri.",
    "For real decisions, I ask you first.": "Untuk keputusan penting, saya bertanya kepada Anda lebih dulu.",
    "What LightVela Can Do": "Yang Dapat Dilakukan LightVela",
    Skill: "Skill",
    "Gives AI professional capability": "Memberi AI kemampuan profesional",
    Soul: "Soul",
    "Gives AI personality and memory": "Memberi AI kepribadian dan memori",
    "Work assistant": "Asisten kerja",
    Knowledge: "Pengetahuan",
    "Monitoring radar": "Radar pemantau",
    "Scheduled reminder": "Pengingat terjadwal",
    "Business assistant": "Asisten bisnis",
    "Life manager": "Pengelola hidup",
    "Project schedules and maintenance": "Jadwal dan pemeliharaan proyek",
    "Coordinate calendars and find meeting windows from chat context": "Selaraskan kalender dan temukan waktu rapat dari konteks chat",
    "Turn meetings into decisions, owners, risks, and next steps": "Ubah rapat menjadi keputusan, pemilik, risiko, dan langkah berikutnya",
    "Track delayed items and draft weekly status reports": "Lacak item tertunda dan susun laporan mingguan",
    "Document and material processing": "Pemrosesan dokumen dan materi",
    "Read PDFs, meeting notes, spreadsheets, and links": "Baca PDF, catatan rapat, spreadsheet, dan tautan",
    "Collaboration follow-through": "Tindak lanjut kolaborasi",
    "Read cross-channel context": "Baca konteks lintas kanal",
    "Turn threads into tasks, reminders, and response drafts": "Ubah utas menjadi tugas, pengingat, dan draf balasan",
    "Pause before decisions that need human judgment": "Berhenti sebelum keputusan yang perlu penilaian manusia",
    "Scheduled reminders": "Pengingat terjadwal",
    "Condition alerts": "Peringatan kondisi",
    "Habit reminders": "Pengingat kebiasaan",
    "Personal knowledge Q&A": "Tanya jawab pengetahuan pribadi",
    "Auto-archive meetings and files": "Arsip otomatis rapat dan file",
    "Remember preferences and context": "Ingat preferensi dan konteks",
    "Market and info radar": "Radar pasar dan informasi",
    "Order and service anomalies": "Anomali pesanan dan layanan",
    "Opportunity and content monitoring": "Pemantauan peluang dan konten",
    "Receipt OCR and budgets": "OCR struk dan anggaran",
    "Contracts, invoices, and payment": "Kontrak, invoice, dan pembayaran",
    "Business daily and trends": "Harian bisnis dan tren",
    "Family calendar and chores": "Kalender keluarga dan tugas rumah",
    "Meal planning and groceries": "Rencana makan dan belanja",
    "Weather, voice, and quick asks": "Cuaca, suara, dan pertanyaan cepat",
    "How to Get Started": "Cara Memulai",
    "Create an Assistant": "Buat Asisten",
    "Name it, choose a model, and it is waiting in the cloud once it shows Running.": "Beri nama, pilih model, dan saat statusnya Running, ia siap di cloud.",
    "Connect Channels": "Hubungkan Kanal",
    "Connect supported platforms such as WhatsApp, Telegram, Slack, and Discord, including multiple channels at once.": "Hubungkan platform yang didukung seperti WhatsApp, Telegram, Slack, dan Discord, termasuk beberapa kanal sekaligus.",
    "Start Talking": "Mulai Berbicara",
    "Tell it what you want done, then refine the goal together in chat.": "Katakan apa yang ingin Anda selesaikan, lalu rapikan tujuannya bersama lewat chat.",
    "Once it is running, there is more you can do.": "Setelah berjalan, masih banyak yang bisa dilakukan.",
    Automations: "Otomatisasi",
    Workbench: "Ruang kerja",
    "Let recurring work run on schedule": "Biarkan pekerjaan rutin berjalan sesuai jadwal",
    "Install templates or describe your own recurring task in plain language.": "Pasang template atau jelaskan tugas berulang dengan bahasa biasa.",
    Templates: "Template",
    "Medication, rent, exchange rates, stock updates": "Obat, sewa, kurs, pembaruan saham",
    Custom: "Kustom",
    "Tell it when to do what, and it becomes a task": "Beri tahu kapan melakukan apa, dan itu menjadi tugas",
    "Edit anytime": "Edit kapan saja",
    "Change it in chat or in My Automations": "Ubah di chat atau di otomatisasi saya",
    "View all scenes": "Lihat semua skenario",
    "Zero code, one sentence, one website": "Tanpa kode, satu kalimat, satu situs",
    "Describe the web workspace you need. LightVela can build, publish, update, or expire it from chat.": "Jelaskan workspace web yang Anda butuhkan. LightVela dapat membuat, menerbitkan, memperbarui, atau menonaktifkannya dari chat.",
    "Personal site": "Situs pribadi",
    "Resume, portfolio, contact": "Resume, portofolio, kontak",
    Dashboard: "Dasbor",
    "Turn monitored metrics into a shareable page": "Ubah metrik yang dipantau menjadi halaman yang bisa dibagikan",
    "Event page": "Halaman acara",
    "Intro, agenda, signup form": "Intro, agenda, formulir pendaftaran",
    "Learn Workbench": "Pelajari ruang kerja",
    "Try it free": "Coba gratis",
    "No credit card required": "Tanpa kartu kredit",
    "Try it free, no credit card required": "Coba gratis, tanpa kartu kredit",
    "Try LightVela free for 14 days.": "Coba LightVela gratis selama 14 hari.",
    "Try an AI token plan free for 3 days.": "Coba paket AI Token gratis selama 3 hari.",
    "Try the Standard plan free for 14 days.": "Coba paket Standard gratis selama 14 hari.",
    "Try the AI Token plan free for 7 days.": "Coba paket AI Token gratis selama 7 hari.",
    "Start free": "Mulai gratis",
    "Keeps running in the cloud": "Tetap berjalan di cloud",
    "Hand off a task without leaving your computer on": "Serahkan tugas tanpa membiarkan komputer terus menyala",
    "Works through conversation": "Bekerja lewat percakapan",
    "Give instructions, add context, and check progress in a familiar chat": "Beri instruksi, tambah konteks, dan cek progres di chat yang familiar",
    "Confirms important actions": "Mengonfirmasi tindakan penting",
    "Waits for your approval before sending, changing, or acting externally": "Menunggu persetujuan Anda sebelum mengirim, mengubah, atau bertindak keluar",
    "Adapts to how you work": "Menyesuaikan cara kerja Anda",
    "Turns your feedback into rules for the next task": "Mengubah masukan Anda menjadi aturan untuk tugas berikutnya",
    "Hand your ideas to Hermes Agent,": "Serahkan ide Anda ke Hermes Agent,",
    "keep them moving in the cloud.": "biarkan terus bergerak di cloud.",
    "My AI companion": "Pendamping AI saya",
    "Thank you Hermes for the technical support provided to LightVela.": "Terima kasih kepada Hermes atas dukungan teknis untuk LightVela.",
    "Ready to set off with you at any time.": "Siap berangkat bersama Anda kapan saja.",
    "Product Introduction": "Pengenalan Produk",
    "Scenario Examples": "Contoh Skenario",
    "How to Start": "Cara Memulai",
    "Help & Feedback": "Bantuan & Masukan",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVela menjaga pendamping AI pribadi Anda tetap online di cloud.",
    "Create it once, connect your channels, and let it keep learning how you work.": "Buat sekali, hubungkan kanal Anda, dan biarkan ia terus mempelajari cara kerja Anda.",
    Legal: "Legal",
    "Data Processing Notice": "Pemberitahuan Pemrosesan Data",
    "Open Source Statement": "Pernyataan Open Source",
    "My AI partners": "Partner AI saya",
    Product: "Produk",
    "Get started": "Mulai",
    Analysis: "Analisis",
    "Self-hosting analysis": "Analisis self-hosting",
    "Hostinger analysis": "Analisis Hostinger",
    "Manus analysis": "Analisis Manus",
    "ChatGPT analysis": "Analisis ChatGPT",
    "Genspark analysis": "Analisis Genspark",
    Community: "Komunitas",
    Company: "Perusahaan",
    "About Us": "Tentang Kami",
    "Privacy Policy": "Kebijakan Privasi",
    "Terms of Service": "Ketentuan Layanan",
    "Open Source Notice": "Pemberitahuan Open Source",
    "Related products": "Produk terkait",
    "14-day free trial": "Uji coba gratis 14 hari",
    "WhatsApp setup guide": "Panduan setup WhatsApp",
    "Telegram setup guide": "Panduan setup Telegram",
    "Discord setup guide": "Panduan setup Discord",
    "Tencent CloudBase": "Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. Semua hak dilindungi. Dibangun oleh Tencent Lighthouse.",
  },
  es: {
    Home: "Inicio",
    Pricing: "Precios",
    Docs: "Documentación",
    Changelog: "Novedades",
    About: "Acerca de",
    "LightVela · AI companion in the cloud": "LightVela · compañero de IA en la nube",
    "Nasdaq Brief": "Resumen de mercado",
    "Market Brief": "Resumen de mercado",
    "LightVela: market brief is ready": "LightVela: el resumen de mercado está listo",
    "LightVela: Nasdaq sector brief is ready": "LightVela: el resumen sectorial del Nasdaq está listo",
    "Market brief is ready:": "El resumen de mercado está listo:",
    "Nasdaq sector brief is ready:": "El resumen sectorial del Nasdaq está listo:",
    "Nasdaq Sector Brief - Aug 27, 2026 Close": "Resumen sectorial del Nasdaq - Cierre del 27 de agosto de 2026",
    "Market tone: tech-led, very narrow breadth": "Tono del mercado: liderado por tecnología, amplitud muy estrecha",
    "I will pull conversion data this afternoon.": "Esta tarde prepararé los datos de conversión.",
    "read the last week of messages. What is blocking us right now?": "lee los mensajes de la última semana. ¿Qué nos bloquea ahora?",
    "Done. Lin sends design a usable copy draft today; you add conversion data this afternoon; Alex books the first customer today and the other two tomorrow and Thursday. I will @ each owner before their deadline.": "Listo. Lin envía hoy un borrador usable al equipo de diseño; tú añades datos de conversión esta tarde; Alex agenda el primer cliente hoy y los otros dos mañana y el jueves. Mencionaré a cada responsable antes de su fecha límite.",
    "Your AI companion—always on, always evolving with you.": "Cuanto más lo uses, mejor te entenderá, tu compañero de IA siempre en línea",
    "LightVela can become your": "LightVela puede ser tu",
    "knowledge base": "base de conocimiento",
    "My AI Companion": "Mi compañero de IA",
    Chats: "Chats",
    Status: "Estado",
    Channels: "Canales",
    Calls: "Llamadas",
    "Search or start a new chat": "Busca o inicia un chat",
    All: "Todos",
    Unread: "No leídos",
    Groups: "Grupos",
    Today: "Hoy",
    Me: "Yo",
    You: "Tú",
    "Type a message": "Escribe un mensaje",
    "Send a message to #todo": "Envía un mensaje a #todo",
    "Message # chat": "Mensaje # chat",
    Search: "Buscar",
    "From first hello to trusted companion": "Del primer hola a un compañero de confianza",
    "Let me learn your world": "Déjame conocer tu mundo",
    "Connect me to supported channels such as": "Conéctame a canales compatibles como",
    "WhatsApp, Telegram, Slack, and Discord": "WhatsApp, Telegram, Slack y Discord",
    ", so your family, friends, and teammates can @ me where they already talk.": ", para que tu familia, amigos y equipo puedan mencionarme donde ya conversan.",
    "I can be the person you want to talk to, or your own extension.": "Puedo ser la persona con la que quieres hablar, o una extensión de ti.",
    "I read long group threads, summarize them, and help answer.": "Leo hilos largos, los resumo y ayudo a responder.",
    "I can show up on schedule, like your best reminder.": "Puedo aparecer en el momento justo, como tu mejor recordatorio.",
    "Then I become your best working partner": "Luego me convierto en tu mejor partner de trabajo",
    "Give me your materials and I organize them myself. What you give me": "Dame tus materiales y yo los organizo. Lo que me entregas",
    "belongs only to you": "solo te pertenece a ti",
    ", and I do not rummage through your computer.": ", y no reviso tu ordenador.",
    "Drop in PDF, Word, Markdown, and more.": "Añade PDF, Word, Markdown y más.",
    "Add Soul, Skills, and Automations so I learn faster.": "Añade Automations, Workbench y DeepSeek Harness para que aprenda más rápido.",
    "Long memory, quick recall, fast response.": "Memoria larga, recuperación rápida y respuesta ágil.",
    "After that, I stay always on": "Después, sigo siempre activo",
    "I stay available 24/7 in the cloud, so you never need to leave your computer running. Whenever you correct me, I turn your feedback into a new rule and apply it next time.": "Funciono en la nube y estoy disponible 24/7, así que tu ordenador no tiene que quedar encendido. Cada corrección se guarda como una regla para la próxima vez.",
    "I organize group context and unanswered threads.": "Organizo el contexto del grupo y los hilos sin responder.",
    "Scheduled work runs by itself.": "El trabajo programado se ejecuta solo.",
    "For real decisions, I ask you first.": "Para decisiones reales, te pregunto primero.",
    "What LightVela Can Do": "Qué puede hacer LightVela",
    Skill: "Skill",
    "Gives AI professional capability": "Da capacidades profesionales a la IA",
    Soul: "Soul",
    "Gives AI personality and memory": "Da personalidad y memoria a la IA",
    "Work assistant": "Asistente de trabajo",
    Knowledge: "Conocimiento",
    "Monitoring radar": "Radar de monitoreo",
    "Scheduled reminder": "Recordatorio programado",
    "Business assistant": "Asistente de negocio",
    "Life manager": "Gestor personal",
    "Project schedules and maintenance": "Calendarios y mantenimiento de proyectos",
    "Coordinate calendars and find meeting windows from chat context": "Coordina calendarios y encuentra huecos de reunión desde el chat",
    "Turn meetings into decisions, owners, risks, and next steps": "Convierte reuniones en decisiones, responsables, riesgos y siguientes pasos",
    "Track delayed items and draft weekly status reports": "Sigue retrasos y redacta informes semanales",
    "Document and material processing": "Procesamiento de documentos y materiales",
    "Read PDFs, meeting notes, spreadsheets, and links": "Lee PDF, notas de reunión, hojas de cálculo y enlaces",
    "Collaboration follow-through": "Seguimiento de colaboración",
    "Read cross-channel context": "Lee contexto entre canales",
    "Turn threads into tasks, reminders, and response drafts": "Convierte hilos en tareas, recordatorios y borradores",
    "Pause before decisions that need human judgment": "Se detiene ante decisiones que requieren criterio humano",
    "Scheduled reminders": "Recordatorios programados",
    "Condition alerts": "Alertas por condición",
    "Habit reminders": "Recordatorios de hábitos",
    "Personal knowledge Q&A": "Preguntas y respuestas de conocimiento personal",
    "Auto-archive meetings and files": "Archivo automático de reuniones y archivos",
    "Remember preferences and context": "Recuerda preferencias y contexto",
    "Market and info radar": "Radar de mercado e información",
    "Order and service anomalies": "Anomalías de pedidos y servicios",
    "Opportunity and content monitoring": "Monitoreo de oportunidades y contenido",
    "Receipt OCR and budgets": "OCR de recibos y presupuestos",
    "Contracts, invoices, and payment": "Contratos, facturas y pagos",
    "Business daily and trends": "Resumen diario y tendencias",
    "Family calendar and chores": "Calendario familiar y tareas",
    "Meal planning and groceries": "Plan de comidas y compras",
    "Weather, voice, and quick asks": "Clima, voz y consultas rápidas",
    "How to Get Started": "Cómo empezar",
    "Create an Assistant": "Crea un asistente",
    "Name it, choose a model, and it is waiting in the cloud once it shows Running.": "Ponle nombre, elige un modelo y, cuando muestre Running, estará esperando en la nube.",
    "Connect Channels": "Conecta canales",
    "Connect supported platforms such as WhatsApp, Telegram, Slack, and Discord, including multiple channels at once.": "Conecta plataformas compatibles como WhatsApp, Telegram, Slack y Discord, incluso varios canales a la vez.",
    "Start Talking": "Empieza a hablar",
    "Tell it what you want done, then refine the goal together in chat.": "Dile qué quieres lograr y ajusten el objetivo juntos en el chat.",
    "Once it is running, there is more you can do.": "Cuando esté en marcha, puedes hacer mucho más.",
    Automations: "Automatizaciones",
    Workbench: "Área de trabajo",
    "Let recurring work run on schedule": "Deja que el trabajo recurrente se ejecute a tiempo",
    "Install templates or describe your own recurring task in plain language.": "Instala plantillas o describe tu tarea recurrente en lenguaje natural.",
    Templates: "Plantillas",
    "Medication, rent, exchange rates, stock updates": "Medicamentos, alquiler, tipos de cambio, bolsa",
    Custom: "Personalizado",
    "Tell it when to do what, and it becomes a task": "Dile cuándo hacer qué, y se convierte en tarea",
    "Edit anytime": "Edita cuando quieras",
    "Change it in chat or in My Automations": "Cámbialo en el chat o en mis automatizaciones",
    "View all scenes": "Ver todos los escenarios",
    "Zero code, one sentence, one website": "Cero código, una frase, un sitio web",
    "Describe the web workspace you need. LightVela can build, publish, update, or expire it from chat.": "Describe el workspace web que necesitas. LightVela puede crearlo, publicarlo, actualizarlo o desactivarlo desde el chat.",
    "Personal site": "Sitio personal",
    "Resume, portfolio, contact": "CV, portfolio, contacto",
    Dashboard: "Panel",
    "Turn monitored metrics into a shareable page": "Convierte métricas monitoreadas en una página compartible",
    "Event page": "Página de evento",
    "Intro, agenda, signup form": "Introducción, agenda y formulario",
    "Learn Workbench": "Conoce el área de trabajo",
    "Try it free": "Pruébalo gratis",
    "No credit card required": "Sin tarjeta de crédito",
    "Try it free, no credit card required": "Pruébalo gratis, sin tarjeta de crédito",
    "Try LightVela free for 14 days.": "Prueba LightVela gratis durante 14 días.",
    "Try an AI token plan free for 3 days.": "Prueba un plan de tokens de IA gratis durante 3 días.",
    "Try the Standard plan free for 14 days.": "Prueba el plan Standard gratis durante 14 días.",
    "Try the AI Token plan free for 7 days.": "Prueba el plan AI Token gratis durante 7 días.",
    "Start free": "Empieza gratis",
    "Keeps running in the cloud": "Sigue funcionando en la nube",
    "Hand off a task without leaving your computer on": "Entrega una tarea sin dejar el ordenador encendido",
    "Works through conversation": "Funciona mediante conversación",
    "Give instructions, add context, and check progress in a familiar chat": "Da instrucciones, añade contexto y revisa avances en un chat familiar",
    "Confirms important actions": "Confirma acciones importantes",
    "Waits for your approval before sending, changing, or acting externally": "Espera tu aprobación antes de enviar, cambiar o actuar fuera",
    "Adapts to how you work": "Se adapta a tu forma de trabajar",
    "Turns your feedback into rules for the next task": "Convierte tu feedback en reglas para la próxima tarea",
    "Hand your ideas to Hermes Agent,": "Entrega tus ideas a Hermes Agent,",
    "keep them moving in the cloud.": "y mantenlas avanzando en la nube.",
    "My AI companion": "Mi compañero de IA",
    "Thank you Hermes for the technical support provided to LightVela.": "Gracias a Hermes por el soporte técnico proporcionado a LightVela.",
    "Ready to set off with you at any time.": "Listo para despegar contigo en cualquier momento.",
    "Product Introduction": "Introducción del producto",
    "Scenario Examples": "Ejemplos de escenarios",
    "How to Start": "Cómo empezar",
    "Help & Feedback": "Ayuda y feedback",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVela mantiene a tu compañero de IA personal siempre en línea en la nube.",
    "Create it once, connect your channels, and let it keep learning how you work.": "Créalo una vez, conecta tus canales y deja que siga aprendiendo cómo trabajas.",
    Legal: "Legal",
    "Data Processing Notice": "Aviso de procesamiento de datos",
    "Open Source Statement": "Declaración de código abierto",
    "My AI partners": "Mis partners de IA",
    Product: "Producto",
    "Get started": "Empezar",
    Analysis: "Análisis",
    "Self-hosting analysis": "Análisis de self-hosting",
    "Hostinger analysis": "Análisis de Hostinger",
    "Manus analysis": "Análisis de Manus",
    "ChatGPT analysis": "Análisis de ChatGPT",
    "Genspark analysis": "Análisis de Genspark",
    Community: "Comunidad",
    Company: "Empresa",
    "About Us": "Sobre nosotros",
    "Privacy Policy": "Política de privacidad",
    "Terms of Service": "Términos del servicio",
    "Open Source Notice": "Aviso de código abierto",
    "Related products": "Productos relacionados",
    "14-day free trial": "Prueba gratis de 14 días",
    "WhatsApp setup guide": "Guía de conexión de WhatsApp",
    "Telegram setup guide": "Guía de conexión de Telegram",
    "Discord setup guide": "Guía de conexión de Discord",
    "Tencent CloudBase": "Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. Todos los derechos reservados. Creado por Tencent Lighthouse.",
  },
};
Object.assign(coreCopyByLocale, {
  "ja-JP": {
    Home: "ホーム",
    Pricing: "料金",
    Docs: "ドキュメント",
    Changelog: "更新履歴",
    About: "会社概要",
    "LightVela · AI companion in the cloud": "LightVela · クラウドのAIパートナー",
    "Nasdaq Brief": "市場ブリーフ",
    "Market Brief": "市場ブリーフ",
    "LightVela: market brief is ready": "LightVela：市場ブリーフの準備ができました",
    "LightVela: Nasdaq sector brief is ready": "LightVela：Nasdaqセクターブリーフの準備ができました",
    "Market brief is ready:": "市場ブリーフの準備ができました：",
    "Nasdaq sector brief is ready:": "Nasdaqセクターブリーフの準備ができました：",
    "Nasdaq Sector Brief - Aug 27, 2026 Close": "Nasdaqセクターブリーフ - 2026年8月27日終値",
    "Market tone: tech-led, very narrow breadth": "市場トーン：テック主導、広がりは限定的",
    "I will pull conversion data this afternoon.": "午後にコンバージョンデータを出します。",
    "read the last week of messages. What is blocking us right now?": "先週のメッセージを読んで、今のボトルネックを教えて。",
    "Done. Lin sends design a usable copy draft today; you add conversion data this afternoon; Alex books the first customer today and the other two tomorrow and Thursday. I will @ each owner before their deadline.": "完了です。Linは今日デザイン向けに使えるコピー案を送り、あなたは午後にコンバージョンデータを追加し、Alexは今日1件目の顧客を予約、残り2件は明日と木曜に回します。締切前に各担当者へメンションします。",
    "Your AI companion—always on, always evolving with you.": "使うほどあなたを理解する、ずっとオンラインのAIパートナー",
    "LightVela can become your": "LightVelaはあなたの",
    "knowledge base": "ナレッジベース",
    "My AI Companion": "私のAIパートナー",
    Chats: "チャット",
    Status: "ステータス",
    Channels: "チャンネル",
    Calls: "通話",
    "Search or start a new chat": "検索または新しいチャットを開始",
    All: "すべて",
    Unread: "未読",
    Groups: "グループ",
    Today: "今日",
    Me: "自分",
    You: "あなた",
    "Type a message": "メッセージを入力",
    "Send a message to #todo": "#todo にメッセージを送信",
    "Message # chat": "# chat にメッセージ",
    Search: "検索",
    "AI Companion Setup": "AIパートナー設定",
    "Plan Status": "プラン状況",
    "Ready to create.": "作成の準備ができました。",
    "Start from Workbench": "ワークベンチから開始",
    "Pricing check": "料金確認",
    "Channel Setup": "チャンネル設定",
    "Channels ready": "チャンネル準備完了",
    "Assistant Notes": "AIパートナーメモ",
    "Preferences saved.": "好みを保存しました。",
    "Cloud Status": "クラウド状態",
    "Running in the cloud.": "クラウドで実行中です。",
    Skills: "スキル",
    "Knowledge and automations": "ナレッジと自動化",
    "Help Digest": "ヘルプ要約",
    "Setup tips are ready.": "設定ヒントを用意しました。",
    Integrations: "連携",
    "Supported channels connected.": "対応チャンネルを接続しました。",
    "From first hello to trusted companion": "最初の挨拶から、信頼できるパートナーへ",
    "Let me learn your world": "あなたの世界を覚えさせてください",
    "Connect me to supported channels such as": "対応チャンネルに接続できます：",
    "WhatsApp, Telegram, Slack, and Discord": "WhatsApp、Telegram、Slack、Discord",
    ", so your family, friends, and teammates can @ me where they already talk.": "。家族、友人、チームメイトが普段の会話の中でそのまま私を @ できます。",
    "I can be the person you want to talk to, or your own extension.": "話し相手にも、あなた自身の延長にもなれます。",
    "I read long group threads, summarize them, and help answer.": "長いグループスレッドを読み、要約し、返信を手伝います。",
    "I can show up on schedule, like your best reminder.": "最高のリマインダーのように、時間どおりに現れます。",
    "Then I become your best working partner": "その後、あなたの最高の仕事パートナーになります",
    "Give me your materials and I organize them myself. What you give me": "資料を渡してくれれば、私が整理します。あなたが渡したものは",
    "belongs only to you": "あなただけのもの",
    ", and I do not rummage through your computer.": "であり、あなたのコンピューター内を探し回ることはありません。",
    "Drop in PDF, Word, Markdown, and more.": "PDF、Word、Markdownなどを入れられます。",
    "Add Soul, Skills, and Automations so I learn faster.": "Automations、Workbench、DeepSeek Harnessを追加すると、より早く学習します。",
    "Long memory, quick recall, fast response.": "長い記憶、素早い想起、高速な応答。",
    "After that, I stay always on": "その後は、ずっと稼働し続けます",
    "I stay available 24/7 in the cloud, so you never need to leave your computer running. Whenever you correct me, I turn your feedback into a new rule and apply it next time.": "私はクラウドで24時間365日稼働するので、あなたのコンピューターを起動し続ける必要はありません。修正されるたびに新しいルールとして保存し、次回はあなたの好みに沿って動きます。",
    "I organize group context and unanswered threads.": "グループの文脈と未返信スレッドを整理します。",
    "Scheduled work runs by itself.": "定時の作業は自動で実行されます。",
    "For real decisions, I ask you first.": "重要な判断は、必ず先に確認します。",
    "What LightVela Can Do": "LightVelaでできること",
    Skill: "Skill",
    "Gives AI professional capability": "AIに専門的な能力を与えます",
    Soul: "Soul",
    "Gives AI personality and memory": "AIに人格と記憶を与えます",
    "Work assistant": "仕事アシスタント",
    Knowledge: "ナレッジ",
    "Monitoring radar": "監視レーダー",
    "Scheduled reminder": "予約リマインダー",
    "Business assistant": "ビジネスアシスタント",
    "Life manager": "生活マネージャー",
    "Project schedules and maintenance": "プロジェクト予定と保守",
    "Coordinate calendars and find meeting windows from chat context": "チャットの文脈からカレンダーを調整し、会議時間を見つけます",
    "Turn meetings into decisions, owners, risks, and next steps": "会議を決定事項、担当者、リスク、次の一手に変換します",
    "Track delayed items and draft weekly status reports": "遅れている項目を追跡し、週次ステータスレポートを下書きします",
    "Document and material processing": "ドキュメントと資料の処理",
    "Read PDFs, meeting notes, spreadsheets, and links": "PDF、議事録、スプレッドシート、リンクを読み取ります",
    "Generate executive, customer, and execution versions from the same source": "同じ素材から経営向け、顧客向け、実行向けの版を作成します",
    "Keep source trails so the original material is easy to verify": "元資料を確認しやすいように出典の流れを残します",
    "Collaboration follow-through": "コラボレーションのフォローアップ",
    "Read cross-channel context": "複数チャンネルの文脈を読み取ります",
    "Turn threads into tasks, reminders, and response drafts": "スレッドをタスク、リマインダー、返信案に変換します",
    "Pause before decisions that need human judgment": "人の判断が必要な決定では立ち止まります",
    "Scheduled reminders": "予約リマインダー",
    "Condition alerts": "条件アラート",
    "Habit reminders": "習慣リマインダー",
    "Personal knowledge Q&A": "個人ナレッジQ&A",
    "Auto-archive meetings and files": "会議とファイルを自動アーカイブ",
    "Remember preferences and context": "好みと文脈を記憶",
    "Market and info radar": "市場と情報のレーダー",
    "Order and service anomalies": "注文とサービスの異常",
    "Opportunity and content monitoring": "機会とコンテンツの監視",
    "Receipt OCR and budgets": "レシートOCRと予算",
    "Contracts, invoices, and payment": "契約、請求書、支払い",
    "Business daily and trends": "ビジネス日報とトレンド",
    "Family calendar and chores": "家族カレンダーと家事",
    "Meal planning and groceries": "献立計画と買い物",
    "Weather, voice, and quick asks": "天気、音声、すばやい質問",
    "How to Get Started": "始め方",
    "Create an Assistant": "アシスタントを作成",
    "Name it, choose a model, and it is waiting in the cloud once it shows Running.": "名前を付け、モデルを選ぶと、「稼働中」と表示された時点でクラウド上で待機します。",
    "Connect Channels": "チャンネルを接続",
    "Connect supported platforms such as WhatsApp, Telegram, Slack, and Discord, including multiple channels at once.": "WhatsApp、Telegram、Slack、Discordなどの対応プラットフォームを、複数チャンネルまとめて接続できます。",
    "Start Talking": "話し始める",
    "Tell it what you want done, then refine the goal together in chat.": "やってほしいことを伝え、チャットで一緒に目標を整えます。",
    "Once it is running, there is more you can do.": "起動したら、さらにできることがあります。",
    Automations: "自動タスク",
    Workbench: "ワークベンチ",
    "Let recurring work run on schedule": "繰り返し作業を予定どおりに実行",
    "Install templates or describe your own recurring task in plain language.": "テンプレートを使うか、自然な言葉で独自の定期タスクを説明できます。",
    Templates: "テンプレート",
    "Medication, rent, exchange rates, stock updates": "薬、家賃、為替、株価更新",
    Custom: "カスタム",
    "Tell it when to do what, and it becomes a task": "いつ何をするか伝えるだけで、タスクになります",
    "Edit anytime": "いつでも編集",
    "Change it in chat or in My Automations": "チャットまたはマイ自動タスクで変更できます",
    "View all scenes": "すべてのシーンを見る",
    "Zero code, one sentence, one website": "コード不要、一文で、ひとつのWebサイト",
    "Describe the web workspace you need. LightVela can build, publish, update, or expire it from chat.": "必要なWebワークスペースを説明してください。LightVelaはチャットから作成、公開、更新、停止まで行えます。",
    "Personal site": "個人サイト",
    "Resume, portfolio, contact": "履歴書、ポートフォリオ、連絡先",
    Dashboard: "ダッシュボード",
    "Turn monitored metrics into a shareable page": "監視中の指標を共有できるページに変換",
    "Event page": "イベントページ",
    "Intro, agenda, signup form": "紹介、アジェンダ、申込フォーム",
    "Learn Workbench": "ワークベンチを見る",
    "Workbench product screen": "ワークベンチ製品画面",
    "Try it free": "無料で試す",
    "No credit card required": "クレジットカード不要",
    "Try it free, no credit card required": "クレジットカード不要で無料体験",
    "Try LightVela free for 14 days.": "LightVelaを14日間無料でお試しいただけます。",
    "Try an AI token plan free for 3 days.": "AI Tokenプランを3日間無料でお試しいただけます。",
    "Try the Standard plan free for 14 days.": "Standardプランを14日間無料で試せます。",
    "Try the AI Token plan free for 7 days.": "AI Tokenプランを7日間無料で試せます。",
    "Start free": "無料で開始",
    "Keeps running in the cloud": "クラウドで稼働し続けます",
    "Hand off a task without leaving your computer on": "コンピューターを起動したままにせず、タスクを任せられます",
    "Works through conversation": "会話で動きます",
    "Give instructions, add context, and check progress in a familiar chat": "慣れたチャットで指示し、文脈を追加し、進捗を確認できます",
    "Confirms important actions": "重要な操作は確認します",
    "Waits for your approval before sending, changing, or acting externally": "送信、変更、外部操作の前に承認を待ちます",
    "Adapts to how you work": "あなたの働き方に適応します",
    "Turns your feedback into rules for the next task": "フィードバックを次のタスクのルールに変換します",
    "Hand your ideas to Hermes Agent,": "アイデアをHermes Agentに預けて、",
    "keep them moving in the cloud.": "クラウドで動かし続けましょう。",
    "My AI companion": "私のAIパートナー",
    "Thank you Hermes for the technical support provided to LightVela.": "LightVelaへの技術支援を提供してくれたHermesに感謝します。",
    "Ready to set off with you at any time.": "いつでも一緒に出発できます。",
    "Product Introduction": "製品紹介",
    "Scenario Examples": "シナリオ例",
    "How to Start": "始め方",
    "Help & Feedback": "ヘルプとフィードバック",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVelaは、あなた専用のAIパートナーをクラウドでオンラインに保ちます。",
    "Create it once, connect your channels, and let it keep learning how you work.": "一度作成してチャンネルを接続すれば、あなたの働き方を学び続けます。",
    Legal: "法務",
    "Privacy Policy": "プライバシーポリシー",
    "Terms of Service": "利用規約",
    "Data Processing Notice": "データ処理に関するお知らせ",
    "Open Source Statement": "オープンソース声明",
    "Open Source Notice": "オープンソース通知",
    Product: "製品",
    "Get started": "始める",
    Analysis: "分析",
    "Self-hosting analysis": "セルフホスティング比較",
    "Hostinger analysis": "Hostinger比較",
    "Manus analysis": "Manus比較",
    "ChatGPT analysis": "ChatGPT比較",
    "Genspark analysis": "Genspark比較",
    Community: "コミュニティ",
    Company: "会社",
    "About Us": "会社概要",
    "Related products": "関連製品",
    "14-day free trial": "14日間無料トライアル",
    "WhatsApp setup guide": "WhatsApp接続ガイド",
    "Telegram setup guide": "Telegram接続ガイド",
    "Discord setup guide": "Discord接続ガイド",
    "Tencent CloudBase": "Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
    "My AI partners": "私のAIパートナー",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. 無断転載を禁じます。Tencent Lighthouseが開発。",
  },
  "ko-KR": {
    Home: "홈",
    Pricing: "요금",
    Docs: "문서",
    Changelog: "업데이트 내역",
    About: "회사 소개",
    "LightVela · AI companion in the cloud": "LightVela · 클라우드의 AI 파트너",
    "Nasdaq Brief": "시장 브리프",
    "Market Brief": "시장 브리프",
    "LightVela: market brief is ready": "LightVela: 시장 브리프가 준비되었습니다",
    "LightVela: Nasdaq sector brief is ready": "LightVela: Nasdaq 섹터 브리프가 준비되었습니다",
    "Market brief is ready:": "시장 브리프가 준비되었습니다:",
    "Nasdaq sector brief is ready:": "Nasdaq 섹터 브리프가 준비되었습니다:",
    "Nasdaq Sector Brief - Aug 27, 2026 Close": "Nasdaq 섹터 브리프 - 2026년 8월 27일 마감",
    "Market tone: tech-led, very narrow breadth": "시장 분위기: 기술주 주도, 폭은 매우 좁음",
    "I will pull conversion data this afternoon.": "오늘 오후에 전환 데이터를 가져오겠습니다.",
    "read the last week of messages. What is blocking us right now?": "지난주 메시지를 읽고 지금 무엇이 막고 있는지 알려줘.",
    "Done. Lin sends design a usable copy draft today; you add conversion data this afternoon; Alex books the first customer today and the other two tomorrow and Thursday. I will @ each owner before their deadline.": "완료했습니다. Lin은 오늘 디자인팀에 사용할 수 있는 카피 초안을 보내고, 당신은 오후에 전환 데이터를 추가하며, Alex는 오늘 첫 고객을 예약하고 나머지 두 건은 내일과 목요일에 진행합니다. 마감 전에 각 담당자를 멘션하겠습니다.",
    "Your AI companion—always on, always evolving with you.": "쓸수록 나를 더 잘 이해하는, 늘 온라인인 AI 파트너",
    "LightVela can become your": "LightVela는 당신의",
    "knowledge base": "지식 베이스",
    "My AI Companion": "내 AI 파트너",
    Chats: "채팅",
    Status: "상태",
    Channels: "채널",
    Calls: "통화",
    "Search or start a new chat": "검색하거나 새 채팅 시작",
    All: "전체",
    Unread: "읽지 않음",
    Groups: "그룹",
    Today: "오늘",
    Me: "나",
    You: "당신",
    "Type a message": "메시지를 입력하세요",
    "Send a message to #todo": "#todo에 메시지 보내기",
    "Message # chat": "# chat 메시지",
    Search: "검색",
    "AI Companion Setup": "AI 파트너 설정",
    "Plan Status": "플랜 상태",
    "Ready to create.": "만들 준비가 되었습니다.",
    "Start from Workbench": "워크벤치에서 시작",
    "Pricing check": "요금 확인",
    "Channel Setup": "채널 설정",
    "Channels ready": "채널 준비 완료",
    "Assistant Notes": "AI 파트너 메모",
    "Preferences saved.": "선호 설정이 저장되었습니다.",
    "Cloud Status": "클라우드 상태",
    "Running in the cloud.": "클라우드에서 실행 중입니다.",
    Skills: "스킬",
    "Knowledge and automations": "지식과 자동화",
    "Help Digest": "도움말 요약",
    "Setup tips are ready.": "설정 팁이 준비되었습니다.",
    Integrations: "연동",
    "Supported channels connected.": "지원 채널이 연결되었습니다.",
    "From first hello to trusted companion": "첫 인사에서 믿을 수 있는 파트너까지",
    "Let me learn your world": "당신의 세계를 배우게 해 주세요",
    "Connect me to supported channels such as": "지원되는 채널에 연결할 수 있습니다:",
    "WhatsApp, Telegram, Slack, and Discord": "WhatsApp, Telegram, Slack, Discord",
    ", so your family, friends, and teammates can @ me where they already talk.": ". 가족, 친구, 팀원이 익숙한 대화 공간에서 바로 저를 @할 수 있습니다.",
    "I can be the person you want to talk to, or your own extension.": "대화 상대가 될 수도 있고, 당신의 확장이 될 수도 있습니다.",
    "I read long group threads, summarize them, and help answer.": "긴 그룹 스레드를 읽고 요약하며 답변을 돕습니다.",
    "I can show up on schedule, like your best reminder.": "가장 좋은 알림처럼 정해진 시간에 나타납니다.",
    "Then I become your best working partner": "그다음에는 최고의 업무 파트너가 됩니다",
    "Give me your materials and I organize them myself. What you give me": "자료를 주면 제가 직접 정리합니다. 당신이 주는 것은",
    "belongs only to you": "오직 당신의 것",
    ", and I do not rummage through your computer.": "이며, 컴퓨터 안을 뒤지지 않습니다.",
    "Drop in PDF, Word, Markdown, and more.": "PDF, Word, Markdown 등을 넣을 수 있습니다.",
    "Add Soul, Skills, and Automations so I learn faster.": "Automations, Workbench, DeepSeek Harness를 추가하면 더 빨리 학습합니다.",
    "Long memory, quick recall, fast response.": "긴 기억, 빠른 회상, 빠른 응답.",
    "After that, I stay always on": "그 후에는 언제나 켜져 있습니다",
    "I stay available 24/7 in the cloud, so you never need to leave your computer running. Whenever you correct me, I turn your feedback into a new rule and apply it next time.": "저는 클라우드에서 24시간 연중무휴로 실행되므로 컴퓨터를 계속 켜 둘 필요가 없습니다. 당신이 한 번 수정할 때마다 새 규칙으로 저장하고 다음에는 그 선호에 맞춰 움직입니다.",
    "I organize group context and unanswered threads.": "그룹 맥락과 답하지 않은 스레드를 정리합니다.",
    "Scheduled work runs by itself.": "예약된 작업은 자동으로 실행됩니다.",
    "For real decisions, I ask you first.": "중요한 결정은 반드시 먼저 묻습니다.",
    "What LightVela Can Do": "LightVela로 할 수 있는 일",
    Skill: "Skill",
    "Gives AI professional capability": "AI에 전문 능력을 더합니다",
    Soul: "Soul",
    "Gives AI personality and memory": "AI에 성격과 기억을 더합니다",
    "Work assistant": "업무 어시스턴트",
    Knowledge: "지식",
    "Monitoring radar": "모니터링 레이더",
    "Scheduled reminder": "예약 알림",
    "Business assistant": "비즈니스 어시스턴트",
    "Life manager": "생활 매니저",
    "Project schedules and maintenance": "프로젝트 일정과 유지관리",
    "Coordinate calendars and find meeting windows from chat context": "채팅 맥락에서 캘린더를 맞추고 회의 시간을 찾습니다",
    "Turn meetings into decisions, owners, risks, and next steps": "회의를 결정 사항, 담당자, 리스크, 다음 단계로 바꿉니다",
    "Track delayed items and draft weekly status reports": "지연 항목을 추적하고 주간 상태 보고서를 작성합니다",
    "Document and material processing": "문서와 자료 처리",
    "Read PDFs, meeting notes, spreadsheets, and links": "PDF, 회의록, 스프레드시트, 링크를 읽습니다",
    "Generate executive, customer, and execution versions from the same source": "같은 자료에서 경영진용, 고객용, 실행용 버전을 만듭니다",
    "Keep source trails so the original material is easy to verify": "원본 자료를 쉽게 확인할 수 있도록 출처 흐름을 남깁니다",
    "Collaboration follow-through": "협업 후속 처리",
    "Read cross-channel context": "여러 채널의 맥락을 읽습니다",
    "Turn threads into tasks, reminders, and response drafts": "스레드를 작업, 알림, 답변 초안으로 바꿉니다",
    "Pause before decisions that need human judgment": "사람의 판단이 필요한 결정 앞에서는 멈춥니다",
    "Scheduled reminders": "예약 알림",
    "Condition alerts": "조건 알림",
    "Habit reminders": "습관 알림",
    "Personal knowledge Q&A": "개인 지식 Q&A",
    "Auto-archive meetings and files": "회의와 파일 자동 보관",
    "Remember preferences and context": "선호와 맥락 기억",
    "Market and info radar": "시장과 정보 레이더",
    "Order and service anomalies": "주문과 서비스 이상",
    "Opportunity and content monitoring": "기회와 콘텐츠 모니터링",
    "Receipt OCR and budgets": "영수증 OCR과 예산",
    "Contracts, invoices, and payment": "계약, 청구서, 결제",
    "Business daily and trends": "비즈니스 데일리와 트렌드",
    "Family calendar and chores": "가족 캘린더와 집안일",
    "Meal planning and groceries": "식단 계획과 장보기",
    "Weather, voice, and quick asks": "날씨, 음성, 빠른 질문",
    "How to Get Started": "시작 방법",
    "Create an Assistant": "어시스턴트 만들기",
    "Name it, choose a model, and it is waiting in the cloud once it shows Running.": "이름을 정하고 모델을 선택하면 '실행 중'으로 표시된 뒤 클라우드에서 대기합니다.",
    "Connect Channels": "채널 연결",
    "Connect supported platforms such as WhatsApp, Telegram, Slack, and Discord, including multiple channels at once.": "WhatsApp, Telegram, Slack, Discord 같은 지원 플랫폼을 여러 채널까지 한 번에 연결할 수 있습니다.",
    "Start Talking": "대화 시작",
    "Tell it what you want done, then refine the goal together in chat.": "원하는 일을 말하고 채팅에서 함께 목표를 다듬습니다.",
    "Once it is running, there is more you can do.": "실행되면 더 많은 일을 할 수 있습니다.",
    Automations: "자동 작업",
    Workbench: "워크벤치",
    "Let recurring work run on schedule": "반복 작업을 일정대로 실행",
    "Install templates or describe your own recurring task in plain language.": "템플릿을 설치하거나 반복 작업을 자연어로 설명할 수 있습니다.",
    Templates: "템플릿",
    "Medication, rent, exchange rates, stock updates": "약, 월세, 환율, 주식 업데이트",
    Custom: "사용자 지정",
    "Tell it when to do what, and it becomes a task": "언제 무엇을 할지 말하면 작업이 됩니다",
    "Edit anytime": "언제든 편집",
    "Change it in chat or in My Automations": "채팅이나 내 자동 작업에서 변경",
    "View all scenes": "모든 시나리오 보기",
    "Zero code, one sentence, one website": "코드 없이, 한 문장으로, 하나의 웹사이트",
    "Describe the web workspace you need. LightVela can build, publish, update, or expire it from chat.": "필요한 웹 워크스페이스를 설명하세요. LightVela가 채팅에서 만들고, 게시하고, 업데이트하고, 만료할 수 있습니다.",
    "Personal site": "개인 사이트",
    "Resume, portfolio, contact": "이력서, 포트폴리오, 연락처",
    Dashboard: "대시보드",
    "Turn monitored metrics into a shareable page": "모니터링 지표를 공유 가능한 페이지로 전환",
    "Event page": "이벤트 페이지",
    "Intro, agenda, signup form": "소개, 일정, 신청 폼",
    "Learn Workbench": "워크벤치 보기",
    "Workbench product screen": "워크벤치 제품 화면",
    "Try it free": "무료로 사용해 보기",
    "No credit card required": "신용카드 필요 없음",
    "Try it free, no credit card required": "신용카드 없이 무료로 체험하세요",
    "Try LightVela free for 14 days.": "LightVela를 14일 동안 무료로 사용해 보세요.",
    "Try an AI token plan free for 3 days.": "AI Token 플랜을 3일 동안 무료로 사용해 보세요.",
    "Try the Standard plan free for 14 days.": "Standard 플랜을 14일 동안 무료로 사용해 보세요.",
    "Try the AI Token plan free for 7 days.": "AI Token 플랜을 7일 동안 무료로 사용해 보세요.",
    "Start free": "무료 시작",
    "Keeps running in the cloud": "클라우드에서 계속 실행",
    "Hand off a task without leaving your computer on": "컴퓨터를 계속 켜 두지 않고 작업을 맡길 수 있습니다",
    "Works through conversation": "대화로 작동",
    "Give instructions, add context, and check progress in a familiar chat": "익숙한 채팅에서 지시하고 맥락을 더하며 진행 상황을 확인합니다",
    "Confirms important actions": "중요한 작업은 확인합니다",
    "Waits for your approval before sending, changing, or acting externally": "보내기, 변경, 외부 작업 전에 승인을 기다립니다",
    "Adapts to how you work": "당신의 일하는 방식에 맞춰집니다",
    "Turns your feedback into rules for the next task": "피드백을 다음 작업의 규칙으로 바꿉니다",
    "Hand your ideas to Hermes Agent,": "아이디어는 Hermes Agent에게 맡기고,",
    "keep them moving in the cloud.": "클라우드에서 계속 움직이게 하세요.",
    "My AI companion": "내 AI 파트너",
    "Thank you Hermes for the technical support provided to LightVela.": "LightVela에 기술 지원을 제공해 준 Hermes에게 감사합니다.",
    "Ready to set off with you at any time.": "언제든 함께 출발할 준비가 되어 있습니다.",
    "Product Introduction": "제품 소개",
    "Scenario Examples": "시나리오 예시",
    "How to Start": "시작 방법",
    "Help & Feedback": "도움말 및 피드백",
    "LightVela keeps your personal AI companion online in the cloud.": "LightVela는 개인 AI 파트너를 클라우드에서 계속 온라인 상태로 유지합니다.",
    "Create it once, connect your channels, and let it keep learning how you work.": "한 번 만들고 채널을 연결하면, 당신의 일하는 방식을 계속 학습합니다.",
    Legal: "법률",
    "Privacy Policy": "개인정보 처리방침",
    "Terms of Service": "서비스 약관",
    "Data Processing Notice": "데이터 처리 안내",
    "Open Source Statement": "오픈소스 고지",
    "Open Source Notice": "오픈소스 고지",
    Product: "제품",
    "Get started": "시작하기",
    Analysis: "분석",
    "Self-hosting analysis": "셀프 호스팅 비교",
    "Hostinger analysis": "Hostinger 비교",
    "Manus analysis": "Manus 비교",
    "ChatGPT analysis": "ChatGPT 비교",
    "Genspark analysis": "Genspark 비교",
    Community: "커뮤니티",
    Company: "회사",
    "About Us": "회사 소개",
    "Related products": "관련 제품",
    "14-day free trial": "14일 무료 체험",
    "WhatsApp setup guide": "WhatsApp 연결 가이드",
    "Telegram setup guide": "Telegram 연결 가이드",
    "Discord setup guide": "Discord 연결 가이드",
    "Tencent CloudBase": "Tencent CloudBase",
    "Tencent EdgeOne": "Tencent EdgeOne",
    "My AI partners": "내 AI 파트너",
    "© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.": "© 2026 LightVela. 모든 권리 보유. Tencent Lighthouse에서 제작.",
  },
});
Object.assign(coreCopyByLocale, {
  "en-US": { Blog: "Blog" },
  "zh-CN": { Blog: "博客" },
  "zh-SG": { Blog: "博客" },
  "zh-Hant": { Blog: "博客" },
  "id-ID": { Blog: "Blog" },
  es: { Blog: "Blog" },
  "ja-JP": { Blog: "ブログ" },
  "ko-KR": { Blog: "블로그" },
});
const cardAltCopyByLocale = {
  "zh-CN": {
    "Messaging platforms": "消息平台",
    "Files organized into a folder": "资料整理到文件夹",
    "Always-on cloud assistant": "常驻云端的 AI 伙伴",
    "Workbench product screen": "工作台产品界面",
  },
  "zh-SG": {
    "Messaging platforms": "消息平台",
    "Files organized into a folder": "资料整理到文件夹",
    "Always-on cloud assistant": "常驻云端的 AI 伙伴",
    "Workbench product screen": "工作台产品界面",
  },
  "zh-Hant": {
    "Messaging platforms": "訊息平台",
    "Files organized into a folder": "資料整理到文件夾",
    "Always-on cloud assistant": "常駐雲端的 AI 夥伴",
    "Workbench product screen": "工作臺產品界面",
  },
  "id-ID": {
    "Messaging platforms": "Platform pesan",
    "Files organized into a folder": "File tersusun dalam folder",
    "Always-on cloud assistant": "Pendamping cloud yang selalu aktif",
    "Workbench product screen": "Layar produk ruang kerja",
  },
  es: {
    "Messaging platforms": "Plataformas de mensajería",
    "Files organized into a folder": "Archivos organizados en una carpeta",
    "Always-on cloud assistant": "Compañero cloud siempre activo",
    "Workbench product screen": "Pantalla del producto del área de trabajo",
  },
  "ja-JP": {
    "Messaging platforms": "メッセージングプラットフォーム",
    "Files organized into a folder": "フォルダーに整理されたファイル",
    "Always-on cloud assistant": "常時稼働するクラウドAIパートナー",
    "Workbench product screen": "ワークベンチ製品画面",
  },
  "ko-KR": {
    "Messaging platforms": "메시징 플랫폼",
    "Files organized into a folder": "폴더로 정리된 파일",
    "Always-on cloud assistant": "항상 켜져 있는 클라우드 AI 파트너",
    "Workbench product screen": "워크벤치 제품 화면",
  },
};
for (const [locale, copy] of Object.entries(cardAltCopyByLocale)) {
  Object.assign(coreCopyByLocale[locale], copy);
}
const textFragmentsByLocale = {
  "id-ID": [
    ["Friday Night Arena reminder: Rift Clash starts Friday at 8:00 PM GMT+8. Register in", "Pengingat Friday Night Arena: Rift Clash dimulai Jumat pukul 20.00 GMT+8. Daftar di"],
    [", and use", ", dan gunakan"],
    ["for last-minute questions.", "untuk pertanyaan mendadak."],
    [", and join voice 10 minutes early.", ", dan masuk voice 10 menit lebih awal."],
    ["Scheduled. At 7:30 PM Friday, I will remind registered members in", "Terjadwal. Jumat pukul 19.30, saya akan mengingatkan anggota terdaftar di"],
    ["and share the check-in and team links.", "serta membagikan tautan check-in dan tim."],
    ["read the last week of messages. What is blocking us right now?", "baca pesan minggu lalu. Apa yang sedang menghambat kita?"],
    ["I will pull conversion data this afternoon.", "Saya akan menarik data konversi sore ini."],
    ["reorder the work and remind each owner before the deadline.", "atur ulang pekerjaan dan ingatkan tiap owner sebelum tenggat."],
    ["Pricing-page copy is the main blocker. It is due Friday, and both design and the conversion analysis are waiting for it.", "Copy halaman pricing adalah hambatan utama. Tenggatnya Jumat, dan tim desain serta analisis konversi sama-sama menunggunya."],
    ["I still owe three customer follow-ups. I can only book one today.", "Saya masih punya tiga tindak lanjut pelanggan. Hari ini saya hanya bisa menjadwalkan satu."],
    ["Next time, do not split customer follow-ups by day. Rank them by renewal risk first.", "Lain kali, jangan pisahkan tindak lanjut pelanggan per hari. Urutkan dulu berdasarkan risiko perpanjangan."],
    ["Got it. From now on I will rank customer follow-ups by renewal risk before delay, and I have reordered this list using that rule.", "Baik. Mulai sekarang saya akan mengurutkan tindak lanjut pelanggan berdasarkan risiko perpanjangan sebelum keterlambatan, dan daftar ini sudah saya susun ulang dengan aturan itu."],
    ["show me today's Nasdaq market and the hottest sectors.", "tunjukkan pasar Nasdaq hari ini dan sektor yang paling panas."],
    ["Also flag the risks so I do not only look at the winners.", "Tandai juga risikonya agar saya tidak hanya melihat para pemenang."],
    ["Added. Watch Jackson Hole, rate reversal risk, and whether the move broadens beyond NVDA into equipment and software.", "Ditambahkan. Pantau Jackson Hole, risiko pembalikan suku bunga, dan apakah pergerakan melebar dari NVDA ke equipment dan software."],
    ["Nasdaq Sector Brief - Aug 27, 2026 Close", "Ringkasan Sektor Nasdaq - Penutupan 27 Agu 2026"],
    ["Market tone: tech-led, very narrow breadth", "Nada pasar: dipimpin teknologi, breadth sangat sempit"],
    ["Nasdaq +1.57%, equal-weight S&P -0.30%", "Nasdaq +1,57%, S&P berbobot sama -0,30%"],
    ["VIX 14.51, risk appetite improved but breadth is thin", "VIX 14,51, risk appetite membaik tetapi breadth masih tipis"],
    ["Leading themes", "Tema utama"],
    ["Cybersecurity: Okta +28.6%, CRWD +20.9%", "Keamanan siber: Okta +28,6%, CRWD +20,9%"],
    ["AI application software: Salesforce +23%, Adobe +5.7%", "Software aplikasi AI: Salesforce +23%, Adobe +5,7%"],
    ["Semiconductor equipment / EDA: Synopsys +13%", "Peralatan semikonduktor / EDA: Synopsys +13%"],
    ["Optical / AI infrastructure: boosted by NVDA outlook", "Optical / infrastruktur AI: terdorong outlook NVDA"],
    ["Semiconductors: NVDA +8.74%, AVGO +4.5%", "Semikonduktor: NVDA +8,74%, AVGO +4,5%"],
    ["Main chain: chips → equipment / EDA → optical → AI software / security", "Rantai utama: chip → equipment / EDA → optical → software AI / keamanan"],
    ["Note: airlines, healthcare, banks, and China ADRs weakened.", "Catatan: maskapai, healthcare, bank, dan ADR China melemah."],
    ["generated at", "dibuat pukul"],
    ["pages", "halaman"],
    ["auto-collected", "dikumpulkan otomatis"],
    ["Team Workspace", "Ruang Tim"],
    ["Friends", "Teman"],
    ["MAIN HALL", "RUANG UTAMA"],
    ["Today at ", "Hari ini "],
    ["Today ", "Hari ini "],
  ],
  es: [
    ["Friday Night Arena reminder: Rift Clash starts Friday at 8:00 PM GMT+8. Register in", "Recordatorio de Friday Night Arena: Rift Clash empieza el viernes a las 20:00 GMT+8. Regístrate en"],
    [", and use", ", y usa"],
    ["for last-minute questions.", "para preguntas de último minuto."],
    [", and join voice 10 minutes early.", ", y entra al canal de voz 10 minutos antes."],
    ["Scheduled. At 7:30 PM Friday, I will remind registered members in", "Programado. El viernes a las 19:30 recordaré a los miembros registrados en"],
    ["and share the check-in and team links.", "y compartiré los enlaces de check-in y equipo."],
    ["read the last week of messages. What is blocking us right now?", "lee los mensajes de la última semana. ¿Qué nos bloquea ahora?"],
    ["I will pull conversion data this afternoon.", "Esta tarde prepararé los datos de conversión."],
    ["reorder the work and remind each owner before the deadline.", "reordena el trabajo y recuerda a cada responsable antes de la fecha límite."],
    ["Pricing-page copy is the main blocker. It is due Friday, and both design and the conversion analysis are waiting for it.", "El texto de la página de precios es el bloqueo principal. Vence el viernes, y diseño y análisis de conversión lo están esperando."],
    ["I still owe three customer follow-ups. I can only book one today.", "Aún debo tres seguimientos de clientes. Hoy solo puedo agendar uno."],
    ["Next time, do not split customer follow-ups by day. Rank them by renewal risk first.", "La próxima vez no dividas los seguimientos por día. Ordénalos primero por riesgo de renovación."],
    ["Got it. From now on I will rank customer follow-ups by renewal risk before delay, and I have reordered this list using that rule.", "Entendido. Desde ahora ordenaré los seguimientos por riesgo de renovación antes que por retraso, y ya reordené esta lista con esa regla."],
    ["show me today's Nasdaq market and the hottest sectors.", "muéstrame el mercado Nasdaq de hoy y los sectores más fuertes."],
    ["Also flag the risks so I do not only look at the winners.", "Marca también los riesgos para que no mire solo a los ganadores."],
    ["Added. Watch Jackson Hole, rate reversal risk, and whether the move broadens beyond NVDA into equipment and software.", "Añadido. Vigila Jackson Hole, el riesgo de giro en tasas y si el movimiento se amplía más allá de NVDA hacia equipment y software."],
    ["Nasdaq Sector Brief - Aug 27, 2026 Close", "Resumen sectorial del Nasdaq - Cierre del 27 de agosto de 2026"],
    ["Market tone: tech-led, very narrow breadth", "Tono del mercado: liderado por tecnología, amplitud muy estrecha"],
    ["Nasdaq +1.57%, equal-weight S&P -0.30%", "Nasdaq +1,57%, S&P equiponderado -0,30%"],
    ["VIX 14.51, risk appetite improved but breadth is thin", "VIX 14,51, mejora el apetito por riesgo pero la amplitud sigue débil"],
    ["Leading themes", "Temas líderes"],
    ["Cybersecurity: Okta +28.6%, CRWD +20.9%", "Ciberseguridad: Okta +28,6%, CRWD +20,9%"],
    ["AI application software: Salesforce +23%, Adobe +5.7%", "Software de aplicación de IA: Salesforce +23%, Adobe +5,7%"],
    ["Semiconductor equipment / EDA: Synopsys +13%", "Equipos de semiconductores / EDA: Synopsys +13%"],
    ["Optical / AI infrastructure: boosted by NVDA outlook", "Óptica / infraestructura de IA: impulsada por el outlook de NVDA"],
    ["Semiconductors: NVDA +8.74%, AVGO +4.5%", "Semiconductores: NVDA +8,74%, AVGO +4,5%"],
    ["Main chain: chips → equipment / EDA → optical → AI software / security", "Cadena principal: chips → equipos / EDA → óptica → software de IA / seguridad"],
    ["Note: airlines, healthcare, banks, and China ADRs weakened.", "Nota: aerolíneas, salud, bancos y ADR chinos se debilitaron."],
    ["generated at", "generado a las"],
    ["pages", "páginas"],
    ["auto-collected", "recopilado automáticamente"],
    ["Team Workspace", "Espacio del equipo"],
    ["Friends", "Amigos"],
    ["MAIN HALL", "SALA PRINCIPAL"],
    ["Today at ", "Hoy "],
    ["Today ", "Hoy "],
  ],
};
Object.assign(textFragmentsByLocale, {
  "ja-JP": [
    ["Friday Night Arena reminder: Rift Clash starts Friday at 8:00 PM GMT+8. Register in", "Friday Night Arenaのお知らせ：Rift Clashは金曜20:00 GMT+8に開始します。登録は"],
    [", and use", "を使い、"],
    ["for last-minute questions.", "直前の質問に使ってください。"],
    ["When does the tournament start in my time zone?", "この大会は私のタイムゾーンだと何時に始まりますか？"],
    ["The tournament starts Friday at 8:00 PM GMT+8. For you, that's 10:00 PM AEST.", "大会は金曜20:00 GMT+8に始まります。あなたのタイムゾーンではAESTの22:00です。"],
    ["What do I need before joining tonight's raid?", "今夜のレイドに参加する前に何を準備すればいいですか？"],
    ["Make sure you're registered, read the rules in", "登録済みであることを確認し、ルールは"],
    [", and join voice 10 minutes early.", "、音声チャンネルには10分前に入ってください。"],
    ["What if I registered but have not been assigned a team?", "登録済みなのにチームがまだ割り当てられていない場合はどうすればいいですか？"],
    ["Check in at", "受付は"],
    ["30 minutes before the event. Moderators will fill open spots, and I will summarize which teams still need players.", "イベント開始30分前に行ってください。モデレーターが空き枠を補充し、私がまだ人数不足のチームをまとめます。"],
    ["Remind us once more before it starts.", "開始前にもう一度リマインドしてください。"],
    ["Scheduled. At 7:30 PM Friday, I will remind registered members in", "予約しました。金曜19:30に登録済みメンバーへ"],
    ["and share the check-in and team links.", "でリマインドし、チェックインとチームリンクを共有します。"],
    ["read the last week of messages. What is blocking us right now?", "先週のメッセージを読んで、今のボトルネックを教えて。"],
    ["I will pull conversion data this afternoon.", "午後にコンバージョンデータを出します。"],
    ["reorder the work and remind each owner before the deadline.", "作業順を組み直して、締切前に各担当者へリマインドして。"],
    ["Pricing-page copy is the main blocker. It is due Friday, and both design and the conversion analysis are waiting for it.", "料金ページのコピーが最大のボトルネックです。締切は金曜で、デザインとコンバージョン分析の両方が待っています。"],
    ["I still owe three customer follow-ups. I can only book one today.", "顧客フォローがまだ3件残っています。今日は1件しか予約できません。"],
    ["Next time, do not split customer follow-ups by day. Rank them by renewal risk first.", "次回から顧客フォローを日ごとに分けず、まず更新リスク順に並べてください。"],
    ["Got it. From now on I will rank customer follow-ups by renewal risk before delay, and I have reordered this list using that rule.", "了解しました。今後は遅延より先に更新リスクで顧客フォローを並べ、今回はそのルールで並べ替えました。"],
    ["show me today's Nasdaq market and the hottest sectors.", "今日のNasdaq市場と注目セクターを見せて。"],
    ["Also flag the risks so I do not only look at the winners.", "勝ち組だけを見ないように、リスクも示して。"],
    ["Added. Watch Jackson Hole, rate reversal risk, and whether the move broadens beyond NVDA into equipment and software.", "追加しました。Jackson Hole、金利反転リスク、NVDA以外の装置・ソフトウェアへ動きが広がるかを確認してください。"],
    ["Nasdaq Sector Brief - Aug 27, 2026 Close", "Nasdaqセクターブリーフ - 2026年8月27日終値"],
    ["Market tone: tech-led, very narrow breadth", "市場トーン：テック主導、広がりは限定的"],
    ["Nasdaq +1.57%, equal-weight S&P -0.30%", "Nasdaq +1.57%、均等加重S&P -0.30%"],
    ["VIX 14.51, risk appetite improved but breadth is thin", "VIX 14.51、リスク選好は改善も市場の広がりは薄い"],
    ["Leading themes", "主なテーマ"],
    ["Cybersecurity: Okta +28.6%, CRWD +20.9%", "サイバーセキュリティ：Okta +28.6%、CRWD +20.9%"],
    ["AI application software: Salesforce +23%, Adobe +5.7%", "AIアプリケーションソフトウェア：Salesforce +23%、Adobe +5.7%"],
    ["Semiconductor equipment / EDA: Synopsys +13%", "半導体装置 / EDA：Synopsys +13%"],
    ["Optical / AI infrastructure: boosted by NVDA outlook", "光通信 / AIインフラ：NVDA見通しが支援"],
    ["Semiconductors: NVDA +8.74%, AVGO +4.5%", "半導体：NVDA +8.74%、AVGO +4.5%"],
    ["Main chain: chips → equipment / EDA → optical → AI software / security", "主な連鎖：チップ → 装置 / EDA → 光通信 → AIソフトウェア / セキュリティ"],
    ["Note: airlines, healthcare, banks, and China ADRs weakened.", "注記：航空、ヘルスケア、銀行、中国ADRは弱含み。"],
    ["generated at", "生成時刻"],
    ["pages", "ページ"],
    ["auto-collected", "自動収集"],
    ["Team Workspace", "チームワークスペース"],
    ["Friends", "友人"],
    ["MAIN HALL", "メインホール"],
    ["memory-dedupe pushed", "memory-dedupeをpush済み"],
    ["#337 skill follow-up", "#337 skillのフォローアップ"],
    ["All checks passed.", "すべてのチェックに合格しました。"],
    ["v2.4.0 draft is ready.", "v2.4.0のドラフトが準備できました。"],
    ["Two comments need responses.", "2件のコメントに返信が必要です。"],
    ["The weekly summary is ready.", "週次サマリーが準備できました。"],
    ["Three endpoints were updated.", "3つのエンドポイントが更新されました。"],
    ["Keep it small. Check provider sync and the session-end hook first.", "変更は小さく保って。まずprovider syncとsession-end hookを確認して。"],
    ["Post the patch and test results here. We will merge tonight.", "パッチとテスト結果をここに投稿して。今夜マージします。"],
    ["Do not change the storage schema. Contain the concurrent write first.", "ストレージスキーマは変更しないで。まず同時書き込みを抑えて。"],
    ["Add a regression case where sync and session end fire together.", "syncとsession endが同時に発火する回帰テストを追加して。"],
    ["Added. Twenty concurrent runs now produce one record each.", "追加しました。20件の同時実行でも各実行が1レコードだけ生成します。"],
    ["patch · tests passed", "patch · テスト通過"],
    ["2 orders may be late", "2件の注文が遅れている可能性があります"],
    ["Order delays are growing", "注文遅延が増えています"],
    ["Today at ", "今日 "],
    ["Today ", "今日 "],
  ],
  "ko-KR": [
    ["Friday Night Arena reminder: Rift Clash starts Friday at 8:00 PM GMT+8. Register in", "Friday Night Arena 알림: Rift Clash는 금요일 20:00 GMT+8에 시작합니다. 등록은"],
    [", and use", "에서 하고, "],
    ["for last-minute questions.", "막판 질문에 사용하세요."],
    ["When does the tournament start in my time zone?", "이 대회가 제 시간대에서는 몇 시에 시작하나요?"],
    ["The tournament starts Friday at 8:00 PM GMT+8. For you, that's 10:00 PM AEST.", "대회는 금요일 20:00 GMT+8에 시작합니다. 당신의 시간대에서는 AEST 22:00입니다."],
    ["What do I need before joining tonight's raid?", "오늘 밤 레이드에 참여하기 전에 무엇을 준비해야 하나요?"],
    ["Make sure you're registered, read the rules in", "등록이 완료됐는지 확인하고 규칙은"],
    [", and join voice 10 minutes early.", " 음성 채널에는 10분 일찍 들어오세요."],
    ["What if I registered but have not been assigned a team?", "등록했는데 아직 팀을 배정받지 못했다면 어떻게 하나요?"],
    ["Check in at", "체크인은"],
    ["30 minutes before the event. Moderators will fill open spots, and I will summarize which teams still need players.", "이벤트 30분 전에 진행하세요. 운영진이 빈자리를 채우고, 제가 아직 인원이 필요한 팀을 정리하겠습니다."],
    ["Remind us once more before it starts.", "시작 전에 한 번 더 알려 주세요."],
    ["Scheduled. At 7:30 PM Friday, I will remind registered members in", "예약했습니다. 금요일 19:30에 등록된 멤버에게"],
    ["and share the check-in and team links.", "에서 알리고 체크인 및 팀 링크를 공유하겠습니다."],
    ["read the last week of messages. What is blocking us right now?", "지난주 메시지를 읽고 지금 무엇이 막고 있는지 알려줘."],
    ["I will pull conversion data this afternoon.", "오늘 오후에 전환 데이터를 가져오겠습니다."],
    ["reorder the work and remind each owner before the deadline.", "작업 순서를 다시 정리하고 마감 전에 각 담당자에게 알려줘."],
    ["Pricing-page copy is the main blocker. It is due Friday, and both design and the conversion analysis are waiting for it.", "요금 페이지 카피가 가장 큰 병목입니다. 금요일이 마감이고 디자인과 전환 분석 모두 이 작업을 기다리고 있습니다."],
    ["I still owe three customer follow-ups. I can only book one today.", "고객 후속 조치가 아직 세 건 남아 있습니다. 오늘은 한 건만 예약할 수 있습니다."],
    ["Next time, do not split customer follow-ups by day. Rank them by renewal risk first.", "다음부터는 고객 후속 조치를 날짜별로 나누지 말고, 갱신 리스크 순으로 먼저 정렬해 주세요."],
    ["Got it. From now on I will rank customer follow-ups by renewal risk before delay, and I have reordered this list using that rule.", "알겠습니다. 앞으로 고객 후속 조치는 지연보다 갱신 리스크를 먼저 기준으로 정렬하고, 이번 목록도 그 규칙으로 다시 정리했습니다."],
    ["show me today's Nasdaq market and the hottest sectors.", "오늘 Nasdaq 시장과 가장 뜨거운 섹터를 보여줘."],
    ["Also flag the risks so I do not only look at the winners.", "상승 종목만 보지 않도록 리스크도 표시해 줘."],
    ["Added. Watch Jackson Hole, rate reversal risk, and whether the move broadens beyond NVDA into equipment and software.", "추가했습니다. Jackson Hole, 금리 반전 리스크, 그리고 움직임이 NVDA를 넘어 장비와 소프트웨어로 확산되는지 확인하세요."],
    ["Nasdaq Sector Brief - Aug 27, 2026 Close", "Nasdaq 섹터 브리프 - 2026년 8월 27일 마감"],
    ["Market tone: tech-led, very narrow breadth", "시장 분위기: 기술주 주도, 폭은 매우 좁음"],
    ["Nasdaq +1.57%, equal-weight S&P -0.30%", "Nasdaq +1.57%, 동일가중 S&P -0.30%"],
    ["VIX 14.51, risk appetite improved but breadth is thin", "VIX 14.51, 위험 선호는 개선됐지만 시장 폭은 얇음"],
    ["Leading themes", "주요 테마"],
    ["Cybersecurity: Okta +28.6%, CRWD +20.9%", "사이버보안: Okta +28.6%, CRWD +20.9%"],
    ["AI application software: Salesforce +23%, Adobe +5.7%", "AI 애플리케이션 소프트웨어: Salesforce +23%, Adobe +5.7%"],
    ["Semiconductor equipment / EDA: Synopsys +13%", "반도체 장비 / EDA: Synopsys +13%"],
    ["Optical / AI infrastructure: boosted by NVDA outlook", "광통신 / AI 인프라: NVDA 전망이 견인"],
    ["Semiconductors: NVDA +8.74%, AVGO +4.5%", "반도체: NVDA +8.74%, AVGO +4.5%"],
    ["Main chain: chips → equipment / EDA → optical → AI software / security", "주요 흐름: 칩 → 장비 / EDA → 광통신 → AI 소프트웨어 / 보안"],
    ["Note: airlines, healthcare, banks, and China ADRs weakened.", "참고: 항공, 헬스케어, 은행, 중국 ADR은 약세였습니다."],
    ["generated at", "생성 시각"],
    ["pages", "페이지"],
    ["auto-collected", "자동 수집"],
    ["Team Workspace", "팀 워크스페이스"],
    ["Friends", "친구"],
    ["MAIN HALL", "메인 홀"],
    ["memory-dedupe pushed", "memory-dedupe 푸시됨"],
    ["#337 skill follow-up", "#337 skill 후속 조치"],
    ["All checks passed.", "모든 체크를 통과했습니다."],
    ["v2.4.0 draft is ready.", "v2.4.0 초안이 준비되었습니다."],
    ["Two comments need responses.", "댓글 2개에 답변이 필요합니다."],
    ["The weekly summary is ready.", "주간 요약이 준비되었습니다."],
    ["Three endpoints were updated.", "엔드포인트 3개가 업데이트되었습니다."],
    ["Keep it small. Check provider sync and the session-end hook first.", "변경은 작게 유지해. 먼저 provider sync와 session-end hook을 확인해."],
    ["Post the patch and test results here. We will merge tonight.", "패치와 테스트 결과를 여기에 올려 주세요. 오늘 밤 병합하겠습니다."],
    ["Do not change the storage schema. Contain the concurrent write first.", "스토리지 스키마는 바꾸지 말고, 먼저 동시 쓰기를 제어하세요."],
    ["Add a regression case where sync and session end fire together.", "sync와 session end가 동시에 발생하는 회귀 테스트를 추가하세요."],
    ["Added. Twenty concurrent runs now produce one record each.", "추가했습니다. 이제 동시 실행 20건도 각각 레코드 하나만 생성합니다."],
    ["patch · tests passed", "patch · 테스트 통과"],
    ["2 orders may be late", "주문 2건이 늦을 수 있습니다"],
    ["Order delays are growing", "주문 지연이 늘고 있습니다"],
    ["Today at ", "오늘 "],
    ["Today ", "오늘 "],
  ],
});
const demoExactCopyTriples = [
  ["AI Companion Setup", "Pengaturan Pendamping AI", "Configuración del compañero de IA"],
  ["Plan Status", "Status Paket", "Estado del plan"],
  ["Ready to create.", "Siap dibuat.", "Listo para crear."],
  ["Start from Workbench", "Mulai dari ruang kerja", "Empieza desde el área de trabajo"],
  ["Pricing check", "Cek harga", "Revisión de precios"],
  ["Channel Setup", "Pengaturan kanal", "Configuración de canales"],
  ["Channels ready", "Kanal siap", "Canales listos"],
  ["Assistant Notes", "Catatan asisten", "Notas del asistente"],
  ["Preferences saved.", "Preferensi tersimpan.", "Preferencias guardadas."],
  ["Cloud Status", "Status Cloud", "Estado de la nube"],
  ["Running in the cloud.", "Berjalan di cloud.", "Funcionando en la nube."],
  ["Skills", "Skills", "Skills"],
  ["Knowledge and automations", "Pengetahuan dan automations", "Conocimiento y automatizaciones"],
  ["Help Digest", "Ringkasan bantuan", "Resumen de ayuda"],
  ["Setup tips are ready.", "Tips pengaturan sudah siap.", "Los consejos de configuración están listos."],
  ["Integrations", "Integrasi", "Integraciones"],
  ["Supported channels connected.", "Kanal yang didukung terhubung.", "Canales compatibles conectados."],
  ["@LightVela are you ready? Help me start my AI companion.", "@LightVela sudah siap? Bantu saya memulai pendamping AI saya.", "@LightVela ¿estás listo? Ayúdame a iniciar mi compañero de IA."],
  ["I want it to answer in my style and keep working in the cloud.", "Saya ingin ia menjawab dengan gaya saya dan tetap bekerja di cloud.", "Quiero que responda con mi estilo y siga trabajando en la nube."],
  ["Your AI companion is waiting to start. Create it in Workbench; if your plan is not active yet, go to Pricing first.", "Pendamping AI Anda siap dimulai. Buat di ruang kerja; jika paket belum aktif, buka halaman harga lebih dulu.", "Tu compañero de IA está listo para empezar. Créalo en el área de trabajo; si tu plan aún no está activo, ve primero a precios."],
  ["Take me to Workbench so I can set it up.", "Bawa saya ke ruang kerja agar bisa mengaturnya.", "Llévame al área de trabajo para configurarlo."],
  ["If my plan is not active, show me Pricing first.", "Jika paket saya belum aktif, tampilkan halaman harga dulu.", "Si mi plan no está activo, muéstrame precios primero."],
  ["Connect WhatsApp, Telegram, Discord, and Slack after creation.", "Hubungkan WhatsApp, Telegram, Discord, dan Slack setelah dibuat.", "Conecta WhatsApp, Telegram, Discord y Slack después de crearlo."],
  ["Done. I will guide you to Workbench when you are ready, and to Pricing when a plan is required.", "Selesai. Saya akan mengarahkan Anda ke ruang kerja saat siap, dan ke halaman harga saat perlu paket.", "Listo. Te guiaré al área de trabajo cuando estés listo y a precios cuando haga falta un plan."],
  ["Open Workbench to create your companion. If a plan is required, open Pricing first, then come back and connect your channels.", "Buka ruang kerja untuk membuat pendamping Anda. Jika perlu paket, buka halaman harga dulu, lalu kembali untuk menghubungkan kanal.", "Abre el área de trabajo para crear tu compañero. Si hace falta un plan, abre precios primero y luego vuelve para conectar tus canales."],
  ["lightvela-companion-setup.guide", "panduan-setup-companion-lightvela", "guia-configuracion-companion-lightvela"],
  ["Workbench · Pricing · Channels", "Ruang kerja · Harga · Kanal", "Área de trabajo · Precios · Canales"],
  ["工作台 · 购买页 · 通道", "Ruang kerja · Harga · Kanal", "Área de trabajo · Precios · Canales"],
  ["LightVela setup channel: create your AI companion in Workbench, then connect this community for reminders and Q&A.", "Kanal setup LightVela: buat pendamping AI di ruang kerja, lalu hubungkan komunitas ini untuk pengingat dan tanya jawab.", "Canal de configuración de LightVela: crea tu compañero de IA en el área de trabajo y luego conecta esta comunidad para recordatorios y preguntas."],
  ["@LightVela can you join this Discord server after I create you?", "@LightVela bisakah kamu bergabung ke server Discord ini setelah saya membuatmu?", "@LightVela ¿puedes unirte a este servidor de Discord después de crearte?"],
  ["Yes. Create me in Workbench first, then add the Discord channel. If your plan is not active, open Pricing before connecting.", "Bisa. Buat saya di ruang kerja dulu, lalu tambahkan kanal Discord. Jika paket belum aktif, buka halaman harga sebelum menghubungkan.", "Sí. Créame primero en el área de trabajo y luego añade el canal de Discord. Si tu plan no está activo, abre precios antes de conectar."],
  ["@LightVela What can you do here once connected?", "@LightVela apa yang bisa kamu lakukan di sini setelah terhubung?", "@LightVela ¿qué puedes hacer aquí cuando estés conectado?"],
  ["What can you do here once connected?", "Apa yang bisa kamu lakukan di sini setelah terhubung?", "¿Qué puedes hacer aquí cuando estés conectado?"],
  ["I can answer common questions, summarize long threads, and send reminders without asking people to leave Discord.", "Saya bisa menjawab pertanyaan umum, merangkum utas panjang, dan mengirim pengingat tanpa meminta orang keluar dari Discord.", "Puedo responder preguntas frecuentes, resumir hilos largos y enviar recordatorios sin sacar a nadie de Discord."],
  ["Can Slack work the same way?", "Apakah Slack bisa bekerja dengan cara yang sama?", "¿Slack puede funcionar igual?"],
  ["Yes. Slack, WhatsApp, Telegram, and Discord can all become places where your companion listens and responds.", "Ya. Slack, WhatsApp, Telegram, dan Discord semuanya bisa menjadi tempat pendamping Anda mendengar dan menjawab.", "Sí. Slack, WhatsApp, Telegram y Discord pueden ser lugares donde tu compañero escucha y responde."],
  ["Create the companion first, then connect channels.", "Buat pendamping dulu, lalu hubungkan kanal.", "Crea primero el compañero y luego conecta canales."],
  ["Set it up in Workbench; check Pricing first if the plan is not active.", "Atur di ruang kerja; cek halaman harga dulu jika paket belum aktif.", "Configúralo en el área de trabajo; revisa precios primero si el plan no está activo."],
  ["Create it in Workbench; check Pricing first if the plan is not active.", "Buat di ruang kerja; cek halaman harga dulu jika paket belum aktif.", "Créalo en el área de trabajo; revisa precios primero si el plan no está activo."],
  ["@LightVela we are setting up the team workspace. What comes first?", "@LightVela kami sedang menyiapkan workspace tim. Apa yang harus dilakukan dulu?", "@LightVela estamos configurando el workspace del equipo. ¿Qué va primero?"],
  ["Create your AI companion in Workbench first. I will keep the setup small: name, model, and the first channel.", "Buat pendamping AI Anda di ruang kerja dulu. Saya akan menjaga setup tetap kecil: nama, model, dan kanal pertama.", "Crea primero tu compañero de IA en el área de trabajo. Mantendré la configuración simple: nombre, modelo y primer canal."],
  ["I want WhatsApp, Telegram, Discord, and Slack connected.", "Saya ingin WhatsApp, Telegram, Discord, dan Slack terhubung.", "Quiero conectar WhatsApp, Telegram, Discord y Slack."],
  ["Good. After creation, connect each channel once. I will answer in the right place and keep shared context together.", "Bagus. Setelah dibuat, hubungkan tiap kanal sekali. Saya akan menjawab di tempat yang tepat dan menyatukan konteks bersama.", "Perfecto. Después de crearlo, conecta cada canal una vez. Responderé en el lugar correcto y mantendré el contexto unido."],
  ["If the plan is not active, send me to Pricing.", "Jika paket belum aktif, arahkan saya ke halaman harga.", "Si el plan no está activo, llévame a precios."],
  ["Understood. I will send you to Pricing first, then back to Workbench to finish channel setup.", "Dipahami. Saya akan mengarahkan Anda ke halaman harga dulu, lalu kembali ke ruang kerja untuk menyelesaikan setup kanal.", "Entendido. Te llevaré primero a precios y luego de vuelta al área de trabajo para terminar los canales."],
  ["Dinner Crew", "Grup Makan Malam", "Grupo de cena"],
  ["Hotpot tonight?", "Hotpot malam ini?", "¿Hotpot esta noche?"],
  ["I will check earnings tonight.", "Saya akan cek laporan earnings malam ini.", "Revisaré los resultados esta noche."],
  ["Project Team", "Tim Proyek", "Equipo de proyecto"],
  ["LightVela updated the weekly draft.", "LightVela memperbarui draf mingguan.", "LightVela actualizó el borrador semanal."],
  ["Home Shopping", "Belanja Rumah", "Compras del hogar"],
  ["Tue", "Sel", "Mar"],
  ["Milk and coffee are on the list.", "Susu dan kopi sudah masuk daftar.", "Leche y café están en la lista."],
  ["Mon", "Sen", "Lun"],
  ["Morning coffee is on me.", "Kopi pagi aku yang traktir.", "El café de la mañana lo invito yo."],
  ["Reading List", "Daftar Bacaan", "Lista de lectura"],
  ["Three reports are ready to review.", "Tiga laporan siap ditinjau.", "Tres informes están listos para revisar."],
  ["Travel Plans", "Rencana Perjalanan", "Planes de viaje"],
  ["Sun", "Min", "Dom"],
  ["The hotel confirmation is filed.", "Konfirmasi hotel sudah diarsipkan.", "La confirmación del hotel ya está archivada."],
  ["Sat", "Sab", "Sáb"],
  ["This week's digest is ready.", "Ringkasan minggu ini sudah siap.", "El resumen de esta semana está listo."],
  ["LightVela Dev", "Dev LightVela", "Dev de LightVela"],
  ["DSH finished the patch.", "DSH menyelesaikan patch.", "DSH terminó el parche."],
  ["LightVela Issues", "Isu LightVela", "Incidencias de LightVela"],
  ["#337 skill follow-up", "Tindak lanjut skill #337", "Seguimiento del skill #337"],
  ["CI Alerts", "Peringatan CI", "Alertas de CI"],
  ["All checks passed.", "Semua pemeriksaan lolos.", "Todas las comprobaciones pasaron."],
  ["Release Notes", "Catatan Rilis", "Notas de versión"],
  ["v2.4.0 draft is ready.", "Draf v2.4.0 sudah siap.", "El borrador v2.4.0 está listo."],
  ["Ops Monitor", "Monitor Operasi", "Monitor de operaciones"],
  ["API latency is back to normal.", "Latensi API sudah kembali normal.", "La latencia de la API volvió a la normalidad."],
  ["Design Review", "Ulasan Desain", "Revisión de diseño"],
  ["Two comments need responses.", "Dua komentar perlu dijawab.", "Dos comentarios necesitan respuesta."],
  ["Support Digest", "Ringkasan Dukungan", "Resumen de soporte"],
  ["The weekly summary is ready.", "Ringkasan mingguan sudah siap.", "El resumen semanal está listo."],
  ["API Changes", "Perubahan API", "Cambios de API"],
  ["Three endpoints were updated.", "Tiga endpoint diperbarui.", "Se actualizaron tres endpoints."],
  ["@LightVela ask DSH to fix LightVela: memory provider occasionally writes duplicate records. Reproduce first, then patch.", "@LightVela minta DSH memperbaiki LightVela: memory provider kadang menulis record duplikat. Reproduksi dulu, lalu patch.", "@LightVela pídele a DSH que corrija LightVela: el proveedor de memoria a veces escribe registros duplicados. Primero reproducir, luego parchear."],
  ["Keep it small. Check provider sync and the session-end hook first.", "Jaga tetap kecil. Cek sinkronisasi provider dan hook akhir sesi dulu.", "Manténlo pequeño. Revisa primero la sincronización del proveedor y el hook de fin de sesión."],
  ["DSH reproduced it in an isolated branch. It happens when provider sync and session end fire together.", "DSH mereproduksinya di branch terisolasi. Ini terjadi saat sinkronisasi provider dan akhir sesi berjalan bersamaan.", "DSH lo reprodujo en una rama aislada. Ocurre cuando la sincronización del proveedor y el fin de sesión se disparan juntos."],
  ["Post the patch and test results here. We will merge tonight.", "Kirim patch dan hasil tes di sini. Kita merge malam ini.", "Publica aquí el parche y los resultados de pruebas. Lo fusionamos esta noche."],
  ["Do not change the storage schema. Contain the concurrent write first.", "Jangan ubah skema penyimpanan. Batasi dulu penulisan bersamaan.", "No cambies el esquema de almacenamiento. Contén primero la escritura concurrente."],
  ["Add a regression case where sync and session end fire together.", "Tambahkan kasus regresi saat sinkronisasi dan akhir sesi berjalan bersamaan.", "Añade un caso de regresión donde la sincronización y el fin de sesión ocurren juntos."],
  ["Added. Twenty concurrent runs now produce one record each.", "Ditambahkan. Dua puluh run paralel sekarang masing-masing menghasilkan satu record.", "Añadido. Veinte ejecuciones concurrentes ahora producen un registro cada una."],
  ["The minimal fix is ready with a regression test. Unit, integration, and CI all pass. Review only provider sync and the session-end hook.", "Perbaikan minimal siap dengan tes regresi. Unit, integrasi, dan CI semua lolos. Review hanya sinkronisasi provider dan hook akhir sesi.", "La corrección mínima está lista con una prueba de regresión. Unitarias, integración y CI pasan. Revisen solo la sincronización del proveedor y el hook de fin de sesión."],
  ["When does the tournament start in my time zone?", "Turnamen mulai jam berapa di zona waktu saya?", "¿A qué hora empieza el torneo en mi zona horaria?"],
  ["The tournament starts Friday at 8:00 PM GMT+8. For you, that's 10:00 PM AEST.", "Turnamen mulai Jumat pukul 20.00 GMT+8. Untuk Anda, itu pukul 22.00 AEST.", "El torneo empieza el viernes a las 20:00 GMT+8. Para ti, son las 22:00 AEST."],
  ["What do I need before joining tonight's raid?", "Apa yang perlu saya siapkan sebelum ikut raid malam ini?", "¿Qué necesito antes de unirme a la raid de esta noche?"],
  ["Make sure you're registered, read the rules in", "Pastikan Anda sudah terdaftar, baca aturan di", "Asegúrate de estar registrado, lee las reglas en"],
  ["What if I registered but have not been assigned a team?", "Bagaimana kalau saya sudah daftar tapi belum mendapat tim?", "¿Y si me registré pero aún no me asignaron equipo?"],
  ["Check in at", "Check-in di", "Haz check-in en"],
  ["30 minutes before the event. Moderators will fill open spots, and I will summarize which teams still need players.", "30 menit sebelum acara. Moderator akan mengisi slot kosong, dan saya akan merangkum tim yang masih butuh pemain.", "30 minutos antes del evento. Los moderadores llenarán plazas libres y yo resumiré qué equipos aún necesitan jugadores."],
  ["Remind us once more before it starts.", "Ingatkan kami sekali lagi sebelum mulai.", "Recuérdanos una vez más antes de que empiece."],
  ["Generate executive, customer, and execution versions from the same source", "Buat versi eksekutif, pelanggan, dan eksekusi dari sumber yang sama", "Genera versiones ejecutiva, cliente y ejecución desde la misma fuente"],
  ["Keep source trails so the original material is easy to verify", "Simpan jejak sumber agar materi asli mudah diverifikasi", "Mantén trazas de fuente para verificar fácilmente el material original"],
  ["LightVela Cases", "Contoh LightVela", "Casos de LightVela"],
  ["We just finished the pricing-page meeting. Can you sort the notes and tasks?", "Kami baru selesai rapat halaman pricing. Bisa rapikan catatan dan tugasnya?", "Acabamos la reunión de la página de precios. ¿Puedes ordenar notas y tareas?"],
  ["Done. Three decisions were actually made, and one risk is still open:", "Selesai. Ada tiga keputusan yang benar-benar dibuat, dan satu risiko masih terbuka:", "Listo. Se tomaron tres decisiones reales y queda un riesgo abierto:"],
  ["Pricing page meeting notes", "Catatan rapat halaman pricing", "Notas de la reunión de precios"],
  ["Decision", "Keputusan", "Decisión"],
  ["Ship the single-currency version on Aug 28; multi-currency moves to the next iteration", "Rilis versi satu mata uang pada 28 Agu; multi-mata uang masuk iterasi berikutnya", "Lanzar versión de moneda única el 28 de agosto; multimoneda pasa a la siguiente iteración"],
  ["Owners", "Pemilik", "Responsables"],
  ["Lina owns copy, Alex owns the page, Rachel owns cost wording, you own 3 customer follow-ups", "Lina menangani copy, Alex halaman, Rachel wording biaya, Anda menangani 3 follow-up pelanggan", "Lina lleva el copy, Alex la página, Rachel el texto de costes, tú llevas 3 seguimientos de cliente"],
  ["Risk", "Risiko", "Riesgo"],
  ["Copy cannot be final until Finance confirms cost wording", "Copy belum final sampai Finance mengonfirmasi wording biaya", "El copy no puede cerrarse hasta que Finanzas confirme el texto de costes"],
  ["Tasks created", "Tugas dibuat", "Tareas creadas"],
  ["Rachel by Aug 19, copy by Aug 21, page to QA by Aug 22", "Rachel paling lambat 19 Agu, copy 21 Agu, halaman ke QA 22 Agu", "Rachel antes del 19 de agosto, copy antes del 21, página a QA antes del 22"],
  ["Send it to the project channel, and draft the weekly report too.", "Kirim ke kanal proyek, dan buat juga draf laporan mingguan.", "Envíalo al canal del proyecto y prepara también el informe semanal."],
  ["Sent. I also drafted the weekly report in your last format:", "Terkirim. Saya juga membuat draf laporan mingguan dengan format terakhir Anda:", "Enviado. También preparé el informe semanal con tu último formato:"],
  ["This customer interview is too long. Read it first.", "Wawancara pelanggan ini terlalu panjang. Baca dulu.", "Esta entrevista de cliente es demasiado larga. Léela primero."],
  ["Read. Instead of a long summary, here are the parts that affect the next move:", "Sudah dibaca. Alih-alih ringkasan panjang, ini bagian yang memengaruhi langkah berikutnya:", "Leído. En vez de un resumen largo, estas son las partes que afectan el siguiente paso:"],
  ["Customer Archive feature quick read", "Ringkasan cepat fitur Customer Archive", "Lectura rápida de Customer Archive"],
  ["Need", "Kebutuhan", "Necesidad"],
  ["They want sales leads, contracts, and payments connected so teams stop checking manually", "Mereka ingin leads penjualan, kontrak, dan pembayaran terhubung agar tim tidak mengecek manual", "Quieren conectar leads, contratos y pagos para que el equipo deje de revisar manualmente"],
  ["Opportunity", "Peluang", "Oportunidad"],
  ["They are open to a 12-person pilot if Slack summaries work", "Mereka terbuka untuk pilot 12 orang jika ringkasan Slack berjalan baik", "Aceptan un piloto de 12 personas si los resúmenes de Slack funcionan"],
  ["Concern", "Kekhawatiran", "Preocupación"],
  ["They require human approval before any external action", "Mereka meminta persetujuan manusia sebelum tindakan eksternal apa pun", "Requieren aprobación humana antes de cualquier acción externa"],
  ["Next step", "Langkah berikutnya", "Siguiente paso"],
  ["Reply with a read-only plus manual-approval pilot plan", "Balas dengan rencana pilot read-only plus persetujuan manual", "Responder con un piloto de solo lectura y aprobación manual"],
  ["Write the customer reply. Keep it plain, not salesy.", "Tulis balasan pelanggan. Buat sederhana, jangan terasa jualan.", "Escribe la respuesta al cliente. Clara, sin tono comercial."],
  ["Draft:", "Draf:", "Borrador:"],
  ["We can start with a read-only setup and keep every external action behind manual approval. The first version will summarize leads, quote status, contract status, and payment milestones. Nothing will be sent or changed without your confirmation.", "Kita bisa mulai dengan setup read-only dan menahan setiap tindakan eksternal sampai ada persetujuan manual. Versi pertama akan merangkum leads, status penawaran, status kontrak, dan milestone pembayaran. Tidak ada yang dikirim atau diubah tanpa konfirmasi Anda.", "Podemos empezar con una configuración de solo lectura y dejar cada acción externa bajo aprobación manual. La primera versión resumirá leads, estado de cotizaciones, contratos e hitos de pago. Nada se enviará ni cambiará sin tu confirmación."],
  ["Customer reply draft", "Draf balasan pelanggan", "Borrador de respuesta al cliente"],
  ["@LightVela The customer says the price is high again. Who should reply?", "@LightVela pelanggan bilang harganya masih tinggi. Siapa yang sebaiknya membalas?", "@LightVela el cliente vuelve a decir que el precio es alto. ¿Quién debería responder?"],
  ["@LightVela read the context and draft a reply for me", "@LightVela baca konteksnya dan buatkan draf balasan untuk saya", "@LightVela lee el contexto y prepara una respuesta para mí"],
  ["I checked 17 messages from last Wednesday through today. This is not just price pressure; they are worried the pilot will not show value.", "Saya mengecek 17 pesan dari Rabu lalu sampai hari ini. Ini bukan sekadar tekanan harga; mereka khawatir pilot tidak menunjukkan nilai.", "Revisé 17 mensajes desde el miércoles pasado hasta hoy. No es solo presión de precio; les preocupa que el piloto no demuestre valor."],
  ["Acknowledge the budget concern", "Akui kekhawatiran soal anggaran", "Reconocer la preocupación de presupuesto"],
  ["Suggest a 14-day pilot with one success metric: hours saved", "Usulkan pilot 14 hari dengan satu metrik sukses: jam yang dihemat", "Sugerir un piloto de 14 días con una métrica: horas ahorradas"],
  ["Promise a day-7 review before discussing a smaller plan", "Janjikan review hari ke-7 sebelum membahas paket lebih kecil", "Prometer revisión el día 7 antes de hablar de un plan menor"],
  ["I put the draft in the input box. I have not sent it yet.", "Saya menaruh draf di kotak input. Belum saya kirim.", "Puse el borrador en la caja de texto. Aún no lo envié."],
  ["Start from rent, medication, exchange rate, stock, and routine templates", "Mulai dari template sewa, obat, kurs, saham, dan rutinitas", "Empieza con plantillas de alquiler, medicamentos, divisas, bolsa y rutinas"],
  ["Confirm time, frequency, and channel before enabling", "Konfirmasi waktu, frekuensi, dan kanal sebelum mengaktifkan", "Confirma hora, frecuencia y canal antes de activar"],
  ["Keep execution records so tasks can be adjusted later", "Simpan catatan eksekusi agar tugas bisa disesuaikan nanti", "Guarda registros de ejecución para ajustar tareas después"],
  ["Check orders, budgets, web pages, and service status on schedule", "Cek pesanan, anggaran, halaman web, dan status layanan sesuai jadwal", "Revisa pedidos, presupuestos, webs y servicios según horario"],
  ["Summarize evidence and suggested action before changing anything", "Ringkas bukti dan tindakan yang disarankan sebelum mengubah apa pun", "Resume evidencias y acciones sugeridas antes de cambiar nada"],
  ["Execute only after approval", "Jalankan hanya setelah disetujui", "Ejecuta solo tras aprobación"],
  ["Save one-off preferences as durable operating rules", "Simpan preferensi sesaat sebagai aturan kerja yang tahan lama", "Guarda preferencias puntuales como reglas duraderas"],
  ["Separate routine tasks, sensitive tasks, and approval-required tasks", "Pisahkan tugas rutin, tugas sensitif, dan tugas yang perlu persetujuan", "Separa tareas rutinarias, sensibles y con aprobación requerida"],
  ["Ask a clarifying question instead of guessing", "Ajukan pertanyaan klarifikasi alih-alih menebak", "Pregunta para aclarar en vez de adivinar"],
  ["Show me the automation templates. I want to set up the common ones.", "Tampilkan template automations. Saya ingin mengatur yang umum.", "Muéstrame las plantillas de automatización. Quiero configurar las comunes."],
  ["Here is the template area. Pick a common case and I will confirm the details before enabling it.", "Ini area template. Pilih kasus umum dan saya akan konfirmasi detailnya sebelum mengaktifkan.", "Aquí está el área de plantillas. Elige un caso común y confirmaré los detalles antes de activarlo."],
  ["water, rent, exchange rates, fitness, stock updates", "air, sewa, kurs, fitness, pembaruan saham", "agua, alquiler, divisas, fitness, actualizaciones bursátiles"],
  ["Automation template area", "Area template automation", "Área de plantillas de automatización"],
  ["Enable rent reminders on the 5th, one the night before and one that morning.", "Aktifkan pengingat sewa tanggal 5, satu malam sebelumnya dan satu pagi harinya.", "Activa recordatorios de alquiler el día 5, uno la noche anterior y otro esa mañana."],
  ["Done. I will remind you at 20:00 on the 4th and 08:00 on the 5th every month, through Telegram and WhatsApp.", "Selesai. Saya akan mengingatkan pukul 20.00 tanggal 4 dan 08.00 tanggal 5 setiap bulan lewat Telegram dan WhatsApp.", "Listo. Te recordaré a las 20:00 del día 4 y a las 08:00 del día 5 cada mes por Telegram y WhatsApp."],
  ["Check coffee orders every 20 minutes. If anything is not shipped after an hour, tell the staff.", "Cek pesanan kopi tiap 20 menit. Jika ada yang belum dikirim setelah satu jam, beri tahu staf.", "Revisa pedidos de café cada 20 minutos. Si algo no se envía tras una hora, avisa al personal."],
  ["Task is running. I will only act when the condition matches.", "Tugas berjalan. Saya hanya bertindak saat kondisinya cocok.", "La tarea está activa. Solo actuaré cuando se cumpla la condición."],
  ["Automation", "Otomatisasi", "Automatización"],
  ["Frequency", "Frekuensi", "Frecuencia"],
  ["Every 20 minutes", "Setiap 20 menit", "Cada 20 minutos"],
  ["Condition", "Kondisi", "Condición"],
  ["Paid orders older than 60 minutes without shipment", "Pesanan berbayar lebih dari 60 menit tanpa pengiriman", "Pedidos pagados con más de 60 minutos sin envío"],
  ["Action", "Tindakan", "Acción"],
  ["Notify staff first, then send the order IDs to you", "Beri tahu staf dulu, lalu kirim ID pesanan kepada Anda", "Avisar al personal primero y luego enviarte los ID de pedido"],
  ["Guardrail", "Batasan", "Límite"],
  ["No refunds or inventory edits", "Tidak ada refund atau perubahan inventori", "Sin reembolsos ni cambios de inventario"],
  ["2 orders may be late", "2 pesanan mungkin terlambat", "2 pedidos pueden estar retrasados"],
  ["Orders #8172 and #8178 are over 60 minutes old.", "Pesanan #8172 dan #8178 sudah lebih dari 60 menit.", "Los pedidos #8172 y #8178 superan los 60 minutos."],
  ["I can message Mia: these two are overdue, please handle them first and fill in the reason. Send it now?", "Saya bisa mengirim pesan ke Mia: dua pesanan ini terlambat, tolong tangani dulu dan isi alasannya. Kirim sekarang?", "Puedo escribir a Mia: estos dos están retrasados, revísalos primero y añade el motivo. ¿Lo envío ahora?"],
  ["When a customer says the quote is high, do not discount immediately. Diagnose why first.", "Saat pelanggan bilang penawaran mahal, jangan langsung diskon. Diagnosa alasannya dulu.", "Cuando un cliente diga que la cotización es alta, no descuentos de inmediato. Diagnostica primero el motivo."],
  ["Saved to sales-follow-up rules:", "Disimpan ke aturan sales-follow-up:", "Guardado en reglas de seguimiento comercial:"],
  ["Read the latest meeting notes and quote email first", "Baca catatan rapat dan email penawaran terbaru dulu", "Leer primero las últimas notas de reunión y el email de cotización"],
  ["Classify the issue as budget, value, authority, or timing", "Klasifikasikan isu sebagai anggaran, nilai, otoritas, atau timing", "Clasificar el problema como presupuesto, valor, autoridad o timing"],
  ["Only write a discount reply if you explicitly approve discounting", "Tulis balasan diskon hanya jika Anda menyetujui diskon secara eksplisit", "Escribir respuesta con descuento solo si apruebas explícitamente descontar"],
  ["Default to pilot, phased rollout, or read-only setup", "Default ke pilot, rollout bertahap, atau setup read-only", "Priorizar piloto, despliegue gradual o configuración de solo lectura"],
  ["@LightVela this customer says it is too expensive again", "@LightVela pelanggan ini bilang terlalu mahal lagi", "@LightVela este cliente vuelve a decir que es demasiado caro"],
  ["Using the new rule: this looks like a value concern, not a budget ceiling. They said they were worried the pilot would not be used.", "Menggunakan aturan baru: ini terlihat seperti kekhawatiran nilai, bukan batas anggaran. Mereka bilang khawatir pilot tidak akan dipakai.", "Con la nueva regla: parece una preocupación de valor, no un techo de presupuesto. Dijeron que les preocupaba que el piloto no se usara."],
  ["Turn PDFs, contracts, notes, and links into searchable memory", "Ubah PDF, kontrak, catatan, dan tautan menjadi memori yang bisa dicari", "Convierte PDF, contratos, notas y enlaces en memoria consultable"],
  ["Answer with source trails", "Jawab dengan jejak sumber", "Responde con trazas de fuente"],
  ["Keep project context so you do not repeat yourself", "Simpan konteks proyek agar Anda tidak perlu mengulang", "Mantén el contexto del proyecto para no repetir explicaciones"],
  ["Collect meeting notes, PDFs, spreadsheets, and screenshots", "Kumpulkan catatan rapat, PDF, spreadsheet, dan screenshot", "Recoge notas de reunión, PDF, hojas de cálculo y capturas"],
  ["Archive by project, customer, or personal area", "Arsipkan berdasarkan proyek, pelanggan, atau area pribadi", "Archiva por proyecto, cliente o área personal"],
  ["Convert new material into summaries, tasks, and context", "Ubah materi baru menjadi ringkasan, tugas, dan konteks", "Convierte material nuevo en resúmenes, tareas y contexto"],
  ["Save writing format, approval boundaries, names, and routines", "Simpan format tulisan, batas persetujuan, nama, dan rutinitas", "Guarda formato de escritura, límites de aprobación, nombres y rutinas"],
  ["Flag conflicts instead of forcing a decision", "Tandai konflik alih-alih memaksakan keputusan", "Marca conflictos en vez de forzar una decisión"],
  ["Use less repeated explanation over time", "Kurangi penjelasan berulang dari waktu ke waktu", "Reduce explicaciones repetidas con el tiempo"],
  ["Add these interviews to the knowledge base. I want to ask questions later.", "Tambahkan wawancara ini ke knowledge base. Saya ingin bertanya nanti.", "Añade estas entrevistas a la base de conocimiento. Quiero hacer preguntas después."],
  ["Imported and split into 184 searchable snippets.", "Diimpor dan dibagi menjadi 184 snippet yang bisa dicari.", "Importado y dividido en 184 fragmentos consultables."],
  ["Q3 customer interview knowledge base", "Knowledge base wawancara pelanggan Q3", "Base de conocimiento de entrevistas Q3"],
  ["What do customers complain about most?", "Apa yang paling sering dikeluhkan pelanggan?", "¿De qué se quejan más los clientes?"],
  ["Inconsistent reporting definitions: 12 of 18 customers", "Definisi laporan tidak konsisten: 12 dari 18 pelanggan", "Definiciones de reporting inconsistentes: 12 de 18 clientes"],
  ["Approval chains are too slow: 9 of 18 customers", "Rantai persetujuan terlalu lambat: 9 dari 18 pelanggan", "Cadenas de aprobación demasiado lentas: 9 de 18 clientes"],
  ["New teammates take too long to onboard: 7 of 18 customers", "Anggota tim baru terlalu lama onboarding: 7 dari 18 pelanggan", "Nuevos miembros tardan demasiado en incorporarse: 7 de 18 clientes"],
  ["Each point links back to the original PDF page.", "Setiap poin terhubung kembali ke halaman PDF asli.", "Cada punto enlaza a la página original del PDF."],
  ["Every weekday at 11, organize new meeting notes and PDFs into Nextcloud.", "Setiap hari kerja pukul 11, atur catatan rapat dan PDF baru ke Nextcloud.", "Cada día laboral a las 11, organiza nuevas notas de reunión y PDF en Nextcloud."],
  ["I can do that with read-only access to inbox and calendar attachments.", "Saya bisa melakukannya dengan akses read-only ke inbox dan lampiran kalender.", "Puedo hacerlo con acceso de solo lectura al inbox y adjuntos de calendario."],
  ["Archive rule", "Aturan arsip", "Regla de archivo"],
  ["Time", "Waktu", "Hora"],
  ["Weekdays at 11:00", "Hari kerja pukul 11.00", "Días laborales a las 11:00"],
  ["Sources", "Sumber", "Fuentes"],
  ["Gmail attachments, calendar notes, Slack files", "Lampiran Gmail, catatan kalender, file Slack", "Adjuntos de Gmail, notas de calendario, archivos de Slack"],
  ["Archive", "Arsip", "Archivo"],
  ["By customer and project in Nextcloud", "Berdasarkan pelanggan dan proyek di Nextcloud", "Por cliente y proyecto en Nextcloud"],
  ["Output", "Keluaran", "Salida"],
  ["Summary, tasks, uncategorized file list", "Ringkasan, tugas, daftar file belum dikategorikan", "Resumen, tareas y lista de archivos sin clasificar"],
  ["When I say executive version, make it short, direct, and conclusion first.", "Saat saya bilang versi eksekutif, buat singkat, langsung, dan simpulan di awal.", "Cuando diga versión ejecutiva, hazla breve, directa y con la conclusión primero."],
  ["Saved. Executive version means:", "Disimpan. Versi eksekutif berarti:", "Guardado. Versión ejecutiva significa:"],
  ["Conclusion in the first sentence", "Simpulan di kalimat pertama", "Conclusión en la primera frase"],
  ["No more than three evidence points", "Maksimal tiga poin bukti", "No más de tres evidencias"],
  ["Risks and required decisions separated", "Risiko dan keputusan yang dibutuhkan dipisahkan", "Riesgos y decisiones requeridas separados"],
  ["No background unless you ask for it", "Tanpa latar belakang kecuali Anda memintanya", "Sin contexto salvo que lo pidas"],
  ["Make the Customer Archive feature notes executive version.", "Buat catatan fitur Customer Archive menjadi versi eksekutif.", "Convierte las notas de Customer Archive en versión ejecutiva."],
  ["Executive version: Customer Archive feature is worth a pilot, but version one should be read-only with manual approval. They want sales, contracts, and payment status connected; the main risk is contract amount misreading, so every external action should stop for confirmation.", "Versi eksekutif: fitur Customer Archive layak dipilotkan, tetapi versi pertama sebaiknya read-only dengan persetujuan manual. Mereka ingin status sales, kontrak, dan pembayaran terhubung; risiko utama adalah salah baca nilai kontrak, jadi setiap tindakan eksternal harus berhenti untuk konfirmasi.", "Versión ejecutiva: Customer Archive merece un piloto, pero la primera versión debe ser de solo lectura con aprobación manual. Quieren conectar ventas, contratos y pagos; el principal riesgo es leer mal importes de contrato, así que toda acción externa debe detenerse para confirmación."],
  ["Watch news, releases, price changes, and filings in the background", "Pantau berita, rilis, perubahan harga, dan filing di latar belakang", "Vigila noticias, lanzamientos, cambios de precio y filings en segundo plano"],
  ["Deduplicate and cross-check sources", "Deduplicasi dan cek silang sumber", "Deduplica y contrasta fuentes"],
  ["Push only decision-relevant changes", "Kirim hanya perubahan yang relevan untuk keputusan", "Envía solo cambios relevantes para decidir"],
  ["Monitor orders, inventory, services, and feedback", "Pantau pesanan, inventori, layanan, dan feedback", "Monitorea pedidos, inventario, servicios y feedback"],
  ["Attach evidence and impact scope", "Lampirkan bukti dan cakupan dampak", "Adjunta evidencias y alcance de impacto"],
  ["Distinguish reminders from urgent risks", "Bedakan pengingat dari risiko mendesak", "Distingue recordatorios de riesgos urgentes"],
  ["Track local events, content ideas, releases, and customer opportunities", "Pantau acara lokal, ide konten, rilis, dan peluang pelanggan", "Sigue eventos locales, ideas de contenido, lanzamientos y oportunidades de cliente"],
  ["Explain why something is worth seeing", "Jelaskan mengapa sesuatu layak dilihat", "Explica por qué algo merece atención"],
  ["Turn findings into daily briefs, reports, or shareable pages", "Ubah temuan menjadi briefing harian, laporan, atau halaman yang bisa dibagikan", "Convierte hallazgos en briefs diarios, informes o páginas compartibles"],
  ["Morning brief. Only three items matter today:", "Brief pagi. Hanya tiga hal yang penting hari ini:", "Brief matutino. Solo importan tres cosas hoy:"],
  ["Competitor A launched team budgets, overlapping next month roadmap", "Kompetitor A meluncurkan team budgets, tumpang tindih dengan roadmap bulan depan", "Competidor A lanzó presupuestos de equipo, solapando el roadmap del próximo mes"],
  ["OpenRouter price changes may lower low-frequency task cost by 12%", "Perubahan harga OpenRouter bisa menurunkan biaya tugas frekuensi rendah sebesar 12%", "Cambios de precio de OpenRouter pueden reducir un 12% el coste de tareas poco frecuentes"],
  ["A GitHub dependency released 2.4.0 with auth callback breaking changes", "Dependensi GitHub merilis 2.4.0 dengan breaking change pada callback auth", "Una dependencia de GitHub lanzó 2.4.0 con breaking changes en callbacks de auth"],
  ["Full radar log", "Log radar lengkap", "Registro completo del radar"],
  ["Order delays are growing", "Keterlambatan pesanan meningkat", "Los retrasos de pedidos aumentan"],
  ["11 new late orders appeared in the last 30 minutes.", "11 pesanan terlambat baru muncul dalam 30 menit terakhir.", "Aparecieron 11 nuevos pedidos retrasados en los últimos 30 minutos."],
  ["The printer queue started repeating errors at 14:02. Windows printing still works.", "Antrean printer mulai mengulang error pukul 14.02. Print dari Windows masih berjalan.", "La cola de impresión empezó a repetir errores a las 14:02. La impresión desde Windows aún funciona."],
  ["Tell staff to print from Windows for now.", "Beri tahu staf agar sementara print dari Windows.", "Indica al personal que imprima desde Windows por ahora."],
  ["Sent. I also scheduled a follow-up check in 15 minutes.", "Terkirim. Saya juga menjadwalkan pengecekan ulang dalam 15 menit.", "Enviado. También programé una revisión en 15 minutos."],
  ["Watch small music events in Shanghai this weekend. Avoid commercial ones.", "Pantau acara musik kecil di Shanghai akhir pekan ini. Hindari yang komersial.", "Busca eventos musicales pequeños en Shanghái este fin de semana. Evita los comerciales."],
  ["Found three that fit your taste:", "Menemukan tiga yang cocok dengan selera Anda:", "Encontré tres que encajan con tu gusto:"],
  ["Saturday 20:30, Yuyintang, indie label showcase, 120 RMB", "Sabtu 20.30, Yuyintang, showcase label indie, 120 RMB", "Sábado 20:30, Yuyintang, showcase de sello indie, 120 RMB"],
  ["Sunday 16:00, M50 rooftop, small electronic live set", "Minggu 16.00, rooftop M50, live elektronik kecil", "Domingo 16:00, azotea M50, set electrónico pequeño"],
  ["Sunday 19:30, jazz improv, 4.2 km away", "Minggu 19.30, improv jazz, 4,2 km dari Anda", "Domingo 19:30, improvisación jazz, a 4,2 km"],
  ["Filtered event list", "Daftar acara tersaring", "Lista de eventos filtrada"],
  ["Read receipts, bills, and payment screenshots", "Baca struk, tagihan, dan screenshot pembayaran", "Lee recibos, facturas y capturas de pago"],
  ["Split expenses by budget category, client, or project", "Pisahkan pengeluaran berdasarkan kategori anggaran, pelanggan, atau proyek", "Divide gastos por categoría de presupuesto, cliente o proyecto"],
  ["Warn when spending is likely to exceed plan", "Peringatkan saat pengeluaran mungkin melebihi rencana", "Avisa cuando el gasto pueda superar el plan"],
  ["Connect quotes, contracts, invoices, payments, and expenses", "Hubungkan penawaran, kontrak, invoice, pembayaran, dan pengeluaran", "Conecta cotizaciones, contratos, facturas, pagos y gastos"],
  ["Stop for approval before sending or changing anything external", "Berhenti untuk persetujuan sebelum mengirim atau mengubah apa pun di luar", "Detente para aprobación antes de enviar o cambiar algo externo"],
  ["Reduce admin work for freelancers and small teams", "Kurangi kerja admin untuk freelancer dan tim kecil", "Reduce administración para freelancers y equipos pequeños"],
  ["Summarize revenue, leads, costs, and customer status", "Ringkas pendapatan, leads, biaya, dan status pelanggan", "Resume ingresos, leads, costes y estado de clientes"],
  ["Highlight exceptions instead of dumping metrics", "Sorot pengecualian, bukan menumpuk metrik", "Destaca excepciones en vez de volcar métricas"],
  ["Turn tracked data into dashboards or periodic reports", "Ubah data terlacak menjadi dashboard atau laporan berkala", "Convierte datos monitoreados en dashboards o informes periódicos"],
  ["Log this receipt and tell me whether this month is over budget.", "Catat struk ini dan beri tahu apakah bulan ini melebihi anggaran.", "Registra este recibo y dime si este mes supera el presupuesto."],
  ["one image", "satu gambar", "una imagen"],
  ["Shopping receipt", "Struk belanja", "Recibo de compra"],
  ["Logged. Total is 46.37. Here is the receipt breakdown:", "Tercatat. Totalnya 46,37. Berikut rincian struknya:", "Registrado. El total es 46,37. Este es el desglose:"],
  ["Receipt result", "Hasil struk", "Resultado del recibo"],
  ["Groceries", "Bahan makanan", "Comestibles"],
  ["Household item", "Barang rumah tangga", "Artículo del hogar"],
  ["Tax", "Pajak", "Impuesto"],
  ["Total", "Total", "Total"],
  ["Where is Customer Archive feature stuck between quote and payment?", "Di mana fitur Customer Archive tersendat antara penawaran dan pembayaran?", "¿Dónde está bloqueado Customer Archive entre cotización y pago?"],
  ["I checked the quote, contract, and finance sheet:", "Saya mengecek penawaran, kontrak, dan sheet keuangan:", "Revisé la cotización, el contrato y la hoja financiera:"],
  ["Customer Archive feature commercial status", "Status komersial fitur Customer Archive", "Estado comercial de Customer Archive"],
  ["Quote", "Penawaran", "Cotización"],
  ["Confirmed at 48,000", "Dikonfirmasi sebesar 48.000", "Confirmado en 48.000"],
  ["Contract", "Kontrak", "Contrato"],
  ["Customer legal left two comments on Aug 20; internal reply pending", "Legal pelanggan meninggalkan dua komentar pada 20 Agu; balasan internal masih tertunda", "Legal del cliente dejó dos comentarios el 20 de agosto; respuesta interna pendiente"],
  ["Invoice", "Faktur", "Factura"],
  ["Not issued until contract is signed", "Belum diterbitkan sampai kontrak ditandatangani", "No se emite hasta firmar el contrato"],
  ["Payment", "Pembayaran", "Pago"],
  ["Expected 7 working days after signing", "Diperkirakan 7 hari kerja setelah tanda tangan", "Previsto 7 días laborales tras la firma"],
  ["Legal follow-up draft", "Draf follow-up legal", "Borrador de seguimiento legal"],
  ["Business daily:", "Harian bisnis:", "Resumen diario:"],
  ["Freelance assistant daily", "Harian asisten freelancer", "Diario del asistente freelance"],
  ["Revenue", "Pendapatan", "Ingresos"],
  ["18,400 confirmed this week, +22% week over week", "18.400 terkonfirmasi minggu ini, +22% dibanding minggu lalu", "18.400 confirmados esta semana, +22% semanal"],
  ["Leads", "Prospek", "Prospectos"],
  ["7 new leads, 2 from customer referrals", "7 lead baru, 2 dari referral pelanggan", "7 leads nuevos, 2 por referidos de clientes"],
  ["Customer Archive feature legal follow-up may push payment into next week", "Follow-up legal fitur Customer Archive bisa mendorong pembayaran ke minggu depan", "El seguimiento legal de Customer Archive puede mover el pago a la próxima semana"],
  ["Next action", "Tindakan berikutnya", "Siguiente acción"],
  ["Handle Customer Archive feature first, then Vera revised quote", "Tangani fitur Customer Archive dulu, lalu revisi penawaran Vera", "Atender primero Customer Archive y luego la cotización revisada de Vera"],
  ["Make this a mobile dashboard.", "Jadikan ini dashboard mobile.", "Haz esto como dashboard móvil."],
  ["Generated. On mobile, open tasks appear first, then revenue and lead trends.", "Sudah dibuat. Di mobile, tugas terbuka muncul dulu, lalu pendapatan dan tren leads.", "Generado. En móvil aparecen primero tareas abiertas, luego ingresos y tendencias de leads."],
  ["Business tracking dashboard", "Dashboard pelacakan bisnis", "Dashboard de seguimiento comercial"],
  ["Put family calendars, tasks, school events, and chores in one place", "Satukan kalender keluarga, tugas, acara sekolah, dan pekerjaan rumah", "Pon calendarios familiares, tareas, escuela y quehaceres en un lugar"],
  ["Let both people add and claim shared tasks", "Biarkan dua orang menambah dan mengambil tugas bersama", "Permite que ambas personas añadan y reclamen tareas compartidas"],
  ["Flag conflicts and suggest adjustments", "Tandai konflik dan sarankan penyesuaian", "Marca conflictos y sugiere ajustes"],
  ["Plan meals from calendar, weather, inventory, and preferences", "Rencanakan makan dari kalender, cuaca, stok, dan preferensi", "Planifica comidas según calendario, clima, inventario y preferencias"],
  ["Generate shopping lists and update inventory from photos", "Buat daftar belanja dan perbarui stok dari foto", "Genera listas de compra y actualiza inventario desde fotos"],
  ["Remember family tastes and restrictions", "Ingat selera dan batasan keluarga", "Recuerda gustos y restricciones familiares"],
  ["Use voice or text in WhatsApp, Telegram, and other chats", "Gunakan suara atau teks di WhatsApp, Telegram, dan chat lain", "Usa voz o texto en WhatsApp, Telegram y otros chats"],
  ["Reply naturally with weather, calendar, or reminders", "Balas natural dengan cuaca, kalender, atau pengingat", "Responde naturalmente con clima, calendario o recordatorios"],
  ["Repeat unclear input instead of pretending to understand", "Ulangi input yang tidak jelas, bukan pura-pura paham", "Repite entradas poco claras en vez de fingir entender"],
  ["@LightVela do not forget swim class on Friday. We also need goggles.", "@LightVela jangan lupa kelas renang hari Jumat. Kita juga butuh kacamata renang.", "@LightVela no olvides la clase de natación del viernes. También necesitamos gafas."],
  ["Got it. Swim class is on the family calendar, and goggles are in this week shopping list.", "Siap. Kelas renang ada di kalender keluarga, dan kacamata masuk daftar belanja minggu ini.", "Listo. La clase de natación está en el calendario familiar y las gafas en la lista de compra de esta semana."],
  ["Friday 16:30 swim class, remind 2 hours before", "Jumat 16.30 kelas renang, ingatkan 2 jam sebelumnya", "Viernes 16:30 clase de natación, recordar 2 horas antes"],
  ["Goggles marked as must-check-before-leaving", "Kacamata ditandai wajib dicek sebelum berangkat", "Gafas marcadas como revisar antes de salir"],
  ["If Friday afternoon conflicts with work, I will flag it one day earlier", "Jika Jumat sore bentrok dengan kerja, saya akan tandai sehari sebelumnya", "Si el viernes por la tarde entra en conflicto con trabajo, lo avisaré un día antes"],
  ["I have a meeting at 4:30 on Friday.", "Saya ada rapat Jumat pukul 16.30.", "Tengo una reunión el viernes a las 16:30."],
  ["Conflict found. Swim class and your meeting start at the same time. I suggest Nora handles pickup, or you move the meeting to 15:30. I have not changed anything yet.", "Konflik ditemukan. Kelas renang dan rapat Anda mulai bersamaan. Saya sarankan Nora menjemput, atau Anda pindahkan rapat ke 15.30. Saya belum mengubah apa pun.", "Conflicto detectado. Natación y tu reunión empiezan a la misma hora. Sugiero que Nora recoja, o mover la reunión a las 15:30. Aún no cambié nada."],
  ["Next week is busy. Plan simple weekday dinners.", "Minggu depan padat. Rencanakan makan malam hari kerja yang sederhana.", "La próxima semana está cargada. Planifica cenas sencillas entre semana."],
  ["Planned, all under 30 minutes:", "Sudah direncanakan, semua di bawah 30 menit:", "Planificado, todo en menos de 30 minutos:"],
  ["Monday: tomato beef rice, make one extra lunch box", "Senin: nasi sapi tomat, buat satu bekal ekstra", "Lunes: arroz con ternera y tomate, preparar una ración extra"],
  ["Tuesday: egg and greens noodles, 15 minutes", "Selasa: mi telur dan sayur, 15 menit", "Martes: fideos con huevo y verduras, 15 minutos"],
  ["Wednesday: air-fryer chicken with salad", "Rabu: ayam air-fryer dengan salad", "Miércoles: pollo en air fryer con ensalada"],
  ["Thursday: curry rice using Wednesday leftovers", "Kamis: nasi kari pakai sisa Rabu", "Jueves: arroz con curry usando sobras del miércoles"],
  ["Friday: eat out, no cooking plan", "Jumat: makan di luar, tidak ada rencana masak", "Viernes: comer fuera, sin plan de cocina"],
  ["Next-week-grocery-list.pdf", "Daftar-belanja-minggu-depan.pdf", "lista-compra-proxima-semana.pdf"],
  ["1 page · ready to share", "1 halaman · siap dibagikan", "1 página · listo para compartir"],
  ["Are you there? Will it rain in Shanghai tomorrow?", "Kamu di sana? Besok Shanghai hujan?", "¿Estás ahí? ¿Lloverá mañana en Shanghái?"],
  ["Here. Shanghai tomorrow is cloudy in the morning with light rain in the afternoon, 19-22 C.", "Di sini. Shanghai besok pagi berawan, siang hujan ringan, 19-22 C.", "Aquí. Shanghái estará nublado por la mañana con lluvia ligera por la tarde, 19-22 C."],
  ["You have an outside meeting at 15:00. Want a one-hour umbrella reminder?", "Anda ada rapat luar pukul 15.00. Mau pengingat payung satu jam sebelumnya?", "Tienes una reunión fuera a las 15:00. ¿Quieres recordatorio de paraguas una hora antes?"],
  ["Yes. And reply by voice next time.", "Ya. Dan balas dengan suara lain kali.", "Sí. Y responde por voz la próxima vez."],
  ["0:07 · voice reply", "0:07 · balasan suara", "0:07 · respuesta de voz"],
  ["Voice replies are on. If I cannot hear a memo clearly, I will repeat what I heard and ask you to confirm.", "Balasan suara aktif. Jika saya tidak mendengar memo dengan jelas, saya akan mengulang yang terdengar dan meminta konfirmasi.", "Respuestas de voz activadas. Si no oigo bien una nota, repetiré lo entendido y pediré confirmación."],
  ["China", "Tiongkok", "China"],
  ["The Skill page gives me way more choice than the other agent providers I use. I have already installed 100+ skills.", "Halaman Skill memberi saya jauh lebih banyak pilihan dibanding penyedia agent lain yang saya pakai. Saya sudah memasang 100+ skill.", "La página de Skills me da muchas más opciones que otros proveedores de agentes. Ya instalé más de 100 skills."],
  ["Kuala Lumpur, Malaysia", "Kuala Lumpur, Malaysia", "Kuala Lumpur, Malasia"],
  ["LightVela helps me watch orders, reviews, competitor prices, and campaign notes across channels. I get the summary before opening my shop dashboard.", "LightVela membantu saya memantau pesanan, ulasan, harga kompetitor, dan catatan kampanye lintas kanal. Saya mendapat ringkasan sebelum membuka dashboard toko.", "LightVela me ayuda a vigilar pedidos, reseñas, precios de competidores y notas de campaña entre canales. Recibo el resumen antes de abrir el panel de mi tienda."],
  ["Indonesia", "Indonesia", "Indonesia"],
  ["Automations work beautifully across channels. My Discord and Telegram communities can both receive updates from the bot.", "Automations berjalan mulus lintas kanal. Komunitas Discord dan Telegram saya bisa sama-sama menerima pembaruan dari bot.", "Las automatizaciones funcionan muy bien entre canales. Mis comunidades de Discord y Telegram reciben actualizaciones del bot."],
  ["Singapore", "Singapura", "Singapur"],
  ["Every morning it turns market moves, filings, and alerts into one clean brief. I still make the decision, but the prep work is already done.", "Setiap pagi, ia mengubah pergerakan pasar, filing, dan alert menjadi satu brief yang rapi. Keputusan tetap saya ambil, tapi persiapannya sudah selesai.", "Cada mañana convierte movimientos de mercado, filings y alertas en un brief limpio. La decisión sigue siendo mía, pero la preparación ya está hecha."],
  ["Shenzhen, China", "Shenzhen, Tiongkok", "Shenzhen, China"],
  ["LightVela keeps the dirty work running in the background, from information search and trend monitoring to context alignment, so I can stop being a human search engine and focus on judgment and creative ideas.", "LightVela menjalankan pekerjaan berat di latar belakang, dari pencarian informasi dan pemantauan tren sampai penyelarasan konteks, sehingga saya tidak lagi jadi mesin pencari manusia dan bisa fokus pada penilaian serta ide kreatif.", "LightVela mantiene el trabajo pesado en segundo plano, desde búsqueda de información y monitoreo de tendencias hasta alineación de contexto, para que deje de ser un buscador humano y me enfoque en criterio e ideas creativas."],
  ["Bangkok, Thailand", "Bangkok, Thailand", "Bangkok, Tailandia"],
  ["I use LightVela to collect release notes, API changes, and support questions. It keeps our team aligned without another meeting.", "Saya memakai LightVela untuk mengumpulkan catatan rilis, perubahan API, dan pertanyaan dukungan. Tim tetap selaras tanpa rapat tambahan.", "Uso LightVela para recopilar notas de versión, cambios de API y preguntas de soporte. Mantiene al equipo alineado sin otra reunión."],
  ["Beijing, China", "Beijing, Tiongkok", "Pekín, China"],
  ["I built my first personal blog with LightVela. Compared with the old-school way of coding everything by hand, now one sentence to LightVela's Hermes baby is enough to get it done.", "Saya membuat blog pribadi pertama saya dengan LightVela. Dibanding cara lama menulis semua kode sendiri, sekarang satu kalimat ke Hermes di LightVela sudah cukup untuk menyelesaikannya.", "Construí mi primer blog personal con LightVela. Frente a la forma antigua de programarlo todo a mano, ahora una frase a Hermes en LightVela basta para hacerlo."],
  ["San Francisco, United States", "San Francisco, Amerika Serikat", "San Francisco, Estados Unidos"],
  ["I recommend it to indie builders because it turns scattered ideas into specs, tasks, and tiny shipped pages faster than my old solo workflow.", "Saya merekomendasikannya untuk indie builders karena ia mengubah ide terpencar menjadi spesifikasi, tugas, dan halaman kecil yang bisa dirilis lebih cepat daripada workflow solo lama saya.", "Lo recomiendo a builders indie porque convierte ideas dispersas en specs, tareas y pequeñas páginas publicadas más rápido que mi antiguo flujo en solitario."],
  ["Hong Kong, China", "Hong Kong, Tiongkok", "Hong Kong, China"],
  ["DeepSeek Harness in Labs works really well. With LightVela, one setup now gives me two uses at once.", "DeepSeek Harness di Labs bekerja sangat baik. Dengan LightVela, satu setup sekarang memberi saya dua kegunaan sekaligus.", "DeepSeek Harness en Labs funciona muy bien. Con LightVela, una configuración ahora me sirve para dos usos a la vez."],
  ["LightVela significantly enhances my work mobility by letting me handle tasks on the go. It streamlines deep research and delivers real-time alerts for critical updates right to my messaging apps.", "LightVela sangat meningkatkan mobilitas kerja saya karena saya bisa menangani tugas saat bepergian. Ia merapikan riset mendalam dan mengirim alert real-time untuk pembaruan penting langsung ke aplikasi pesan saya.", "LightVela mejora mucho mi movilidad laboral al permitirme gestionar tareas en movimiento. Simplifica la investigación profunda y envía alertas en tiempo real sobre actualizaciones críticas directamente a mis apps de mensajería."],
  ["Slovakia", "Slovakia", "Eslovaquia"],
  ["Preparing for Computer Science and tech certifications means handling a lot of information. With LightVela, I can automate daily documentation summaries, coding exercises, and knowledge reviews so I always stay on track with my technical goals.", "Mempersiapkan Computer Science dan sertifikasi teknologi berarti mengelola banyak informasi. Dengan LightVela, saya bisa mengotomatiskan ringkasan dokumentasi harian, latihan coding, dan review pengetahuan agar selalu sesuai target teknis.", "Prepararme para Ciencias de la Computación y certificaciones técnicas implica manejar mucha información. Con LightVela puedo automatizar resúmenes diarios de documentación, ejercicios de código y repasos para mantenerme alineado con mis metas técnicas."],
  ["It keeps my class notes, coding practice, and exam reviews in one rhythm. I know what to read, what to code, and what to revisit.", "Ia menjaga catatan kelas, latihan coding, dan review ujian saya dalam satu ritme. Saya tahu apa yang harus dibaca, dikodekan, dan diulang.", "Mantiene mis apuntes, práctica de código y repasos de examen en un mismo ritmo. Sé qué leer, qué programar y qué repasar."],
];
const demoExactCopyByLocale = {
  "id-ID": Object.fromEntries(demoExactCopyTriples.map(([from, id]) => [from, id])),
  es: Object.fromEntries(demoExactCopyTriples.map(([from, , es]) => [from, es])),
};
Object.assign(demoExactCopyByLocale, {
  "ja-JP": {
    "@LightVela are you ready? Help me start my AI companion.": "@LightVela 準備できていますか？私のAIパートナーを始めるのを手伝って。",
    "I want it to answer in my style and keep working in the cloud.": "私のスタイルで返事をして、クラウドで動き続けてほしい。",
    "Your AI companion is waiting to start. Create it in Workbench; if your plan is not active yet, go to Pricing first.": "あなたのAIパートナーは起動待ちです。ワークベンチで作成してください。プランがまだ有効でない場合は、先に料金ページへ進んでください。",
    "Take me to Workbench so I can set it up.": "設定できるようにワークベンチへ連れて行って。",
    "If my plan is not active, show me Pricing first.": "プランが有効でなければ、先に料金を見せて。",
    "Connect WhatsApp, Telegram, Discord, and Slack after creation.": "作成後にWhatsApp、Telegram、Discord、Slackを接続して。",
    "Done. I will guide you to Workbench when you are ready, and to Pricing when a plan is required.": "了解です。準備ができたらワークベンチへ、プランが必要なときは料金ページへ案内します。",
    "Open Workbench to create your companion. If a plan is required, open Pricing first, then come back and connect your channels.": "ワークベンチを開いてAIパートナーを作成してください。プランが必要な場合は先に料金ページを開き、その後戻ってチャンネルを接続します。",
    "lightvela-companion-setup.guide": "lightvela-companion-setup-guide",
    "Workbench · Pricing · Channels": "ワークベンチ · 料金 · チャンネル",
    "工作台 · 购买页 · 通道": "ワークベンチ · 料金 · チャンネル",
    "LightVela setup channel: create your AI companion in Workbench, then connect this community for reminders and Q&A.": "LightVela設定チャンネル：ワークベンチでAIパートナーを作成し、このコミュニティを接続してリマインダーやQ&Aに使えます。",
    "@LightVela can you join this Discord server after I create you?": "@LightVela 作成したあと、このDiscordサーバーに参加できますか？",
    "Yes. Create me in Workbench first, then add the Discord channel. If your plan is not active, open Pricing before connecting.": "はい。まずワークベンチで私を作成し、その後Discordチャンネルを追加してください。プランが有効でない場合は接続前に料金ページを開いてください。",
    "@LightVela What can you do here once connected?": "@LightVela 接続後、ここで何ができますか？",
    "What can you do here once connected?": "接続後、ここで何ができますか？",
    "I can answer common questions, summarize long threads, and send reminders without asking people to leave Discord.": "よくある質問に答え、長いスレッドを要約し、Discordから離れずにリマインダーを送れます。",
    "Can Slack work the same way?": "Slackでも同じように使えますか？",
    "Yes. Slack, WhatsApp, Telegram, and Discord can all become places where your companion listens and responds.": "はい。Slack、WhatsApp、Telegram、Discordはすべて、AIパートナーが聞いて返答する場所になります。",
    "Create the companion first, then connect channels.": "まずAIパートナーを作成し、その後チャンネルを接続します。",
    "Set it up in Workbench; check Pricing first if the plan is not active.": "ワークベンチで設定してください。プランが有効でない場合は先に料金を確認します。",
    "Create it in Workbench; check Pricing first if the plan is not active.": "ワークベンチで作成してください。プランが有効でない場合は先に料金を確認します。",
    "@LightVela we are setting up the team workspace. What comes first?": "@LightVela チームワークスペースを設定しています。最初に何をしますか？",
    "Create your AI companion in Workbench first. I will keep the setup small: name, model, and the first channel.": "まずワークベンチでAIパートナーを作成してください。設定は名前、モデル、最初のチャンネルだけに絞ります。",
    "I want WhatsApp, Telegram, Discord, and Slack connected.": "WhatsApp、Telegram、Discord、Slackを接続したいです。",
    "Good. After creation, connect each channel once. I will answer in the right place and keep shared context together.": "いいですね。作成後に各チャンネルを一度ずつ接続します。適切な場所で返信し、共有コンテキストをまとめます。",
    "If the plan is not active, send me to Pricing.": "プランが有効でなければ料金ページへ送ってください。",
    "Understood. I will send you to Pricing first, then back to Workbench to finish channel setup.": "了解しました。まず料金ページへ案内し、その後ワークベンチに戻ってチャンネル設定を完了します。",
    "Dinner Crew": "夕食グループ",
    "Hotpot tonight?": "今夜は火鍋？",
    "I will check earnings tonight.": "今夜、決算を確認します。",
    "Project Team": "プロジェクトチーム",
    "LightVela updated the weekly draft.": "LightVelaが週次ドラフトを更新しました。",
    "Home Shopping": "家の買い物",
    "Tue": "火",
    "Milk and coffee are on the list.": "牛乳とコーヒーをリストに入れました。",
    "Mon": "月",
    "Morning coffee is on me.": "朝のコーヒーは私が出します。",
    "Reading List": "読書リスト",
    "Three reports are ready to review.": "3件のレポートを確認できます。",
    "Travel Plans": "旅行計画",
    "Sun": "日",
    "The hotel confirmation is filed.": "ホテル確認書を保管しました。",
    "Sat": "土",
    "This week's digest is ready.": "今週のダイジェストができました。",
    "chat": "チャット",
    "setup": "設定",
    "help": "ヘルプ",
    "todo": "todo",
    "pricing": "料金",
    "online": "オンライン",
    "LightVela Cases": "LightVelaの事例",
    "We just finished the pricing-page meeting. Can you sort the notes and tasks?": "料金ページの会議が終わりました。メモとタスクを整理できますか？",
    "Done. Three decisions were actually made, and one risk is still open:": "完了です。実際に決まったことは3つ、未解決のリスクが1つあります：",
    "Pricing page meeting notes": "料金ページ会議メモ",
    "Decision": "決定事項",
    "Ship the single-currency version on Aug 28; multi-currency moves to the next iteration": "8月28日に単一通貨版を出し、複数通貨は次のイテレーションへ回す",
    "Owners": "担当者",
    "Lina owns copy, Alex owns the page, Rachel owns cost wording, you own 3 customer follow-ups": "Linaがコピー、Alexがページ、Rachelがコスト文言、あなたが3件の顧客フォローを担当",
    "Risk": "リスク",
    "Copy cannot be final until Finance confirms cost wording": "Financeがコスト文言を確認するまでコピーは確定できません",
    "Tasks created": "作成されたタスク",
    "Rachel by Aug 19, copy by Aug 21, page to QA by Aug 22": "Rachelは8月19日まで、コピーは8月21日まで、ページは8月22日までにQAへ",
    "Send it to the project channel, and draft the weekly report too.": "プロジェクトチャンネルへ送り、週次レポートも下書きして。",
    "Sent. I also drafted the weekly report in your last format:": "送信しました。前回の形式で週次レポートも下書きしました：",
    "This customer interview is too long. Read it first.": "この顧客インタビューは長すぎます。まず読んでください。",
    "Read. Instead of a long summary, here are the parts that affect the next move:": "読みました。長い要約ではなく、次の動きに影響する部分をまとめます：",
    "Customer Archive feature quick read": "Customer Archive機能のクイックリード",
    "Need": "ニーズ",
    "They want sales leads, contracts, and payments connected so teams stop checking manually": "営業リード、契約、支払いを接続して、チームが手作業で確認しなくて済むようにしたい",
    "Opportunity": "機会",
    "They are open to a 12-person pilot if Slack summaries work": "Slack要約が機能すれば、12名のパイロットに前向きです",
    "Concern": "懸念",
    "They require human approval before any external action": "外部アクションの前に人の承認が必要です",
    "Next step": "次のステップ",
    "Reply with a read-only plus manual-approval pilot plan": "読み取り専用と手動承認を組み合わせたパイロット案で返信",
    "Write the customer reply. Keep it plain, not salesy.": "顧客への返信を書いて。売り込みっぽくせず、率直に。",
    "Draft:": "下書き：",
    "We can start with a read-only setup and keep every external action behind manual approval. The first version will summarize leads, quote status, contract status, and payment milestones. Nothing will be sent or changed without your confirmation.": "読み取り専用の設定から始め、すべての外部アクションを手動承認の後ろに置けます。最初の版ではリード、見積状況、契約状況、支払いマイルストーンを要約します。確認なしに送信や変更は行いません。",
    "Customer reply draft": "顧客返信ドラフト",
    "@LightVela The customer says the price is high again. Who should reply?": "@LightVela 顧客がまた価格が高いと言っています。誰が返信すべき？",
    "@LightVela read the context and draft a reply for me": "@LightVela 文脈を読んで返信案を作って",
    "I checked 17 messages from last Wednesday through today. This is not just price pressure; they are worried the pilot will not show value.": "先週水曜から今日までの17件のメッセージを確認しました。単なる価格圧力ではなく、パイロットで価値が見えないことを心配しています。",
    "Acknowledge the budget concern": "予算の懸念を受け止める",
    "Suggest a 14-day pilot with one success metric: hours saved": "成功指標を「節約時間」に絞った14日間パイロットを提案",
    "Promise a day-7 review before discussing a smaller plan": "小さなプランを議論する前に7日目レビューを約束",
    "I put the draft in the input box. I have not sent it yet.": "返信案を入力欄に入れました。まだ送信していません。",
    "Start from rent, medication, exchange rate, stock, and routine templates": "家賃、薬、為替、株価、ルーティンのテンプレートから始める",
    "Confirm time, frequency, and channel before enabling": "有効化前に時間、頻度、チャンネルを確認",
    "Keep execution records so tasks can be adjusted later": "後から調整できるよう実行記録を残す",
    "Check orders, budgets, web pages, and service status on schedule": "注文、予算、Webページ、サービス状態を予定どおり確認",
    "Summarize evidence and suggested action before changing anything": "変更前に根拠と推奨アクションを要約",
    "Execute only after approval": "承認後のみ実行",
    "Save one-off preferences as durable operating rules": "一度の好みを継続的な運用ルールとして保存",
    "Separate routine tasks, sensitive tasks, and approval-required tasks": "定型タスク、センシティブなタスク、承認必須タスクを分ける",
    "Ask a clarifying question instead of guessing": "推測せず確認質問をする",
    "Show me the automation templates. I want to set up the common ones.": "自動化テンプレートを見せて。よく使うものを設定したい。",
    "Here is the template area. Pick a common case and I will confirm the details before enabling it.": "こちらがテンプレートエリアです。一般的なケースを選ぶと、有効化前に詳細を確認します。",
    "Automation template area": "自動化テンプレートエリア",
    "water, rent, exchange rates, fitness, stock updates": "水、家賃、為替、フィットネス、株価更新",
    "Enable rent reminders on the 5th, one the night before and one that morning.": "毎月5日の家賃リマインダーを有効にして。前夜と当日の朝に1回ずつ。",
    "Done. I will remind you at 20:00 on the 4th and 08:00 on the 5th every month, through Telegram and WhatsApp.": "完了です。毎月4日20:00と5日08:00に、TelegramとWhatsAppでリマインドします。",
    "Check coffee orders every 20 minutes. If anything is not shipped after an hour, tell the staff.": "コーヒー注文を20分ごとに確認して。1時間後も未発送ならスタッフに知らせて。",
    "Task is running. I will only act when the condition matches.": "タスクは実行中です。条件に一致したときだけ動きます。",
    "Automation": "自動化",
    "Frequency": "頻度",
    "Every 20 minutes": "20分ごと",
    "Condition": "条件",
    "Paid orders older than 60 minutes without shipment": "支払い済みで60分以上未発送の注文",
    "Action": "アクション",
    "Notify staff first, then send the order IDs to you": "まずスタッフに通知し、その後注文IDをあなたへ送信",
    "Guardrail": "ガードレール",
    "No refunds or inventory edits": "返金や在庫編集はしない",
    "2 orders may be late": "2件の注文が遅れている可能性があります",
    "Orders #8172 and #8178 are over 60 minutes old.": "注文#8172と#8178は60分を超えています。",
    "I can message Mia: these two are overdue, please handle them first and fill in the reason. Send it now?": "Miaに「この2件は期限超過なので先に対応し、理由を記入してください」と送れます。今送信しますか？",
    "When a customer says the quote is high, do not discount immediately. Diagnose why first.": "顧客が見積もりが高いと言っても、すぐ値引きしない。まず理由を診断する。",
    "Saved to sales-follow-up rules:": "営業フォローアップルールに保存しました：",
    "Read the latest meeting notes and quote email first": "最新の会議メモと見積メールを先に読む",
    "Classify the issue as budget, value, authority, or timing": "問題を予算、価値、権限、タイミングに分類",
    "Only write a discount reply if you explicitly approve discounting": "あなたが明示的に承認した場合のみ値引き返信を書く",
    "Default to pilot, phased rollout, or read-only setup": "まずパイロット、段階展開、読み取り専用設定を優先",
    "@LightVela this customer says it is too expensive again": "@LightVela この顧客がまた高すぎると言っています",
    "Using the new rule: this looks like a value concern, not a budget ceiling. They said they were worried the pilot would not be used.": "新しいルールで見ると、これは予算上限ではなく価値への懸念です。パイロットが使われないことを心配していると言っていました。",
    "Turn PDFs, contracts, notes, and links into searchable memory": "PDF、契約書、メモ、リンクを検索できる記憶に変換",
    "Answer with source trails": "出典の流れを添えて回答",
    "Keep project context so you do not repeat yourself": "同じ説明を繰り返さなくて済むようプロジェクト文脈を保持",
    "Collect meeting notes, PDFs, spreadsheets, and screenshots": "会議メモ、PDF、スプレッドシート、スクリーンショットを収集",
    "Archive by project, customer, or personal area": "プロジェクト、顧客、個人エリアごとにアーカイブ",
    "Convert new material into summaries, tasks, and context": "新しい資料を要約、タスク、文脈に変換",
    "Save writing format, approval boundaries, names, and routines": "文章形式、承認範囲、名前、ルーティンを保存",
    "Flag conflicts instead of forcing a decision": "判断を押し切らず、衝突を示す",
    "Use less repeated explanation over time": "時間とともに繰り返し説明を減らす",
    "Add these interviews to the knowledge base. I want to ask questions later.": "このインタビューをナレッジベースに追加して。あとで質問したい。",
    "Imported and split into 184 searchable snippets.": "インポートし、検索可能な184個のスニペットに分割しました。",
    "Q3 customer interview knowledge base": "Q3顧客インタビューのナレッジベース",
    "What do customers complain about most?": "顧客が最も不満に思っていることは？",
    "Inconsistent reporting definitions: 12 of 18 customers": "レポート定義の不一致：18社中12社",
    "Approval chains are too slow: 9 of 18 customers": "承認フローが遅すぎる：18社中9社",
    "New teammates take too long to onboard: 7 of 18 customers": "新しいメンバーのオンボーディングに時間がかかる：18社中7社",
    "Each point links back to the original PDF page.": "各ポイントは元のPDFページにリンクしています。",
    "Every weekday at 11, organize new meeting notes and PDFs into Nextcloud.": "平日11時に新しい会議メモとPDFをNextcloudへ整理して。",
    "I can do that with read-only access to inbox and calendar attachments.": "受信箱とカレンダー添付への読み取り専用アクセスで対応できます。",
    "Archive rule": "アーカイブルール",
    "Time": "時間",
    "Weekdays at 11:00": "平日11:00",
    "Sources": "ソース",
    "Gmail attachments, calendar notes, Slack files": "Gmail添付、カレンダーメモ、Slackファイル",
    "Archive": "アーカイブ",
    "By customer and project in Nextcloud": "Nextcloudで顧客とプロジェクト別に整理",
    "Output": "出力",
    "Summary, tasks, uncategorized file list": "要約、タスク、未分類ファイル一覧",
    "When I say executive version, make it short, direct, and conclusion first.": "エグゼクティブ版と言ったら、短く直接的に、結論を先にしてください。",
    "Saved. Executive version means:": "保存しました。エグゼクティブ版とは：",
    "Conclusion in the first sentence": "最初の文に結論",
    "No more than three evidence points": "根拠は3点以内",
    "Risks and required decisions separated": "リスクと必要な判断を分ける",
    "No background unless you ask for it": "求められない限り背景説明はしない",
    "Make the Customer Archive feature notes executive version.": "Customer Archive機能メモをエグゼクティブ版にして。",
    "Executive version: Customer Archive feature is worth a pilot, but version one should be read-only with manual approval. They want sales, contracts, and payment status connected; the main risk is contract amount misreading, so every external action should stop for confirmation.": "エグゼクティブ版：Customer Archive機能はパイロットの価値がありますが、初版は読み取り専用かつ手動承認にすべきです。営業、契約、支払い状況の接続を望んでおり、主なリスクは契約金額の読み違いなので、すべての外部アクションは確認で止める必要があります。",
    "Watch news, releases, price changes, and filings in the background": "ニュース、リリース、価格変更、開示をバックグラウンドで監視",
    "Deduplicate and cross-check sources": "ソースを重複排除し、照合",
    "Push only decision-relevant changes": "判断に関係する変化だけ通知",
    "Monitor orders, inventory, services, and feedback": "注文、在庫、サービス、フィードバックを監視",
    "Attach evidence and impact scope": "根拠と影響範囲を添付",
    "Distinguish reminders from urgent risks": "リマインダーと緊急リスクを区別",
    "Track local events, content ideas, releases, and customer opportunities": "地域イベント、コンテンツ案、リリース、顧客機会を追跡",
    "Explain why something is worth seeing": "見る価値がある理由を説明",
    "Turn findings into daily briefs, reports, or shareable pages": "発見を日次ブリーフ、レポート、共有ページに変換",
    "Morning brief. Only three items matter today:": "朝のブリーフ。今日重要なのは3件だけです：",
    "Competitor A launched team budgets, overlapping next month roadmap": "競合Aがチーム予算機能を出し、来月のロードマップと重なっています",
    "OpenRouter price changes may lower low-frequency task cost by 12%": "OpenRouterの価格変更で低頻度タスクのコストが12%下がる可能性があります",
    "A GitHub dependency released 2.4.0 with auth callback breaking changes": "GitHub依存が認証コールバックの破壊的変更を含む2.4.0をリリース",
    "Full radar log": "レーダーログ全文",
    "Order delays are growing": "注文遅延が増えています",
    "11 new late orders appeared in the last 30 minutes.": "直近30分で新たに11件の遅延注文が発生しました。",
    "The printer queue started repeating errors at 14:02. Windows printing still works.": "14:02からプリンターキューでエラーが繰り返されています。Windowsからの印刷はまだ動作しています。",
    "4 KB · auto-collected": "4 KB · 自動収集",
    "Tell staff to print from Windows for now.": "当面はWindowsから印刷するようスタッフに伝えて。",
    "Sent. I also scheduled a follow-up check in 15 minutes.": "送信しました。15分後のフォローアップ確認も予約しました。",
    "Watch small music events in Shanghai this weekend. Avoid commercial ones.": "今週末の上海の小さな音楽イベントを探して。商業色の強いものは避けて。",
    "Found three that fit your taste:": "好みに合うものを3件見つけました：",
    "Saturday 20:30, Yuyintang, indie label showcase, 120 RMB": "土曜20:30、育音堂、インディーレーベルショーケース、120元",
    "Sunday 16:00, M50 rooftop, small electronic live set": "日曜16:00、M50屋上、小規模エレクトロニックライブ",
    "Sunday 19:30, jazz improv, 4.2 km away": "日曜19:30、ジャズ即興、4.2 km先",
    "Filtered event list": "絞り込み済みイベント一覧",
    "Read receipts, bills, and payment screenshots": "レシート、請求書、支払いスクリーンショットを読み取る",
    "Split expenses by budget category, client, or project": "予算カテゴリ、顧客、プロジェクト別に支出を分ける",
    "Warn when spending is likely to exceed plan": "支出が計画を超えそうなとき警告",
    "Connect quotes, contracts, invoices, payments, and expenses": "見積、契約、請求書、支払い、経費を接続",
    "Stop for approval before sending or changing anything external": "外部への送信や変更前に承認で停止",
    "Reduce admin work for freelancers and small teams": "フリーランスや小規模チームの事務作業を削減",
    "Summarize revenue, leads, costs, and customer status": "売上、リード、コスト、顧客状況を要約",
    "Highlight exceptions instead of dumping metrics": "指標を並べるのではなく例外を強調",
    "Turn tracked data into dashboards or periodic reports": "追跡データをダッシュボードや定期レポートに変換",
    "Log this receipt and tell me whether this month is over budget.": "このレシートを記録して、今月の予算超過か教えて。",
    "Shopping receipt": "買い物レシート",
    "one image": "画像1枚",
    "Logged. Total is 46.37. Here is the receipt breakdown:": "記録しました。合計は46.37です。内訳はこちらです：",
    "Receipt result": "レシート結果",
    "Groceries": "食料品",
    "Household item": "日用品",
    "Tax": "税",
    "Total": "合計",
    "Where is Customer Archive feature stuck between quote and payment?": "Customer Archive機能は見積から支払いまでのどこで止まっていますか？",
    "I checked the quote, contract, and finance sheet:": "見積、契約、財務シートを確認しました：",
    "Customer Archive feature commercial status": "Customer Archive機能の商談状況",
    "Quote": "見積",
    "Confirmed at 48,000": "48,000で確認済み",
    "Contract": "契約",
    "Customer legal left two comments on Aug 20; internal reply pending": "顧客側法務が8月20日に2件コメント。社内返信待ち",
    "Invoice": "請求書",
    "Not issued until contract is signed": "契約署名まで未発行",
    "Payment": "支払い",
    "Expected 7 working days after signing": "署名後7営業日の見込み",
    "Legal follow-up draft": "法務フォローアップ下書き",
    "Business daily:": "ビジネス日報：",
    "Freelance assistant daily": "フリーランスアシスタント日報",
    "Revenue": "売上",
    "18,400 confirmed this week, +22% week over week": "今週18,400確認、前週比+22%",
    "Leads": "リード",
    "7 new leads, 2 from customer referrals": "新規リード7件、顧客紹介2件",
    "Customer Archive feature legal follow-up may push payment into next week": "Customer Archive機能の法務フォローで支払いが来週にずれ込む可能性",
    "Next action": "次のアクション",
    "Handle Customer Archive feature first, then Vera revised quote": "まずCustomer Archive機能、その後Veraの修正見積に対応",
    "Make this a mobile dashboard.": "これをモバイルダッシュボードにして。",
    "Generated. On mobile, open tasks appear first, then revenue and lead trends.": "生成しました。モバイルでは未完了タスク、売上、リード推移の順で表示されます。",
    "Business tracking dashboard": "ビジネス追跡ダッシュボード",
    "Put family calendars, tasks, school events, and chores in one place": "家族カレンダー、タスク、学校行事、家事を一か所にまとめる",
    "Let both people add and claim shared tasks": "双方が共有タスクを追加し、担当できるようにする",
    "Flag conflicts and suggest adjustments": "衝突を示し、調整案を提案",
    "Plan meals from calendar, weather, inventory, and preferences": "カレンダー、天気、在庫、好みから献立を立てる",
    "Generate shopping lists and update inventory from photos": "買い物リストを作り、写真から在庫を更新",
    "Remember family tastes and restrictions": "家族の好みと制限を記憶",
    "Use voice or text in WhatsApp, Telegram, and other chats": "WhatsApp、Telegramなどのチャットで音声やテキストを使う",
    "Reply naturally with weather, calendar, or reminders": "天気、カレンダー、リマインダーを自然に返す",
    "Repeat unclear input instead of pretending to understand": "分かったふりをせず、不明瞭な入力を聞き返す",
    "@LightVela do not forget swim class on Friday. We also need goggles.": "@LightVela 金曜の水泳教室を忘れないで。ゴーグルも必要です。",
    "Got it. Swim class is on the family calendar, and goggles are in this week shopping list.": "了解です。水泳教室を家族カレンダーに入れ、ゴーグルを今週の買い物リストに追加しました。",
    "Friday 16:30 swim class, remind 2 hours before": "金曜16:30 水泳教室、2時間前にリマインド",
    "Goggles marked as must-check-before-leaving": "ゴーグルを出発前チェック必須に設定",
    "If Friday afternoon conflicts with work, I will flag it one day earlier": "金曜午後に仕事と衝突した場合、前日に通知します",
    "I have a meeting at 4:30 on Friday.": "金曜16:30に会議があります。",
    "Conflict found. Swim class and your meeting start at the same time. I suggest Nora handles pickup, or you move the meeting to 15:30. I have not changed anything yet.": "衝突を検出しました。水泳教室と会議が同時に始まります。Noraに迎えを頼むか、会議を15:30へ移すことを提案します。まだ何も変更していません。",
    "Next week is busy. Plan simple weekday dinners.": "来週は忙しいです。平日の簡単な夕食を計画して。",
    "Planned, all under 30 minutes:": "計画しました。すべて30分以内です：",
    "Monday: tomato beef rice, make one extra lunch box": "月曜：トマト牛肉ご飯、弁当を1つ余分に作る",
    "Tuesday: egg and greens noodles, 15 minutes": "火曜：卵と青菜の麺、15分",
    "Wednesday: air-fryer chicken with salad": "水曜：エアフライヤーチキンとサラダ",
    "Thursday: curry rice using Wednesday leftovers": "木曜：水曜の残りでカレーライス",
    "Friday: eat out, no cooking plan": "金曜：外食、調理なし",
    "Next-week-grocery-list.pdf": "next-week-grocery-list.pdf",
    "1 page · ready to share": "1ページ · 共有準備完了",
    "Are you there? Will it rain in Shanghai tomorrow?": "いる？明日の上海は雨が降る？",
    "Here. Shanghai tomorrow is cloudy in the morning with light rain in the afternoon, 19-22 C.": "います。明日の上海は午前くもり、午後は小雨、19-22 Cです。",
    "You have an outside meeting at 15:00. Want a one-hour umbrella reminder?": "15:00に外出会議があります。1時間前に傘リマインダーを設定しますか？",
    "Yes. And reply by voice next time.": "はい。次回は音声で返事して。",
    "0:07 · voice reply": "0:07 · 音声返信",
    "Voice replies are on. If I cannot hear a memo clearly, I will repeat what I heard and ask you to confirm.": "音声返信を有効にしました。メモが聞き取れない場合は、聞こえた内容を繰り返して確認します。",
    "China": "中国",
    "Kuala Lumpur, Malaysia": "クアラルンプール、マレーシア",
    "Indonesia": "インドネシア",
    "Singapore": "シンガポール",
    "Shenzhen, China": "深圳、中国",
    "Bangkok, Thailand": "バンコク、タイ",
    "Beijing, China": "北京、中国",
    "San Francisco, United States": "サンフランシスコ、アメリカ",
    "Hong Kong, China": "香港、中国",
    "Jakarta, Indonesia": "ジャカルタ、インドネシア",
    "Slovakia": "スロバキア",
    "Taiwan, China": "台湾、中国",
    "The Skill page gives me way more choice than the other agent providers I use. I have already installed 100+ skills.": "Skillページは、私が使っている他のエージェント提供元より選択肢がずっと多いです。すでに100以上のSkillを入れています。",
    "LightVela helps me watch orders, reviews, competitor prices, and campaign notes across channels. I get the summary before opening my shop dashboard.": "LightVelaは注文、レビュー、競合価格、キャンペーンメモをチャンネル横断で監視してくれます。ショップのダッシュボードを開く前に要約が届きます。",
    "Automations work beautifully across channels. My Discord and Telegram communities can both receive updates from the bot.": "自動化はチャンネルをまたいでうまく動きます。DiscordとTelegramのコミュニティの両方が更新を受け取れます。",
    "Every morning it turns market moves, filings, and alerts into one clean brief. I still make the decision, but the prep work is already done.": "毎朝、市場の動き、開示、アラートを1つの整理されたブリーフにしてくれます。判断は私がしますが、準備は終わっています。",
    "LightVela keeps the dirty work running in the background, from information search and trend monitoring to context alignment, so I can stop being a human search engine and focus on judgment and creative ideas.": "LightVelaは情報検索、トレンド監視、文脈整理などの面倒な作業を裏側で続けてくれるので、人間の検索エンジンをやめて判断と創造的なアイデアに集中できます。",
    "I use LightVela to collect release notes, API changes, and support questions. It keeps our team aligned without another meeting.": "私はLightVelaでリリースノート、API変更、サポート質問を集めています。追加の会議なしでチームの認識がそろいます。",
    "I built my first personal blog with LightVela. Compared with the old-school way of coding everything by hand, now one sentence to LightVela's Hermes baby is enough to get it done.": "LightVelaで初めて個人ブログを作りました。すべて手書きでコードを書く昔ながらの方法に比べ、今はLightVelaのHermesへ一文伝えるだけで形になります。",
    "I recommend it to indie builders because it turns scattered ideas into specs, tasks, and tiny shipped pages faster than my old solo workflow.": "散らばったアイデアを仕様、タスク、小さな公開ページへ、以前の一人作業より速く変えてくれるので、個人開発者におすすめしています。",
    "DeepSeek Harness in Labs works really well. With LightVela, one setup now gives me two uses at once.": "LabsのDeepSeek Harnessはとてもよく動きます。LightVelaなら一度の設定で2つの用途を同時に得られます。",
    "LightVela significantly enhances my work mobility by letting me handle tasks on the go. It streamlines deep research and delivers real-time alerts for critical updates right to my messaging apps.": "LightVelaのおかげで移動中でもタスクを扱えるようになり、仕事の機動力が大きく上がりました。深いリサーチを整理し、重要な更新をリアルタイムでメッセージアプリへ届けてくれます。",
    "Preparing for Computer Science and tech certifications means handling a lot of information. With LightVela, I can automate daily documentation summaries, coding exercises, and knowledge reviews so I always stay on track with my technical goals.": "コンピューターサイエンスや技術認定の準備では大量の情報を扱います。LightVelaなら毎日のドキュメント要約、コーディング練習、知識レビューを自動化でき、技術目標から外れずに進められます。",
    "It keeps my class notes, coding practice, and exam reviews in one rhythm. I know what to read, what to code, and what to revisit.": "授業メモ、コーディング練習、試験復習を1つのリズムに保ってくれます。何を読み、何を書き、何を復習するかが分かります。",
  },
  "ko-KR": {
    "@LightVela are you ready? Help me start my AI companion.": "@LightVela 준비됐어? 내 AI 파트너를 시작하게 도와줘.",
    "I want it to answer in my style and keep working in the cloud.": "내 스타일로 답하고 클라우드에서 계속 일했으면 좋겠어.",
    "Your AI companion is waiting to start. Create it in Workbench; if your plan is not active yet, go to Pricing first.": "당신의 AI 파트너가 시작을 기다리고 있습니다. 워크벤치에서 먼저 만들고, 플랜이 아직 활성화되지 않았다면 요금 페이지로 먼저 이동하세요.",
    "Take me to Workbench so I can set it up.": "설정할 수 있게 워크벤치로 데려가 줘.",
    "If my plan is not active, show me Pricing first.": "플랜이 활성화되지 않았으면 요금을 먼저 보여줘.",
    "Connect WhatsApp, Telegram, Discord, and Slack after creation.": "만든 뒤 WhatsApp, Telegram, Discord, Slack을 연결해 줘.",
    "Done. I will guide you to Workbench when you are ready, and to Pricing when a plan is required.": "좋습니다. 준비되면 워크벤치로 안내하고, 플랜이 필요하면 요금 페이지로 안내하겠습니다.",
    "Open Workbench to create your companion. If a plan is required, open Pricing first, then come back and connect your channels.": "워크벤치를 열어 AI 파트너를 만드세요. 플랜이 필요하면 먼저 요금 페이지를 열고, 돌아와 채널을 연결하세요.",
    "lightvela-companion-setup.guide": "lightvela-companion-setup-guide",
    "Workbench · Pricing · Channels": "워크벤치 · 요금 · 채널",
    "工作台 · 购买页 · 通道": "워크벤치 · 요금 · 채널",
    "LightVela setup channel: create your AI companion in Workbench, then connect this community for reminders and Q&A.": "LightVela 설정 채널: 워크벤치에서 AI 파트너를 만든 뒤 이 커뮤니티를 연결해 알림과 Q&A에 사용할 수 있습니다.",
    "@LightVela can you join this Discord server after I create you?": "@LightVela 만든 다음 이 Discord 서버에 들어올 수 있어?",
    "Yes. Create me in Workbench first, then add the Discord channel. If your plan is not active, open Pricing before connecting.": "네. 먼저 워크벤치에서 저를 만들고 Discord 채널을 추가하세요. 플랜이 활성화되지 않았다면 연결 전에 요금 페이지를 열어 주세요.",
    "@LightVela What can you do here once connected?": "@LightVela 연결되면 여기서 무엇을 할 수 있어?",
    "What can you do here once connected?": "연결되면 여기서 무엇을 할 수 있어?",
    "I can answer common questions, summarize long threads, and send reminders without asking people to leave Discord.": "Discord를 떠나지 않고도 자주 묻는 질문에 답하고, 긴 스레드를 요약하고, 알림을 보낼 수 있습니다.",
    "Can Slack work the same way?": "Slack도 같은 방식으로 동작해?",
    "Yes. Slack, WhatsApp, Telegram, and Discord can all become places where your companion listens and responds.": "네. Slack, WhatsApp, Telegram, Discord 모두 AI 파트너가 듣고 답하는 공간이 될 수 있습니다.",
    "Create the companion first, then connect channels.": "먼저 AI 파트너를 만들고 채널을 연결하세요.",
    "Set it up in Workbench; check Pricing first if the plan is not active.": "워크벤치에서 설정하세요. 플랜이 활성화되지 않았다면 요금을 먼저 확인하세요.",
    "Create it in Workbench; check Pricing first if the plan is not active.": "워크벤치에서 만드세요. 플랜이 활성화되지 않았다면 요금을 먼저 확인하세요.",
    "@LightVela we are setting up the team workspace. What comes first?": "@LightVela 팀 워크스페이스를 설정 중이야. 먼저 뭘 해야 해?",
    "Create your AI companion in Workbench first. I will keep the setup small: name, model, and the first channel.": "먼저 워크벤치에서 AI 파트너를 만드세요. 이름, 모델, 첫 채널만으로 설정을 작게 시작하겠습니다.",
    "I want WhatsApp, Telegram, Discord, and Slack connected.": "WhatsApp, Telegram, Discord, Slack을 연결하고 싶어.",
    "Good. After creation, connect each channel once. I will answer in the right place and keep shared context together.": "좋습니다. 생성 후 각 채널을 한 번씩 연결하세요. 알맞은 곳에서 답하고 공유 맥락을 함께 유지하겠습니다.",
    "If the plan is not active, send me to Pricing.": "플랜이 활성화되지 않았으면 요금 페이지로 보내 줘.",
    "Understood. I will send you to Pricing first, then back to Workbench to finish channel setup.": "알겠습니다. 먼저 요금 페이지로 안내한 뒤 워크벤치로 돌아와 채널 설정을 마치겠습니다.",
    "Dinner Crew": "저녁 모임",
    "Hotpot tonight?": "오늘 밤 훠궈?",
    "I will check earnings tonight.": "오늘 밤 실적을 확인하겠습니다.",
    "Project Team": "프로젝트 팀",
    "LightVela updated the weekly draft.": "LightVela가 주간 초안을 업데이트했습니다.",
    "Home Shopping": "집 장보기",
    "Tue": "화",
    "Milk and coffee are on the list.": "우유와 커피가 목록에 있습니다.",
    "Mon": "월",
    "Morning coffee is on me.": "아침 커피는 제가 살게요.",
    "Reading List": "읽기 목록",
    "Three reports are ready to review.": "검토할 보고서 세 개가 준비되었습니다.",
    "Travel Plans": "여행 계획",
    "Sun": "일",
    "The hotel confirmation is filed.": "호텔 확인서를 보관했습니다.",
    "Sat": "토",
    "This week's digest is ready.": "이번 주 다이제스트가 준비되었습니다.",
    "chat": "채팅",
    "setup": "설정",
    "help": "도움말",
    "todo": "todo",
    "pricing": "요금",
    "online": "온라인",
    "LightVela Cases": "LightVela 사례",
    "We just finished the pricing-page meeting. Can you sort the notes and tasks?": "요금 페이지 회의가 막 끝났어. 메모와 작업을 정리해 줄래?",
    "Done. Three decisions were actually made, and one risk is still open:": "완료했습니다. 실제 결정은 세 가지이고, 아직 열린 리스크가 하나 있습니다:",
    "Pricing page meeting notes": "요금 페이지 회의 메모",
    "Decision": "결정 사항",
    "Ship the single-currency version on Aug 28; multi-currency moves to the next iteration": "8월 28일 단일 통화 버전을 출시하고, 다중 통화는 다음 반복으로 이동",
    "Owners": "담당자",
    "Lina owns copy, Alex owns the page, Rachel owns cost wording, you own 3 customer follow-ups": "Lina는 카피, Alex는 페이지, Rachel은 비용 문구, 당신은 고객 후속 조치 3건 담당",
    "Risk": "리스크",
    "Copy cannot be final until Finance confirms cost wording": "Finance가 비용 문구를 확인할 때까지 카피를 확정할 수 없습니다",
    "Tasks created": "생성된 작업",
    "Rachel by Aug 19, copy by Aug 21, page to QA by Aug 22": "Rachel은 8월 19일까지, 카피는 8월 21일까지, 페이지는 8월 22일까지 QA로",
    "Send it to the project channel, and draft the weekly report too.": "프로젝트 채널로 보내고 주간 보고서도 초안 작성해 줘.",
    "Sent. I also drafted the weekly report in your last format:": "보냈습니다. 지난번 형식으로 주간 보고서도 초안 작성했습니다:",
    "This customer interview is too long. Read it first.": "이 고객 인터뷰가 너무 길어. 먼저 읽어 줘.",
    "Read. Instead of a long summary, here are the parts that affect the next move:": "읽었습니다. 긴 요약 대신 다음 움직임에 영향을 주는 부분만 정리합니다:",
    "Customer Archive feature quick read": "Customer Archive 기능 빠른 요약",
    "Need": "필요",
    "They want sales leads, contracts, and payments connected so teams stop checking manually": "영업 리드, 계약, 결제를 연결해 팀이 수동 확인을 멈추길 원합니다",
    "Opportunity": "기회",
    "They are open to a 12-person pilot if Slack summaries work": "Slack 요약이 작동하면 12명 파일럿에 열려 있습니다",
    "Concern": "우려",
    "They require human approval before any external action": "외부 작업 전 사람의 승인이 필요합니다",
    "Next step": "다음 단계",
    "Reply with a read-only plus manual-approval pilot plan": "읽기 전용과 수동 승인 파일럿 계획으로 답변",
    "Write the customer reply. Keep it plain, not salesy.": "고객 답장을 써 줘. 영업 느낌 없이 담백하게.",
    "Draft:": "초안:",
    "We can start with a read-only setup and keep every external action behind manual approval. The first version will summarize leads, quote status, contract status, and payment milestones. Nothing will be sent or changed without your confirmation.": "읽기 전용 설정으로 시작하고 모든 외부 작업을 수동 승인 뒤에 둘 수 있습니다. 첫 버전은 리드, 견적 상태, 계약 상태, 결제 마일스톤을 요약합니다. 확인 없이 보내거나 변경하지 않습니다.",
    "Customer reply draft": "고객 답장 초안",
    "@LightVela The customer says the price is high again. Who should reply?": "@LightVela 고객이 가격이 또 높다고 해. 누가 답해야 할까?",
    "@LightVela read the context and draft a reply for me": "@LightVela 맥락을 읽고 답장 초안을 작성해 줘",
    "I checked 17 messages from last Wednesday through today. This is not just price pressure; they are worried the pilot will not show value.": "지난 수요일부터 오늘까지 메시지 17개를 확인했습니다. 단순한 가격 압박이 아니라 파일럿이 가치를 보여주지 못할까 봐 걱정하고 있습니다.",
    "Acknowledge the budget concern": "예산 우려를 인정",
    "Suggest a 14-day pilot with one success metric: hours saved": "절약 시간이라는 하나의 성공 지표로 14일 파일럿 제안",
    "Promise a day-7 review before discussing a smaller plan": "더 작은 플랜을 논의하기 전에 7일 차 리뷰 약속",
    "I put the draft in the input box. I have not sent it yet.": "초안을 입력창에 넣었습니다. 아직 보내지 않았습니다.",
    "Start from rent, medication, exchange rate, stock, and routine templates": "월세, 약, 환율, 주식, 루틴 템플릿부터 시작",
    "Confirm time, frequency, and channel before enabling": "활성화 전 시간, 빈도, 채널 확인",
    "Keep execution records so tasks can be adjusted later": "나중에 조정할 수 있도록 실행 기록 보관",
    "Check orders, budgets, web pages, and service status on schedule": "주문, 예산, 웹 페이지, 서비스 상태를 일정대로 확인",
    "Summarize evidence and suggested action before changing anything": "변경 전 근거와 권장 조치 요약",
    "Execute only after approval": "승인 후에만 실행",
    "Save one-off preferences as durable operating rules": "일회성 선호를 지속 규칙으로 저장",
    "Separate routine tasks, sensitive tasks, and approval-required tasks": "루틴 작업, 민감한 작업, 승인 필요 작업 분리",
    "Ask a clarifying question instead of guessing": "추측하지 않고 확인 질문하기",
    "Show me the automation templates. I want to set up the common ones.": "자동화 템플릿을 보여줘. 자주 쓰는 것을 설정하고 싶어.",
    "Here is the template area. Pick a common case and I will confirm the details before enabling it.": "템플릿 영역입니다. 일반적인 사례를 고르면 활성화 전 세부 사항을 확인하겠습니다.",
    "Automation template area": "자동화 템플릿 영역",
    "water, rent, exchange rates, fitness, stock updates": "물, 월세, 환율, 운동, 주식 업데이트",
    "Enable rent reminders on the 5th, one the night before and one that morning.": "매월 5일 월세 알림을 켜 줘. 전날 밤 한 번, 당일 아침 한 번.",
    "Done. I will remind you at 20:00 on the 4th and 08:00 on the 5th every month, through Telegram and WhatsApp.": "완료했습니다. 매월 4일 20:00와 5일 08:00에 Telegram과 WhatsApp으로 알려드리겠습니다.",
    "Check coffee orders every 20 minutes. If anything is not shipped after an hour, tell the staff.": "커피 주문을 20분마다 확인해 줘. 한 시간 후에도 배송되지 않으면 직원에게 알려줘.",
    "Task is running. I will only act when the condition matches.": "작업이 실행 중입니다. 조건이 맞을 때만 동작합니다.",
    "Automation": "자동화",
    "Frequency": "빈도",
    "Every 20 minutes": "20분마다",
    "Condition": "조건",
    "Paid orders older than 60 minutes without shipment": "결제 후 60분 넘게 미배송인 주문",
    "Action": "작업",
    "Notify staff first, then send the order IDs to you": "먼저 직원에게 알리고 주문 ID를 당신에게 전송",
    "Guardrail": "가드레일",
    "No refunds or inventory edits": "환불 또는 재고 수정 없음",
    "2 orders may be late": "주문 2건이 늦을 수 있습니다",
    "Orders #8172 and #8178 are over 60 minutes old.": "주문 #8172와 #8178은 60분이 넘었습니다.",
    "I can message Mia: these two are overdue, please handle them first and fill in the reason. Send it now?": "Mia에게 '이 두 건은 지연됐으니 먼저 처리하고 이유를 적어 주세요'라고 보낼 수 있습니다. 지금 보낼까요?",
    "When a customer says the quote is high, do not discount immediately. Diagnose why first.": "고객이 견적이 높다고 말해도 바로 할인하지 말고 먼저 이유를 진단하세요.",
    "Saved to sales-follow-up rules:": "영업 후속 규칙에 저장했습니다:",
    "Read the latest meeting notes and quote email first": "최신 회의 메모와 견적 이메일 먼저 읽기",
    "Classify the issue as budget, value, authority, or timing": "문제를 예산, 가치, 권한, 타이밍으로 분류",
    "Only write a discount reply if you explicitly approve discounting": "명시적으로 할인을 승인한 경우에만 할인 답변 작성",
    "Default to pilot, phased rollout, or read-only setup": "파일럿, 단계적 출시, 읽기 전용 설정을 기본으로",
    "@LightVela this customer says it is too expensive again": "@LightVela 이 고객이 또 너무 비싸다고 해",
    "Using the new rule: this looks like a value concern, not a budget ceiling. They said they were worried the pilot would not be used.": "새 규칙으로 보면 예산 한도가 아니라 가치에 대한 우려입니다. 파일럿이 쓰이지 않을까 걱정한다고 했습니다.",
    "Turn PDFs, contracts, notes, and links into searchable memory": "PDF, 계약서, 메모, 링크를 검색 가능한 기억으로 변환",
    "Answer with source trails": "출처 흐름과 함께 답변",
    "Keep project context so you do not repeat yourself": "같은 설명을 반복하지 않도록 프로젝트 맥락 유지",
    "Collect meeting notes, PDFs, spreadsheets, and screenshots": "회의 메모, PDF, 스프레드시트, 스크린샷 수집",
    "Archive by project, customer, or personal area": "프로젝트, 고객, 개인 영역별로 보관",
    "Convert new material into summaries, tasks, and context": "새 자료를 요약, 작업, 맥락으로 변환",
    "Save writing format, approval boundaries, names, and routines": "글 형식, 승인 경계, 이름, 루틴 저장",
    "Flag conflicts instead of forcing a decision": "결정을 강요하지 않고 충돌 표시",
    "Use less repeated explanation over time": "시간이 갈수록 반복 설명 줄이기",
    "Add these interviews to the knowledge base. I want to ask questions later.": "이 인터뷰들을 지식 베이스에 추가해 줘. 나중에 질문하고 싶어.",
    "Imported and split into 184 searchable snippets.": "가져와서 검색 가능한 스니펫 184개로 나눴습니다.",
    "Q3 customer interview knowledge base": "Q3 고객 인터뷰 지식 베이스",
    "What do customers complain about most?": "고객들이 가장 많이 불평하는 것은?",
    "Inconsistent reporting definitions: 12 of 18 customers": "보고 정의 불일치: 고객 18명 중 12명",
    "Approval chains are too slow: 9 of 18 customers": "승인 체인이 너무 느림: 고객 18명 중 9명",
    "New teammates take too long to onboard: 7 of 18 customers": "새 팀원의 온보딩이 너무 오래 걸림: 고객 18명 중 7명",
    "Each point links back to the original PDF page.": "각 항목은 원본 PDF 페이지로 연결됩니다.",
    "Every weekday at 11, organize new meeting notes and PDFs into Nextcloud.": "평일 11시에 새 회의 메모와 PDF를 Nextcloud에 정리해 줘.",
    "I can do that with read-only access to inbox and calendar attachments.": "받은편지함과 캘린더 첨부에 읽기 전용 접근 권한이 있으면 할 수 있습니다.",
    "Archive rule": "보관 규칙",
    "Time": "시간",
    "Weekdays at 11:00": "평일 11:00",
    "Sources": "소스",
    "Gmail attachments, calendar notes, Slack files": "Gmail 첨부, 캘린더 메모, Slack 파일",
    "Archive": "보관",
    "By customer and project in Nextcloud": "Nextcloud에서 고객과 프로젝트별로",
    "Output": "출력",
    "Summary, tasks, uncategorized file list": "요약, 작업, 미분류 파일 목록",
    "When I say executive version, make it short, direct, and conclusion first.": "내가 임원 요약이라고 하면 짧고 직접적으로, 결론 먼저 작성해 줘.",
    "Saved. Executive version means:": "저장했습니다. 임원 요약은:",
    "Conclusion in the first sentence": "첫 문장에 결론",
    "No more than three evidence points": "근거는 세 가지 이하",
    "Risks and required decisions separated": "리스크와 필요한 결정을 분리",
    "No background unless you ask for it": "요청하지 않으면 배경 설명 없음",
    "Make the Customer Archive feature notes executive version.": "Customer Archive 기능 메모를 임원 요약으로 만들어 줘.",
    "Executive version: Customer Archive feature is worth a pilot, but version one should be read-only with manual approval. They want sales, contracts, and payment status connected; the main risk is contract amount misreading, so every external action should stop for confirmation.": "임원 요약: Customer Archive 기능은 파일럿 가치가 있지만 1차 버전은 읽기 전용과 수동 승인으로 가야 합니다. 영업, 계약, 결제 상태 연결을 원하며, 주요 리스크는 계약 금액 오독이므로 모든 외부 작업은 확인에서 멈춰야 합니다.",
    "Watch news, releases, price changes, and filings in the background": "뉴스, 릴리스, 가격 변경, 공시를 백그라운드에서 감시",
    "Deduplicate and cross-check sources": "소스 중복 제거 및 교차 확인",
    "Push only decision-relevant changes": "결정에 필요한 변화만 전달",
    "Monitor orders, inventory, services, and feedback": "주문, 재고, 서비스, 피드백 모니터링",
    "Attach evidence and impact scope": "근거와 영향 범위 첨부",
    "Distinguish reminders from urgent risks": "알림과 긴급 리스크 구분",
    "Track local events, content ideas, releases, and customer opportunities": "지역 이벤트, 콘텐츠 아이디어, 릴리스, 고객 기회 추적",
    "Explain why something is worth seeing": "볼 가치가 있는 이유 설명",
    "Turn findings into daily briefs, reports, or shareable pages": "발견 내용을 일일 브리프, 보고서, 공유 페이지로 변환",
    "Morning brief. Only three items matter today:": "아침 브리프. 오늘 중요한 것은 세 가지뿐입니다:",
    "Competitor A launched team budgets, overlapping next month roadmap": "경쟁사 A가 팀 예산 기능을 출시해 다음 달 로드맵과 겹칩니다",
    "OpenRouter price changes may lower low-frequency task cost by 12%": "OpenRouter 가격 변경으로 저빈도 작업 비용이 12% 낮아질 수 있습니다",
    "A GitHub dependency released 2.4.0 with auth callback breaking changes": "GitHub 의존성이 인증 콜백 변경을 포함한 2.4.0을 출시했습니다",
    "Full radar log": "전체 레이더 로그",
    "Order delays are growing": "주문 지연이 늘고 있습니다",
    "11 new late orders appeared in the last 30 minutes.": "최근 30분 동안 신규 지연 주문 11건이 발생했습니다.",
    "The printer queue started repeating errors at 14:02. Windows printing still works.": "14:02부터 프린터 대기열 오류가 반복되고 있습니다. Windows 인쇄는 아직 동작합니다.",
    "4 KB · auto-collected": "4 KB · 자동 수집",
    "Tell staff to print from Windows for now.": "당분간 Windows에서 인쇄하라고 직원에게 알려줘.",
    "Sent. I also scheduled a follow-up check in 15 minutes.": "보냈습니다. 15분 뒤 후속 확인도 예약했습니다.",
    "Watch small music events in Shanghai this weekend. Avoid commercial ones.": "이번 주말 상하이의 작은 음악 이벤트를 찾아줘. 상업적인 것은 제외해.",
    "Found three that fit your taste:": "취향에 맞는 것 세 가지를 찾았습니다:",
    "Saturday 20:30, Yuyintang, indie label showcase, 120 RMB": "토요일 20:30, Yuyintang, 인디 레이블 쇼케이스, 120 RMB",
    "Sunday 16:00, M50 rooftop, small electronic live set": "일요일 16:00, M50 루프탑, 작은 전자음악 라이브",
    "Sunday 19:30, jazz improv, 4.2 km away": "일요일 19:30, 재즈 즉흥, 4.2 km 거리",
    "Filtered event list": "필터링된 이벤트 목록",
    "Read receipts, bills, and payment screenshots": "영수증, 청구서, 결제 스크린샷 읽기",
    "Split expenses by budget category, client, or project": "예산 카테고리, 고객, 프로젝트별로 지출 분리",
    "Warn when spending is likely to exceed plan": "지출이 계획을 초과할 가능성이 있으면 경고",
    "Connect quotes, contracts, invoices, payments, and expenses": "견적, 계약, 청구서, 결제, 비용 연결",
    "Stop for approval before sending or changing anything external": "외부로 보내거나 변경하기 전에 승인을 위해 멈춤",
    "Reduce admin work for freelancers and small teams": "프리랜서와 소규모 팀의 관리 업무 줄이기",
    "Summarize revenue, leads, costs, and customer status": "매출, 리드, 비용, 고객 상태 요약",
    "Highlight exceptions instead of dumping metrics": "지표를 나열하는 대신 예외를 강조",
    "Turn tracked data into dashboards or periodic reports": "추적 데이터를 대시보드나 정기 보고서로 변환",
    "Log this receipt and tell me whether this month is over budget.": "이 영수증을 기록하고 이번 달 예산을 초과했는지 알려줘.",
    "Shopping receipt": "쇼핑 영수증",
    "one image": "이미지 1개",
    "Logged. Total is 46.37. Here is the receipt breakdown:": "기록했습니다. 합계는 46.37입니다. 영수증 내역은 다음과 같습니다:",
    "Receipt result": "영수증 결과",
    "Groceries": "식료품",
    "Household item": "생활용품",
    "Tax": "세금",
    "Total": "합계",
    "Where is Customer Archive feature stuck between quote and payment?": "Customer Archive 기능은 견적과 결제 사이 어디에서 막혔나요?",
    "I checked the quote, contract, and finance sheet:": "견적, 계약, 재무 시트를 확인했습니다:",
    "Customer Archive feature commercial status": "Customer Archive 기능 상업 상태",
    "Quote": "견적",
    "Confirmed at 48,000": "48,000으로 확인됨",
    "Contract": "계약",
    "Customer legal left two comments on Aug 20; internal reply pending": "고객 법무팀이 8월 20일 댓글 두 개를 남김. 내부 답변 대기 중",
    "Invoice": "청구서",
    "Not issued until contract is signed": "계약 서명 전까지 미발행",
    "Payment": "결제",
    "Expected 7 working days after signing": "서명 후 영업일 기준 7일 예상",
    "Legal follow-up draft": "법무 후속 초안",
    "Business daily:": "비즈니스 데일리:",
    "Freelance assistant daily": "프리랜서 어시스턴트 데일리",
    "Revenue": "매출",
    "18,400 confirmed this week, +22% week over week": "이번 주 18,400 확정, 전주 대비 +22%",
    "Leads": "리드",
    "7 new leads, 2 from customer referrals": "신규 리드 7건, 고객 추천 2건",
    "Customer Archive feature legal follow-up may push payment into next week": "Customer Archive 기능 법무 후속 조치로 결제가 다음 주로 밀릴 수 있음",
    "Next action": "다음 작업",
    "Handle Customer Archive feature first, then Vera revised quote": "Customer Archive 기능을 먼저 처리하고, 그다음 Vera 수정 견적",
    "Make this a mobile dashboard.": "이걸 모바일 대시보드로 만들어 줘.",
    "Generated. On mobile, open tasks appear first, then revenue and lead trends.": "생성했습니다. 모바일에서는 열린 작업이 먼저 나오고, 그다음 매출과 리드 추이가 표시됩니다.",
    "Business tracking dashboard": "비즈니스 추적 대시보드",
    "Put family calendars, tasks, school events, and chores in one place": "가족 캘린더, 작업, 학교 일정, 집안일을 한곳에 모으기",
    "Let both people add and claim shared tasks": "두 사람이 공유 작업을 추가하고 맡을 수 있게 하기",
    "Flag conflicts and suggest adjustments": "충돌을 표시하고 조정 제안",
    "Plan meals from calendar, weather, inventory, and preferences": "캘린더, 날씨, 재고, 선호로 식단 계획",
    "Generate shopping lists and update inventory from photos": "쇼핑 목록을 만들고 사진으로 재고 업데이트",
    "Remember family tastes and restrictions": "가족 취향과 제한 기억",
    "Use voice or text in WhatsApp, Telegram, and other chats": "WhatsApp, Telegram 등 채팅에서 음성이나 텍스트 사용",
    "Reply naturally with weather, calendar, or reminders": "날씨, 캘린더, 알림으로 자연스럽게 답변",
    "Repeat unclear input instead of pretending to understand": "이해한 척하지 않고 불분명한 입력을 다시 확인",
    "@LightVela do not forget swim class on Friday. We also need goggles.": "@LightVela 금요일 수영 수업 잊지 마. 고글도 필요해.",
    "Got it. Swim class is on the family calendar, and goggles are in this week shopping list.": "알겠습니다. 수영 수업을 가족 캘린더에 넣고, 고글을 이번 주 쇼핑 목록에 추가했습니다.",
    "Friday 16:30 swim class, remind 2 hours before": "금요일 16:30 수영 수업, 2시간 전 알림",
    "Goggles marked as must-check-before-leaving": "고글을 출발 전 필수 확인으로 표시",
    "If Friday afternoon conflicts with work, I will flag it one day earlier": "금요일 오후가 일과 겹치면 하루 전에 알려드리겠습니다",
    "I have a meeting at 4:30 on Friday.": "금요일 4:30에 회의가 있어.",
    "Conflict found. Swim class and your meeting start at the same time. I suggest Nora handles pickup, or you move the meeting to 15:30. I have not changed anything yet.": "충돌을 찾았습니다. 수영 수업과 회의가 같은 시간에 시작합니다. Nora가 픽업하거나 회의를 15:30으로 옮기는 것을 제안합니다. 아직 아무것도 변경하지 않았습니다.",
    "Next week is busy. Plan simple weekday dinners.": "다음 주가 바빠. 평일 간단한 저녁을 계획해 줘.",
    "Planned, all under 30 minutes:": "계획했습니다. 모두 30분 이내입니다:",
    "Monday: tomato beef rice, make one extra lunch box": "월요일: 토마토 소고기 덮밥, 도시락 하나 추가",
    "Tuesday: egg and greens noodles, 15 minutes": "화요일: 달걀 채소 국수, 15분",
    "Wednesday: air-fryer chicken with salad": "수요일: 에어프라이어 치킨과 샐러드",
    "Thursday: curry rice using Wednesday leftovers": "목요일: 수요일 남은 음식으로 카레라이스",
    "Friday: eat out, no cooking plan": "금요일: 외식, 조리 계획 없음",
    "Next-week-grocery-list.pdf": "next-week-grocery-list.pdf",
    "1 page · ready to share": "1페이지 · 공유 준비 완료",
    "Are you there? Will it rain in Shanghai tomorrow?": "있어? 내일 상하이에 비 와?",
    "Here. Shanghai tomorrow is cloudy in the morning with light rain in the afternoon, 19-22 C.": "여기 있습니다. 내일 상하이는 오전 흐림, 오후 약한 비, 19-22 C입니다.",
    "You have an outside meeting at 15:00. Want a one-hour umbrella reminder?": "15:00에 외부 회의가 있습니다. 한 시간 전 우산 알림을 드릴까요?",
    "Yes. And reply by voice next time.": "응. 다음에는 음성으로 답해 줘.",
    "0:07 · voice reply": "0:07 · 음성 답변",
    "Voice replies are on. If I cannot hear a memo clearly, I will repeat what I heard and ask you to confirm.": "음성 답변을 켰습니다. 메모가 잘 들리지 않으면 들은 내용을 반복하고 확인을 요청하겠습니다.",
    "China": "중국",
    "Kuala Lumpur, Malaysia": "쿠알라룸푸르, 말레이시아",
    "Indonesia": "인도네시아",
    "Singapore": "싱가포르",
    "Shenzhen, China": "선전, 중국",
    "Bangkok, Thailand": "방콕, 태국",
    "Beijing, China": "베이징, 중국",
    "San Francisco, United States": "샌프란시스코, 미국",
    "Hong Kong, China": "홍콩, 중국",
    "Jakarta, Indonesia": "자카르타, 인도네시아",
    "Slovakia": "슬로바키아",
    "Taiwan, China": "대만, 중국",
    "The Skill page gives me way more choice than the other agent providers I use. I have already installed 100+ skills.": "Skill 페이지는 제가 쓰는 다른 에이전트 제공업체보다 훨씬 많은 선택지를 줍니다. 이미 100개 이상의 Skill을 설치했습니다.",
    "LightVela helps me watch orders, reviews, competitor prices, and campaign notes across channels. I get the summary before opening my shop dashboard.": "LightVela는 주문, 리뷰, 경쟁사 가격, 캠페인 메모를 여러 채널에서 지켜봐 줍니다. 매장 대시보드를 열기 전에 요약을 받습니다.",
    "Automations work beautifully across channels. My Discord and Telegram communities can both receive updates from the bot.": "자동화는 채널을 넘나들며 잘 작동합니다. 제 Discord와 Telegram 커뮤니티 모두 업데이트를 받을 수 있습니다.",
    "Every morning it turns market moves, filings, and alerts into one clean brief. I still make the decision, but the prep work is already done.": "매일 아침 시장 움직임, 공시, 알림을 하나의 깔끔한 브리프로 바꿔 줍니다. 결정은 제가 하지만 준비는 이미 끝나 있습니다.",
    "LightVela keeps the dirty work running in the background, from information search and trend monitoring to context alignment, so I can stop being a human search engine and focus on judgment and creative ideas.": "LightVela는 정보 검색, 트렌드 모니터링, 맥락 정렬 같은 번거로운 일을 백그라운드에서 계속 처리해 줍니다. 덕분에 사람 검색 엔진 역할을 멈추고 판단과 창의적인 아이디어에 집중할 수 있습니다.",
    "I use LightVela to collect release notes, API changes, and support questions. It keeps our team aligned without another meeting.": "저는 LightVela로 릴리스 노트, API 변경, 지원 질문을 모읍니다. 추가 회의 없이 팀을 맞춰 줍니다.",
    "I built my first personal blog with LightVela. Compared with the old-school way of coding everything by hand, now one sentence to LightVela's Hermes baby is enough to get it done.": "LightVela로 첫 개인 블로그를 만들었습니다. 모든 코드를 손으로 쓰던 방식과 달리, 이제는 LightVela의 Hermes에게 한 문장만 말하면 완성됩니다.",
    "I recommend it to indie builders because it turns scattered ideas into specs, tasks, and tiny shipped pages faster than my old solo workflow.": "흩어진 아이디어를 명세, 작업, 작은 공개 페이지로 예전 혼자 일하던 방식보다 빠르게 바꿔 주기 때문에 인디 빌더에게 추천합니다.",
    "DeepSeek Harness in Labs works really well. With LightVela, one setup now gives me two uses at once.": "Labs의 DeepSeek Harness는 정말 잘 작동합니다. LightVela에서는 한 번 설정으로 두 가지 용도를 동시에 얻을 수 있습니다.",
    "LightVela significantly enhances my work mobility by letting me handle tasks on the go. It streamlines deep research and delivers real-time alerts for critical updates right to my messaging apps.": "LightVela 덕분에 이동 중에도 작업을 처리할 수 있어 업무 이동성이 크게 좋아졌습니다. 깊은 리서치를 정리하고 중요한 업데이트를 메시징 앱으로 실시간 알림해 줍니다.",
    "Preparing for Computer Science and tech certifications means handling a lot of information. With LightVela, I can automate daily documentation summaries, coding exercises, and knowledge reviews so I always stay on track with my technical goals.": "컴퓨터 과학과 기술 자격증을 준비하려면 많은 정보를 다뤄야 합니다. LightVela로 매일 문서 요약, 코딩 연습, 지식 복습을 자동화해 기술 목표를 계속 따라갈 수 있습니다.",
    "It keeps my class notes, coding practice, and exam reviews in one rhythm. I know what to read, what to code, and what to revisit.": "수업 노트, 코딩 연습, 시험 복습을 하나의 리듬으로 유지해 줍니다. 무엇을 읽고, 무엇을 코딩하고, 무엇을 다시 봐야 할지 알 수 있습니다.",
  },
});
const headerActionsLayerCss = `
#lightvela-intl-home .nav {
  pointer-events: none;
  padding: 0;
  background: #fff !important;
  border-bottom: 1px solid rgba(32, 27, 46, 0.08) !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

#lightvela-intl-home .nav__inner {
  pointer-events: auto;
  width: min(1440px, calc(100vw - 48px));
  max-width: min(1440px, calc(100vw - 48px));
  min-height: 64px;
  margin: 0 auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

#lightvela-intl-home .nav__brand img {
  width: 128px;
  height: auto;
  display: block;
  object-fit: contain;
}

#lightvela-intl-home .nav__links {
  gap: 24px;
  max-width: calc(100% - 380px);
}

#lightvela-intl-home .nav__links a {
  height: 64px;
  padding: 0 2px;
  color: rgba(33, 26, 42, 0.88);
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
}

#lightvela-intl-home .nav__links a::after {
  bottom: 14px;
}

@media (min-width: 1100px) {
  #lightvela-intl-home .nav {
    padding-inline: 0;
  }

  #lightvela-intl-home .nav__inner {
    margin: 0 auto;
    padding: 0;
  }
}

@media (min-width: 1280px) {
  #lightvela-intl-home .nav__brand img {
    width: 140px;
    height: auto;
  }
}

.international-home-header-actions-layer {
  position: fixed;
  top: 14px;
  right: max(24px, calc((100% - 1440px) / 2));
  z-index: 70;
  display: flex;
  align-items: center;
}

.international-home-header-actions-layer > div {
  gap: 8px !important;
  transform: none !important;
}

.international-home-header-actions-layer button,
.international-home-header-actions-layer a {
  box-shadow: none !important;
}

@media (max-width: 1099px) {
  #lightvela-intl-home .nav__inner {
    width: calc(100vw - 32px);
    max-width: calc(100vw - 32px);
    min-height: 60px;
  }

  #lightvela-intl-home .nav__brand img {
    width: 118px;
  }

  .international-home-header-actions-layer {
    top: 12px;
    right: 16px;
  }
}

@media (max-width: 640px) {
  .international-home-header-actions-layer {
    top: 12px;
    right: 16px;
  }
}
`;
const breakableAnimatedHeadlineCss = `
#lightvela-intl-home .hero__line--main,
#lightvela-intl-home .hero__line--main *,
#lightvela-intl-home .hero__line--dynamic,
#lightvela-intl-home .hero__line--dynamic * {
  font-family: var(--font-hero) !important;
  font-size: inherit !important;
  font-weight: inherit !important;
  font-style: inherit !important;
  line-height: inherit !important;
}

#lightvela-intl-home .hero__title {
  font-family: var(--font-hero) !important;
  font-weight: 400 !important;
  font-size: 32px !important;
  line-height: 1.2 !important;
  letter-spacing: 0 !important;
}

#lightvela-intl-home .hero__line--main,
#lightvela-intl-home .hero__line--dynamic {
  align-items: baseline !important;
  min-height: auto !important;
  padding-bottom: 0 !important;
}

#lightvela-intl-home .hero__line--main {
  font-family: var(--font-hero) !important;
  font-size: 50px !important;
  font-weight: 500 !important;
  line-height: 1.2 !important;
  font-style: normal !important;
}

#lightvela-intl-home .hero__line--main * {
  font-family: inherit !important;
  font-weight: inherit !important;
}

#lightvela-intl-home[data-locale^='zh'] .hero__line--main {
  font-size: 40px !important;
}

#lightvela-intl-home .hero__line--dynamic {
  font-size: 32px !important;
  font-weight: 400 !important;
  font-style: italic !important;
  line-height: 1.32 !important;
}

#lightvela-intl-home[data-locale^='en'] .hero__line--main {
  font-family: var(--font-cover-en) !important;
  max-width: min(1180px, calc(100vw - 120px));
  font-size: 36px !important;
  font-weight: 600 !important;
  line-height: 1.2 !important;
}

#lightvela-intl-home[data-locale^='en'] .hero__line--dynamic {
  font-size: 28px !important;
  line-height: 1.38 !important;
}

#lightvela-intl-home .hero__line--dynamic .hero__prefix,
#lightvela-intl-home .hero__rotator {
  font-weight: 500 !important;
}

@media (max-width: 768px) {
  #lightvela-intl-home .hero__line--main,
  #lightvela-intl-home .hero__line--dynamic {
    max-width: 92vw;
    flex-wrap: wrap;
    justify-content: center;
  }

  #lightvela-intl-home .hero__line--main {
    font-size: 30px !important;
  }

  #lightvela-intl-home .hero__line--dynamic {
    font-size: 22px !important;
  }

  #lightvela-intl-home[data-locale^='en'] .hero__line--main {
    max-width: min(92vw, 640px);
    font-size: 24px !important;
    line-height: 1.24 !important;
  }

  #lightvela-intl-home[data-locale^='en'] .hero__line--dynamic {
    max-width: 92vw;
    flex-wrap: wrap;
    justify-content: center;
    font-size: 20px !important;
    line-height: 1.35 !important;
  }

  #lightvela-intl-home[data-locale^='zh'] .hero__line--main {
    max-width: min(92vw, 680px);
    font-size: 40px !important;
    line-height: 1.08 !important;
  }
}

@media (max-width: 560px) {
  #lightvela-intl-home[data-locale^='zh'] .hero__line--main {
    font-size: 40px !important;
    line-height: 1.12 !important;
  }
}

@media (min-width: 769px) and (max-width: 1280px) {
  #lightvela-intl-home .hero__line--main {
    font-size: 40px !important;
  }

  #lightvela-intl-home .hero__line--dynamic {
    font-size: 28px !important;
  }

  #lightvela-intl-home[data-locale^='en'] .hero__line--main {
    max-width: min(1060px, calc(100vw - 96px));
    font-size: 31px !important;
    line-height: 1.2 !important;
  }

  #lightvela-intl-home[data-locale^='en'] .hero__line--dynamic {
    font-size: 24px !important;
    line-height: 1.36 !important;
  }

  #lightvela-intl-home[data-locale^='zh'] .hero__line--main {
    font-size: 40px !important;
  }
}

#lightvela-intl-home .hero__frame .hero-live-link + .hero-live-link {
  margin-left: 8px;
  border: 1px solid rgba(34, 27, 51, 0.12);
  background: rgba(255, 255, 255, 0.86);
  color: #252437;
}
`;
const unifiedHomepageTitleFontCss = `
#lightvela-intl-home .hero__title,
#lightvela-intl-home .hero__title *,
#lightvela-intl-home .about__head .k,
#lightvela-intl-home .wcard__body h4,
#lightvela-intl-home .scenes__title,
#lightvela-intl-home .scenes__panel-title,
#lightvela-intl-home .deploy__lead,
#lightvela-intl-home .track__body h3,
#lightvela-intl-home .play__text h4,
#lightvela-intl-home .pricing__head h2,
#lightvela-intl-home .benefit h3,
#lightvela-intl-home .cta__title,
#lightvela-intl-home .cta__title *,
#lightvela-intl-home .foot__title,
#lightvela-intl-home .foot__title * {
  font-family: var(--font-hero) !important;
}
`;
const englishEditorialTitleFontCss = `
#lightvela-intl-home[data-locale^='en'] .about__head .k,
#lightvela-intl-home[data-locale^='en'] .wcard__body h4,
#lightvela-intl-home[data-locale^='en'] .scenes__title,
#lightvela-intl-home[data-locale^='en'] .scenes__panel-title,
#lightvela-intl-home[data-locale^='en'] .deploy__lead,
#lightvela-intl-home[data-locale^='en'] .track__body h3,
#lightvela-intl-home[data-locale^='en'] .play__text h4,
#lightvela-intl-home[data-locale^='en'] .pricing__head h2,
#lightvela-intl-home[data-locale^='en'] .benefit h3,
#lightvela-intl-home[data-locale^='en'] .cta__title,
#lightvela-intl-home[data-locale^='en'] .cta__title * {
  font-family: var(--font-cover-en) !important;
}
`;
const lightUserMessageBubbleCss = `
#lightvela-intl-home .hero__frame .bub--me .bub__box,
#lightvela-intl-home .hero__frame #panel-dc .dc__msg--me > div,
#lightvela-intl-home .hero__frame #panel-dc .dc__msg:not(.dc__bot) > div,
#lightvela-intl-home .hero__frame #panel-sl .dc__msg--me > div,
#lightvela-intl-home .hero__frame #panel-sl .dc__msg:not(.dc__bot) > div,
#lightvela-intl-home .scene-chat .bub--me .bub__box,
#lightvela-intl-home .play__chat .bub--me .bub__box {
  border-color: rgba(34, 27, 51, 0.08) !important;
  background: rgba(248, 248, 249, 0.96) !important;
  color: #252437 !important;
  box-shadow: 0 10px 28px rgba(27, 22, 52, 0.08) !important;
}

#lightvela-intl-home .scene-chat .bub--me .bub__box:has(.line__img) {
  background: transparent !important;
  box-shadow: none !important;
}

#lightvela-intl-home .scene-chat .bub--me .bub__box:has(.line__img) > p {
  border: 1px solid rgba(34, 27, 51, 0.08) !important;
  background: rgba(248, 248, 249, 0.96) !important;
  color: #252437 !important;
  box-shadow: 0 10px 28px rgba(27, 22, 52, 0.08) !important;
}

#lightvela-intl-home .hero__frame .bub--me .bub__box p,
#lightvela-intl-home .hero__frame .bub--me .bub__time,
#lightvela-intl-home .hero__frame #panel-dc .dc__msg--me > div > b,
#lightvela-intl-home .hero__frame #panel-dc .dc__msg--me > div > p,
#lightvela-intl-home .hero__frame #panel-dc .dc__msg:not(.dc__bot) > div > b,
#lightvela-intl-home .hero__frame #panel-dc .dc__msg:not(.dc__bot) > div > p,
#lightvela-intl-home .hero__frame #panel-sl .dc__msg--me > div > b,
#lightvela-intl-home .hero__frame #panel-sl .dc__msg--me > div > p,
#lightvela-intl-home .hero__frame #panel-sl .dc__msg:not(.dc__bot) > div > b,
#lightvela-intl-home .hero__frame #panel-sl .dc__msg:not(.dc__bot) > div > p,
#lightvela-intl-home .scene-chat .bub--me .bub__box p,
#lightvela-intl-home .scene-chat .bub--me .bub__box a,
#lightvela-intl-home .scene-chat .bub--me .bub__time,
#lightvela-intl-home .play__chat .bub--me .bub__box p,
#lightvela-intl-home .play__chat .bub--me .bub__time {
  color: #252437 !important;
}

#lightvela-intl-home .hero__frame .bub--me .bub__time,
#lightvela-intl-home .scene-chat .bub--me .bub__time,
#lightvela-intl-home .play__chat .bub--me .bub__time {
  color: rgba(37, 36, 55, 0.42) !important;
}
`;
const playTabsExpansionCss = `
#lightvela-intl-home #pl-4:checked ~ .plays__tabs label[for='pl-4'] {
  border-color: transparent;
  background: var(--ink);
  color: #fff;
  box-shadow: 0 8px 22px rgba(33, 26, 42, 0.18);
}

#lightvela-intl-home #pl-4:checked ~ .plays__stage #play-4 {
  display: flex;
}

#lightvela-intl-home .plays__tabs label[for='pl-4'] {
  position: relative;
  padding-right: 30px;
  overflow: visible;
}

#lightvela-intl-home .play__new-badge {
  position: absolute;
  top: -16px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 15px;
  margin-left: 0;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(106, 79, 222, 0.12);
  color: var(--brand-strong);
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 6px 16px rgba(33, 26, 42, 0.14);
}

#lightvela-intl-home #pl-4:checked ~ .plays__tabs label[for='pl-4'] .play__new-badge {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

#lightvela-intl-home .play--harness {
  overflow: hidden;
}

#lightvela-intl-home .play__screen--harness {
  display: flex;
  min-height: 300px;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  overflow: hidden;
}

#lightvela-intl-home .harness-visual-img {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 300px;
  object-fit: cover;
  object-position: center top;
}

#lightvela-intl-home .harness-visual {
  position: relative;
  width: min(360px, 88%);
  aspect-ratio: 1.6;
}

#lightvela-intl-home .harness-visual__core {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  width: 84px;
  height: 84px;
  place-items: center;
  border: 1px solid rgba(106, 79, 222, 0.14);
  border-radius: 28px;
  background: linear-gradient(180deg, #fff, #f3f1ff);
  box-shadow: 0 18px 50px rgba(106, 79, 222, 0.18);
  color: var(--brand);
  transform: translate(-50%, -50%);
}

#lightvela-intl-home .harness-visual__core .icon {
  width: 32px;
  height: 32px;
  stroke-width: 2.4;
}

#lightvela-intl-home .harness-visual__line {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 43%;
  height: 1px;
  background: linear-gradient(90deg, rgba(106, 79, 222, 0.28), rgba(106, 79, 222, 0));
  transform-origin: left center;
}

#lightvela-intl-home .harness-visual__line:nth-of-type(1) {
  transform: rotate(-24deg);
}

#lightvela-intl-home .harness-visual__line:nth-of-type(2) {
  transform: rotate(24deg);
}

#lightvela-intl-home .harness-visual__line:nth-of-type(3) {
  transform: rotate(156deg);
}

#lightvela-intl-home .harness-visual__line:nth-of-type(4) {
  transform: rotate(204deg);
}

#lightvela-intl-home .harness-visual__card {
  position: absolute;
  display: grid;
  width: 92px;
  height: 58px;
  grid-template-columns: 18px 1fr;
  column-gap: 9px;
  align-items: center;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.96);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 14px 38px rgba(27, 22, 52, 0.09);
}

#lightvela-intl-home .harness-visual__card i {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 7px;
  background: linear-gradient(135deg, #8d82ff, #6a4fde);
}

#lightvela-intl-home .harness-visual__card b,
#lightvela-intl-home .harness-visual__card em {
  display: block;
  height: 5px;
  border-radius: 999px;
  background: rgba(37, 36, 55, 0.12);
}

#lightvela-intl-home .harness-visual__card b {
  width: 46px;
  margin-bottom: 7px;
}

#lightvela-intl-home .harness-visual__card em {
  width: 34px;
  font-style: normal;
}

#lightvela-intl-home .harness-visual__card--one {
  left: 0;
  top: 18px;
}

#lightvela-intl-home .harness-visual__card--two {
  right: 0;
  top: 10px;
}

#lightvela-intl-home .harness-visual__card--three {
  left: 20px;
  bottom: 4px;
}

#lightvela-intl-home .harness-visual__card--four {
  right: 18px;
  bottom: 16px;
}

@media (max-width: 700px) {
  #lightvela-intl-home .plays__tabs {
    gap: 8px;
  }

  #lightvela-intl-home .plays__tabs label {
    padding-inline: 16px;
  }

  #lightvela-intl-home .play__screen--harness {
    min-height: 220px;
  }

  #lightvela-intl-home .harness-visual-img {
    min-height: 220px;
  }
}
`;
const heroIntegrationLinkCss = `
#lightvela-intl-home .hero__frame .hero-live-link + .hero-live-link {
  margin-left: 8px;
}
`;
const plainHeroEyebrowCss = `
#lightvela-intl-home .hero__eyebrow {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-family: var(--font-hero);
  font-size: 16px;
  font-weight: 500;
}

@media (max-width: 768px) {
  #lightvela-intl-home .hero__eyebrow {
    font-size: 13px;
  }
}
`;
const longLocaleDesktopHeadingCss = `
@media (min-width: 1024px) {
  #lightvela-intl-home:is([data-locale^='id'], [data-locale='es']) .hero__line--main {
    max-width: min(1680px, calc(100vw - 64px));
    white-space: nowrap;
  }

  #lightvela-intl-home[data-locale^='id'] .about__head {
    max-width: min(1200px, calc(100vw - 64px));
  }

  #lightvela-intl-home[data-locale^='id'] .about__head .k {
    white-space: nowrap;
  }
}

@media (min-width: 1024px) and (max-width: 1279px) {
  #lightvela-intl-home:is([data-locale^='id'], [data-locale='es']) .hero__line--main {
    font-size: 25px;
  }

  #lightvela-intl-home[data-locale^='id'] .about__head .k {
    font-size: 36px;
  }
}

@media (min-width: 1280px) and (max-width: 1439px) {
  #lightvela-intl-home:is([data-locale^='id'], [data-locale='es']) .hero__line--main {
    font-size: 32px;
  }
}

@media (min-width: 1440px) {
  #lightvela-intl-home:is([data-locale^='id'], [data-locale='es']) .hero__line--main {
    font-size: 36px;
  }
}
`;
const footerRefreshCss = `
#lightvela-intl-home .foot {
  padding-top: 72px;
  padding-bottom: 78px;
  background: #fff;
}

#lightvela-intl-home .foot__top {
  max-width: var(--shell);
  min-height: 184px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 28px;
  text-align: center;
}

#lightvela-intl-home .foot__title,
#lightvela-intl-home .foot__title .row {
  width: auto;
  max-width: 920px;
  font-family: "STXingkai", "Xingkai SC", "Kaiti SC", "STKaiti", "KaiTi", var(--font-hero) !important;
  font-size: clamp(24px, 2.55vw, 36px);
  font-weight: 400;
  line-height: 1.12;
  color: #17151a;
}

#lightvela-intl-home .foot__title .row {
  display: inline;
  font-style: italic;
}

#lightvela-intl-home .foot__title em {
  display: inline-block;
  margin-inline: 0.08em;
  font-family: "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive !important;
  font-size: 1.08em;
  font-style: italic !important;
  font-weight: 500;
  color: #17151a;
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
  -webkit-text-fill-color: currentColor;
  transform: rotate(-1deg) translateY(0.02em);
}

#lightvela-intl-home .foot__cta a {
  display: inline-flex;
  position: relative;
  width: fit-content;
  max-width: 100%;
  height: 46px;
  margin-top: 0;
  padding: 0 50px 0 24px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: #17151a;
  color: #fff;
  font-size: clamp(15px, 1.05vw, 17px);
  font-weight: 700;
  letter-spacing: 0;
  box-shadow: 0 14px 30px rgba(23, 21, 26, 0.12);
}

#lightvela-intl-home .foot__cta a span {
  display: grid;
  position: absolute;
  right: 6px;
  top: 50%;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 999px;
  background: #fff;
  color: #17151a;
  flex: 0 0 auto;
  transform: translateY(-50%);
}

#lightvela-intl-home .foot__cta a .icon {
  width: 19px;
  height: 19px;
  stroke-width: 2.4;
}

#lightvela-intl-home .foot__links {
  max-width: min(1380px, calc(100vw - 96px));
  margin: 96px auto 0;
  padding-top: 0;
  border-top: 0;
}

#lightvela-intl-home .foot__links-grid {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(250px, 280px) minmax(150px, 168px) minmax(140px, 158px) minmax(140px, 158px) minmax(220px, 250px);
  column-gap: clamp(14px, 1.2vw, 24px);
  row-gap: 42px;
  align-items: start;
}

#lightvela-intl-home .foot__brand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 18px;
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

#lightvela-intl-home .foot__brand-link {
  display: inline-flex;
  align-items: center;
  color: #17151a;
}

#lightvela-intl-home .foot__brand-link img {
  width: 128px;
  height: auto;
  display: block;
}

#lightvela-intl-home .foot__brand-word {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0;
}

#lightvela-intl-home .foot__copyright {
  max-width: 220px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(23, 21, 26, 0.44);
}

#lightvela-intl-home .foot__links h3 {
  font-size: 14px;
  font-weight: 600;
  color: #17151a;
}

#lightvela-intl-home .foot__links ul {
  gap: 14px;
  margin-top: 22px;
}

#lightvela-intl-home .foot__links a {
  font-size: 14px;
  color: rgba(23, 21, 26, 0.66);
}

#lightvela-intl-home .foot__links-grid > div:nth-child(2) a {
  white-space: nowrap;
}

#lightvela-intl-home .foot__bar {
  display: none;
}

@media (max-width: 900px) {
  #lightvela-intl-home .foot {
    padding-top: 64px;
  }

  #lightvela-intl-home .foot__top {
    min-height: 152px;
  }

  #lightvela-intl-home .foot__cta a {
    height: 44px;
    padding: 0 48px 0 22px;
    font-size: 15px;
  }

  #lightvela-intl-home .foot__cta a span {
    right: 6px;
    width: 34px;
    height: 34px;
  }

  #lightvela-intl-home .foot__cta a .icon {
    width: 18px;
    height: 18px;
  }

  #lightvela-intl-home .foot__links {
    margin-top: 64px;
  }

  #lightvela-intl-home .foot__links-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 42px 28px;
  }

  #lightvela-intl-home .foot__brand {
    grid-column: 1 / -1;
    min-height: auto;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding-bottom: 24px;
    border-bottom: 1px solid rgba(23, 21, 26, 0.08);
  }
}

@media (max-width: 560px) {
  #lightvela-intl-home .foot__links-grid {
    grid-template-columns: 1fr;
  }

  #lightvela-intl-home .foot__brand {
    flex-direction: column;
    align-items: flex-start;
  }
}
`;
const voiceSectionRestoreCss = `
#lightvela-intl-home .voice {
  min-height: auto;
  padding: 96px 0 104px;
  overflow: hidden;
  background: #fff;
}

#lightvela-intl-home .voice .marquee__rows {
  display: flex;
  min-height: 420px;
  flex-direction: column;
  justify-content: center;
  gap: 20px;
}

#lightvela-intl-home .voice .mrow {
  min-height: 190px;
  overflow: hidden;
}

#lightvela-intl-home .voice .mrow__track {
  display: flex;
  align-items: stretch;
  gap: 16px;
  width: max-content;
}

#lightvela-intl-home .voice .tcard {
  min-height: 168px;
  display: flex;
  flex-direction: column;
}

#lightvela-intl-home .voice .tcard p {
  flex: 1;
}

@media (max-width: 720px) {
  #lightvela-intl-home .voice {
    padding: 72px 0 84px;
  }

  #lightvela-intl-home .voice .marquee__rows {
    min-height: 380px;
  }
}
`;

function replaceRequired(source, expected, replacement) {
  if (!source.includes(expected)) {
    throw new Error(`Missing expected homepage CSS block: ${expected.split("\n")[0]}`);
  }
  return source.replace(expected, replacement);
}

function cleanGeneratedText(value) {
  return `${value.replace(/[ \t]+$/gm, "").trimEnd()}\n`;
}

function isolateHomepageBaseStyles(source) {
  const scoped = (selector) => `:where(#lightvela-intl-home ${selector})`;
  let css = source;

  css = replaceRequired(css, ":root {", "#lightvela-intl-home {");
  css = replaceRequired(
    css,
    "*,\n*::before,\n*::after {",
    [
      ":where(#lightvela-intl-home),",
      ":where(#lightvela-intl-home *),",
      ":where(#lightvela-intl-home *::before),",
      ":where(#lightvela-intl-home *::after) {",
    ].join("\n"),
  );
  css = replaceRequired(css, "html {", "#lightvela-intl-home {");
  css = replaceRequired(css, "[id] {", ":where(#lightvela-intl-home [id]) {");
  css = replaceRequired(css, "body {", "#lightvela-intl-home {");
  css = replaceRequired(css, "img {", `${scoped("img")} {`);
  css = replaceRequired(css, "a {", `${scoped("a")} {`);
  css = replaceRequired(css, "ul,\nol {", `${scoped("ul")},\n${scoped("ol")} {`);
  css = replaceRequired(css, "button {", `${scoped("button")} {`);
  css = replaceRequired(css, "input {", `${scoped("input")} {`);
  css = css.replace(
    ".foot__bar img {\n  width: 128px;\n  height: 44px;",
    ".foot__bar img {\n  width: 128px;\n  height: auto;",
  );
  css = replaceRequired(
    css,
    `/* Final calibration: complete headline and realistic chat density. */
.hero__line--main .hero__char,
.hero__line--dynamic .hero__char,
.hero__line--dynamic .hero__rotator-wrap,
.hero__cta,
.hero__tabs,
.hero__stage .hero__frame,
.hero__rotator .ch {
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
  animation: none !important;
}`,
    "/* Final calibration: realistic chat density; preserve the source hero motion. */",
  );

  return css;
}

function sourceLocaleFor(locale) {
  if (locale === "zh-Hant") return "zh-CN";
  return locale;
}

function localizeText(value, locale) {
  if (!value) return value;
  const exact = coreCopyByLocale[locale]?.[value];
  if (exact) return exact;
  const demoExact = demoExactCopyByLocale[locale]?.[value];
  if (demoExact) return demoExact;
  const trimmed = value.trim();
  const trimmedExact = trimmed && coreCopyByLocale[locale]?.[trimmed];
  if (trimmedExact) return value.replace(trimmed, trimmedExact);
  const trimmedDemoExact = trimmed && demoExactCopyByLocale[locale]?.[trimmed];
  if (trimmedDemoExact) return value.replace(trimmed, trimmedDemoExact);
  if (locale === "zh-Hant") return zhHantConverter(value);
  let localized = value;
  for (const [from, to] of textFragmentsByLocale[locale] ?? []) {
    localized = localized.replaceAll(from, to);
  }
  return localized;
}

function localizeDocumentText(document, locale) {
  const walker = document.createTreeWalker(document.body, 4);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    node.nodeValue = localizeText(node.nodeValue, locale);
  }
  for (const element of document.querySelectorAll("[aria-label], [alt], [placeholder], [data-full-html]")) {
    for (const attribute of ["aria-label", "alt", "placeholder", "data-full-html"]) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, localizeText(value, locale));
    }
  }
}

function localizeElementText(element, locale) {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    node.nodeValue = localizeText(node.nodeValue, locale);
  }
  for (const node of element.querySelectorAll("[aria-label], [alt], [placeholder], [data-full-html]")) {
    for (const attribute of ["aria-label", "alt", "placeholder", "data-full-html"]) {
      const value = node.getAttribute(attribute);
      if (value) node.setAttribute(attribute, localizeText(value, locale));
    }
  }
}

function captureHeroSurfacePanels(document) {
  return new Map(
    ["panel-wa", "panel-tg", "panel-dc", "panel-sl"].map((id) => {
      const panel = document.getElementById(id);
      if (!panel) throw new Error(`Missing hero surface panel: ${id}`);
      return [id, panel.cloneNode(true)];
    }),
  );
}

function restoreHeroSurfacePanels(document, panels, locale) {
  for (const [id, panel] of panels) {
    const current = document.getElementById(id);
    if (!current) throw new Error(`Missing target hero surface panel: ${id}`);
    const restored = panel.cloneNode(true);
    current.replaceWith(restored);
    localizeElementText(restored, locale);

    for (const anchor of restored.querySelectorAll("a[href]")) {
      const label = anchor.textContent.replace(/\s+/g, " ").trim();
      const mappedRoute = routeByLabel.get(label);
      if (mappedRoute) {
        anchor.setAttribute("href", mappedRoute);
      } else if (anchor.classList.contains("line__file")) {
        anchor.setAttribute("href", "/agents/files");
      } else if (anchor.classList.contains("line__link")) {
        const isWebsite = /dashboard|site|page|看板|網站|网站|主页|首頁|活動|活動頁|活动页/i.test(label);
        anchor.setAttribute("href", isWebsite ? "/agents/websites/" : "/agents/files");
      } else if (anchor.getAttribute("href") === "#") {
        anchor.setAttribute("href", "/agents");
      }
      const localizedHref = localizePublicHref(anchor.getAttribute("href") ?? "", locale);
      anchor.setAttribute("href", localizedHref);
      if (localizedHref.startsWith("https://")) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noreferrer");
      }
    }
  }
  applyLocalizedAssets(document, locale);
  revealHeroDemoMessages(document);
}

function localizePublicHref(href, locale) {
  if (!href.startsWith("/")) return href;
  const prefix = publicPrefixByLocale[locale] ?? "";
  if (!prefix) return href;
  if (href === "/") return prefix;
  if (href.startsWith("/#")) return `${prefix}${href}`;
  if (publicLocalizedPaths.some((pathPrefix) => href === pathPrefix || href.startsWith(`${pathPrefix}/`))) {
    return `${prefix}${href}`;
  }
  return href;
}

function applyLocalizedAssets(document, locale) {
  const localeKey = locale === "zh-Hant" ? "zh-Hant" : locale === "id-ID" ? "id" : locale === "es" ? "es" : locale === "ja-JP" ? "ja" : locale === "ko-KR" ? "ko" : locale === "en-US" ? "en" : "zh-Hans";
  const automationPanelByLocale = {
    en: "automation-templates-panel-en.png",
    "zh-Hans": "automation-templates-panel.png",
    "zh-Hant": "automation-templates-panel-zh-Hant.png",
    id: "automation-templates-panel-id.png",
    es: "automation-templates-panel-es.png",
    ja: "automation-templates-panel-ja.png",
    ko: "automation-templates-panel-ko.png",
  };
  const workbenchPanelByLocale = {
    en: "workbench-panel-en.png",
    "zh-Hans": "workbench-panel-en.png",
    "zh-Hant": "workbench-panel-zh-Hant.png",
    id: "workbench-panel-id.png",
    es: "workbench-panel-es.png",
    ja: "workbench-panel-ja.png",
    ko: "workbench-panel-ko.png",
  };
  const appsCardByLocale = {
    en: "wcard-apps-en.png",
    "zh-Hans": "wcard-apps-zh-Hans.png",
    "zh-Hant": "wcard-apps-zh-Hant.png",
    id: "wcard-apps-id.png",
    es: "wcard-apps-es.png",
    ja: "wcard-apps-ja.png",
    ko: "wcard-apps-ko.png",
  };
  const folderCardByLocale = {
    en: "wcard-folder-en.png",
    "zh-Hans": "wcard-folder-zh-Hans.png",
    "zh-Hant": "wcard-folder-zh-Hant.png",
    id: "wcard-folder-id.png",
    es: "wcard-folder-es.png",
    ja: "wcard-folder-ja.png",
    ko: "wcard-folder-ko.png",
  };
  const hubCardByLocale = {
    en: "wcard-hub-v3-en.png",
    "zh-Hans": "wcard-hub-v3-zh-Hans.png",
    "zh-Hant": "wcard-hub-v3-zh-Hant.png",
    id: "wcard-hub-v3-id.png",
    es: "wcard-hub-v3-es.png",
    ja: "wcard-hub-v3-ja.png",
    ko: "wcard-hub-v3-ko.png",
  };
  const replacements = new Map([
    ["automation-templates-panel-en.png", automationPanelByLocale[localeKey]],
    ["automation-templates-panel.png", automationPanelByLocale[localeKey]],
    ["automation-templates-panel-zh-Hant.png", automationPanelByLocale[localeKey]],
    ["automation-templates-panel-id.png", automationPanelByLocale[localeKey]],
    ["automation-templates-panel-es.png", automationPanelByLocale[localeKey]],
    ["automation-templates-panel-ja.png", automationPanelByLocale[localeKey]],
    ["automation-templates-panel-ko.png", automationPanelByLocale[localeKey]],
    ["workbench-panel-en.png", workbenchPanelByLocale[localeKey]],
    ["workbench-panel-zh-Hant.png", workbenchPanelByLocale[localeKey]],
    ["workbench-panel-id.png", workbenchPanelByLocale[localeKey]],
    ["workbench-panel-es.png", workbenchPanelByLocale[localeKey]],
    ["workbench-panel-ja.png", workbenchPanelByLocale[localeKey]],
    ["workbench-panel-ko.png", workbenchPanelByLocale[localeKey]],
    ["wcard-apps.png", appsCardByLocale[localeKey]],
    ["wcard-apps-en.png", appsCardByLocale[localeKey]],
    ["wcard-apps-zh-Hans.png", appsCardByLocale[localeKey]],
    ["wcard-apps-zh-Hant.png", appsCardByLocale[localeKey]],
    ["wcard-apps-id.png", appsCardByLocale[localeKey]],
    ["wcard-apps-es.png", appsCardByLocale[localeKey]],
    ["wcard-apps-ja.png", appsCardByLocale[localeKey]],
    ["wcard-apps-ko.png", appsCardByLocale[localeKey]],
    ["wcard-folder.png", folderCardByLocale[localeKey]],
    ["wcard-folder-en.png", folderCardByLocale[localeKey]],
    ["wcard-folder-zh-Hans.png", folderCardByLocale[localeKey]],
    ["wcard-folder-zh-Hant.png", folderCardByLocale[localeKey]],
    ["wcard-folder-id.png", folderCardByLocale[localeKey]],
    ["wcard-folder-es.png", folderCardByLocale[localeKey]],
    ["wcard-folder-ja.png", folderCardByLocale[localeKey]],
    ["wcard-folder-ko.png", folderCardByLocale[localeKey]],
    ["wcard-hub-v3.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-en.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-zh-Hans.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-zh-Hant.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-id.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-es.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-ja.png", hubCardByLocale[localeKey]],
    ["wcard-hub-v3-ko.png", hubCardByLocale[localeKey]],
  ]);
  for (const image of document.querySelectorAll("img[src]")) {
    const value = image.getAttribute("src");
    if (!value) continue;
    for (const [from, to] of replacements) {
      if (value.includes(from) && to) image.setAttribute("src", value.replace(from, to));
    }
  }
}

function normalizeHeroDemo(document) {
  for (const badge of document.querySelectorAll(".chat-row__badge")) {
    badge.remove();
  }

  const comments = [];
  const commentWalker = document.createTreeWalker(document.body, 128);
  while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
  comments.forEach((comment) => comment.remove());

  const sourceIsChinese = document.documentElement.lang?.startsWith("zh");
  const setHeroParagraphs = (selector, englishTexts, chineseTexts) => {
    const texts = sourceIsChinese ? chineseTexts : englishTexts;
    const paragraphs = Array.from(document.querySelectorAll(selector));
    paragraphs.forEach((paragraph, index) => {
      if (!texts[index]) return;
      paragraph.textContent = texts[index];
      paragraph.setAttribute("data-full-html", texts[index]);
    });
  };
  const trimHeroMessages = (selector, limit) => {
    Array.from(document.querySelectorAll(selector)).slice(limit).forEach((message) => message.remove());
  };

  setHeroParagraphs(
    "#panel-tg .native__thread .bub p:not(.bub__time)",
    [
      "@LightVela are you ready? Help me start my AI companion.",
      "I want it to answer in my style and keep working in the cloud.",
      "Your AI companion is waiting to start. Create it in Workbench; if your plan is not active yet, go to Pricing first.",
      "Take me to Workbench so I can set it up.",
      "If my plan is not active, show me Pricing first.",
      "Connect WhatsApp, Telegram, Discord, and Slack after creation.",
      "Done. I will guide you to Workbench when you are ready, and to Pricing when a plan is required.",
      "Open Workbench to create your companion. If a plan is required, open Pricing first, then come back and connect your channels.",
    ],
    [
      "@LightVela 你准备好了吗？帮我启动我的 AI 伙伴。",
      "希望它按我的习惯回复，并且在云端持续运行。",
      "你的 AI 伙伴等待启动中。请先去工作台创建；如果还没有购买，先去购买页。",
      "带我去工作台，我现在就想创建。",
      "如果还没购买，先带我去购买页。",
      "创建后帮我把 WhatsApp、Telegram、Discord、Slack 都接上。",
      "好的。准备好后我带你去工作台；需要订阅时我会先带你去购买页。",
      "请打开工作台创建你的 AI 伙伴。若需要订阅，先进入购买页，完成后再回来连接各个通道。",
    ],
  );

  setHeroParagraphs(
    "#panel-dc .dc__body .dc__msg p",
    [
      "LightVela setup channel: create your AI companion in Workbench, then connect this community for reminders and Q&A.",
      "@LightVela can you join this Discord server after I create you?",
      "Yes. Create me in Workbench first, then add the Discord channel. If your plan is not active, open Pricing before connecting.",
      "@LightVela What can you do here once connected?",
      "I can answer common questions, summarize long threads, and send reminders without asking people to leave Discord.",
      "Can Slack work the same way?",
      "Yes. Slack, WhatsApp, Telegram, and Discord can all become places where your companion listens and responds.",
      "Create the companion first, then connect channels.",
      "Set it up in Workbench; check Pricing first if the plan is not active.",
    ],
    [
      "LightVela 设置频道：先在工作台创建你的 AI 伙伴，再把这个社区接上，用来做提醒和问答。",
      "@LightVela 创建完成后，你能加入这个 Discord 服务器吗？",
      "可以。请先在工作台创建我，再添加 Discord 通道。如果套餐还没启用，连接前先打开购买页。",
      "@LightVela 接入以后你在这里能做什么？",
      "我可以回答常见问题、总结长讨论、发提醒，不需要大家离开 Discord。",
      "Slack 也能这样用吗？",
      "可以。Slack、WhatsApp、Telegram、Discord 都能成为你的 AI 伙伴倾听和回复的地方。",
      "先创建 AI 伙伴，再连接通道。",
      "去工作台设置；如果套餐还没启用，先去购买页。",
    ],
  );
  trimHeroMessages("#panel-dc .dc__body .dc__msg", 7);

  setHeroParagraphs(
    "#panel-sl .dc__body .dc__msg p",
    [
      "@LightVela we are setting up the team workspace. What comes first?",
      "Create your AI companion in Workbench first. I will keep the setup small: name, model, and the first channel.",
      "I want WhatsApp, Telegram, Discord, and Slack connected.",
      "If the plan is not active, send me to Pricing.",
      "Good. After creation, connect each channel once. I will answer in the right place and keep shared context together.",
      "Create it in Workbench; check Pricing first if the plan is not active.",
      "Understood. I will send you to Pricing first, then back to Workbench to finish channel setup.",
    ],
    [
      "@LightVela 我们在设置团队工作区，第一步是什么？",
      "先在工作台创建你的 AI 伙伴。我会把设置控制得很简单：名称、模型、第一个通道。",
      "我想把 WhatsApp、Telegram、Discord、Slack 都接上。",
      "如果套餐没启用，先带我去购买页。",
      "好。创建后每个通道连接一次。我会在正确的地方回复，并把共享上下文放在一起。",
      "先去工作台创建；如果套餐未启用，先去购买页。",
      "明白。我会先带你去购买页，再回到工作台完成通道接入。",
    ],
  );
  trimHeroMessages("#panel-sl .dc__body .dc__msg", 7);

  const exactHeroReplacements = [
    ["LightVela Dev", "AI Companion Setup"],
    ["Hermes Dev", "AI Companion Setup"],
    ["LightVela Issues", "Plan Status"],
    ["Hermes Issues", "Plan Status"],
    ["LightVela：DSH 已完成 patch，等你 review", "LightVela：准备好创建"],
    ["DSH finished the patch.", "Ready to create."],
    ["dsh-runner", "Workbench"],
    ["fix/memory-dedupe pushed", "Start from Workbench"],
    ["memory-dedupe pushed", "Start from Workbench"],
    ["#337 skill follow-up", "Pricing check"],
    ["#337 skill optimization follow-up", "Pricing check"],
    ["CI Alerts", "Channel Setup"],
    ["memory provider tests passed", "Channels ready"],
    ["All checks passed.", "Channels ready"],
    ["Release Notes", "Assistant Notes"],
    ["v2.4.0 draft is ready.", "Preferences saved."],
    ["v2.4.0 draft ready for review", "Preferences saved."],
    ["Ops Monitor", "Cloud Status"],
    ["API latency is back to normal.", "Running in the cloud."],
    ["API latency returned to normal", "Running in the cloud."],
    ["Design Review", "Skills"],
    ["2 comments still need responses", "Knowledge and automations"],
    ["Two comments need responses.", "Knowledge and automations"],
    ["Support Digest", "Help Digest"],
    ["weekly issue summary is ready", "Setup tips are ready."],
    ["The weekly summary is ready.", "Setup tips are ready."],
    ["API Changes", "Integrations"],
    ["three endpoints were updated", "Supported channels connected."],
    ["Three endpoints were updated.", "Supported channels connected."],
    ["announcements", "setup"],
    ["tournament-help", "help"],
    ["公告", "设置"],
    ["赛事帮助", "帮助"],
    [
      "@LightVela ask DSH to fix LightVela: memory provider occasionally writes duplicate records. Reproduce first, then patch.",
      "@LightVela are you ready? Help me start my AI companion.",
    ],
    [
      "@LightVela ask DSH to fix Hermes: memory provider occasionally writes duplicate records. Reproduce first, then patch.",
      "@LightVela are you ready? Help me start my AI companion.",
    ],
    [
      "@LightVela 用 DSH 修一下 Hermes：memory provider 偶发重复写入，先复现再给 patch。",
      "@LightVela 你准备好了吗？帮我启动我的 AI 伙伴。",
    ],
    [
      "Keep it small. Check provider sync and the session-end hook first.",
      "I want it to answer in my style and keep working in the cloud.",
    ],
    ["别大改，优先看 sync 和 session end hook。", "希望它按我的习惯回复，并且在云端持续运行。"],
    [
      "DSH reproduced it in an isolated branch. It happens when provider sync and session end fire together.",
      "Your AI companion is waiting to start. Create it in Workbench; if your plan is not active yet, go to Pricing first.",
    ],
    [
      "DSH 已经在隔离分支复现。问题出现在 provider sync 与 session end 同时触发时。",
      "你的 AI 伙伴等待启动中。请先去工作台创建；如果还没有购买，先去购买页。",
    ],
    [
      "Post the patch and test results here. We will merge tonight.",
      "Take me to Workbench so I can set it up.",
    ],
    ["把修复文件和测试结果发群里，今晚合并。", "带我去工作台，我现在就想创建。"],
    [
      "Do not change the storage schema. Contain the concurrent write first.",
      "If my plan is not active, show me Pricing first.",
    ],
    ["不要改存储结构，先把并发写入收口。", "如果还没购买，先带我去购买页。"],
    [
      "Add a regression case where sync and session end fire together.",
      "Connect WhatsApp, Telegram, Discord, and Slack after creation.",
    ],
    ["回归里加一次 sync 和 session end 同时触发。", "创建后帮我把 WhatsApp、Telegram、Discord、Slack 都接上。"],
    [
      "Added. Twenty concurrent runs now produce one record each.",
      "Done. I will guide you to Workbench when you are ready, and to Pricing when a plan is required.",
    ],
    ["已加并发用例，连续跑 20 次都只写入一条记录。", "好的。准备好后我带你去工作台；需要订阅时我会先带你去购买页。"],
    [
      "The minimal fix is ready with a regression test. Unit, integration, and CI all pass. Review only provider sync and the session-end hook.",
      "Open Workbench to create your companion. If a plan is required, open Pricing first, then come back and connect your channels.",
    ],
    [
      "最小修复已完成，并补了 regression test；unit、integration 和 CI 均已通过。建议只 review provider sync 与 session end hook 两处改动。",
      "请打开工作台创建你的 AI 伙伴。若需要订阅，先进入购买页，完成后再回来连接各个通道。",
    ],
    ["fix/memory-provider-dedupe.diff", "lightvela-companion-setup.guide"],
    ["patch · tests passed", "Workbench · Pricing · Channels"],
    [
      "Friday Night Arena reminder: Rift Clash starts Friday at 8:00 PM GMT+8. Register in ",
      "LightVela setup channel: create your AI companion in Workbench, then connect this community for reminders and Q&A. ",
    ],
    ["周五夜间竞技赛提醒：裂隙对决社区赛周五 20:00 GMT+8 开始。报名在 ", "LightVela 设置频道：先在工作台创建你的 AI 伙伴，再把这个社区接上，用来做提醒和问答。"],
    [
      "When does the tournament start in my time zone?",
      "can you join this Discord server after I create you?",
    ],
    ["这次比赛换算到我的时区是几点开始？", "创建完成后，你能加入这个 Discord 服务器吗？"],
    [
      "The tournament starts Friday at 8:00 PM GMT+8. For you, that's 10:00 PM AEST.",
      "Yes. Create me in Workbench first, then add the Discord channel. If your plan is not active, open Pricing before connecting.",
    ],
    ["比赛周五晚上 8 点 GMT+8 开始。", "可以。请先在工作台创建我，再添加 Discord 通道。"],
    ["换到你的时区是 AEST 晚上 10 点。", "如果套餐还没启用，连接前先打开购买页。"],
    ["What do I need before joining tonight's raid?", "What can you do here once connected?"],
    ["今晚进团前我需要先做什么？", "接入以后你在这里能做什么？"],
    [
      "Make sure you're registered, read the rules in ",
      "I can answer common questions, summarize long threads, and send reminders without asking people to leave Discord. ",
    ],
    ["进团前先确认已报名，阅读 ", "我可以回答常见问题、总结长讨论、发提醒，不需要大家离开 Discord。"],
    ["What if I registered but have not been assigned a team?", "Can Slack work the same way?"],
    ["如果我报名后还没分到队怎么办？", "Slack 也能这样用吗？"],
    [
      "Check in at ",
      "Yes. Slack, WhatsApp, Telegram, and Discord can all become places where your companion listens and responds. ",
    ],
    ["开赛前 30 分钟到 ", "可以。Slack、WhatsApp、Telegram、Discord 都能成为你的 AI 伙伴倾听和回复的地方。"],
    ["Moderators will fill open spots, and I will summarize which teams still need players.", "",],
    ["管理员会按空位补队。我也会把缺人的队伍整理出来。", ""],
    ["Remind us once more before it starts.", "Create the companion first, then connect channels."],
    ["那开赛前再提醒我们一次。", "先创建 AI 伙伴，再连接通道。"],
    [
      "Scheduled. At 7:30 PM Friday, I will remind registered members in ",
      "Set it up in Workbench; check Pricing first if the plan is not active. ",
    ],
    ["已安排。周五 19:30 我会在 ", "去工作台设置；如果套餐还没启用，先去购买页。"],
    ["and share the check-in and team links.", "",],
    ["并同步签到和组队入口。", ""],
    [
      "@LightVela read the last week of messages. What is blocking us right now?",
      "@LightVela we are setting up the team workspace. What comes first?",
    ],
    ["@LightVela 翻一下最近一周的讨论，先说现在最卡哪一步。", "@LightVela 我们在设置团队工作区，第一步是什么？"],
    [
      "Pricing-page copy is the main blocker. It is due Friday, and both design and the conversion analysis are waiting for it.",
      "Create your AI companion in Workbench first. I will keep the setup small: name, model, and the first channel.",
    ],
    ["最卡的是定价页文案。周五要交，设计和注册转化分析都在等这版。", "先在工作台创建你的 AI 伙伴。我会把设置控制得很简单：名称、模型、第一个通道。"],
    ["I still owe three customer follow-ups. I can only book one today.", "I want WhatsApp, Telegram, Discord, and Slack connected."],
    ["客户回访还欠三家，我今天只能先约一家。", "我想把 WhatsApp、Telegram、Discord、Slack 都接上。"],
    [
      "I will pull conversion data this afternoon. @LightVela reorder the work and remind each owner before the deadline.",
      "If the plan is not active, send me to Pricing.",
    ],
    ["转化数据我下午拉。@LightVela 照这个重排，截止前提醒负责人。", "如果套餐没启用，先带我去购买页。"],
    [
      "Done. Lin sends design a usable copy draft today; you add conversion data this afternoon; Alex books the first customer today and the other two tomorrow and Thursday. I will @ each owner before their deadline.",
      "Good. After creation, connect each channel once. I will answer in the right place and keep shared context together.",
    ],
    ["好。先由小林今天给设计一版可用文案；你下午补转化数据；阿哲今天约第一家，另外两家放到明后天。我会在各自截止前 @ 对应的人。", "好。创建后每个通道连接一次。我会在正确的地方回复，并把共享上下文放在一起。"],
    [
      "Next time, do not split customer follow-ups by day. Rank them by renewal risk first.",
      "Create it in Workbench; check Pricing first if the plan is not active.",
    ],
    ["以后客户回访别按每天一家排，先看续费风险。", "先去工作台创建；如果套餐未启用，先去购买页。"],
    [
      "Got it. From now on I will rank customer follow-ups by renewal risk before delay, and I have reordered this list using that rule.",
      "Understood. I will send you to Pricing first, then back to Workbench to finish channel setup.",
    ],
    ["记住了。以后排客户回访，我会先看续费风险，再看拖延时间；这次也按这个新规则重排。", "明白。我会先带你去购买页，再回到工作台完成通道接入。"],
  ];

  const replaceHeroCopy = (value) => {
    let next = value;
    for (const [from, to] of exactHeroReplacements) {
      next = next.replaceAll(from, to);
    }
    return next
      .replaceAll("LightVela · Hermes Agent in the Cloud", "LightVela · AI companion in the cloud")
      .replaceAll("LightVela · 云端 Hermes Agent", "LightVela · 云端 AI 伙伴")
      .replaceAll("Nasdaq Brief Assistant", "Market Brief")
      .replaceAll("Hermes Agent: Nasdaq sector brief is ready", "LightVela: market brief is ready")
      .replaceAll("Hermes Agent：纳斯达克热门板块速览已生成", "LightVela：纳斯达克热门板块速览已生成")
      .replaceAll("Nasdaq sector brief is ready:", "Market brief is ready:")
      .replaceAll("Hermes Agent", "LightVela")
      .replaceAll("Hermes updated", "LightVela updated")
      .replaceAll("fix Hermes", "fix LightVela");
  };

  const walker = document.createTreeWalker(document.body, 4);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    node.nodeValue = replaceHeroCopy(node.nodeValue);
  }

  for (const element of document.querySelectorAll("[aria-label], [alt], [placeholder], [data-full-html]")) {
    for (const attribute of ["aria-label", "alt", "placeholder", "data-full-html"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      element.setAttribute(attribute, replaceHeroCopy(value));
    }
  }
}

const alwaysOnEmphasisByLocale = {
  "en-US": [
    ["I stay ", "available 24/7 in the cloud", ", so you never need to leave your computer running. Whenever you correct me, I ", "turn your feedback into a new rule", " and apply it next time."],
  ],
  "zh-SG": [
    ["我在", "云端 7×24 小时在线", "，不用一直开着你的电脑。你每纠正我一次，我就把它记成", "新规则，下次直接按你的习惯做", "。"],
  ],
  "zh-Hant": [
    ["我在", "雲端 7×24 小時在線", "，不用一直開著你的電腦。你每糾正我一次，我就把它記成", "新規則，下次直接按你的習慣做", "。"],
  ],
  "id-ID": [
    ["Saya berjalan ", "di cloud dan tersedia 24/7", ", jadi komputer Anda tidak perlu terus menyala. Setiap kali Anda mengoreksi saya, saya menyimpannya ", "sebagai aturan baru dan mengikuti preferensi Anda berikutnya", "."],
  ],
  es: [
    ["Funciono ", "en la nube y estoy disponible 24/7", ", así que tu ordenador no tiene que quedar encendido. Cada corrección se guarda ", "como una regla para la próxima vez", "."],
  ],
  "ja-JP": [
    ["私は", "クラウドで24時間365日稼働する", "ので、あなたのコンピューターを起動し続ける必要はありません。修正されるたびに", "新しいルールとして保存し、次回はあなたの好みに沿って動きます", "。"],
  ],
  "ko-KR": [
    ["저는 ", "클라우드에서 24시간 연중무휴로 실행", "되므로 컴퓨터를 계속 켜 둘 필요가 없습니다. 당신이 한 번 수정할 때마다 ", "새 규칙으로 저장하고 다음에는 그 선호에 맞춰 움직입니다", "."],
  ],
};

function emphasizeAlwaysOnCard(document, locale) {
  const parts = alwaysOnEmphasisByLocale[locale]?.[0] ?? alwaysOnEmphasisByLocale["en-US"][0];
  const [beforeCloud, cloud, beforeRule, rule, afterRule] = parts;
  const cardText = `${beforeCloud}${cloud}${beforeRule}${rule}${afterRule}`;
  for (const paragraph of document.querySelectorAll(".wcard__body p")) {
    if (paragraph.textContent?.replace(/\s+/g, " ").trim() !== cardText) continue;
    paragraph.replaceChildren(
      document.createTextNode(beforeCloud),
      Object.assign(document.createElement("b"), { textContent: cloud }),
      document.createTextNode(beforeRule),
      Object.assign(document.createElement("b"), { textContent: rule }),
      document.createTextNode(afterRule),
    );
  }
}

const deepSeekHarnessPlayByLocale = {
  "en-US": {
    heading: "One-click Deploy DeepSeek Harness",
    intro: "Ready out of the box, always online in the cloud. Secure WebUI access when you need to operate.",
    items: [
      ["One-click deployment", "from our image"],
      ["Ready out of the box", "with cloud-hosted runtime"],
      ["Always online", "for long-running AI assistant tasks"],
      ["Secure WebUI access", "when you need to operate"],
    ],
    cta: "Open DeepSeek Harness",
  },
  "zh-CN": {
    heading: "一键部署 DeepSeek Harness",
    intro: "开箱即用，常驻云端。需要操作时，可安全进入 WebUI。",
    items: [
      ["一键部署", "基于镜像快速启动"],
      ["开箱即用", "云端托管运行时准备就绪"],
      ["长期在线", "适合长时间运行的 AI 助手任务"],
      ["安全 WebUI", "需要操作时再进入专属界面"],
    ],
    cta: "打开 DeepSeek Harness",
  },
  "zh-SG": {
    heading: "一键部署 DeepSeek Harness",
    intro: "开箱即用，常驻云端。需要操作时，可安全进入 WebUI。",
    items: [
      ["一键部署", "基于镜像快速启动"],
      ["开箱即用", "云端托管运行时准备就绪"],
      ["长期在线", "适合长时间运行的 AI 助手任务"],
      ["安全 WebUI", "需要操作时再进入专属界面"],
    ],
    cta: "打开 DeepSeek Harness",
  },
  "zh-Hant": {
    heading: "一鍵部署 DeepSeek Harness",
    intro: "開箱即用，常駐雲端。需要操作時，可安全進入 WebUI。",
    items: [
      ["一鍵部署", "基於映像快速啟動"],
      ["開箱即用", "雲端託管運行時準備就緒"],
      ["長期在線", "適合長時間運行的 AI 助手任務"],
      ["安全 WebUI", "需要操作時再進入專屬介面"],
    ],
    cta: "打開 DeepSeek Harness",
  },
  "id-ID": {
    heading: "Deploy DeepSeek Harness sekali klik",
    intro: "Siap pakai, selalu online di cloud. Akses WebUI aman saat Anda perlu mengoperasikan.",
    items: [
      ["Deploy sekali klik", "dari image kami"],
      ["Siap pakai", "dengan runtime yang di-host di cloud"],
      ["Selalu online", "untuk tugas asisten AI jangka panjang"],
      ["Akses WebUI aman", "saat Anda perlu mengoperasikan"],
    ],
    cta: "Buka DeepSeek Harness",
  },
  es: {
    heading: "Despliega DeepSeek Harness con un clic",
    intro: "Listo para usar y siempre online en la nube. Acceso WebUI seguro cuando necesites operar.",
    items: [
      ["Despliegue con un clic", "desde nuestra imagen"],
      ["Listo para usar", "con runtime alojado en la nube"],
      ["Siempre online", "para tareas largas de asistente de IA"],
      ["Acceso WebUI seguro", "cuando necesites operar"],
    ],
    cta: "Abrir DeepSeek Harness",
  },
  "ja-JP": {
    heading: "DeepSeek Harnessをワンクリックでデプロイ",
    intro: "すぐに使えて、クラウドで常時オンライン。操作が必要なときは安全な WebUI にアクセスできます。",
    items: [
      ["ワンクリックデプロイ", "専用イメージからすばやく起動"],
      ["すぐに使える", "クラウドホストのランタイムを用意"],
      ["常時オンライン", "長時間の AI アシスタントタスクに対応"],
      ["安全な WebUI", "操作が必要なときだけアクセス"],
    ],
    cta: "DeepSeek Harness を開く",
  },
  "ko-KR": {
    heading: "DeepSeek Harness 원클릭 배포",
    intro: "바로 사용할 수 있고 클라우드에서 항상 온라인입니다. 조작이 필요할 때 안전하게 WebUI에 접속합니다.",
    items: [
      ["원클릭 배포", "전용 이미지에서 빠르게 시작"],
      ["바로 사용 가능", "클라우드 호스팅 런타임 준비"],
      ["항상 온라인", "장시간 AI 어시스턴트 작업에 적합"],
      ["안전한 WebUI", "조작이 필요할 때 접속"],
    ],
    cta: "DeepSeek Harness 열기",
  },
};

const deepSeekHarnessVisualByLocale = {
  "en-US": "/lightvela-intl-home/assets/deepseek-harness-en-us.png?v=20260901-deepseek-ui",
  "zh-CN": "/lightvela-intl-home/assets/deepseek-harness-zh-cn.png?v=20260901-deepseek-ui",
  "zh-SG": "/lightvela-intl-home/assets/deepseek-harness-zh-sg.png?v=20260901-deepseek-ui",
  "zh-Hant": "/lightvela-intl-home/assets/deepseek-harness-zh-hant.png?v=20260901-deepseek-ui",
  "id-ID": "/lightvela-intl-home/assets/deepseek-harness-id-id.png?v=20260901-deepseek-ui",
  es: "/lightvela-intl-home/assets/deepseek-harness-es.png?v=20260901-deepseek-ui",
  "ja-JP": "/lightvela-intl-home/assets/deepseek-harness-ja-jp.png?v=20260901-deepseek-ui",
  "ko-KR": "/lightvela-intl-home/assets/deepseek-harness-ko-kr.png?v=20260901-deepseek-ui",
};

function addDeepSeekHarnessPlay(document, locale) {
  const plays = document.querySelector(".plays");
  const tabs = plays?.querySelector(".plays__tabs");
  const stage = plays?.querySelector(".plays__stage");
  if (!plays || !tabs || !stage || plays.querySelector("#pl-4")) return;

  const copy = deepSeekHarnessPlayByLocale[locale] ?? deepSeekHarnessPlayByLocale["en-US"];
  const visualSrc = deepSeekHarnessVisualByLocale[locale] ?? deepSeekHarnessVisualByLocale["en-US"];
  const secondInput = plays.querySelector("#pl-3");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "play";
  input.id = "pl-4";
  if (secondInput?.nextSibling) {
    plays.insertBefore(input, secondInput.nextSibling);
  } else {
    plays.insertBefore(input, tabs);
  }

  const label = document.createElement("label");
  label.setAttribute("for", "pl-4");
  label.innerHTML = `<svg class="icon"><use href="#i-bolt"></use></svg><span>DeepSeek Harness</span><em class="play__new-badge">New</em>`;
  tabs.appendChild(label);

  const panel = document.createElement("div");
  panel.className = "play play--with-screen play--harness";
  panel.id = "play-4";
  panel.innerHTML = `
    <div class="play__text">
      <h4>${copy.heading}</h4>
      <p>${copy.intro}</p>
      <ul class="play__list">
        ${copy.items.map(([label, body]) => `<li><b><svg class="icon"><use href="#i-check"></use></svg>${label}</b>${body}</li>`).join("")}
      </ul>
      <a class="play__more" href="/agents/labs/deepseek-harness">${copy.cta} <svg class="icon"><use href="#i-arrow-r"></use></svg></a>
    </div>
    <figure class="play__screen play__screen--harness">
      <img class="harness-visual-img" src="${visualSrc}" alt="" loading="lazy" aria-hidden="true">
    </figure>
  `;
  stage.appendChild(panel);
}

function revealHeroDemoMessages(document) {
  for (const message of document.querySelectorAll(".hero__frame .panel .bub, .hero__frame .panel .dc__msg")) {
    const speaker = message.querySelector(".bub__name, b")?.textContent ?? "";
    if (message.classList.contains("bub") && speaker.includes("LightVela")) {
      message.classList.add("bub--ai");
    }
    message.classList.remove("is-typing");
    message.classList.add("is-in", "is-done");
    for (const copy of message.querySelectorAll(".bub__box > p:not(.bub__time), .bub__box > pre.bub__report > code, :scope > div > p")) {
      const html = copy.getAttribute("data-full-html");
      if (html) copy.innerHTML = html;
    }
  }
}

function alignHeaderNavigation(document) {
  const links = document.querySelector(".nav__links");
  if (!links) return;

  const anchors = Array.from(links.querySelectorAll("a"));
  const docs = anchors.find((anchor) => (anchor.getAttribute("href") ?? "").endsWith("/docs/overview"));
  const changelog = anchors.find((anchor) => (anchor.getAttribute("href") ?? "").endsWith("/changelog"));
  if (!docs || !changelog || changelog.nextElementSibling === docs) return;

  links.insertBefore(changelog, docs);
  links.insertBefore(document.createTextNode("\n      "), docs);
}

function prepareDocumentForLocale(document, locale) {
  normalizeHeroDemo(document);
  localizeDocumentText(document, locale);
  applyLocalizedAssets(document, locale);
  emphasizeAlwaysOnCard(document, locale);
  revealHeroDemoMessages(document);
  const root = document.querySelector("#lightvela-intl-home");
  const rotator = document.querySelector("#hero-rotator");
  const words = rotatorWordsByLocale[locale] ?? rotatorWordsByLocale["en-US"];
  if (rotator) rotator.textContent = words[0];
  if (root) {
    root.setAttribute("data-locale", locale);
    root.setAttribute("data-rotator-words", JSON.stringify(words));
  }
}

function applyFooterLayout(document) {
  const footer = document.querySelector("footer.foot");
  if (!footer) throw new Error("Missing homepage footer");

  footer.innerHTML = `
  <div class="foot__top">
    <h2 class="foot__title"><span class="row">Hand your ideas to Hermes Agent,</span><br><span class="row">keep them moving in the cloud.</span></h2>
    <div class="foot__cta"><a href="/agents">My AI companion <span><svg class="icon"><use href="#i-arrow-ur"></use></svg></span></a></div>
  </div>
  <div class="foot__links"><div class="foot__links-grid">
    <div class="foot__brand"><a class="foot__brand-link" href="/"><img src="/lightvela-logo.svg" alt="LightVela"></a><p class="foot__copyright">© 2026 LightVela. All rights reserved. Built by Tencent Lighthouse.</p></div>
    <div><h3>Product</h3><ul><li><a href="/blog">Blog</a></li><li><a href="/subscribe">14-day free trial</a></li><li><a href="/subscribe">Pricing</a></li><li><a href="/docs/configuration/channel-whatsapp">WhatsApp setup guide</a></li><li><a href="/docs/configuration/channel-telegram">Telegram setup guide</a></li><li><a href="/docs/configuration/channel-discord">Discord setup guide</a></li></ul></div>
    <div><h3>Analysis</h3><ul><li><a href="/docs/compare/lightvela-vs-localhost-ai-agent">Self-hosting analysis</a></li><li><a href="/docs/compare/lightvela-vs-hostinger">Hostinger analysis</a></li><li><a href="/docs/compare/lightvela-vs-manus">Manus analysis</a></li><li><a href="/docs/compare/lightvela-vs-chatgpt">ChatGPT analysis</a></li><li><a href="/docs/compare/lightvela-vs-genspark">Genspark analysis</a></li></ul></div>
    <div><h3>Community</h3><ul><li><a href="https://x.com/agentlightvela" target="_blank" rel="noreferrer">X / Twitter</a></li><li><a href="https://discord.gg/Myh58xEMe2" target="_blank" rel="noreferrer">Discord</a></li><li><a href="https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b" target="_blank" rel="noreferrer">WhatsApp</a></li><li><a href="https://www.youtube.com/@TencentLightVela" target="_blank" rel="noreferrer">YouTube</a></li></ul></div>
    <div><h3>Company</h3><ul><li><a href="/about">About Us</a></li><li><a href="/privacy-policy">Privacy Policy</a></li><li><a href="/terms-of-service">Terms of Service</a></li><li><a href="/open-source-licenses">Open Source Notice</a></li></ul></div>
    <div><h3>Related products</h3><ul><li><a href="https://edgeone.ai/" target="_blank" rel="noreferrer">Tencent EdgeOne</a></li><li><a href="https://tcb.cloud.tencent.com/en/?from=lightvela" target="_blank" rel="noreferrer">Tencent CloudBase</a></li></ul></div>
  </div></div>
`;
}

function emphasizeFooterHermes(document) {
  const title = document.querySelector(".foot__title");
  if (!title || title.querySelector(".foot__signature")) return;

  const walker = document.createTreeWalker(title, 4);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.nodeValue ?? "";
    const signatureText = "Hermes Agent";
    const index = text.indexOf(signatureText);
    if (index === -1) continue;

    const fragment = document.createDocumentFragment();
    if (index > 0) fragment.append(document.createTextNode(text.slice(0, index)));
    const signature = document.createElement("em");
    signature.className = "foot__signature";
    signature.textContent = signatureText;
    fragment.append(signature);
    if (index + signatureText.length < text.length) {
      fragment.append(document.createTextNode(text.slice(index + signatureText.length)));
    }
    node.replaceWith(fragment);
    return;
  }
}

if (!process.argv[2]) {
  throw new Error("Usage: node scripts/import-international-homepage.mjs <approved-static-homepage-root>");
}

const routeByLabel = new Map([
  ["Home", "/"],
  ["Pricing", "/subscribe"],
  ["Docs", "/docs/overview"],
  ["Changelog", "/changelog"],
  ["Blog", "/blog"],
  ["About", "/about"],
  ["CN", "/zh-sg/"],
  ["Early Access", "/subscribe"],
  ["My AI Companion", "/agents"],
  ["View all scenes", "/agents/automations"],
  ["Learn Workbench", "/agents/websites/"],
  ["Start free", "/subscribe"],
  ["My AI partners", "/agents"],
  ["My AI companion", "/agents"],
  ["Get started", "/agents"],
  ["Product Introduction", "/"],
  ["Scenario Examples", "/#scenes"],
  ["How to Start", "/subscribe"],
  ["Help & Feedback", "/support"],
  ["Legal", "/privacy-policy"],
  ["Data Processing Notice", "/privacy-policy"],
  ["Open Source Statement", "/open-source-licenses"],
  ["WhatsApp setup guide", "/docs/configuration/channel-whatsapp"],
  ["Telegram setup guide", "/docs/configuration/channel-telegram"],
  ["Discord setup guide", "/docs/configuration/channel-discord"],
  ["Self-hosting analysis", "/docs/compare/lightvela-vs-localhost-ai-agent"],
  ["Hostinger analysis", "/docs/compare/lightvela-vs-hostinger"],
  ["Manus analysis", "/docs/compare/lightvela-vs-manus"],
  ["ChatGPT analysis", "/docs/compare/lightvela-vs-chatgpt"],
  ["Genspark analysis", "/docs/compare/lightvela-vs-genspark"],
  ["Discord", "https://discord.gg/Myh58xEMe2"],
  ["WhatsApp", "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b"],
  ["X / Twitter", "https://x.com/agentlightvela"],
  ["YouTube", "https://www.youtube.com/@TencentLightVela"],
  ["About Us", "/about"],
  ["Privacy Policy", "/privacy-policy"],
  ["Terms of Service", "/terms-of-service"],
  ["Open Source Notice", "/open-source-licenses"],
  ["Tencent CloudBase", "https://tcb.cloud.tencent.com/en/?from=lightvela"],
  ["Tencent EdgeOne", "https://edgeone.ai/"],
  ["首页", "/"],
  ["定价", "/subscribe"],
  ["文档", "/docs/overview"],
  ["文檔", "/docs/overview"],
  ["产品文档", "/docs/overview"],
  ["產品文檔", "/docs/overview"],
  ["更新日志", "/changelog"],
  ["关于我们", "/about"],
  ["抢先体验", "/subscribe"],
  ["我的智能体伙伴", "/agents"],
  ["人设 / Skill / 自动任务", "/agents"],
  ["自动任务 / 工作台 / DeepSeek Harness", "/agents"],
  ["自動任務 / 工作臺 / DeepSeek Harness", "/agents"],
  ["看全部场景", "/agents/automations"],
  ["了解工作台", "/agents/websites/"],
  ["立即免费体验", "/subscribe"],
  ["我的 AI 伙伴", "/agents"],
  ["开始使用", "/agents"],
  ["WhatsApp 接入指南", "/docs/configuration/channel-whatsapp"],
  ["Telegram 接入指南", "/docs/configuration/channel-telegram"],
  ["Discord 接入指南", "/docs/configuration/channel-discord"],
  ["与自托管对比", "/docs/compare/lightvela-vs-localhost-ai-agent"],
  ["与 Hostinger 对比", "/docs/compare/lightvela-vs-hostinger"],
  ["与 Manus 对比", "/docs/compare/lightvela-vs-manus"],
  ["与 ChatGPT 对比", "/docs/compare/lightvela-vs-chatgpt"],
  ["与 Genspark 对比", "/docs/compare/lightvela-vs-genspark"],
  ["隐私政策", "/privacy-policy"],
  ["服务条款", "/terms-of-service"],
  ["开源声明", "/open-source-licenses"],
  ["腾讯云 CloudBase", "https://tcb.cloud.tencent.com/en/?from=lightvela"],
  ["腾讯云 EdgeOne", "https://edgeone.ai/"],
]);

const cssSource = await readFile(path.join(sourceRoot, "style.css"), "utf8");
const assetPaths = new Set();

for (const match of cssSource.matchAll(/url\(\s*(['"]?)(assets\/[^'")]+)\1\s*\)/g)) {
  assetPaths.add(match[2].split(/[?#]/)[0]);
}

let inlineScripts = [];

const preservedHarnessAssets = await Promise.all(
  preservedHarnessAssetNames.map(async (assetName) => [
    assetName,
    await readFile(path.join(targetRoot, "assets", assetName)),
  ]),
);
await rm(targetRoot, { recursive: true, force: true });
await mkdir(path.join(targetRoot, "assets"), { recursive: true });
await Promise.all(
  preservedHarnessAssets.map(([assetName, contents]) =>
    writeFile(path.join(targetRoot, "assets", assetName), contents),
  ),
);

for (const locale of supportedLocales) {
  const html = await readFile(path.join(sourceRoot, sourceFileByLocale[locale]), "utf8");
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const sourceLocale = sourceLocaleFor(locale);
  const heroSurfacePanels = captureHeroSurfacePanels(document);

  const headerActions = document.querySelector(".nav__actions");
  if (!headerActions) throw new Error("Missing homepage header actions container");
  const headerActionsMount = document.createElement("div");
  headerActionsMount.id = "international-home-header-actions";
  headerActions.replaceChildren(headerActionsMount);

  const headerLogo = document.querySelector(".nav__brand img");
  if (!headerLogo) throw new Error("Missing homepage header logo");
  headerLogo.setAttribute("src", "/lightvela-logo.svg");
  document.querySelector(".nav__brand b")?.remove();

  const footerLogo = document.querySelector(".foot__bar-l img");
  if (footerLogo) footerLogo.setAttribute("src", "/lightvela-logo.svg");

  for (const script of document.querySelectorAll("script")) {
    if (locale === "en-US" && !script.src && script.textContent?.trim()) {
      inlineScripts.push(script.textContent.trim());
    }
    script.remove();
  }

  addDeepSeekHarnessPlay(document, locale);
  applyFooterLayout(document);

  for (const anchor of document.querySelectorAll("a[href]")) {
    const label = anchor.textContent.replace(/\s+/g, " ").trim();
    const mappedRoute = routeByLabel.get(label);
    if (mappedRoute) {
      anchor.setAttribute("href", mappedRoute);
    } else if (anchor.getAttribute("href") === "#top") {
      anchor.setAttribute("href", "/");
    } else if (anchor.classList.contains("line__file")) {
      anchor.setAttribute("href", "/agents/files");
    } else if (anchor.classList.contains("line__link")) {
      const isWebsite = /dashboard|site|page|看板|网站|主页|活动页/i.test(label);
      anchor.setAttribute("href", isWebsite ? "/agents/websites/" : "/agents/files");
    }

    const href = anchor.getAttribute("href") ?? "";
    const localizedHref = localizePublicHref(href, locale);
    anchor.setAttribute("href", localizedHref);
    if (localizedHref.startsWith("https://")) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noreferrer");
    }
  }

  alignHeaderNavigation(document);
  prepareDocumentForLocale(document, locale);
  emphasizeFooterHermes(document);
  restoreHeroSurfacePanels(document, heroSurfacePanels, locale);
  for (const element of document.querySelectorAll("[src], [poster]")) {
    for (const attribute of ["src", "poster"]) {
      const value = element.getAttribute(attribute);
      if (!value?.startsWith("assets/")) continue;
      const assetPath = value.split(/[?#]/)[0];
      assetPaths.add(assetPath);
      element.setAttribute(attribute, `/lightvela-intl-home/${value}`);
    }
  }

  const unresolvedAnchors = Array.from(document.querySelectorAll("a[href]"), (anchor) => anchor.getAttribute("href"))
    .filter((href) => !href?.startsWith("/") && !href?.startsWith("https://"));
  if (unresolvedAnchors.length > 0) {
    throw new Error(`Unresolved homepage anchors (${locale}): ${unresolvedAnchors.join(", ")}`);
  }

  const fragment = [
    `<div id="lightvela-intl-home" data-locale="${locale}" data-source-locale="${sourceLocale}" data-rotator-words='${JSON.stringify(rotatorWordsByLocale[locale])}' style="--cta-delay: 1350ms; --tabs-delay: 1510ms; --frame-delay: 1670ms;">`,
    document.body.innerHTML.trim(),
    "</div>",
    "",
  ].join("\n");

  await writeFile(path.join(targetRoot, `index-fragment.${locale}.html`), cleanGeneratedText(fragment));
  if (locale === "en-US") {
    await writeFile(path.join(targetRoot, "index-fragment.html"), cleanGeneratedText(fragment));
  }
}

for (const assetName of [
  "automation-templates-panel.png",
  "automation-templates-panel-zh-Hant.png",
  "automation-templates-panel-id.png",
  "automation-templates-panel-es.png",
  "automation-templates-panel-ja.png",
  "automation-templates-panel-ko.png",
  "workbench-panel-id.png",
  "workbench-panel-es.png",
  "workbench-panel-ja.png",
  "workbench-panel-ko.png",
  "wcard-apps-en.png",
  "wcard-apps-zh-Hans.png",
  "wcard-apps-zh-Hant.png",
  "wcard-apps-id.png",
  "wcard-apps-es.png",
  "wcard-apps-ja.png",
  "wcard-apps-ko.png",
  "wcard-folder-en.png",
  "wcard-folder-zh-Hans.png",
  "wcard-folder-zh-Hant.png",
  "wcard-folder-id.png",
  "wcard-folder-es.png",
  "wcard-folder-ja.png",
  "wcard-folder-ko.png",
  "wcard-hub-v3-en.png",
  "wcard-hub-v3-zh-Hans.png",
  "wcard-hub-v3-zh-Hant.png",
  "wcard-hub-v3-id.png",
  "wcard-hub-v3-es.png",
  "wcard-hub-v3-ja.png",
  "wcard-hub-v3-ko.png",
]) {
  assetPaths.add(`assets/${assetName}`);
}

for (const assetPath of assetPaths) {
  const relativeAssetPath = assetPath.slice("assets/".length);
  const destination = path.join(targetRoot, "assets", relativeAssetPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(sourceRoot, assetPath), destination);
}

const editorialLocaleSelector = "#lightvela-intl-home:is([data-locale^='en'], [data-locale^='id'], [data-locale='es'], [data-locale^='ja'], [data-locale^='ko'])";
const localizedBaseCss = isolateHomepageBaseStyles(cssSource)
  .replaceAll("html[lang='en']", "#lightvela-intl-home[data-locale^='en']")
  .replaceAll("#lightvela-intl-home[data-locale^='en']", editorialLocaleSelector);
const css = `${localizedBaseCss}\n${headerActionsLayerCss}\n${playTabsExpansionCss}\n${heroIntegrationLinkCss}\n${plainHeroEyebrowCss}\n${longLocaleDesktopHeadingCss}\n${footerRefreshCss}\n${voiceSectionRestoreCss}`;
const runtimeSource = inlineScripts.join("\n\n").replace(
  "var words = ['knowledge base', 'monitoring radar', 'reminder scheduler', 'business assistant', 'life concierge', 'work assistant'];",
  "var words = JSON.parse((el.closest('#lightvela-intl-home') || {}).dataset?.rotatorWords || '[]');\n    if (!words.length) words = ['knowledge base', 'monitoring radar', 'reminder scheduler', 'business assistant', 'life concierge', 'work assistant'];",
).replace(
  `        subs.forEach(function (btn, i) { btn.classList.toggle('on', i === active); });
        chats.forEach(function (chat, i) {`,
  `        subs.forEach(function (btn, i) {
          btn.classList.toggle('on', i === active);
          btn.setAttribute('aria-pressed', i === active ? 'true' : 'false');
        });
        chats.forEach(function (chat, i) {`,
).replace(
  `      subs.forEach(function (btn, i) {
        btn.addEventListener('mouseenter', function () {
          if (active === i) return;
          render(i, true);
        });
      });`,
  `      subs.forEach(function (btn, i) {
        function activate() {
          if (active === i) return;
          render(i, true);
        }
        function activateFromKeyboard(event) {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate();
        }
        btn.addEventListener('mouseenter', activate);
        btn.addEventListener('click', activate);
        btn.addEventListener('keydown', activateFromKeyboard);
      });`,
);
if (
  !runtimeSource.includes("btn.setAttribute('aria-pressed', i === active ? 'true' : 'false');")
  || !runtimeSource.includes("btn.addEventListener('click', activate);")
  || !runtimeSource.includes("btn.addEventListener('keydown', activateFromKeyboard);")
) {
  throw new Error("Unable to add accessible activation to homepage scene buttons");
}
const playHoverRuntime = `
(function () {
  document.querySelectorAll('.plays__tabs label[for]').forEach(function (label) {
    label.addEventListener('mouseenter', function () {
      var input = document.getElementById(label.htmlFor);
      if (input && !input.checked) input.click();
    });
  });
})();
`;
const runtime = `/* Generated from the approved international homepage motion. */\n${runtimeSource}\n${playHoverRuntime}\n`;
const heroChatCopies = JSON.stringify(heroLiveCopyByLocale);
const heroChat = (await readFile(path.join(sourceRoot, "assets/hero-chat.js"), "utf8"))
  .replace(
    "var isEnglish = document.documentElement.lang === 'en';\n  var replyText = isEnglish\n    ? 'Your AI companion is waiting for you here.'\n    : '你的智能体伙伴在这里等你哦。';\n  var linkText = isEnglish ? 'Meet your companion' : '去看看你的智能体伙伴';",
    `var root = document.getElementById('lightvela-intl-home');\n  var locale = root && root.dataset.locale ? root.dataset.locale : document.documentElement.lang;\n  var copies = ${heroChatCopies};\n  var copy = copies[locale] || copies['en-US'];\n  var replyText = copy.replyText;\n  var linkText = copy.linkText;`,
  )
  .replace("var linkText = copy.linkText;", "var linkText = copy.linkText;\n  var pricingText = copy.pricingText;\n  var pricingHref = copy.pricingHref || '/subscribe';")
  .replaceAll("isEnglish ? 'You' : '我'", "copy.you")
  .replaceAll("isEnglish ? 'just now' : '刚刚'", "copy.justNow")
  .replaceAll(
    "link.textContent = linkText;\n      box.appendChild(link);",
    "link.textContent = linkText;\n      box.appendChild(link);\n      var pricingLink = document.createElement('a');\n      pricingLink.className = 'hero-live-link hero-live-link--secondary';\n      pricingLink.href = pricingHref;\n      pricingLink.textContent = pricingText;\n      box.appendChild(pricingLink);",
  )
  .replaceAll(
    "link.textContent = linkText;\n      body.appendChild(link);",
    "link.textContent = linkText;\n      body.appendChild(link);\n      var pricingLink = document.createElement('a');\n      pricingLink.className = 'hero-live-link hero-live-link--secondary';\n      pricingLink.href = pricingHref;\n      pricingLink.textContent = pricingText;\n      body.appendChild(pricingLink);",
  )
  .replaceAll("#get-started", "/agents")
  .replace(
    `function replayPanel(panel) {
    replayRun += 1;
    clearReplayTimers();
    activeReplayPanel = null;
    replayPending = false;
    if (!panel) return;

    var messages = Array.prototype.slice.call(
      panel.querySelectorAll('.bub, .dc__msg')
    );
    messages.forEach(function (message) {
      message.classList.remove('is-typing');
      message.classList.add('is-in');
      revealCopies(message);
      message.classList.add('is-done');
    });
    scrollToBottom(panel);
  }`,
    `function replayPanel(panel) {
    var run = ++replayRun;
    clearReplayTimers();
    activeReplayPanel = null;
    replayPending = false;
    if (!panel) return;

    var messages = Array.prototype.slice.call(
      panel.querySelectorAll('.bub, .dc__msg')
    );
    if (reduceMotion) {
      messages.forEach(function (message) {
        message.classList.remove('is-typing');
        message.classList.add('is-in', 'is-done');
        revealCopies(message);
      });
      scrollToBottom(panel);
      return;
    }

    messages.forEach(function (message) {
      message.classList.remove('is-in', 'is-done', 'is-typing');
      getCopies(message).forEach(function (copy) {
        originalHtml(copy);
        copy.innerHTML = '';
      });
    });

    activeReplayPanel = panel;
    replayPending = true;

    function showMessage(index) {
      if (run !== replayRun || index >= messages.length) {
        if (run === replayRun) {
          activeReplayPanel = null;
          replayPending = false;
        }
        return;
      }

      var message = messages[index];
      message.classList.add('is-in');
      scrollToBottom(panel);

      if (!isLightVelaMessage(message)) {
        revealCopies(message);
        message.classList.add('is-done');
        schedule(function () { showMessage(index + 1); }, Math.max(180, MSG_GAP - 140));
        return;
      }

      message.classList.add('is-typing');
      schedule(function () {
        if (run !== replayRun) return;
        var copies = getCopies(message);
        var copyIndex = 0;

        function nextCopy() {
          if (run !== replayRun) return;
          if (copyIndex >= copies.length) {
            message.classList.remove('is-typing');
            message.classList.add('is-done');
            scrollToBottom(panel);
            schedule(function () { showMessage(index + 1); }, MSG_GAP);
            return;
          }
          typeCopy(copies[copyIndex], run, function () {
            copyIndex += 1;
            scrollToBottom(panel);
            nextCopy();
          });
        }

        nextCopy();
      }, 180);
    }

    schedule(function () { showMessage(0); }, 80);
  }`,
  );

await writeFile(path.join(targetRoot, "style.css"), cleanGeneratedText(css));
await writeFile(path.join(targetRoot, "runtime.js"), cleanGeneratedText(runtime));
await writeFile(path.join(targetRoot, "hero-chat.js"), cleanGeneratedText(heroChat));
await copyFile(path.join(sourceRoot, "assets/scene-wheel.js"), path.join(targetRoot, "scene-wheel.js"));

await initializeInternationalHomeFragmentAccessibility(targetRoot);
const voiceAvatarSummary = await optimizeInternationalHomeVoiceAvatars(targetRoot);

console.log(
  `Imported ${assetPaths.size} assets into ${targetRoot}; optimized ${voiceAvatarSummary.avatars} voice avatars (${voiceAvatarSummary.sourceBytes} -> ${voiceAvatarSummary.optimizedBytes} bytes)`,
);

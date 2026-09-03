import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error("Usage: node scripts/generate-international-card-images.mjs <approved-static-homepage-root>");
}

const sourceRoot = path.resolve(sourceArgument);
const outDir = path.join(sourceRoot, "assets");
const textlessPreview = process.argv.includes("--textless-preview");

const locales = {
  en: {
    apps: {
      header: "Everyone can @ LightVela",
      channels: [
        ["WhatsApp", "Mom", "Can you remind us Friday?"],
        ["Telegram", "Alex", "Summarize this thread."],
        ["Discord", "Mira", "What should I do next?"],
        ["Slack", "Lin", "Turn this into tasks."],
      ],
      reply: "I read the context and answer where you already talk.",
    },
    folder: {
      inputs: ["PDF", "Word", "Markdown", "Links / Web", "Images / Sheets"],
      docs: ["Project files", "Study notes", "Ideas"],
      header: "Drop in what you know",
      memory: "Private work memory",
      rules: ["Your files", "Your rules", "Your style"],
    },
    hub: {
      header: "Cloud companion stays on",
      center: "Always on",
      nodes: ["Daily tasks", "Email brief", "Meeting notes", "Travel plans"],
      rule: "New rule saved",
    },
  },
  "zh-Hans": {
    apps: {
      header: "大家都能 @ LightVela",
      channels: [
        ["WhatsApp", "妈妈", "周五记得提醒我们"],
        ["Telegram", "阿哲", "帮我总结这串讨论"],
        ["Discord", "Mira", "下一步该做什么？"],
        ["Slack", "小林", "把这些整理成任务"],
      ],
      reply: "我会读上下文，在你常用的对话里回复。",
    },
    folder: {
      inputs: ["PDF", "Word", "Markdown", "链接 / 网页", "图片 / 表格"],
      docs: ["项目资料", "学习笔记", "灵感收集"],
      header: "把资料交给我",
      memory: "私有工作记忆",
      rules: ["你的文件", "你的规则", "你的口吻"],
    },
    hub: {
      header: "云端伙伴持续在线",
      center: "常驻云端",
      nodes: ["每日待办", "邮件摘要", "会议记录", "旅行计划"],
      rule: "新规则已记住",
    },
  },
  "zh-Hant": {
    apps: {
      header: "大家都能 @ LightVela",
      channels: [
        ["WhatsApp", "媽媽", "週五記得提醒我們"],
        ["Telegram", "阿哲", "幫我總結這串討論"],
        ["Discord", "Mira", "下一步該做什麼？"],
        ["Slack", "小林", "把這些整理成任務"],
      ],
      reply: "我會讀上下文，在你常用的對話裡回覆。",
    },
    folder: {
      inputs: ["PDF", "Word", "Markdown", "連結 / 網頁", "圖片 / 表格"],
      docs: ["項目資料", "學習筆記", "靈感收集"],
      header: "把資料交給我",
      memory: "私有工作記憶",
      rules: ["你的文件", "你的規則", "你的口吻"],
    },
    hub: {
      header: "雲端夥伴持續在線",
      center: "常駐雲端",
      nodes: ["每日待辦", "郵件摘要", "會議記錄", "旅行計劃"],
      rule: "新規則已記住",
    },
  },
  id: {
    apps: {
      header: "Semua bisa @ LightVela",
      channels: [
        ["WhatsApp", "Ibu", "Ingatkan kami Jumat."],
        ["Telegram", "Alex", "Ringkas utas ini."],
        ["Discord", "Mira", "Apa langkah berikutnya?"],
        ["Slack", "Lin", "Ubah ini jadi tugas."],
      ],
      reply: "Saya membaca konteks dan menjawab di tempat Anda biasa bicara.",
    },
    folder: {
      inputs: ["PDF", "Word", "Markdown", "Link / Web", "Gambar / Tabel"],
      docs: ["Materi proyek", "Catatan belajar", "Koleksi ide"],
      header: "Serahkan bahan Anda",
      memory: "Memori kerja privat",
      rules: ["File Anda", "Aturan Anda", "Gaya Anda"],
    },
    hub: {
      header: "Pendamping cloud tetap aktif",
      center: "Selalu aktif",
      nodes: ["Tugas harian", "Ringkasan email", "Catatan rapat", "Rencana pergi"],
      rule: "Aturan baru tersimpan",
    },
  },
  es: {
    apps: {
      header: "Todos pueden @ LightVela",
      channels: [
        ["WhatsApp", "Mamá", "Recuérdanos el viernes."],
        ["Telegram", "Alex", "Resume este hilo."],
        ["Discord", "Mira", "¿Cuál es el siguiente paso?"],
        ["Slack", "Lin", "Convierte esto en tareas."],
      ],
      reply: "Leo el contexto y respondo donde ya conversan.",
    },
    folder: {
      inputs: ["PDF", "Word", "Markdown", "Enlaces / Web", "Imágenes / Tablas"],
      docs: ["Materiales", "Notas de estudio", "Ideas guardadas"],
      header: "Entrégame tus materiales",
      memory: "Memoria privada de trabajo",
      rules: ["Tus archivos", "Tus reglas", "Tu estilo"],
    },
    hub: {
      header: "Compañero cloud siempre activo",
      center: "Siempre activo",
      nodes: ["Tareas diarias", "Resumen email", "Notas de reunión", "Plan de viaje"],
      rule: "Nueva regla guardada",
    },
  },
};

const filesByLocale = {
  en: ["wcard-apps-en.png", "wcard-folder-en.png", "wcard-hub-v3-en.png"],
  "zh-Hans": ["wcard-apps-zh-Hans.png", "wcard-folder-zh-Hans.png", "wcard-hub-v3-zh-Hans.png"],
  "zh-Hant": ["wcard-apps-zh-Hant.png", "wcard-folder-zh-Hant.png", "wcard-hub-v3-zh-Hant.png"],
  id: ["wcard-apps-id.png", "wcard-folder-id.png", "wcard-hub-v3-id.png"],
  es: ["wcard-apps-es.png", "wcard-folder-es.png", "wcard-hub-v3-es.png"],
};

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function text(value, x, y, size, weight = 700, color = "#252437", anchor = "start") {
  if (textlessPreview) return "";
  return `<text x="${x}" y="${y}" font-family="Inter, Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(value)}</text>`;
}

function softLines(x, y, widths) {
  return widths.map((width, index) => `<rect x="${x}" y="${y + index * 22}" width="${width}" height="10" rx="5" fill="#ecebf5"/>`).join("");
}

function folderSvg(copy) {
  const iconColors = ["#f05d5e", "#4b7df1", "#252437", "#566eff", "#72c776"];
  const inputCards = copy.folder.inputs
    .map((label, index) => {
      const y = 88 + index * 70;
      const icon = index === 0 ? "PDF" : index === 1 ? "W" : index === 2 ? "M" : index === 3 ? "↗" : "▣";
      const fontSize = label.length > 13 ? 22 : 26;
      return `
        <g filter="url(#cardShadow)">
          <rect x="94" y="${y}" width="266" height="52" rx="13" fill="#ffffff"/>
        </g>
        <rect x="118" y="${y + 15}" width="24" height="24" rx="7" fill="${iconColors[index]}" opacity=".16"/>
        ${text(icon, 130, y + 33, 13, 800, iconColors[index], "middle")}
        ${text(label, 158, y + 34, fontSize, 700)}
      `;
    })
    .join("");

  const docCards = copy.folder.docs
    .map((label, index) => {
      const y = 74 + index * 70;
      const x = 574 + index * 24;
      const width = index === 0 ? 300 : 286;
      const bulletColor = index === 0 ? "#7660f5" : index === 1 ? "#b9b35b" : "#e2a35a";
      const fontSize = label.length > 15 ? 20 : 24;
      return `
        <g filter="url(#docShadow)">
          <rect x="${x}" y="${y}" width="${width}" height="90" rx="16" fill="#ffffff"/>
        </g>
        <circle cx="${x + 34}" cy="${y + 34}" r="6" fill="${bulletColor}"/>
        ${text(label, x + 54, y + 42, fontSize, 700)}
        <rect x="${x + 54}" y="${y + 58}" width="154" height="10" rx="5" fill="#ecebf5"/>
        <rect x="${x + 54}" y="${y + 76}" width="106" height="10" rx="5" fill="#f1f0f8"/>
      `;
    })
    .join("");

  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="52%" cy="50%" r="72%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="1" stop-color="#f6f6f8"/>
        </radialGradient>
        <filter id="cardShadow" x="50" y="50" width="360" height="420" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#8180b8" flood-opacity=".12"/>
        </filter>
        <filter id="docShadow" x="520" y="50" width="410" height="330" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#716cf0" flood-opacity=".11"/>
        </filter>
        <linearGradient id="folderGrad" x1="508" x2="812" y1="292" y2="508" gradientUnits="userSpaceOnUse">
          <stop stop-color="#aeb4ff"/>
          <stop offset="1" stop-color="#7477ee"/>
        </linearGradient>
        <filter id="folderShadow" x="430" y="230" width="440" height="300" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#6c6bf3" flood-opacity=".16"/>
        </filter>
      </defs>
      <rect width="980" height="540" fill="url(#bg)"/>
      ${inputCards}
      <path d="M398 270h54" stroke="#9da0ff" stroke-width="7" stroke-linecap="round"/>
      <path d="M468 270l-24-18v36l24-18z" fill="#9da0ff"/>
      ${docCards}
      <g filter="url(#folderShadow)">
        <path d="M500 350c0-26 21-47 47-47h80c15 0 28 7 37 19l18 25h112c25 0 44 20 44 44v44c0 27-22 49-49 49H558c-32 0-58-26-58-58V350z" fill="url(#folderGrad)"/>
        <path d="M500 387h136c18 0 34 11 41 28l9 21h152v1c0 26-22 47-49 47H558c-32 0-58-26-58-58V387z" fill="#8c8ff8"/>
        <path d="M670 402l13 26 28 4-21 20 5 28-25-13-25 13 5-28-21-20 29-4 12-26z" fill="white" opacity=".94"/>
      </g>
      <path d="M802 48l12 25 27 4-20 19 5 27-24-13-24 13 5-27-20-19 27-4 12-25z" fill="#8978ff" opacity=".7"/>
    </svg>
  `;
}

function hubCard(label, x, y, icon, lineWidths) {
  const titleX = x + 76;
  const iconX = x + 26;
  const fontSize = label.length > 15 ? 18 : 21;
  return `
    <g filter="url(#hubShadow)">
      <rect x="${x}" y="${y}" width="286" height="118" rx="22" fill="#ffffff"/>
    </g>
    <rect x="${iconX}" y="${y + 28}" width="36" height="36" rx="10" fill="url(#iconGrad)"/>
    ${icon}
    ${text(label, titleX, y + 53, fontSize, 800)}
    ${softLines(titleX, y + 74, lineWidths)}
  `;
}

function hubSvg(copy) {
  const labels = copy.hub;
  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="52%" r="70%">
          <stop offset="0" stop-color="#f4f3ff"/>
          <stop offset=".58" stop-color="#ffffff"/>
          <stop offset="1" stop-color="#f7f7fa"/>
        </radialGradient>
        <linearGradient id="iconGrad" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="#bec3ff"/>
          <stop offset="1" stop-color="#756df0"/>
        </linearGradient>
        <filter id="hubShadow" x="0" y="0" width="360" height="190" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#7c7fb9" flood-opacity=".14"/>
        </filter>
        <filter id="circleShadow" x="360" y="140" width="260" height="260" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#7d7aef" flood-opacity=".18"/>
        </filter>
      </defs>
      <rect width="980" height="540" fill="url(#bg)"/>
      <g opacity=".52" stroke="#c4c1ff" stroke-width="3" stroke-linecap="round">
        <path d="M420 250L314 174"/>
        <path d="M560 250L666 174"/>
        <path d="M420 292L318 366"/>
        <path d="M560 292L662 366"/>
      </g>
      ${hubCard(labels[0], 110, 84, '<path d="M145 123h26M153 114v18M181 114v18M139 136h46M147 154l12 12 26-30" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>', [150, 116])}
      ${hubCard(labels[1], 584, 84, '<path d="M618 126l19 16 19-16M612 118h50v36h-50z" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>', [150, 122])}
      ${hubCard(labels[2], 112, 336, '<rect x="146" y="368" width="34" height="24" rx="5" fill="white"/><path d="M180 374l20-10v36l-20-10z" fill="white"/>', [162, 126])}
      ${hubCard(labels[3], 584, 336, '<path d="M620 390l48-18-18 48-12-20-24 22-11-11 22-24-20-12z" fill="white"/>', [156, 116])}
      <g filter="url(#circleShadow)">
        <circle cx="490" cy="270" r="84" fill="#ffffff"/>
        <circle cx="490" cy="270" r="68" fill="#f3f1ff" stroke="#e3e0ff" stroke-width="2"/>
        ${text("7×24H", 490, 284, 40, 800, "#9189f6", "middle")}
      </g>
    </svg>
  `;
}

function workspacePartnerSvg() {
  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="45%" r="75%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".72" stop-color="#fafaff"/>
          <stop offset="1" stop-color="#f4f4f7"/>
        </radialGradient>
        <linearGradient id="tray" x1="420" y1="244" x2="792" y2="492" gradientUnits="userSpaceOnUse">
          <stop stop-color="#b7c1ff"/>
          <stop offset=".56" stop-color="#8986f6"/>
          <stop offset="1" stop-color="#6f70de"/>
        </linearGradient>
        <linearGradient id="mint" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#b9f5da"/>
          <stop offset="1" stop-color="#5bcfa6"/>
        </linearGradient>
        <linearGradient id="coral" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#ffd7c2"/>
          <stop offset="1" stop-color="#ff9a7d"/>
        </linearGradient>
        <filter id="softShadow" x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#7473a5" flood-opacity=".14"/>
        </filter>
        <filter id="trayShadow" x="350" y="204" width="520" height="330" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="26" stdDeviation="28" flood-color="#6d6bf1" flood-opacity=".20"/>
        </filter>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="16" result="blur"/>
          <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.47 0 0 0 0 0.42 0 0 0 0 1 0 0 0 .35 0"/>
          <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect width="980" height="540" rx="32" fill="url(#bg)"/>
      <g opacity=".55">
        <path d="M96 418C202 378 250 454 350 400C447 348 447 232 540 206C610 186 666 225 732 184C774 158 790 116 842 104" stroke="#e6e3ff" stroke-width="2"/>
        <path d="M128 100C250 156 284 68 390 120C504 175 496 262 608 283C710 302 760 244 876 290" stroke="#dff5ef" stroke-width="2"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="86" y="94" width="116" height="150" rx="24" fill="#ffffff"/>
        <rect x="116" y="120" width="40" height="50" rx="8" fill="#fff2f2"/>
        <path d="M126 134h20M126 149h24M126 164h15" stroke="#ff8b8b" stroke-width="5" stroke-linecap="round"/>
        <path d="M116 194h56M116 216h38" stroke="#c8c6d8" stroke-width="9" stroke-linecap="round"/>
        <rect x="118" y="200" width="40" height="14" rx="7" fill="url(#coral)"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="246" y="70" width="136" height="96" rx="22" fill="#ffffff"/>
        <rect x="276" y="98" width="76" height="40" rx="10" fill="#eef1ff"/>
        <path d="M292 126l16-19 14 15 8-9 12 13" stroke="#8791ff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="294" cy="112" r="5" fill="#7d72ff"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="104" y="296" width="148" height="104" rx="24" fill="#ffffff"/>
        <circle cx="145" cy="348" r="23" fill="url(#mint)"/>
        <path d="M134 348h22M145 337v22" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
        <path d="M186 328h30M186 352h42M186 376h24" stroke="#c8c6d8" stroke-width="9" stroke-linecap="round"/>
        <path d="M124 386l16-16 13 11 20-24" stroke="#60c9a4" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="274" y="242" width="112" height="128" rx="24" fill="#ffffff"/>
        <rect x="308" y="274" width="44" height="44" rx="14" fill="#f2ecff"/>
        <path d="M318 302l12-16 14 20" stroke="#8478ff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M310 338h48M310 360h34" stroke="#c8c6d8" stroke-width="9" stroke-linecap="round"/>
        <rect x="306" y="252" width="14" height="14" rx="4" fill="#ffad8f"/>
        <rect x="326" y="252" width="14" height="14" rx="4" fill="#8d85f6"/>
        <rect x="346" y="252" width="14" height="14" rx="4" fill="#70d0ad"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="570" y="74" width="238" height="82" rx="18" fill="#ffffff"/>
        <circle cx="604" cy="112" r="7" fill="#7465f3"/>
        <path d="M628 104h92M628 128h132" stroke="#c8c6d8" stroke-width="9" stroke-linecap="round"/>
        <path d="M744 94l16 16 32-34" stroke="#7e77f6" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="602" y="176" width="246" height="86" rx="18" fill="#ffffff"/>
        <circle cx="637" cy="214" r="7" fill="#c0b95d"/>
        <path d="M660 204h116M660 230h82" stroke="#c8c6d8" stroke-width="9" stroke-linecap="round"/>
        <rect x="780" y="196" width="34" height="34" rx="9" fill="#eefbf6"/>
        <path d="M789 213h16M797 205v16" stroke="#66c9a8" stroke-width="5" stroke-linecap="round"/>
      </g>
      <g filter="url(#softShadow)">
        <rect x="628" y="284" width="220" height="92" rx="18" fill="#ffffff"/>
        <circle cx="663" cy="324" r="7" fill="#e2a35a"/>
        <path d="M686 314h104M686 340h70" stroke="#c8c6d8" stroke-width="9" stroke-linecap="round"/>
        <path d="M800 344c20-32 36-52 62-74" stroke="#ffad8f" stroke-width="7" stroke-linecap="round"/>
      </g>
      <g opacity=".72" stroke-linecap="round">
        <path d="M398 270C452 270 470 246 522 232" stroke="#a19cff" stroke-width="7"/>
        <path d="M518 232l-20-14 5 31 15-17z" fill="#a19cff"/>
        <path d="M386 318C444 334 474 328 522 312" stroke="#7fd7bd" stroke-width="6"/>
        <path d="M520 312l-24-8 12 28 12-20z" fill="#7fd7bd"/>
      </g>
      <g filter="url(#trayShadow)">
        <path d="M442 282c0-26 21-47 47-47h92c15 0 29 7 38 20l20 28h140c28 0 51 23 51 51v60c0 38-31 69-69 69H520c-43 0-78-35-78-78V282z" fill="url(#tray)"/>
        <path d="M442 344h160c22 0 42 13 50 34l12 29h166v2c0 30-25 54-56 54H520c-43 0-78-35-78-78V344z" fill="#8083f2" opacity=".96"/>
        <path d="M510 236c31-47 82-72 141-66 50 5 91 34 117 78" stroke="#eff0ff" stroke-width="17" stroke-linecap="round" opacity=".78"/>
        <path d="M666 177c12 22 17 43 16 72" stroke="#bfc3ff" stroke-width="8" stroke-linecap="round" opacity=".9"/>
        <path d="M637 386l16 33 36 5-26 25 6 36-32-17-32 17 6-36-26-25 36-5 16-33z" fill="white"/>
        <circle cx="548" cy="318" r="9" fill="#ffffff" opacity=".9"/>
        <circle cx="594" cy="318" r="9" fill="#ffffff" opacity=".72"/>
        <circle cx="640" cy="318" r="9" fill="#ffffff" opacity=".52"/>
      </g>
      <g filter="url(#glow)">
        <circle cx="688" cy="116" r="9" fill="#7d72ff"/>
        <circle cx="730" cy="143" r="6" fill="#55cca6"/>
        <circle cx="784" cy="94" r="5" fill="#ff9f80"/>
      </g>
    </svg>
  `;
}

function alwaysOnCloudSvg() {
  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="51%" cy="49%" r="72%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".62" stop-color="#fbfbff"/>
          <stop offset="1" stop-color="#f3f4f8"/>
        </radialGradient>
        <radialGradient id="core" cx="50%" cy="42%" r="64%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".54" stop-color="#f0efff"/>
          <stop offset="1" stop-color="#d9d9ff"/>
        </radialGradient>
        <linearGradient id="violet" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#bfc5ff"/>
          <stop offset="1" stop-color="#736cf0"/>
        </linearGradient>
        <linearGradient id="aqua" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#c5f5ee"/>
          <stop offset="1" stop-color="#6ad0c0"/>
        </linearGradient>
        <filter id="cardShadow" x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#7b7aa4" flood-opacity=".13"/>
        </filter>
        <filter id="coreShadow" x="300" y="98" width="380" height="380" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="22" stdDeviation="30" flood-color="#817df1" flood-opacity=".22"/>
        </filter>
      </defs>
      <rect width="980" height="540" rx="32" fill="url(#bg)"/>
      <g opacity=".62" stroke="#d9d6ff" stroke-width="4" stroke-linecap="round">
        <path d="M490 270C420 212 356 176 260 156"/>
        <path d="M490 270C584 204 641 164 760 148"/>
        <path d="M490 270C397 318 338 362 240 396"/>
        <path d="M490 270C596 316 652 368 768 394"/>
      </g>
      <g filter="url(#cardShadow)">
        <rect x="116" y="94" width="214" height="126" rx="26" fill="#ffffff"/>
        <rect x="148" y="126" width="42" height="42" rx="14" fill="url(#violet)"/>
        <path d="M160 147h18M169 138v18M202 134h72M202 160h86M202 184h56" stroke="#c7c5d9" stroke-width="9" stroke-linecap="round"/>
        <path d="M153 184l14 14 28-36" stroke="#8179f7" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="292" cy="124" r="9" fill="#ff8e7f"/>
      </g>
      <g filter="url(#cardShadow)">
        <rect x="650" y="88" width="216" height="132" rx="26" fill="#ffffff"/>
        <rect x="684" y="124" width="44" height="36" rx="12" fill="url(#violet)"/>
        <path d="M692 133l14 13 15-13" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M746 132h74M746 158h90M746 184h66" stroke="#c7c5d9" stroke-width="9" stroke-linecap="round"/>
        <path d="M814 112c18 0 32 14 32 32" stroke="#8e86f7" stroke-width="6" stroke-linecap="round"/>
      </g>
      <g filter="url(#cardShadow)">
        <rect x="104" y="318" width="236" height="124" rx="26" fill="#ffffff"/>
        <rect x="140" y="354" width="54" height="36" rx="12" fill="#eef7f4"/>
        <path d="M140 390h54M206 352h76M206 378h92M206 404h60" stroke="#c7c5d9" stroke-width="9" stroke-linecap="round"/>
        <path d="M152 372c18-22 36-22 54 0" stroke="url(#aqua)" stroke-width="8" stroke-linecap="round"/>
        <circle cx="306" cy="356" r="8" fill="#6ad0c0"/>
      </g>
      <g filter="url(#cardShadow)">
        <rect x="648" y="318" width="232" height="126" rx="26" fill="#ffffff"/>
        <path d="M694 386l78-42-29 86-19-35-40 36-15-16 40-35-38-17z" fill="url(#violet)"/>
        <path d="M774 354h58M774 382h72M774 410h48" stroke="#c7c5d9" stroke-width="9" stroke-linecap="round"/>
        <path d="M820 410l22-28 18 12" stroke="#ffad8f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <g filter="url(#cardShadow)">
        <rect x="376" y="82" width="226" height="74" rx="24" fill="#ffffff"/>
        <circle cx="418" cy="119" r="18" fill="#f3f2ff"/>
        <path d="M409 120h18M418 111v18" stroke="#8f86f7" stroke-width="6" stroke-linecap="round"/>
        <path d="M456 108h78M456 132h104" stroke="#c7c5d9" stroke-width="8" stroke-linecap="round"/>
      </g>
      <g filter="url(#cardShadow)">
        <rect x="388" y="392" width="206" height="70" rx="24" fill="#ffffff"/>
        <path d="M430 426h42M491 426h42M552 426h14" stroke="#c7c5d9" stroke-width="9" stroke-linecap="round"/>
        <path d="M420 438c20-22 37-42 61-28 20 12 34-6 50-22" stroke="#8f86f7" stroke-width="6" stroke-linecap="round"/>
      </g>
      <g filter="url(#coreShadow)">
        <circle cx="490" cy="270" r="112" fill="#ffffff"/>
        <circle cx="490" cy="270" r="88" fill="url(#core)" stroke="#eceaff" stroke-width="3"/>
        <path d="M430 274c20-44 42-62 72-62 40 0 68 31 68 70 0 37-30 68-68 68h-70c-30 0-54-22-54-50 0-26 20-48 52-48" fill="#ffffff" stroke="#8f86f7" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M456 286l23 23 50-62" stroke="#69cdb2" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M456 216a70 70 0 0 1 92 0" stroke="#b3afff" stroke-width="8" stroke-linecap="round"/>
        <circle cx="552" cy="226" r="10" fill="#ff9f80"/>
        <circle cx="490" cy="270" r="128" stroke="#f2f1ff" stroke-width="8"/>
      </g>
      <g>
        <circle cx="370" cy="192" r="11" fill="#8b83f7"/>
        <circle cx="616" cy="184" r="11" fill="#8b83f7"/>
        <circle cx="360" cy="348" r="11" fill="#6ad0c0"/>
        <circle cx="624" cy="354" r="11" fill="#ff9f80"/>
      </g>
      <g opacity=".55">
        <path d="M374 116c86-46 158-46 236 2" stroke="#ebe9ff" stroke-width="3" stroke-linecap="round"/>
        <path d="M382 424c80 40 160 40 220 0" stroke="#e5f6f1" stroke-width="3" stroke-linecap="round"/>
      </g>
    </svg>
  `;
}

function multiText(values, x, y, size, weight = 700, color = "#252437", gap = 28, anchor = "start") {
  if (textlessPreview) return "";
  return values.map((value, index) => text(value, x, y + index * gap, size, weight, color, anchor)).join("");
}

function channelCard(channel, x, y, accent, icon) {
  const [platform, person, message] = channel;
  const messageSize = message.length > 27 ? 17 : 19;
  return `
    <g filter="url(#softShadow)">
      <rect x="${x}" y="${y}" width="332" height="118" rx="26" fill="#ffffff" opacity=".92"/>
      <circle cx="${x + 42}" cy="${y + 42}" r="23" fill="${accent}"/>
      ${icon(x + 42, y + 42)}
      ${text(platform, x + 80, y + 39, 20, 800)}
      ${text(person, x + 80, y + 68, 15, 700, "#8f8d9b")}
      ${text(message, x + 80, y + 94, messageSize, 650)}
    </g>
  `;
}

function appsSvg(copy) {
  const icons = [
    (cx, cy) => `<path d="M${cx - 10} ${cy + 12}l3-12a18 18 0 1 1 7 7l-12 3z" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M${cx - 7} ${cy - 4}c6 8 10 10 18 12" stroke="#fff" stroke-width="4" stroke-linecap="round"/>`,
    (cx, cy) => `<path d="M${cx - 18} ${cy + 2}l38-17-12 36-10-13-14 12-8-8 15-10z" fill="#fff"/>`,
    (cx, cy) => `<path d="M${cx - 17} ${cy + 10}c4-18 30-18 34 0M${cx - 20} ${cy + 1}v12c0 5 4 8 9 8h22c5 0 9-3 9-8V${cy + 1}" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="${cx - 7}" cy="${cy + 1}" r="3" fill="#fff"/><circle cx="${cx + 7}" cy="${cy + 1}" r="3" fill="#fff"/>`,
    (cx, cy) => `<path d="M${cx - 15} ${cy - 18}l9 36M${cx + 8} ${cy - 18}l9 36M${cx - 20} ${cy - 7}h40M${cx - 22} ${cy + 9}h40" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`,
  ];
  const colors = ["#18c466", "#28a8f2", "#6d86dd", "#f05b9b"];
  const cards = copy.apps.channels.map((channel, index) => {
    const positions = [
      [74, 104],
      [574, 104],
      [74, 310],
      [574, 310],
    ];
    return channelCard(channel, positions[index][0], positions[index][1], colors[index], icons[index]);
  }).join("");
  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="50%" r="74%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".72" stop-color="#fbfbff"/>
          <stop offset="1" stop-color="#f3f3f6"/>
        </radialGradient>
        <linearGradient id="replyGrad" x1="378" y1="192" x2="632" y2="348" gradientUnits="userSpaceOnUse">
          <stop stop-color="#bfc5ff"/>
          <stop offset="1" stop-color="#7772ef"/>
        </linearGradient>
        <filter id="softShadow" x="-18%" y="-30%" width="140%" height="175%">
          <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#7b7896" flood-opacity=".13"/>
        </filter>
        <filter id="replyShadow" x="285" y="150" width="420" height="260" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="22" stdDeviation="24" flood-color="#736ff0" flood-opacity=".2"/>
        </filter>
      </defs>
      <rect width="980" height="540" rx="34" fill="url(#bg)"/>
      <g opacity=".6" stroke="#dfddff" stroke-width="3">
        <path d="M406 164C448 188 466 204 490 246"/>
        <path d="M574 164C532 188 514 204 490 246"/>
        <path d="M404 370C448 342 468 326 490 294"/>
        <path d="M576 370C532 342 512 326 490 294"/>
      </g>
      ${multiText([copy.apps.header], 490, 58, 30, 800, "#252437", 28, "middle")}
      ${cards}
      <g filter="url(#replyShadow)">
        <rect x="326" y="214" width="328" height="126" rx="30" fill="url(#replyGrad)"/>
        <circle cx="382" cy="277" r="28" fill="rgba(255,255,255,.24)"/>
        <path d="M370 278c22-30 44-29 64 0" stroke="#fff" stroke-width="7" stroke-linecap="round"/>
        <path d="M454 258h122M454 286h88" stroke="#fff" stroke-width="11" stroke-linecap="round" opacity=".78"/>
        <path d="M598 246l12 26 28 4-20 19 5 28-25-14-25 14 5-28-20-19 28-4 12-26z" fill="#fff"/>
      </g>
      ${multiText([copy.apps.reply], 490, 488, copy.apps.reply.length > 58 ? 18 : 20, 650, "#6d6b78", 24, "middle")}
    </svg>
  `;
}

function memorySvg(copy) {
  const inputCards = copy.folder.inputs.map((label, index) => {
    const y = 118 + index * 62;
    const colors = ["#ff747b", "#5f85ff", "#6e7180", "#8b84ff", "#77d19a"];
    const fontSize = label.length > 15 ? 18 : 21;
    return `
      <g filter="url(#softShadow)">
        <rect x="78" y="${y}" width="240" height="48" rx="14" fill="#ffffff"/>
      </g>
      <rect x="104" y="${y + 14}" width="21" height="21" rx="6" fill="${colors[index]}" opacity=".18"/>
      ${text(label, 144, y + 33, fontSize, 800)}
    `;
  }).join("");
  const docCards = copy.folder.rules.map((label, index) => {
    const y = 94 + index * 86;
    const x = 574 + index * 22;
    const colors = ["#7465f3", "#62c9aa", "#ff9e73"];
    return `
      <g filter="url(#softShadow)">
        <rect x="${x}" y="${y}" width="286" height="70" rx="19" fill="#ffffff"/>
      </g>
      <circle cx="${x + 35}" cy="${y + 35}" r="8" fill="${colors[index]}"/>
      ${text(label, x + 58, y + 43, label.length > 14 ? 19 : 22, 800)}
      <path d="M${x + 172} ${y + 35}h62" stroke="#e8e6f2" stroke-width="9" stroke-linecap="round"/>
    `;
  }).join("");
  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="48%" r="75%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".72" stop-color="#fbfbff"/>
          <stop offset="1" stop-color="#f3f3f6"/>
        </radialGradient>
        <linearGradient id="folderGrad" x1="380" y1="236" x2="736" y2="500" gradientUnits="userSpaceOnUse">
          <stop stop-color="#b7c2ff"/>
          <stop offset=".52" stop-color="#8987f6"/>
          <stop offset="1" stop-color="#7474e8"/>
        </linearGradient>
        <filter id="softShadow" x="-18%" y="-28%" width="140%" height="170%">
          <feDropShadow dx="0" dy="17" stdDeviation="18" flood-color="#7b7896" flood-opacity=".13"/>
        </filter>
        <filter id="folderShadow" x="306" y="196" width="500" height="330" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="24" stdDeviation="26" flood-color="#716ff0" flood-opacity=".2"/>
        </filter>
      </defs>
      <rect width="980" height="540" rx="34" fill="url(#bg)"/>
      ${multiText([copy.folder.header], 490, 58, 30, 800, "#252437", 28, "middle")}
      ${inputCards}
      <path d="M352 270h78" stroke="#9b9cff" stroke-width="8" stroke-linecap="round"/>
      <path d="M450 270l-28-20v40l28-20z" fill="#9b9cff"/>
      ${docCards}
      <g filter="url(#folderShadow)">
        <path d="M390 298c0-30 24-54 54-54h98c17 0 33 8 43 22l24 32h146c31 0 57 25 57 57v54c0 39-32 71-71 71H476c-47 0-86-38-86-86v-96z" fill="url(#folderGrad)"/>
        <path d="M390 360h174c25 0 47 15 56 38l14 35h178c-10 28-37 47-71 47H476c-47 0-86-38-86-86v-34z" fill="#8185f1" opacity=".96"/>
        <path d="M588 390l15 31 34 5-25 24 6 34-30-16-30 16 6-34-25-24 34-5 15-31z" fill="#ffffff"/>
        ${multiText([copy.folder.memory], 594, 326, copy.folder.memory.length > 20 ? 22 : 27, 800, "#ffffff", 24, "middle")}
      </g>
    </svg>
  `;
}

function cloudRulesSvg(copy) {
  const positions = [
    [112, 122],
    [662, 122],
    [116, 346],
    [662, 346],
  ];
  const nodeCards = copy.hub.nodes.map((label, index) => {
    const [x, y] = positions[index];
    const color = index === 0 ? "#8278f8" : index === 1 ? "#6b80e9" : index === 2 ? "#68cbb0" : "#ff9f7d";
    const fontSize = label.length > 17 ? 18 : 21;
    return `
      <g filter="url(#softShadow)">
        <rect x="${x}" y="${y}" width="234" height="96" rx="24" fill="#ffffff"/>
      </g>
      <circle cx="${x + 40}" cy="${y + 48}" r="18" fill="${color}" opacity=".86"/>
      <path d="M${x + 66} ${y + 38}h94M${x + 66} ${y + 62}h128" stroke="#e4e2ef" stroke-width="9" stroke-linecap="round"/>
      ${text(label, x + 66, y + 32, fontSize, 800)}
    `;
  }).join("");
  return `
    <svg width="980" height="540" viewBox="0 0 980 540" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="50%" r="76%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".68" stop-color="#fbfbff"/>
          <stop offset="1" stop-color="#f3f4f8"/>
        </radialGradient>
        <radialGradient id="core" cx="50%" cy="42%" r="66%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".6" stop-color="#f0efff"/>
          <stop offset="1" stop-color="#dbdbff"/>
        </radialGradient>
        <filter id="softShadow" x="-20%" y="-32%" width="142%" height="178%">
          <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#79769f" flood-opacity=".13"/>
        </filter>
        <filter id="coreShadow" x="320" y="116" width="340" height="330" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#7f7af1" flood-opacity=".22"/>
        </filter>
      </defs>
      <rect width="980" height="540" rx="34" fill="url(#bg)"/>
      ${multiText([copy.hub.header], 490, 58, 30, 800, "#252437", 28, "middle")}
      <g opacity=".58" stroke="#d8d4ff" stroke-width="4" stroke-linecap="round">
        <path d="M490 270L346 170"/>
        <path d="M490 270L662 170"/>
        <path d="M490 270L350 392"/>
        <path d="M490 270L662 392"/>
      </g>
      ${nodeCards}
      <g filter="url(#coreShadow)">
        <circle cx="490" cy="270" r="104" fill="#ffffff"/>
        <circle cx="490" cy="270" r="80" fill="url(#core)" stroke="#eceaff" stroke-width="3"/>
        <path d="M438 276c17-37 37-53 64-53 38 0 64 28 64 64 0 34-28 62-64 62h-62c-29 0-52-21-52-48 0-25 19-45 50-45" fill="#ffffff" stroke="#8d85f6" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M456 292l22 22 48-58" stroke="#68cbb0" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
        ${multiText([copy.hub.center], 490, 288, copy.hub.center.length > 12 ? 20 : 24, 800, "#8b83f7", 24, "middle")}
      </g>
      <g filter="url(#softShadow)">
        <rect x="350" y="422" width="280" height="62" rx="22" fill="#ffffff"/>
        <circle cx="388" cy="453" r="14" fill="#68cbb0"/>
        <path d="M381 453l6 7 13-16" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        ${text(copy.hub.rule, 418, 461, copy.hub.rule.length > 20 ? 18 : 21, 800)}
      </g>
    </svg>
  `;
}

const renderQueue = textlessPreview
  ? [
      [
        "preview",
        {
          apps: {
            header: "",
            channels: [
              ["", "", ""],
              ["", "", ""],
              ["", "", ""],
              ["", "", ""],
            ],
            reply: "",
          },
          folder: {
            inputs: ["", "", "", "", ""],
            docs: ["", "", ""],
            header: "",
            memory: "",
            rules: ["", "", ""],
          },
          hub: {
            header: "",
            center: "",
            nodes: ["", "", "", ""],
            rule: "",
          },
        },
      ],
    ]
  : Object.entries(locales);
const outputFilesByLocale = textlessPreview
  ? { preview: ["wcard-apps-textless-preview.png", "wcard-folder-textless-preview.png", "wcard-hub-v3-textless-preview.png"] }
  : filesByLocale;

await mkdir(outDir, { recursive: true });

for (const [locale, copy] of renderQueue) {
  const [appsFile, folderFile, hubFile] = outputFilesByLocale[locale];
  await sharp(Buffer.from(appsSvg(copy))).png().toFile(path.join(outDir, appsFile));
  await sharp(Buffer.from(memorySvg(copy))).png().toFile(path.join(outDir, folderFile));
  await sharp(Buffer.from(cloudRulesSvg(copy))).png().toFile(path.join(outDir, hubFile));
  console.log(`generated ${appsFile}, ${folderFile}, ${hubFile}`);
}

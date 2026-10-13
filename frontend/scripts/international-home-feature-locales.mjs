// Editable, localized text for the Figma capability illustrations.
const DEFAULT_LOCALE = 'en-US';
const HOME_VISUAL_ASSET_VERSION = '20260930-home-visual-v1';
export const FEATURE_LOCALES = Object.freeze([DEFAULT_LOCALE, 'zh-CN', 'zh-SG', 'zh-Hant', 'id-ID', 'es', 'ja-JP', 'ko-KR']);
const SIMPLIFIED_CHINESE = 'zh-CN';
const SINGAPORE_CHINESE = 'zh-SG';
const TRADITIONAL_CHINESE = 'zh-Hant';
const CHINESE_LOCALES = new Set([SIMPLIFIED_CHINESE, SINGAPORE_CHINESE, TRADITIONAL_CHINESE]);
const STEP_ARTWORK = Object.freeze({ asset: 'figma-steps-user-original.webp', width: 676, height: 591, footY: 520 });
const copy = {
  'en-US': ['Confirm important actions first', 'Your approval comes before external actions.', 'Send this update?', 'Confirmed. Go ahead.', 'Every weekday at 9 AM', 'Your daily briefing is ready.', 'Remind me to drink water', 'Reminder scheduled.'],
  'zh-CN': ['重要动作先确认', '涉及发送、修改或其他外部操作时，先等你授权。', '彻底删除旧记忆和草稿文件。', '这会永久删除长期记忆和一个工作台文件。请回复「确认删除」继续；其他回复均不会执行。', '每个工作日早上 9 点', '今日简报已准备好。', '提醒我喝水', '提醒已设置。'],
  'zh-Hant': ['重要動作先確認', '涉及傳送、修改或其他外部操作時，先等你授權。', '可以傳送這則更新嗎？', '確認，傳送吧。', '每個工作日早上 9 點', '今日簡報已準備好。', '提醒我喝水', '提醒已設定。'],
  'id-ID': ['Konfirmasi tindakan penting', 'Tindakan eksternal menunggu persetujuan Anda.', 'Kirim pembaruan ini?', 'Ya, silakan kirim.', 'Setiap hari kerja pukul 09.00', 'Ringkasan harian Anda siap.', 'Ingatkan saya minum air', 'Pengingat dijadwalkan.'],
  es: ['Confirma las acciones importantes', 'Las acciones externas requieren tu autorización.', '¿Envío esta actualización?', 'Sí, adelante.', 'Cada día laborable a las 9:00', 'Tu resumen diario está listo.', 'Recuérdame beber agua', 'Recordatorio programado.'],
  'ja-JP': ['重要な操作は先に確認', '送信や変更などの外部操作は、承認を待ってから実行します。', 'この更新を送信しますか？', 'はい、送信してください。', '平日の午前9時に', '今日のまとめができました。', '水分補給を知らせて', 'リマインダーを設定しました。'],
  'ko-KR': ['중요한 작업은 먼저 확인', '전송이나 변경 등 외부 작업은 승인을 받은 뒤 실행합니다.', '이 업데이트를 보낼까요?', '네, 보내 주세요.', '평일마다 오전 9시에', '오늘의 요약이 준비됐어요.', '물 마시라고 알려 줘', '알림을 예약했어요.'],
};
copy[SINGAPORE_CHINESE] = copy[SIMPLIFIED_CHINESE];
// One concise sentence per card; the shared generator keeps both sites in sync.
const descriptions = {
  'zh-CN': ['在常用聊天软件里直接交办任务。', '即使你离开，任务也会继续完成。', '定时或按条件自动执行任务。', '在对话中创建、发布和修改网页。', '安装技能，让智能体能做更多事。', '记住你的偏好，越用越懂你。', '发送、修改等外部操作先征得你同意。'],
  'zh-Hant': ['在常用聊天軟體裡直接交辦任務。', '即使你離開，任務也會繼續完成。', '定時或按條件自動執行任務。', '在對話中建立、發布和修改網頁。', '安裝技能，讓智慧體能做更多事。', '記住你的偏好，越用越懂你。', '傳送、修改等外部操作先徵得你同意。'],
  'en-US': ['Assign tasks in the chat apps you use.', 'Work continues even when you step away.', 'Run tasks on a schedule or a trigger.', 'Create, publish, and edit web pages in chat.', 'Install skills to do more with your agent.', 'Your agent remembers how you like to work.', 'External actions wait for your approval.'],
  'id-ID': ['Berikan tugas lewat aplikasi chat Anda.', 'Tugas terus berjalan saat Anda pergi.', 'Jalankan tugas sesuai jadwal atau pemicu.', 'Buat, terbitkan, dan edit web lewat chat.', 'Pasang skill untuk menambah kemampuan agen.', 'Agen mengingat cara kerja pilihan Anda.', 'Tindakan eksternal menunggu izin Anda.'],
  es: ['Asigna tareas desde tus apps de chat.', 'El trabajo continúa aunque te ausentes.', 'Automatiza tareas por horario o condición.', 'Crea, publica y edita páginas desde el chat.', 'Instala habilidades para ampliar tu agente.', 'Tu agente recuerda cómo prefieres trabajar.', 'Las acciones externas requieren tu permiso.'],
  'ja-JP': ['いつものチャットからタスクを依頼。', '離れていてもタスクは進みます。', '時刻や条件に合わせてタスクを自動実行。', 'チャットでWebページを作成・公開・編集。', 'スキルを追加してできることを拡張。', '好みを覚えて、あなたに合った働き方へ。', '送信や変更などの外部操作は承認後に実行。'],
  'ko-KR': ['평소 쓰는 채팅 앱에서 작업을 맡기세요.', '자리를 비워도 작업은 계속됩니다.', '시간이나 조건에 맞춰 작업을 실행합니다.', '채팅으로 웹페이지를 만들고 게시·수정하세요.', '스킬을 설치해 에이전트의 기능을 넓히세요.', '선호하는 작업 방식을 기억합니다.', '외부 작업은 먼저 승인을 받습니다.'],
};
descriptions[SINGAPORE_CHINESE] = descriptions[SIMPLIFIED_CHINESE];
// Clockwise orbit coordinates, paired with their icons to avoid parallel-array drift.
const SKILL_ORBIT_ITEMS = [
  { icon: 'search', x: 0, y: -85 },
  { icon: 'pen', x: 75, y: -55 },
  { icon: 'globe', x: 95, y: 20 },
  { icon: 'file', x: 45, y: 80 },
  { icon: 'bolt', x: -45, y: 80 },
  { icon: 'book', x: -95, y: 20 },
  { icon: 'plug', x: -75, y: -55 },
];
const SKILL_ORBIT_STAGGER_SECONDS = 1.2;

// Format only generated decorative blocks, never page prose or script contents.
function formatFeatureMarkup(markup) {
  let depth = 0;
  return markup.split(/(?<=>)\s*(?=<)/).map((token) => {
    if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
    const line = `${'  '.repeat(depth)}${token}`;
    if (/^<[a-z]/i.test(token) && !/<\//.test(token) && !/\/\s*>$/.test(token)
      && !/^<(?:img|br|hr|input|meta|link)\b/i.test(token)) depth++;
    return line;
  }).join('\n');
}
export function localizeFeatureCards(html, locale) {
  for (const asset of ['scenes-mascot-duo.webp', STEP_ARTWORK.asset, 'hermes-black-companion.webp', 'hermes-door.webp']) {
    html = html.replaceAll(`/lightvela-intl-home/assets/${asset}`, `/lightvela-intl-home/assets/${asset}?v=${HOME_VISUAL_ASSET_VERSION}`)
      .replaceAll(`?v=${HOME_VISUAL_ASSET_VERSION}?v=${HOME_VISUAL_ASSET_VERSION}`, `?v=${HOME_VISUAL_ASSET_VERSION}`);
  }
  // Snapshot widths depend on the capture viewport/font. CSS owns the fallback;
  // feature-motion.js reserves the widest localized phrase at runtime.
  html = html.replace(/(<span class="hero__rotator-wrap"[^>]*\bstyle=")([^"]*)(")/g, (_match, before, style, after) => {
    const delay = style.match(/(?:^|;)\s*--rotator-delay\s*:\s*([^;]+)/)?.[1];
    return `${before}${delay ? `--rotator-delay: ${delay.trim()};` : ''}${after}`;
  });
  html = html.replace(/(?:\\n\s*)+$/, '\n');
  html = restoreFooterBoundary(html);
  // Retire the previous duo artwork, including imported snapshots.
  html = html.replace(/<span class="scenes__mascot"[^>]*><img[^>]*><\/span>/g, '');
  html = addFeatureMotion(html, locale);
  const words = copy[locale] ?? copy[DEFAULT_LOCALE];
  const bubbles = (items) => `<div class="feature-copy-preview">${items.map((text) => `<span>${text}</span>`).join('')}</div>`;
  const confirm = `<article class="wcard wcard--confirm"><div class="wcard__inner"><div class="wcard__demo">${bubbles(words.slice(2, 4))}</div><div class="wcard__body"><h4>${words[0]}</h4><p>${words[1]}</p></div></div></article>`;
  if (html.includes('wcard--confirm')) html = html.replace(/<article class="wcard wcard--confirm">[\s\S]*?<\/article>/, formatFeatureMarkup(confirm));
  else html = html.replace(/(<div class="wcard__demo wcard__demo--mem"[\s\S]*?<\/article>)/, `$1\n${formatFeatureMarkup(confirm)}`);
  html = html.replace(/<div class="feature-copy-preview feature-copy-preview--scheduled">[\s\S]*?<\/div>/g, '');
  html = html.replace(/<div class="feature-motion-tasks"[\s\S]*?<!-- \/feature-motion -->/g, '');
  const cases = [...html.matchAll(/<div class="aut__case aut__case--\d+">[\s\S]*?<\/div>/g)].map(([markup]) => markup.replaceAll('aut__', 'feature-task__').replace(/(<p class="feature-task__bubble feature-task__bubble--agent">)(?!<b>)/, '$1<b>LightVela</b>'));
  if (cases.length) html = html.replace(/(<div class="wcard__demo wcard__demo--auto"[^>]*>)/, `$1<div class="feature-motion-tasks" aria-hidden="true">${cases.join('')}</div><!-- /feature-motion -->`);
  let cardIndex = 0;
  const sentences = descriptions[locale] ?? descriptions[DEFAULT_LOCALE];
  html = html.replace(/<div class="wcard__body">([\s\S]*?)<\/div>/g, (match, body) => {
    const index = cardIndex++;
    const heading = index === 3 ? `<h4 class="wcard__workspace-title">${sentences[index]}</h4>` : (body.match(/<h4>[\s\S]*?<\/h4>/)?.[0] ?? '');
    const caption = index === 1 ? `<p>${sentences[index]}</p>` : '';
    return `<div class="wcard__body">${heading}${caption}</div>`;
  });
  const step = `<span class="home-step-mascot" aria-hidden="true" data-foot-y="${STEP_ARTWORK.footY}"><img src="/lightvela-intl-home/assets/${STEP_ARTWORK.asset}?v=${HOME_VISUAL_ASSET_VERSION}" alt="" width="${STEP_ARTWORK.width}" height="${STEP_ARTWORK.height}" loading="lazy"></span>`;
  const existingStep = /<span class="home-step-mascot"[^>]*>[\s\S]*?<\/span>/g;
  // This is the sole owner of the step artwork, for both fresh and legacy imports.
  if (existingStep.test(html)) return html.replace(existingStep, () => step);
  return html.replace(/<(?:ol|div)\b[^>]*\bclass="[^"]*\btrack\b[^"]*"[^>]*>/, (track) => step + track);
}

function addFeatureMotion(html, locale) {
  html = html.replace(/<div class="feature-motion-(?:chat|skills|wave|workspace)"[\s\S]*?<!-- \/feature-motion -->/g, '');
  const chinese = CHINESE_LOCALES.has(locale);
  const traditional = locale === TRADITIONAL_CHINESE;
  const international = [['whatsapp.svg', 'WhatsApp'], ['telegram.svg', 'Telegram'], ['discord.svg', 'Discord'], ['slack.svg', 'Slack']];
  const domestic = [['wechat.webp', chinese ? '微信' : 'WeChat'], ['qq.webp', 'QQ'], ['feishu.webp', chinese ? (traditional ? '飛書' : '飞书') : 'Feishu'], ['dingtalk.webp', chinese ? (traditional ? '釘釘' : '钉钉') : 'DingTalk']];
  const page = (channels) => `<div class="feature-motion-page">${channels.map(([asset, name]) => `<div class="feature-motion-channel"><img src="/lightvela-intl-home/assets/${asset}" alt="" width="28" height="28" loading="lazy"><span>${name}<small>17:25</small></span></div>`).join('')}</div>`;
  const chat = `<div class="feature-motion-chat" aria-hidden="true"><div class="feature-motion-pages">${page(international)}${page(domestic)}${page(international)}</div></div><!-- /feature-motion -->`;
  const skills = `<div class="feature-motion-skills" aria-hidden="true">${SKILL_ORBIT_ITEMS.map(({ icon, x, y }, index) => `<span class="feature-skill" style="--x:${x}px;--y:${y}px;--delay:-${index * SKILL_ORBIT_STAGGER_SECONDS}s"><svg class="icon"><use href="#i-${icon}"></use></svg></span>`).join('')}</div><!-- /feature-motion -->`;
  const workspace = '<div class="feature-motion-workspace" aria-hidden="true"><svg viewBox="0 0 320 100"><path d="M20 80 Q160 -15 300 80" fill="none" stroke="#ccc" stroke-width="2" stroke-dasharray="5 5"/><circle cx="20" cy="80" r="7" fill="#4825ff"/><circle cx="300" cy="80" r="7" fill="#00c875"/><g class="feature-workspace-arrow"><path d="M-10 -11 L12 0 L-10 11 L-5 0Z" fill="#111" stroke="white" stroke-width="2" stroke-linejoin="round"/></g></svg></div><!-- /feature-motion -->';
  const wave = '<div class="feature-motion-wave" aria-hidden="true"><img src="/lightvela-intl-home/assets/figma-feature-memory-wave.webp" alt="" loading="lazy"></div><!-- /feature-motion -->';
  for (const [demo, content] of [['chat', chat], ['skills', skills], ['mem', wave], ['workspace', workspace]]) {
    html = html.replace(new RegExp(`(<div class="wcard__demo wcard__demo--${demo}"[^>]*>)`), `$1${formatFeatureMarkup(content)}`);
  }
  return html;
}

export function restoreFooterBoundary(html) {
  html = html.replace(/<span class="home-footer-mascot"[\s\S]*?<\/span>/g, '');
  html = html.replace(/<div class="home-footer-boundary"[\s\S]*?<\/div>/g, '');
  const boundary = `<div class="home-footer-boundary"><svg viewBox="0 0 964 966" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><image href="/lightvela-intl-home/assets/hermes-door.webp?v=${HOME_VISUAL_ASSET_VERSION}" width="964" height="966" preserveAspectRatio="xMidYMid meet"/></svg></div>`;
  html = html.replace(/(<footer class="foot(?: foot--domestic)?">)/, `$1${boundary}`);
  // CTA text and href form a state-machine input; decoration must preserve both.
  return html;
}

// The animation owner also restores natural text at each line's final frame.
const heroHeadlineRuntime = String.raw`  (function () {
    var INITIAL = 100;
    var STEP = 30;
    var CHAR_DURATION = 500;
    var SEGMENT_GAP = 80;
    var shouldKeepNaturalText = window.matchMedia('(max-width: 640px), (prefers-reduced-motion: reduce)').matches;
    var restoreTimers = [];
    function naturalText(el) {
      return el.textContent.replace(/\u00a0/g, ' ');
    }
    function splitChars(el, startDelay) {
      var text = naturalText(el);
      el.textContent = '';
      for (var i = 0; i < text.length; i++) {
        var ch = document.createElement('span');
        ch.className = 'hero__char';
        ch.textContent = text[i] === ' ' ? '\u00a0' : text[i];
        ch.style.setProperty('--cd', (startDelay + i * STEP) + 'ms');
        el.appendChild(ch);
      }
      var endDelay = startDelay + Math.max(0, text.length - 1) * STEP + CHAR_DURATION;
      // Keep every character until the last entrance animation has finished.
      // This owner then restores ordinary spaces so later resizes wrap by word.
      restoreTimers.push(window.setTimeout(function () { el.textContent = text; }, endDelay));
      return endDelay;
    }
    var main = document.querySelector('.hero__line--main');
    var prefix = document.querySelector('.hero__line--dynamic .hero__prefix');
    var wrap = document.querySelector('.hero__line--dynamic .hero__rotator-wrap');
    var suffix = document.querySelector('.hero__line--dynamic .hero__suffix');
    if (shouldKeepNaturalText) {
      if (main) main.textContent = naturalText(main);
      if (prefix) prefix.textContent = naturalText(prefix);
    }
    var next = INITIAL;
    if (!shouldKeepNaturalText && main) next = splitChars(main, next);
    if (!shouldKeepNaturalText && prefix) next = splitChars(prefix, next + SEGMENT_GAP);
    var rotatorDelay = shouldKeepNaturalText ? 0 : next + SEGMENT_GAP;
    if (wrap) wrap.style.setProperty('--rotator-delay', rotatorDelay + 'ms');
    if (suffix) suffix.style.setProperty('--rotator-delay', rotatorDelay + 'ms');
    var root = document.documentElement;
    var afterText = rotatorDelay + (shouldKeepNaturalText ? 0 : 600) + 200;
    root.style.setProperty('--cta-delay', afterText + 'ms');
    root.style.setProperty('--tabs-delay', (afterText + 160) + 'ms');
    root.style.setProperty('--frame-delay', (afterText + 320) + 'ms');
    root.classList.add('hero-sequence-ready');
    if (restoreTimers.length) {
      document.addEventListener('lightvela-home-dispose', function () {
        restoreTimers.forEach(function (timer) { window.clearTimeout(timer); });
      }, { once: true });
    }
  })();`;

// The approved source includes per-word measuring; only feature-motion.js owns
// hero sizing now. Keep this normalization shared by import and regression tests.
export function normalizeHeroRuntime(source) {
  return source
    .replace(/  \(function \(\) \{\n    var INITIAL = 100;[\s\S]*?\n  \}\)\(\);/, heroHeadlineRuntime)
    .replace(/^[ \t]*var measurer = el\.cloneNode\(false\);\n[\s\S]*?^[ \t]*function measure\(word\) \{[^\n]*\}\n/m, '')
    .replace(/^[ \t]*wrap\.style\.width = measure\(words\[index\]\) \+ 'px';\n/gm, '')
    .replace(/^[ \t]*var width = measure\(word\);\n[ \t]*if \(width > 0\) wrap\.style\.width = width \+ 'px';\n/gm, '');
}

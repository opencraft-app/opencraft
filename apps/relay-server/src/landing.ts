export const RELAY_LANDING_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#09090b"/><path d="m23 20-12 12 12 12m18-24 12 12-12 12M36 17l-8 30" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const LOGOS = {
  codex: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>`,
  claude: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`,
  cursor: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>`,
  codebuddy: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z"/><path d="M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z"/></svg>`,
  gemini: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.5C12.35 6.85 17.15 11.65 22.5 12C17.15 12.35 12.35 17.15 12 22.5C11.65 17.15 6.85 12.35 1.5 12C6.85 11.65 11.65 6.85 12 1.5Z"/></svg>`,
  pi: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.5 7.5h13a1.25 1.25 0 0 1 0 2.5H16v6.25c0 .55.38.95.92.95.28 0 .54-.08.82-.24a1.1 1.1 0 0 1 1.1 1.9c-.62.38-1.32.59-2.12.59-1.88 0-3.22-1.24-3.22-3.15V10h-3.2v6.65c0 .92-.34 1.82-.98 2.42a1.25 1.25 0 0 1-1.74-1.8c.27-.26.42-.62.42-1.02V10H5.5a1.25 1.25 0 0 1 0-2.5Z"/></svg>`,
  anthropic: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/></svg>`,
  ollama: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042z"/></svg>`,
};

export function renderRelayLandingPage(): string {
  const quickstartCmd = `npx --yes --package=https://github.com/sliverp/opencraft/releases/download/v1.0.2/opencraft-1.0.2-darwin-arm64-node24.tgz -- opencraft start`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCraft — Anyone Agents Anywhere</title>
  <meta name="description" content="每个人的 Agent，连接每一个地方。统一调度本机与云端开发机上的 Codex、Claude Code、Cursor、CodeBuddy、Gemini 与自有模型。" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root {
      --bg: #ffffff;
      --bg-subtle: #fafafa;
      --fg: #09090b;
      --fg-secondary: #52525b;
      --fg-muted: #a1a1aa;
      --line: #eaeaea;
      --line-strong: #d4d4d8;
      --btn-bg: #09090b;
      --btn-fg: #ffffff;
      --cmd-bg: #fafafa;
      --grid-color: rgba(0, 0, 0, 0.035);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #050506;
        --bg-subtle: #0c0c0e;
        --fg: #fafafa;
        --fg-secondary: #a1a1aa;
        --fg-muted: #52525b;
        --line: #1c1c1f;
        --line-strong: #2e2e33;
        --btn-bg: #fafafa;
        --btn-fg: #09090b;
        --cmd-bg: #0c0c0e;
        --grid-color: rgba(255, 255, 255, 0.035);
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    a { color: inherit; text-decoration: none; }

    .backdrop {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background-image:
        linear-gradient(to right, var(--grid-color) 1px, transparent 1px),
        linear-gradient(to bottom, var(--grid-color) 1px, transparent 1px);
      background-size: 64px 64px;
      mask-image: radial-gradient(ellipse 80% 55% at 50% 0%, #000 35%, transparent 100%);
      -webkit-mask-image: radial-gradient(ellipse 80% 55% at 50% 0%, #000 35%, transparent 100%);
    }

    .wrap {
      position: relative;
      z-index: 1;
      max-width: 980px;
      margin: 0 auto;
      padding: 0 28px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 76px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 11px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .brand svg { width: 26px; height: 26px; border-radius: 6px; }
    .nav-right {
      display: flex;
      align-items: center;
      gap: 24px;
      font-size: 13.5px;
      color: var(--fg-secondary);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 12.5px;
      color: var(--fg-secondary);
    }
    .status::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
    }

    .hero {
      padding: 108px 0 88px;
    }
    .eyebrow {
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--fg-muted);
      margin: 0 0 22px;
    }
    h1 {
      margin: 0 0 24px;
      font-size: clamp(42px, 6.4vw, 72px);
      line-height: 1.06;
      letter-spacing: -0.045em;
      font-weight: 680;
    }
    .lead {
      margin: 0 0 44px;
      max-width: 600px;
      font-size: clamp(16.5px, 2vw, 19.5px);
      line-height: 1.65;
      color: var(--fg-secondary);
      font-weight: 400;
    }

    .cta-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
      margin-bottom: 44px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 44px;
      padding: 0 22px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      letter-spacing: -0.01em;
      border: 1px solid var(--line-strong);
      background: transparent;
      color: var(--fg);
      transition: opacity 0.15s ease, border-color 0.15s ease;
    }
    .btn-solid {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border-color: var(--btn-bg);
    }

    .cmd-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--cmd-bg);
    }
    .cmd-scroll {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .cmd-scroll::-webkit-scrollbar { display: none; }
    .prompt {
      color: var(--fg-muted);
      font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 13px;
      user-select: none;
    }
    .cmd-text {
      font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 13px;
      color: var(--fg);
      white-space: nowrap;
    }
    .copy {
      flex: 0 0 auto;
      appearance: none;
      border: 1px solid var(--line-strong);
      background: var(--bg);
      color: var(--fg);
      height: 30px;
      padding: 0 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }

    .agents-strip {
      padding: 44px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }
    .agents-label {
      font-size: 12.5px;
      color: var(--fg-muted);
      letter-spacing: 0.02em;
    }
    .agents-list {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 26px;
    }
    .agent-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13.5px;
      font-weight: 500;
      color: var(--fg-secondary);
    }
    .agent-item svg {
      width: 17px;
      height: 17px;
      opacity: 0.88;
    }

    .pillars {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border-bottom: 1px solid var(--line);
    }
    .pillar {
      padding: 52px 32px 52px 0;
    }
    .pillar + .pillar {
      padding-left: 32px;
      border-left: 1px solid var(--line);
    }
    .pillar:last-child {
      padding-right: 0;
    }
    .pillar-num {
      font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 11.5px;
      color: var(--fg-muted);
      margin-bottom: 18px;
      display: block;
    }
    .pillar h3 {
      margin: 0 0 10px;
      font-size: 16.5px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .pillar p {
      margin: 0;
      font-size: 14px;
      line-height: 1.7;
      color: var(--fg-secondary);
    }

    footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 36px 0 56px;
      font-size: 13px;
      color: var(--fg-muted);
    }
    .footer-links {
      display: flex;
      gap: 20px;
    }

    @media (hover: hover) and (pointer: fine) {
      :root:not([data-touch-interaction="true"]) .nav-right a:hover { color: var(--fg); }
      :root:not([data-touch-interaction="true"]) .btn:hover { border-color: var(--fg); }
      :root:not([data-touch-interaction="true"]) .btn-solid:hover { opacity: 0.86; }
      :root:not([data-touch-interaction="true"]) .copy:hover { border-color: var(--fg); }
      :root:not([data-touch-interaction="true"]) .footer-links a:hover { color: var(--fg); }
    }

    @media (max-width: 760px) {
      .hero { padding: 68px 0 56px; }
      .pillars { grid-template-columns: 1fr; }
      .pillar, .pillar + .pillar {
        padding: 32px 0;
        border-left: 0;
      }
      .pillar + .pillar { border-top: 1px solid var(--line); }
      .status { display: none; }
    }
  </style>
</head>
<body>
  <div class="backdrop" aria-hidden="true"></div>
  <div class="wrap">
    <header>
      <a class="brand" href="/">
        ${RELAY_LANDING_ICON_SVG}
        <span>OpenCraft</span>
      </a>
      <nav class="nav-right">
        <span class="status">Relay Online</span>
        <a href="https://github.com/sliverp/opencraft/releases" target="_blank" rel="noopener noreferrer">Releases</a>
        <a href="https://github.com/sliverp/opencraft" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
    </header>

    <main>
      <section class="hero">
        <p class="eyebrow">Anyone · Agents · Anywhere</p>
        <h1>每个人的 Agent，<br/>连接每一个地方。</h1>
        <p class="lead">
          将本机与远程开发机上的 Codex、Claude Code、Cursor、CodeBuddy、Gemini 及自有模型接入同一工作台。环境与凭据留在原处，对话在任意设备间自由接力。
        </p>

        <div class="cta-row">
          <a class="btn btn-solid" href="https://github.com/sliverp/opencraft/releases/latest" target="_blank" rel="noopener noreferrer">下载最新发行版</a>
          <a class="btn" href="https://github.com/sliverp/opencraft" target="_blank" rel="noopener noreferrer">阅读文档与源码</a>
        </div>

        <div class="cmd-bar" id="quickstart">
          <div class="cmd-scroll">
            <span class="prompt">$</span>
            <code class="cmd-text">${quickstartCmd}</code>
          </div>
          <button class="copy" type="button" id="copy-cmd" data-cmd="${quickstartCmd.replaceAll('"', "&quot;")}">复制</button>
        </div>
      </section>

      <section class="agents-strip" aria-label="支持的生态">
        <span class="agents-label">原生接入</span>
        <div class="agents-list">
          <span class="agent-item">${LOGOS.codex}<span>Codex</span></span>
          <span class="agent-item">${LOGOS.claude}<span>Claude Code</span></span>
          <span class="agent-item">${LOGOS.cursor}<span>Cursor</span></span>
          <span class="agent-item">${LOGOS.codebuddy}<span>CodeBuddy</span></span>
          <span class="agent-item">${LOGOS.gemini}<span>Gemini</span></span>
          <span class="agent-item">${LOGOS.pi}<span>Pi</span></span>
          <span class="agent-item">${LOGOS.anthropic}<span>Anthropic / OpenAI API</span></span>
          <span class="agent-item">${LOGOS.ollama}<span>Ollama</span></span>
        </div>
      </section>

      <section class="pillars">
        <div class="pillar">
          <span class="pillar-num">01 / CONTINUITY</span>
          <h3>多模型无缝接力</h3>
          <p>实时统筹各工具额度窗口。单一工具限流或切换专长模型时，一键携带完整上下文移交至新对话继续推进。</p>
        </div>
        <div class="pillar">
          <span class="pillar-num">02 / ANYWHERE</span>
          <h3>跨机器直连</h3>
          <p>一条命令经认证 HTTPS 中继连接云端 Linux / macOS 开发机，无需暴露 SSH 端口，支持远程服务与 CLI 在线升级。</p>
        </div>
        <div class="pillar">
          <span class="pillar-num">03 / SOVEREIGNTY</span>
          <h3>凭据留在原处</h3>
          <p>Agent 始终在原机器与原代码目录中运行，登录态与密钥由本地 Host 独占保管；协作只共享能力，不交出底层凭据。</p>
        </div>
      </section>
    </main>

    <footer>
      <span>OpenCraft · MIT-0 License</span>
      <div class="footer-links">
        <a href="https://github.com/sliverp/opencraft" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="https://github.com/sliverp/opencraft/releases" target="_blank" rel="noopener noreferrer">v1.0.2</a>
      </div>
    </footer>
  </div>

  <script>
    (function () {
      var btn = document.getElementById("copy-cmd");
      if (!btn) return;
      btn.addEventListener("click", function () {
        var cmd = btn.getAttribute("data-cmd") || "";
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(cmd).then(function () {
          var prev = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(function () { btn.textContent = prev; }, 1600);
        });
      });
    })();
  </script>
</body>
</html>`;
}

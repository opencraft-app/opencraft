export const RELAY_LANDING_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#18181b"/><path d="m23 20-12 12 12 12m18-24 12 12-12 12M36 17l-8 30" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function renderRelayLandingPage(): string {
  const quickstartCmd = `npx --yes --package=https://github.com/sliverp/opencraft/releases/download/v1.0.2/opencraft-1.0.2-darwin-arm64-node24.tgz -- opencraft start`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCraft — Anyone Agents Anywhere</title>
  <meta name="description" content="每个人的 Agent，连接每一个地方。把 Codex、Claude Code、Cursor、CodeBuddy、Gemini、Pi 与本地/云端模型接进同一个连续的工作台。" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --surface-subtle: #f4f4f5;
      --text: #09090b;
      --text-secondary: #52525b;
      --text-muted: #71717a;
      --border: #e4e4e7;
      --border-strong: #d4d4d8;
      --accent: #18181b;
      --accent-fg: #ffffff;
      --badge-bg: #eff6ff;
      --badge-fg: #1d4ed8;
      --code-bg: #111113;
      --code-fg: #f4f4f5;
      --shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.04);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #09090b;
        --surface: #121215;
        --surface-subtle: #18181b;
        --text: #fafafa;
        --text-secondary: #a1a1aa;
        --text-muted: #71717a;
        --border: #27272a;
        --border-strong: #3f3f46;
        --accent: #fafafa;
        --accent-fg: #09090b;
        --badge-bg: rgb(59 130 246 / 0.15);
        --badge-fg: #60a5fa;
        --code-bg: #0c0c0e;
        --code-fg: #e4e4e7;
        --shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 12px 32px rgb(0 0 0 / 0.35);
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; text-decoration: none; }
    .container {
      max-width: 1040px;
      margin: 0 auto;
      padding: 0 24px;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      background: color-mix(in srgb, var(--bg) 82%, transparent);
      border-bottom: 1px solid var(--border);
    }
    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 60px;
      gap: 16px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 650;
      font-size: 16px;
      letter-spacing: -0.01em;
    }
    .brand svg { width: 28px; height: 28px; border-radius: 7px; }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 18px;
      font-size: 14px;
      color: var(--text-secondary);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 38px;
      padding: 0 16px;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 550;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
    }
    .btn-primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }
    .hero {
      padding: 76px 0 52px;
      text-align: center;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12.5px;
      font-weight: 550;
      background: var(--badge-bg);
      color: var(--badge-fg);
      margin-bottom: 20px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 0 3px rgb(16 185 129 / 0.2);
    }
    h1 {
      margin: 0 auto 16px;
      max-width: 780px;
      font-size: clamp(34px, 5.2vw, 56px);
      line-height: 1.1;
      letter-spacing: -0.03em;
      font-weight: 750;
    }
    .subtitle {
      margin: 0 auto 32px;
      max-width: 660px;
      font-size: clamp(16px, 2vw, 19px);
      color: var(--text-secondary);
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
      margin-bottom: 36px;
    }
    .hero-actions .btn { height: 42px; padding: 0 20px; font-size: 14.5px; }
    .terminal-card {
      max-width: 820px;
      margin: 0 auto;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--code-bg);
      color: var(--code-fg);
      box-shadow: var(--shadow);
      text-align: left;
      overflow: hidden;
    }
    .terminal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-bottom: 1px solid rgb(255 255 255 / 0.08);
      font-size: 12px;
      color: #a1a1aa;
    }
    .terminal-dots { display: flex; gap: 6px; }
    .terminal-dots span { width: 10px; height: 10px; border-radius: 50%; background: #3f3f46; }
    .copy-btn {
      appearance: none;
      border: 1px solid rgb(255 255 255 / 0.16);
      background: rgb(255 255 255 / 0.06);
      color: #e4e4e7;
      border-radius: 6px;
      padding: 3px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    @media (hover: hover) and (pointer: fine) {
      :root:not([data-touch-interaction="true"]) .nav-links a:hover { color: var(--text); }
      :root:not([data-touch-interaction="true"]) .btn:hover { border-color: var(--border-strong); background: var(--surface-subtle); }
      :root:not([data-touch-interaction="true"]) .btn-primary:hover { opacity: 0.9; background: var(--accent); }
      :root:not([data-touch-interaction="true"]) .copy-btn:hover { background: rgb(255 255 255 / 0.14); }
    }
    .terminal-body {
      padding: 16px 18px;
      font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.65;
      overflow-x: auto;
      white-space: pre;
    }
    .terminal-note {
      margin-top: 12px;
      font-size: 12.5px;
      color: var(--text-muted);
    }
    .section { padding: 48px 0; }
    .section-title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin: 0 0 8px;
      text-align: center;
    }
    .section-desc {
      text-align: center;
      color: var(--text-secondary);
      font-size: 15px;
      margin: 0 auto 32px;
      max-width: 620px;
    }
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .agent-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .agent-badge {
      width: 42px;
      height: 42px;
      border-radius: 11px;
      display: grid;
      place-items: center;
      flex: 0 0 42px;
      font-weight: 700;
      font-size: 15px;
      color: #fff;
    }
    .agent-card strong { display: block; font-size: 14.5px; line-height: 1.3; }
    .agent-card span { display: block; font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: 16px;
    }
    .feature-card {
      padding: 22px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .feature-card h3 {
      margin: 0 0 8px;
      font-size: 16.5px;
      letter-spacing: -0.01em;
    }
    .feature-card p {
      margin: 0;
      font-size: 14px;
      color: var(--text-secondary);
    }
    footer {
      margin-top: 40px;
      padding: 28px 0 40px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 12px;
    }
    @media (max-width: 640px) {
      .nav-links a.hide-mobile { display: none; }
      .hero { padding-top: 48px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="container nav">
      <a class="brand" href="/">
        ${RELAY_LANDING_ICON_SVG}
        <span>OpenCraft</span>
      </a>
      <nav class="nav-links">
        <a class="hide-mobile" href="#agents">支持生态</a>
        <a class="hide-mobile" href="#features">核心特性</a>
        <a class="hide-mobile" href="#quickstart">快速开始</a>
        <a class="btn" href="https://github.com/sliverp/opencraft" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
    </div>
  </header>

  <main class="container">
    <section class="hero">
      <div class="pill"><span class="dot"></span><span>Anyone Agents Anywhere · HTTPS Relay Node Online</span></div>
      <h1>每个人的 Agent<br/>连接每一个地方</h1>
      <p class="subtitle">
        把分散在不同机器、不同订阅额度和不同 CLI / IDE 里的 Agent 接进同一个连续的工作台——随时切换模型、跨机移交上下文、共享执行能力而无需交出底层凭据。
      </p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#quickstart">一键启动本地服务</a>
        <a class="btn" href="https://github.com/sliverp/opencraft/releases" target="_blank" rel="noopener noreferrer">查看发行版 (v1.0.2)</a>
      </div>

      <div id="quickstart" class="terminal-card">
        <div class="terminal-head">
          <div class="terminal-dots"><span></span><span></span><span></span></div>
          <span>macOS (Apple Silicon) · Node.js 24 LTS 一键启动</span>
          <button class="copy-btn" type="button" id="copy-cmd" data-cmd="${quickstartCmd.replaceAll('"', "&quot;")}">复制命令</button>
        </div>
        <div class="terminal-body" id="cmd-text">${quickstartCmd}</div>
      </div>
      <p class="terminal-note">执行后自动启动本机执行端与 Web 工作台；需要接入远程开发机时，在「设置 → 我的远程机器」一键生成连接命令即可经本 HTTPS 节点加密回连。</p>
    </section>

    <section id="agents" class="section">
      <h2 class="section-title">已支持的 Agent 与模型生态</h2>
      <p class="section-desc">直接复用各台机器上已经安装并登录好的原生 CLI、IDE 桥接与自有 API 端点</p>
      <div class="agents-grid">
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#18181b,#27272a)">Cx</div>
          <div><strong>Codex</strong><span>原生 CLI · 推理档位与 Fast · 历史与用量</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#df7b5c,#c55e3f)">Cl</div>
          <div><strong>Claude Code</strong><span>原生 CLI 接入 · 会话历史恢复与分支</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#27272a,#111113)">Cu</div>
          <div><strong>Cursor</strong><span>Cursor Agent 接入 · 原生模型发现与续聊</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#3b82f6,#1d4ed8)">CB</div>
          <div><strong>CodeBuddy (CLI &amp; IDE)</strong><span>命令行与 IDE 当前模型双向联动</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#4f46e5,#7c3aed)">Gm</div>
          <div><strong>Gemini CLI</strong><span>原生 Gemini CLI 接入与多模态交互</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#14b8a6,#0f766e)">Pi</div>
          <div><strong>Pi &amp; DSH</strong><span>内置持久引擎与外置 ACP 执行引擎</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#059669,#047857)">API</div>
          <div><strong>OpenAI / Anthropic 协议</strong><span>自定义端点与凭据，Host 本地安全持有</span></div>
        </div>
        <div class="agent-card">
          <div class="agent-badge" style="background:linear-gradient(135deg,#52525b,#27272a)">Ol</div>
          <div><strong>Ollama 本地与云端</strong><span>本机开源大模型自动发现与即插即用</span></div>
        </div>
      </div>
    </section>

    <section id="features" class="section">
      <h2 class="section-title">为什么使用 OpenCraft</h2>
      <p class="section-desc">保持代码、环境与凭据留在原处，让对话与协作在任意设备间连续流动</p>
      <div class="features-grid">
        <div class="feature-card">
          <h3>多 Agent 额度统筹与无缝接力</h3>
          <p>同一工作台内实时查看 Codex / Cursor 用量窗口；单一工具限流或需要切换模型专长时，一键携带完整上下文移交到新对话继续推进。</p>
        </div>
        <div class="feature-card">
          <h3>跨机器连接（本机 ⇄ 云开发机）</h3>
          <p>一条 Bash 命令即可通过认证 HTTPS 中继接入远程 Linux / macOS 机器，无需暴露 SSH 端口，支持页面内一键升级远端服务与 CLI。</p>
        </div>
        <div class="feature-card">
          <h3>环境不搬家，凭据不外泄</h3>
          <p>Agent 始终在它原本的机器和代码目录里执行，登录态与 API Key 留在所属 Host；分享协作空间时只共享使用能力，不暴露底层密钥。</p>
        </div>
      </div>
    </section>

    <footer>
      <span>OpenCraft · MIT-0 License · Anyone Agents Anywhere</span>
      <span><a href="https://github.com/sliverp/opencraft" target="_blank" rel="noopener noreferrer">github.com/sliverp/opencraft</a></span>
    </footer>
  </main>

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
          setTimeout(function () { btn.textContent = prev; }, 1800);
        });
      });
    })();
  </script>
</body>
</html>`;
}

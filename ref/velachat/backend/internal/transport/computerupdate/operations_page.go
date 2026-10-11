package computerupdate

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
)

func serveOperationsPage(writer http.ResponseWriter, request *http.Request, requestID string) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		writeRouteError(writer, request.Context(), http.StatusMethodNotAllowed, "invalid_request", "请求方法无效")
		return
	}
	nonceHash := sha256.Sum256([]byte(requestID))
	nonce := base64.RawStdEncoding.EncodeToString(nonceHash[:])
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Pragma", "no-cache")
	writer.Header().Set(
		"Content-Security-Policy",
		"default-src 'none'; style-src 'nonce-"+nonce+"'; script-src 'nonce-"+nonce+"'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	)
	if request.Method == http.MethodHead {
		writer.WriteHeader(http.StatusOK)
		return
	}
	_, _ = fmt.Fprintf(writer, operationsPageDocument, nonce, nonce)
}

const operationsPageDocument = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Computer Update</title>
  <style nonce="%s">
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; background: #f5f5f7; color: #1d1d1f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; }
    main { width: min(820px, calc(100%% - 40px)); margin: 64px auto; }
    header { margin: 0 0 28px; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -.02em; }
    header p, .muted { margin: 0; color: #6e6e73; font-size: 14px; }
    section { margin-top: 28px; }
    h2 { margin: 0 0 10px 12px; color: #6e6e73; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .group { overflow: hidden; border: 1px solid rgba(0,0,0,.08); border-radius: 14px; background: rgba(255,255,255,.92); box-shadow: 0 1px 2px rgba(0,0,0,.03); }
    .row { display: grid; grid-template-columns: 110px 1fr auto; gap: 16px; align-items: center; min-height: 66px; padding: 12px 16px; }
    .row + .row { border-top: 1px solid rgba(0,0,0,.07); }
    .channel { font-weight: 600; text-transform: capitalize; }
    .version { min-width: 0; }
    .version strong, .version span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .version span { margin-top: 3px; color: #86868b; font-size: 12px; }
    .controls { display: flex; gap: 8px; align-items: center; }
    input { width: 150px; height: 34px; border: 1px solid rgba(0,0,0,.14); border-radius: 8px; padding: 0 10px; background: #fff; color: inherit; font: inherit; outline: none; }
    input:focus { border-color: #8e8e93; box-shadow: 0 0 0 3px rgba(142,142,147,.15); }
    button { height: 34px; border: 0; border-radius: 8px; padding: 0 13px; background: #e9e9eb; color: #1d1d1f; font: 600 13px inherit; cursor: pointer; }
    button:hover { background: #dedee1; }
    button:disabled { cursor: default; opacity: .45; }
    .audit { display: grid; grid-template-columns: 90px 1fr auto; gap: 12px; padding: 13px 16px; font-size: 13px; }
    .audit + .audit { border-top: 1px solid rgba(0,0,0,.07); }
    .status { min-height: 20px; margin: 14px 12px 0; color: #b42318; font-size: 13px; }
    @media (max-width: 680px) { main { width: min(100%% - 24px, 820px); margin: 28px auto; } .row { grid-template-columns: 88px 1fr; } .controls { grid-column: 1 / -1; } input { flex: 1; width: auto; } }
  </style>
</head>
<body>
  <main>
    <header><h1>Computer Update</h1><p>稳定版与 Canary 的预期版本。发布会同时更新 macOS 和 Linux。</p></header>
    <section><h2>Channels</h2><div id="channels" class="group"><div class="row muted">正在读取…</div></div><p id="status" class="status" role="status"></p></section>
    <section><h2>Recent activity</h2><div id="audit" class="group"><div class="audit muted">暂无记录</div></div></section>
  </main>
  <script nonce="%s">
    const channelsNode = document.querySelector('#channels');
    const auditNode = document.querySelector('#audit');
    const statusNode = document.querySelector('#status');
    const sequences = { stable: 0, canary: 0 };

    async function request(path, options) {
      const response = await fetch(path, { cache: 'no-store', ...options });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || '请求失败 (' + response.status + ')');
      return body;
    }

    function channelRow(name, views) {
      const row = document.createElement('div'); row.className = 'row';
      const label = document.createElement('div'); label.className = 'channel'; label.textContent = name;
      const version = document.createElement('div'); version.className = 'version';
      const current = views[0];
      const title = document.createElement('strong'); title.textContent = current?.expectedVersion || '尚未发布';
      const detail = document.createElement('span'); detail.textContent = current ? 'Sequence ' + current.sequence + ' · macOS / Linux' : 'Sequence 0';
      version.append(title, detail);
      const controls = document.createElement('div'); controls.className = 'controls';
      const input = document.createElement('input'); input.placeholder = 'v0.1.52'; input.autocomplete = 'off'; input.setAttribute('aria-label', name + ' 版本');
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '发布';
      button.addEventListener('click', async () => {
        button.disabled = true; statusNode.textContent = '';
        try {
          await request('/ops/computer-updates/channels/' + name, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"' + sequences[name] + '"' },
            body: JSON.stringify({ version: input.value.trim() }),
          });
          input.value = ''; await load();
        } catch (error) { statusNode.textContent = error.message; }
        finally { button.disabled = false; }
      });
      controls.append(input, button); row.append(label, version, controls); return row;
    }

    async function load() {
      statusNode.textContent = '';
      try {
        const [channelViews, auditPage] = await Promise.all([
          request('/ops/computer-updates/channels'),
          request('/ops/computer-updates/audit?limit=20'),
        ]);
        channelsNode.replaceChildren();
        for (const name of ['stable', 'canary']) {
          const views = channelViews.filter(item => item.channel === name);
          sequences[name] = views[0]?.sequence || 0;
          channelsNode.append(channelRow(name, views));
        }
        auditNode.replaceChildren();
        if (!auditPage.items.length) {
          const empty = document.createElement('div'); empty.className = 'audit muted'; empty.textContent = '暂无发布记录'; auditNode.append(empty);
        } else for (const item of auditPage.items) {
          const row = document.createElement('div'); row.className = 'audit';
          const channel = document.createElement('strong'); channel.textContent = item.channel;
          const version = document.createElement('span'); version.textContent = item.version;
          const time = document.createElement('span'); time.className = 'muted'; time.textContent = new Date(item.createdAt).toLocaleString();
          row.append(channel, version, time); auditNode.append(row);
        }
      } catch (error) { statusNode.textContent = error.message; }
    }
    load();
  </script>
</body>
</html>`

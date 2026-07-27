import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.env.FAKE_QQ_PORT || "19010");
const appID = process.env.FAKE_QQ_APP_ID || "local-qq-app-id";
const defaultUser = process.env.FAKE_QQ_DEFAULT_USER || "local";
const mockControlBaseURL = String(process.env.MOCK_CONTROL_BASE_URL || "").replace(/\/+$/, "");

const users = new Map([
  [
    "local",
    {
      openid: "fake-qq-openid-local",
      nickname: "Local QQ User",
    },
  ],
  [
    "second",
    {
      openid: "fake-qq-openid-second",
      nickname: "Second Local QQ User",
    },
  ],
]);

const codes = new Map();
const tokens = new Map();

function sendJSON(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function selectedUser(url) {
  const key = url.searchParams.get("fake_user") || defaultUser;
  return users.get(users.has(key) ? key : "local");
}

function userFromToken(token) {
  return tokens.get(token);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendHTML(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

async function readForm(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("request_too_large");
  }
  return new URLSearchParams(body);
}

async function controlRequest(path, options = {}) {
  const response = await fetch(`${mockControlBaseURL}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `mock_control_${response.status}`);
  }
  return payload;
}

function oauthFields(params) {
  const names = ["redirect_uri", "state", "client_id", "response_type", "scope"];
  return names
    .filter((name) => params.get(name))
    .map(
      (name) =>
        `<input type="hidden" name="${name}" value="${escapeHTML(params.get(name))}">`,
    )
    .join("");
}

function pageShell(title, content) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #eef2f7; color: #172033; display: grid; place-items: center; padding: 24px; }
    main { width: min(720px, 100%); background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; box-shadow: 0 18px 50px rgba(31, 48, 78, .12); overflow: hidden; }
    header { display: flex; align-items: center; gap: 14px; padding: 22px 26px; border-bottom: 1px solid #e5eaf1; }
    .mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 50%; background: #12b7f5; color: #fff; font-weight: 800; font-size: 18px; }
    h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
    .subtle { margin: 4px 0 0; color: #68758b; font-size: 13px; }
    section { padding: 22px 26px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    label.title { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 650; color: #46536a; }
    select, input[type="search"] { width: 100%; min-height: 42px; border: 1px solid #cbd4e1; border-radius: 6px; background: #fff; padding: 9px 11px; color: #172033; font: inherit; }
    select:focus, input:focus { outline: 2px solid #8edcff; outline-offset: 1px; border-color: #12a9e8; }
    .actions { display: flex; justify-content: flex-end; margin-top: 20px; }
    button { min-height: 42px; border: 0; border-radius: 6px; padding: 0 18px; background: #087ea4; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #066b8d; }
    dl { display: grid; grid-template-columns: 110px 1fr; gap: 12px 18px; margin: 0; }
    dt { color: #68758b; }
    dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .notice { margin: 18px 0 0; padding: 12px 14px; border-left: 3px solid #12b7f5; background: #f1faff; color: #35506b; font-size: 13px; }
    @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } header, section { padding: 18px; } dl { grid-template-columns: 90px 1fr; } }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

async function renderSelection(res, url) {
  const scenarioQuery = url.searchParams.get("scenario_q") || "";
  const scenarioPage = url.searchParams.get("scenario_page") || "1";
  const [userPage, scenarioPagePayload] = await Promise.all([
    controlRequest("/v1/users?page=1&page_size=100"),
    controlRequest(
      `/v1/scenarios?page=${encodeURIComponent(scenarioPage)}&page_size=50&q=${encodeURIComponent(scenarioQuery)}`,
    ),
  ]);
  const userOptions = [
    '<option value="__create__" selected>创建空白用户</option>',
    ...userPage.items.map(
      (user) =>
        `<option value="${escapeHTML(user.mockUserId)}">${escapeHTML(user.displayName)} · ${escapeHTML(user.scenarioId)}</option>`,
    ),
  ].join("");
  const scenarioOptions = scenarioPagePayload.items
    .map(
      (scenario) =>
        `<option value="${escapeHTML(scenario.id)}">${escapeHTML(scenario.name)} · ${escapeHTML(scenario.id)}</option>`,
    )
    .join("");
  const content = `
<header><div class="mark">QQ</div><div><h1>本地身份登录</h1><p class="subtle">Lightclaw localstack</p></div></header>
<section>
  <form method="get" action="/oauth2.0/authorize">
    ${oauthFields(url.searchParams)}
    <label class="title" for="scenario_q">搜索场景</label>
    <input id="scenario_q" type="search" name="scenario_q" value="${escapeHTML(scenarioQuery)}">
  </form>
  <form method="post" action="/oauth2.0/authorize">
    ${oauthFields(url.searchParams)}
    <input type="hidden" name="user_action" value="select">
    <div class="grid">
      <div><label class="title" for="mock_user_id">用户</label><select id="mock_user_id" name="mock_user_id">${userOptions}</select></div>
      <div><label class="title" for="scenario_id">场景</label><select id="scenario_id" name="scenario_id">${scenarioOptions}</select></div>
    </div>
    <div class="actions"><button type="submit">选择并继续</button></div>
  </form>
</section>`;
  sendHTML(res, 200, pageShell("本地身份登录", content));
}

function renderConfirmation(res, params, user) {
  const content = `
<header><div class="mark">QQ</div><div><h1>${escapeHTML(user.displayName)}</h1><p class="subtle">${escapeHTML(user.scenarioId)}</p></div></header>
<section>
  <dl>
    <dt>姓名</dt><dd>${escapeHTML(user.realname.name)}</dd>
    <dt>身份证</dt><dd>${escapeHTML(user.realname.idCard)}</dd>
    <dt>手机号</dt><dd>${escapeHTML(user.phone)}</dd>
    <dt>验证码</dt><dd>${escapeHTML(user.developmentSMSCode)}</dd>
  </dl>
  <p class="notice">这些值仅属于当前本地测试身份。</p>
  <form method="post" action="/oauth2.0/authorize">
    ${oauthFields(params)}
    <input type="hidden" name="user_action" value="continue">
    <input type="hidden" name="mock_user_id" value="${escapeHTML(user.mockUserId)}">
    <div class="actions"><button type="submit">继续登录</button></div>
  </form>
</section>`;
  sendHTML(res, 200, pageShell(user.displayName, content));
}

function authorizeRedirect(res, params, user) {
  const redirectURI = params.get("redirect_uri");
  if (!redirectURI) {
    sendJSON(res, 400, { error: "missing_redirect_uri" });
    return;
  }

  const code = `fake-qq-code-${crypto.randomUUID()}`;
  codes.set(code, user);

  const redirectURL = new URL(redirectURI);
  redirectURL.searchParams.set("code", code);
  const state = params.get("state");
  if (state) {
    redirectURL.searchParams.set("state", state);
  }

  res.writeHead(302, {
    location: redirectURL.toString(),
    "cache-control": "no-store",
  });
  res.end();
}

async function authorize(req, res, url) {
  if (!mockControlBaseURL) {
    authorizeRedirect(res, url.searchParams, selectedUser(url));
    return;
  }

  if (req.method === "GET") {
    await renderSelection(res, url);
    return;
  }
  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "method_not_allowed" });
    return;
  }

  const form = await readForm(req);
  const params = new URLSearchParams(url.searchParams);
  for (const [key, value] of form) params.set(key, value);
  const action = form.get("user_action") || "select";
  if (action === "continue") {
    const user = await controlRequest(
      `/v1/users/${encodeURIComponent(form.get("mock_user_id") || "")}`,
    );
    authorizeRedirect(res, params, {
      openid: user.qqOpenId,
      nickname: user.displayName,
    });
    return;
  }

  const selectedID =
    action === "create" ? "__create__" : form.get("mock_user_id");
  const scenarioId = form.get("scenario_id") || "full";
  let user;
  if (!selectedID || selectedID === "__create__") {
    user = await controlRequest("/v1/users", {
      method: "POST",
      body: JSON.stringify({ scenarioId }),
    });
  } else {
    await controlRequest(
      `/v1/users/${encodeURIComponent(selectedID)}/scenario`,
      {
        method: "PUT",
        body: JSON.stringify({ scenarioId }),
      },
    );
    user = await controlRequest(`/v1/users/${encodeURIComponent(selectedID)}`);
  }
  renderConfirmation(res, params, user);
}

function token(req, res, url) {
  const code = url.searchParams.get("code") || "";
  const user = codes.get(code);
  if (!user) {
    sendJSON(res, 200, {
      error: 100019,
      error_description: "invalid fake authorization code",
    });
    return;
  }

  const accessToken = `fake-qq-token-${crypto.randomUUID()}`;
  tokens.set(accessToken, user);
  sendJSON(res, 200, {
    access_token: accessToken,
    refresh_token: `fake-qq-refresh-${crypto.randomUUID()}`,
    expires_in: 7776000,
  });
}

function me(req, res, url) {
  const accessToken = url.searchParams.get("access_token") || "";
  const user = userFromToken(accessToken);
  if (!user) {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end('callback({"error":100016,"error_description":"invalid fake access token"});');
    return;
  }
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`callback(${JSON.stringify({ client_id: appID, openid: user.openid })});`);
}

function userInfo(req, res, url) {
  const accessToken = url.searchParams.get("access_token") || "";
  const user = userFromToken(accessToken);
  if (!user) {
    sendJSON(res, 200, { ret: 100016, msg: "invalid fake access token" });
    return;
  }
  sendJSON(res, 200, {
    ret: 0,
    msg: "",
    nickname: user.nickname,
    figureurl_1: "",
    figureurl_2: "",
    figureurl_qq_1: "",
    figureurl_qq_2: "",
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/healthz") {
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/oauth2.0/authorize") {
      await authorize(req, res, url);
      return;
    }
    if (url.pathname === "/oauth2.0/token") {
      token(req, res, url);
      return;
    }
    if (url.pathname === "/oauth2.0/me") {
      me(req, res, url);
      return;
    }
    if (url.pathname === "/user/get_user_info") {
      userInfo(req, res, url);
      return;
    }

    sendJSON(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    sendJSON(res, 502, { error: "mock_control_unavailable" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`fake QQ OAuth listening on :${port}`);
});

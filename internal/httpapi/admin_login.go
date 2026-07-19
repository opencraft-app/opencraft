package httpapi

const adminLoginHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LLM Gateway Login</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --line: #dfdfd8;
      --text: #20211d;
      --muted: #6c7068;
      --accent: #266df0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    form {
      width: min(360px, calc(100vw - 32px));
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    h1 { font-size: 18px; margin: 0; }
    p { color: var(--muted); margin: 0; font-size: 13px; line-height: 1.5; }
    label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; }
    input {
      width: 100%;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
    }
    button {
      height: 36px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-weight: 700;
    }
    .error { color: #b42318; min-height: 18px; font-size: 12px; }
  </style>
</head>
<body>
  <form id="loginForm">
    <div>
      <h1>LLM Gateway</h1>
      <p>Control plane sign in</p>
    </div>
    <div>
      <label>Username</label>
      <input id="username" autocomplete="username" value="cluster-admin" />
    </div>
    <div>
      <label>Password</label>
      <input id="password" type="password" autocomplete="current-password" autofocus />
    </div>
    <button type="submit">Sign in</button>
    <div id="error" class="error"></div>
  </form>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async event => {
      event.preventDefault();
      const error = document.getElementById('error');
      error.textContent = '';
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        error.textContent = data.message || 'Sign in failed';
        return;
      }
      const next = new URLSearchParams(location.search).get('next') || '/admin';
      location.href = next.startsWith('/') ? next : '/admin';
    });
  </script>
</body>
</html>`

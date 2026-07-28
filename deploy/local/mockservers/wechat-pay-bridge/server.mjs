import http from "node:http";

const port = Number(process.env.FAKE_WECHAT_PAY_BRIDGE_PORT || "19040");
const frontendBaseURL = (process.env.FRONTEND_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const openID = process.env.FAKE_WECHAT_OPEN_ID || "local-wechat-openid";

function sendJSON(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const requestURL = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (requestURL.pathname === "/healthz") {
    sendJSON(response, 200, { ok: true });
    return;
  }
  if (request.method !== "GET" || requestURL.pathname !== "/auth/wechat-pay") {
    sendJSON(response, 404, { error: "not_found" });
    return;
  }

  const target = new URL("/auth/wechat-pay", frontendBaseURL);
  for (const [name, value] of requestURL.searchParams) {
    target.searchParams.append(name, value);
  }
  target.searchParams.set("openid", openID);
  target.searchParams.set("local_wechat_mock", "1");

  console.log(`fake wechat pay bridge redirect deal=${requestURL.searchParams.get("d") || ""}`);
  response.writeHead(302, {
    location: target.toString(),
    "cache-control": "no-store",
  });
  response.end();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`fake wechat pay bridge listening on :${port}`);
});

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const port = Number(process.env.FAKE_TENCENTCLOUD_PORT || "19030");
const tlsPort = Number(process.env.FAKE_TENCENTCLOUD_TLS_PORT || "0");
const tlsCertPath = process.env.FAKE_TENCENTCLOUD_TLS_CERT || "";
const tlsKeyPath = process.env.FAKE_TENCENTCLOUD_TLS_KEY || "";
const mockControlBaseURL = String(process.env.MOCK_CONTROL_BASE_URL || "").replace(/\/+$/, "");
const uin = 700000164995;
const appID = 251202221;

function sendJSON(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function requestID() {
  return `local-${crypto.randomUUID()}`;
}

function identityAliasHash(name, idCard) {
  const normalizedName = String(name || "").normalize("NFKC").trim();
  const normalizedIDCard = String(idCard || "")
    .normalize("NFKC")
    .trim()
    .toUpperCase();
  return crypto
    .createHash("sha256")
    .update(`${normalizedName}\0${normalizedIDCard}`, "utf8")
    .digest("hex");
}

async function resolveRealnamePreset(payload) {
  const response = await fetch(`${mockControlBaseURL}/v1/resolve`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      capabilityId: "tencentcloud.faceid.id-card-verification",
      identityAliasHash: identityAliasHash(payload.Name, payload.IdCard),
    }),
  });
  if (response.status === 404) return "identity-not-found";
  if (!response.ok) {
    throw new Error(`mock-control resolve failed with ${response.status}`);
  }
  const resolved = await response.json();
  return resolved.preset;
}

async function responseFor(action, payload = {}) {
  const expires = Math.floor(Date.now() / 1000) + 7200;
  const base = { RequestId: requestID() };

  switch (action) {
    case "RegisterCloudForSaaS":
      return { ...base, Uin: uin, Key: "local-shadow-key", ExpiredTime: expires };
    case "GetAppIdByUin":
      return { ...base, AppId: appID };
    case "GetTokenByAuthCodeForSaaS":
      return {
        ...base,
        Uin: uin,
        OwnerUin: uin,
        Token: "local-saas-token",
        ExpiredTime: expires,
      };
    case "GetSaaSAccessToken":
      return {
        ...base,
        Credentials: {
          Token: "local-session-token",
          TmpSecretId: "AKIDLOCALSHADOW",
          TmpSecretKey: "local-shadow-secret-key",
        },
        ExpiredTime: expires,
        Expiration: new Date(expires * 1000).toISOString(),
      };
    case "DescribeBasicAuthForSaaS":
      return {
        ...base,
        AccountOwnerUin: uin,
        AccountType: 0,
        Name: "Local Developer",
        Mobile: "13800000000",
        CountryCode: "86",
        Idcard: "110101199001010000",
      };
    case "IdCardVerification":
      if (mockControlBaseURL) {
        const preset = await resolveRealnamePreset(payload);
        if (preset === "identity-mismatch") {
          return {
            ...base,
            Result: "1001",
            Description: "local fake identity mismatch",
          };
        }
        if (preset === "identity-not-found") {
          return {
            ...base,
            Result: "1002",
            Description: "local fake identity not found",
          };
        }
        if (preset !== "success") {
          return {
            ...base,
            Result: "1099",
            Description: `unsupported local preset: ${preset}`,
          };
        }
      }
      return {
        ...base,
        Result: "0",
        Description: "local fake verification passed",
      };
    default:
      return base;
  }
}

async function readJSON(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("request_too_large");
  }
  return body ? JSON.parse(body) : {};
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    sendJSON(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    sendJSON(res, 405, { Response: { Error: { Code: "InvalidAction" }, RequestId: requestID() } });
    return;
  }

  const action = String(req.headers["x-tc-action"] || "");
  try {
    const payload = await readJSON(req);
    console.log(`fake tencentcloud action=${action || "unknown"} host=${req.headers.host || ""}`);
    sendJSON(res, 200, { Response: await responseFor(action, payload) });
  } catch (error) {
    console.error(error);
    sendJSON(res, 500, {
      Response: {
        Error: {
          Code: "InternalError.LocalMock",
          Message: "local mock provider failed",
        },
        RequestId: requestID(),
      },
    });
  }
}

const server = http.createServer(handleRequest);
server.listen(port, "0.0.0.0", () => {
  console.log(`fake tencentcloud listening on :${port}`);
});

if (tlsPort > 0 && tlsCertPath && tlsKeyPath) {
  const tlsServer = https.createServer({
    cert: fs.readFileSync(tlsCertPath),
    key: fs.readFileSync(tlsKeyPath),
  }, handleRequest);
  tlsServer.listen(tlsPort, "0.0.0.0", () => {
    console.log(`fake tencentcloud TLS listening on :${tlsPort}`);
  });
}

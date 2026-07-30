import http from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || "18080");
const shadowBaseURL = (process.env.SHADOW_BASE_URL || "").replace(/\/+$/, "");
const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN || "";

function writeJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function errorEnvelope(code, message, requestID) {
  return {
    code,
    message,
    request_id: requestID,
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJSON(response, 200, { ok: true });
    return;
  }

  const requestID = randomUUID();
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET" || url.pathname !== "/internal/shadow/binding") {
    writeJSON(response, 404, errorEnvelope("NOT_FOUND", "route not found", requestID));
    return;
  }

  if (request.headers.authorization !== `Bearer ${internalServiceToken}`) {
    writeJSON(response, 401, errorEnvelope("UNAUTHORIZED", "unauthorized", requestID));
    return;
  }

  const externalUserID = (url.searchParams.get("external_user_id") || "").trim();
  if (!externalUserID) {
    writeJSON(response, 400, errorEnvelope("INVALID_ARGUMENT", "external_user_id is required", requestID));
    return;
  }

  try {
    const upstream = await fetch(`${shadowBaseURL}/v1/shadow-preflight/binding`, {
      headers: {
        accept: "application/json",
        "x-user-id": externalUserID,
      },
      signal: AbortSignal.timeout(4000),
    });
    const body = await upstream.json();

    if (!upstream.ok) {
      writeJSON(
        response,
        502,
        errorEnvelope("SHADOW_UPSTREAM_ERROR", body.error || `shadow returned ${upstream.status}`, requestID),
      );
      return;
    }
    if (!body.bound || !body.binding) {
      writeJSON(response, 404, errorEnvelope("BINDING_NOT_FOUND", "binding not found", requestID));
      return;
    }

    writeJSON(response, 200, {
      code: "0",
      message: "OK",
      request_id: requestID,
      data: body.binding,
    });
  } catch (error) {
    writeJSON(
      response,
      502,
      errorEnvelope("SHADOW_UPSTREAM_ERROR", error instanceof Error ? error.message : String(error), requestID),
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`shadow-trade-adapter listening on ${port}`);
});

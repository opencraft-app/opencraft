import assert from "node:assert/strict";
import test from "node:test";

import {
  HermesDashboardWhatsAppOnboardingHandler,
} from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/whatsapp-onboarding-handler";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";

class FakeDashboardClient {
  readonly requests: Array<{
    input: string;
    method: string;
    headers: HeadersInit | undefined;
    json: unknown;
  }> = [];
  closed = false;

  async fetchJson<T>(input: string, init: {
    readonly method?: string;
    readonly headers?: HeadersInit;
    readonly json?: unknown;
  } = {}): Promise<T> {
    this.requests.push({
      input,
      method: init.method ?? "GET",
      headers: init.headers,
      json: init.json,
    });
    if (input.endsWith("/start")) {
      return {
        pairing_id: "pair/1",
        status: "waiting",
        qr_payload: "qr-current",
        expires_at: "2030-01-01T00:00:00Z",
        mode: "bot",
        allowed_users: "",
      } as T;
    }
    if (input.endsWith("/apply")) return { ok: true, platform: "whatsapp" } as T;
    if (init.method === "DELETE") return { ok: true } as T;
    return {
      pairing_id: "pair/1",
      status: "connected",
      expires_at: "2030-01-01T00:00:00Z",
      mode: "bot",
      allowed_users: "",
    } as T;
  }

  close(): void { this.closed = true; }
}

test("WhatsApp onboarding uses a Dashboard-owned pairing resource and snapshot reads", async () => {
  const client = new FakeDashboardClient();
  const handler = new HermesDashboardWhatsAppOnboardingHandler();
  handler.attach(client as never, "dashboard-secret");

  const started = await handler.handle("hermes/whatsapp/onboarding/start", {
    mode: "bot",
    allowedUsers: "",
  }) as { pairing_id: string; qr_payload: string };
  assert.equal(started.pairing_id, "pair/1");
  assert.equal(started.qr_payload, "qr-current");

  await handler.handle("hermes/whatsapp/onboarding/read", { pairingId: "pair/1" });
  await handler.handle("hermes/whatsapp/onboarding/apply", { pairingId: "pair/1", mode: "bot" });
  await handler.handle("hermes/whatsapp/onboarding/cancel", { pairingId: "pair/1" });

  assert.deepEqual(client.requests.map(({ input, method }) => ({ input, method })), [
    { input: "/api/messaging/whatsapp/onboarding/start", method: "POST" },
    { input: "/api/messaging/whatsapp/onboarding/pair%2F1", method: "GET" },
    { input: "/api/messaging/whatsapp/onboarding/pair%2F1/apply", method: "POST" },
    { input: "/api/messaging/whatsapp/onboarding/pair%2F1", method: "DELETE" },
  ]);
  assert.ok(client.requests.every((request) => (
    new Headers(request.headers).get("x-hermes-session-token") === "dashboard-secret"
  )));
  handler.dispose();
  assert.equal(client.closed, true);
});

test("WhatsApp onboarding methods are admitted only through the dedicated Host handler", async () => {
  const client = new FakeDashboardClient();
  const handler = new HermesDashboardWhatsAppOnboardingHandler();
  handler.attach(client as never, "secret");

  const result = await dispatchAppServerRequest({} as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "hermes/whatsapp/onboarding/read",
    params: { pairingId: "pair/1" },
  }, { whatsappOnboarding: handler }) as { status: string };
  assert.equal(result.status, "connected");

  await assert.rejects(
    dispatchAppServerRequest({} as never, {
      jsonrpc: "2.0",
      id: 2,
      method: "hermes/whatsapp/onboarding/read",
      params: { pairingId: "pair/1" },
    }),
    /service is unavailable/u,
  );
  handler.dispose();
});

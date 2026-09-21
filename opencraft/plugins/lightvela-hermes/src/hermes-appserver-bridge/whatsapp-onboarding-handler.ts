import type { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";

type JsonHttpClient = Pick<TatHttpVirtualClient, "fetchJson" | "close">;

export type HermesWhatsAppOnboardingStatus =
  | "installing"
  | "starting"
  | "waiting"
  | "connected"
  | "error"
  | "expired"
  | "cancelled";

export interface HermesWhatsAppOnboardingSession {
  readonly pairing_id: string;
  readonly status: HermesWhatsAppOnboardingStatus;
  readonly qr_payload?: string | null;
  readonly expires_at: string;
  readonly mode: "bot" | "self-chat";
  readonly allowed_users: string;
  readonly account_id?: string | null;
  readonly account_name?: string | null;
  readonly account_phone?: string | null;
  readonly error?: string | null;
}

export interface HermesWhatsAppOnboardingApplyResult {
  readonly ok: boolean;
  readonly platform: "whatsapp";
  readonly needs_restart?: boolean;
  readonly restart_started?: boolean;
  readonly restart_error?: string | null;
}

const METHODS = new Set([
  "hermes/whatsapp/onboarding/start",
  "hermes/whatsapp/onboarding/read",
  "hermes/whatsapp/onboarding/apply",
  "hermes/whatsapp/onboarding/cancel",
]);

export const isHermesWhatsAppOnboardingMethod = (method: string): boolean => METHODS.has(method);

const record = (value: unknown): Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const requiredPairingId = (params: Record<string, unknown>): string => {
  const pairingId = typeof params.pairingId === "string" ? params.pairingId.trim() : "";
  if (pairingId === "") throw new TypeError("WhatsApp pairingId is required");
  return pairingId;
};

/**
 * Host-owned adapter for Hermes' durable WhatsApp onboarding transaction.
 *
 * The Dashboard process owns the pairing child process and the latest QR
 * snapshot. Browser reconnects only re-read that resource; they never recreate
 * a long-running PTY command or become the QR event owner.
 */
export class HermesDashboardWhatsAppOnboardingHandler {
  private client: JsonHttpClient | null = null;
  private sessionToken: string | null = null;
  private disposed = false;

  attach(client: JsonHttpClient, sessionToken: string): void {
    if (this.disposed) throw new Error("WhatsApp onboarding handler is disposed");
    this.client?.close();
    this.client = client;
    this.sessionToken = sessionToken;
  }

  detach(): void {
    this.client?.close();
    this.client = null;
    this.sessionToken = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
  }

  async handle(method: string, rawParams: unknown): Promise<unknown> {
    const params = record(rawParams);
    switch (method) {
      case "hermes/whatsapp/onboarding/start":
        return this.request<HermesWhatsAppOnboardingSession>(
          "/api/messaging/whatsapp/onboarding/start",
          "POST",
          {
            mode: params.mode === "self-chat" ? "self-chat" : "bot",
            allowed_users: typeof params.allowedUsers === "string" ? params.allowedUsers : "",
          },
        );
      case "hermes/whatsapp/onboarding/read":
        return this.request<HermesWhatsAppOnboardingSession>(
          `/api/messaging/whatsapp/onboarding/${encodeURIComponent(requiredPairingId(params))}`,
          "GET",
        );
      case "hermes/whatsapp/onboarding/apply":
        return this.request<HermesWhatsAppOnboardingApplyResult>(
          `/api/messaging/whatsapp/onboarding/${encodeURIComponent(requiredPairingId(params))}/apply`,
          "POST",
          {
            mode: params.mode === "self-chat" ? "self-chat" : "bot",
            allowed_users: typeof params.allowedUsers === "string" ? params.allowedUsers : "",
          },
        );
      case "hermes/whatsapp/onboarding/cancel":
        return this.request<{ readonly ok: boolean }>(
          `/api/messaging/whatsapp/onboarding/${encodeURIComponent(requiredPairingId(params))}`,
          "DELETE",
        );
      default:
        throw Object.assign(new Error(`Unsupported WhatsApp onboarding method: ${method}`), { rpcCode: -32601 });
    }
  }

  private async request<T>(path: string, method: string, json?: unknown): Promise<T> {
    if (this.client === null || this.sessionToken === null) {
      throw new Error("Hermes Dashboard is not connected");
    }
    return await this.client.fetchJson<T>(path, {
      method,
      headers: { "X-Hermes-Session-Token": this.sessionToken },
      ...(json === undefined ? {} : { json }),
    });
  }
}

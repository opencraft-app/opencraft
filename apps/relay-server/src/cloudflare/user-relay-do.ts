// Per-human-Actor Durable Object (`user:<actorId>`).
// Owns that person's enrolled machines, quota enforcement, 10-minute pairing codes,
// and outgoing collaborator `ShareGrant`s, synchronizing committed authority to
// the target `MachineRelayDO` instances.
import { sha256 } from "@noble/hashes/sha2.js";
import {
  formatMachineCredential,
  formatPairingUrl,
  formatShareUrl,
  isValidRelayMachineId,
} from "@opencraft/relay-protocol";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import {
  INTERNAL_CALLER_HEADER,
  INTERNAL_CALLER_VALUE,
  type CloudRelayDOState,
  type CloudRelayEnv,
  type DurableObjectLocationHint,
} from "./bindings.js";
import { randomBase64Url, sha256Hex, toHex } from "./crypto.js";
import { DEFAULT_FREE_MACHINE_LIMIT, UserRelayStore, machineRelayObjectName } from "./domain.js";

const encoder = new TextEncoder();
const sha256SyncHex = (text: string): string => toHex(sha256(encoder.encode(text)));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export class UserRelayDO {
  #store: UserRelayStore | null = null;
  #failed = false;

  constructor(
    private readonly ctx: CloudRelayDOState,
    private readonly env: CloudRelayEnv,
  ) {
    void this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.#store = UserRelayStore.open(durableObjectSqlDatabase(this.ctx.storage), sha256SyncHex);
      } catch {
        this.#failed = true;
      }
    });
  }

  #machineStub(machineId: string, hint?: DurableObjectLocationHint) {
    const id = this.env.MACHINE_RELAY.idFromName(machineRelayObjectName(machineId));
    return hint ? this.env.MACHINE_RELAY.get(id, { locationHint: hint }) : this.env.MACHINE_RELAY.get(id);
  }

  #defaultLimit(): number {
    const raw = Number(
      this.env.OPENCRAFT_RELAY_FREE_MACHINE_LIMIT ??
        this.env.OPENCRAFT_MAX_MACHINES_PER_USER ??
        DEFAULT_FREE_MACHINE_LIMIT,
    );
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : DEFAULT_FREE_MACHINE_LIMIT;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_CALLER_HEADER) !== INTERNAL_CALLER_VALUE) {
      return json(403, { error: "forbidden" });
    }
    if (this.#failed || !this.#store) return json(503, { error: "user_relay_unavailable" });
    const url = new URL(request.url);
    const now = Date.now();

    if (request.method === "POST" && url.pathname === "/ensure-profile") {
      const body = (await request.json()) as { actorId?: unknown; displayName?: unknown };
      if (typeof body.actorId !== "string" || !body.actorId) return json(400, { error: "invalid_actor" });
      const profile = this.#store.ensureProfile({
        actorId: body.actorId,
        displayName: typeof body.displayName === "string" ? body.displayName : "OpenCraft User",
        defaultMachineLimit: this.#defaultLimit(),
        now,
      });
      return json(200, { profile });
    }

    const profile = this.#store.readProfile();
    if (!profile) return json(404, { error: "profile_not_found" });

    if (request.method === "GET" && url.pathname === "/summary") {
      return json(200, {
        profile,
        machines: this.#store.listMachines(),
        shares: this.#store.listShareGrants(),
        passkeys: this.#store.listHubPasskeys(),
        threadIndex: this.#store.listThreadIndex(),
      });
    }

    if (request.method === "POST" && url.pathname === "/passkey/record") {
      const body = (await request.json()) as { credentialId?: unknown; label?: unknown };
      if (typeof body.credentialId !== "string" || !body.credentialId) {
        return json(400, { error: "invalid_credential_id" });
      }
      this.#store.recordHubPasskey({
        credentialId: body.credentialId,
        label: typeof body.label === "string" ? body.label : "Passkey",
        now,
      });
      return json(200, { ok: true, passkeys: this.#store.listHubPasskeys() });
    }

    if (request.method === "POST" && url.pathname === "/machines/adopt") {
      const body = (await request.json()) as {
        machineId?: unknown;
        displayName?: unknown;
        secretHash?: unknown;
        approvalRequired?: unknown;
      };
      if (
        typeof body.machineId !== "string" ||
        !isValidRelayMachineId(body.machineId) ||
        typeof body.secretHash !== "string"
      ) {
        return json(400, { error: "invalid_adopt_request" });
      }
      const adopted = this.#store.enrollMachine({
        machineId: body.machineId,
        displayName: typeof body.displayName === "string" ? body.displayName : "My Machine",
        secretHash: body.secretHash,
        approvalRequired: body.approvalRequired === true,
        now,
      });
      if (!adopted.ok) return json(429, { error: adopted.error, limit: profile.machineLimit });
      return json(200, { ok: true, machine: adopted.machine });
    }

    if (request.method === "POST" && url.pathname === "/machines/detach") {
      const body = (await request.json()) as { machineId?: unknown };
      if (typeof body.machineId !== "string" || !isValidRelayMachineId(body.machineId)) {
        return json(400, { error: "invalid_machine_id" });
      }
      this.#store.revokeMachine(body.machineId, now);
      return json(200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/machines/thread-index") {
      const body = (await request.json()) as { machineId?: unknown; threads?: unknown };
      if (
        typeof body.machineId !== "string" ||
        !isValidRelayMachineId(body.machineId) ||
        !Array.isArray(body.threads)
      ) {
        return json(400, { error: "invalid_thread_index_payload" });
      }
      this.#store.replaceMachineThreadIndex(
        body.machineId,
        body.threads as readonly {
          readonly threadId: string;
          readonly title: string;
          readonly status: "idle" | "running" | "waiting" | "failed";
          readonly updatedAt: number;
        }[],
      );
      return json(200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/machines/enroll") {
      const body = (await request.json()) as {
        machineId?: unknown;
        displayName?: unknown;
        approvalRequired?: unknown;
        ownerDeviceThumbprint?: unknown;
      };
      const machineId =
        typeof body.machineId === "string" && isValidRelayMachineId(body.machineId)
          ? body.machineId
          : crypto.randomUUID();
      const displayName =
        typeof body.displayName === "string" && body.displayName.trim()
          ? body.displayName.trim().slice(0, 128)
          : "My Machine";
      const approvalRequired = body.approvalRequired === true;
      const secret = randomBase64Url(32);
      const secretHash = await sha256Hex(secret);
      const enrolled = this.#store.enrollMachine({
        machineId,
        displayName,
        secretHash,
        approvalRequired,
        now,
      });
      if (!enrolled.ok) return json(429, { error: enrolled.error, limit: profile.machineLimit });

      const hint = (request.headers.get("x-opencraft-location-hint") ?? undefined) as
        DurableObjectLocationHint | undefined;
      const configRes = await this.#machineStub(machineId, hint).fetch(
        new Request("https://machine-relay.internal/internal/configure", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE,
          },
          body: JSON.stringify({
            machineId,
            displayName,
            ownerActorId: profile.actorId,
            secretHash,
            approvalRequired,
            maxBlobBytes: profile.maxBlobBytes,
            ...(typeof body.ownerDeviceThumbprint === "string"
              ? { ownerDeviceThumbprint: body.ownerDeviceThumbprint }
              : {}),
          }),
        }),
      );
      if (!configRes.ok) {
        this.#store.revokeMachine(machineId, now);
        return json(502, { error: "machine_configuration_failed" });
      }

      const pairSecret = randomBase64Url(24);
      const pairMeta = this.#store.createPairingCode({
        codeHash: await sha256Hex(pairSecret),
        machineId,
        approvalRequired,
        now,
      });
      const credential = formatMachineCredential(machineId, secret);
      const compoundCode = `${profile.actorId.slice(6)}_${pairSecret}`;
      const pairingUrl = formatPairingUrl({
        relayOrigin: this.env.OPENCRAFT_RELAY_ORIGIN,
        machineId,
        code: compoundCode,
        approvalRequired,
      });
      return json(201, {
        machine: { ...enrolled.machine, ownerActorId: profile.actorId },
        credential,
        pairingUrl,
        pairingExpiresAt: pairMeta.expiresAt,
        pairing: {
          code: compoundCode,
          expiresAt: pairMeta.expiresAt,
          approvalRequired,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/machines/pair-code") {
      const body = (await request.json()) as { machineId?: unknown; approvalRequired?: unknown };
      if (typeof body.machineId !== "string" || !isValidRelayMachineId(body.machineId)) {
        return json(400, { error: "invalid_machine_id" });
      }
      const approvalRequired = body.approvalRequired === true;
      const pairSecret = randomBase64Url(24);
      try {
        const meta = this.#store.createPairingCode({
          codeHash: await sha256Hex(pairSecret),
          machineId: body.machineId,
          approvalRequired,
          now,
        });
        const code = `${profile.actorId.slice(6)}_${pairSecret}`;
        return json(200, {
          code,
          pairingUrl: formatPairingUrl({
            relayOrigin: this.env.OPENCRAFT_RELAY_ORIGIN,
            machineId: body.machineId,
            code,
            approvalRequired,
          }),
          httpsPairingUrl: formatPairingUrl(
            {
              relayOrigin: this.env.OPENCRAFT_RELAY_ORIGIN,
              machineId: body.machineId,
              code,
              approvalRequired,
              ...(this.env.OPENCRAFT_WEB_APP_ORIGIN ? { webOrigin: this.env.OPENCRAFT_WEB_APP_ORIGIN } : {}),
            },
            "https",
          ),
          expiresAt: meta.expiresAt,
          approvalRequired,
        });
      } catch {
        return json(404, { error: "machine_not_found" });
      }
    }

    if (request.method === "POST" && url.pathname === "/machines/redeem-pair") {
      const body = (await request.json()) as { machineId?: unknown; rawSecret?: unknown };
      if (typeof body.machineId !== "string" || typeof body.rawSecret !== "string") {
        return json(400, { error: "invalid_request" });
      }
      const redeemed = this.#store.redeemPairingCode({
        codeHash: await sha256Hex(body.rawSecret),
        machineId: body.machineId,
        now,
      });
      if (!redeemed) return json(403, { error: "invalid_or_expired_pairing_code" });
      const machine = this.#store.listMachines().find((m) => m.machineId === body.machineId);
      return json(200, {
        actorId: profile.actorId,
        sessionEpoch: profile.sessionEpoch,
        approvalRequired: redeemed.approvalRequired,
        ...(machine?.displayName ? { displayName: machine.displayName } : {}),
      });
    }

    if (request.method === "POST" && url.pathname === "/machines/revoke") {
      const body = (await request.json()) as { machineId?: unknown };
      if (typeof body.machineId !== "string" || !isValidRelayMachineId(body.machineId)) {
        return json(400, { error: "invalid_machine_id" });
      }
      this.#store.revokeMachine(body.machineId, now);
      await this.#machineStub(body.machineId).fetch(
        new Request("https://machine-relay.internal/internal/revoke-machine", {
          method: "POST",
          headers: { [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE },
        }),
      );
      return json(200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/shares/create") {
      const body = (await request.json()) as {
        machineId?: unknown;
        label?: unknown;
        allowExecution?: unknown;
        threadIds?: unknown;
        ttlMs?: unknown;
      };
      if (typeof body.machineId !== "string" || !isValidRelayMachineId(body.machineId)) {
        return json(400, { error: "invalid_machine_id" });
      }
      const threadIds = Array.isArray(body.threadIds)
        ? body.threadIds
            .filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 256)
            .slice(0, 64)
        : undefined;
      const grantId = crypto.randomUUID();
      const rawSecret = randomBase64Url(24);
      const shareToken = `${profile.actorId.slice(6)}_${rawSecret}`;
      try {
        const summary = this.#store.createShareGrant({
          grantId,
          tokenHash: await sha256Hex(rawSecret),
          machineId: body.machineId,
          label: typeof body.label === "string" ? body.label : "Shared Agent",
          allowExecution: body.allowExecution !== false,
          ...(threadIds?.length ? { threadIds } : {}),
          ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
          now,
        });
        return json(200, {
          grant: summary,
          shareToken,
          shareUrl: formatShareUrl(this.env.OPENCRAFT_RELAY_ORIGIN, shareToken, this.env.OPENCRAFT_WEB_APP_ORIGIN),
        });
      } catch {
        return json(404, { error: "machine_not_found" });
      }
    }

    if (request.method === "POST" && url.pathname === "/shares/claim") {
      const body = (await request.json()) as { rawSecret?: unknown; granteeActorId?: unknown };
      if (typeof body.rawSecret !== "string" || typeof body.granteeActorId !== "string") {
        return json(400, { error: "invalid_request" });
      }
      if (body.granteeActorId === profile.actorId) {
        return json(400, { error: "cannot_claim_own_share" });
      }
      const claimed = this.#store.claimShareGrant({
        tokenHash: await sha256Hex(body.rawSecret),
        granteeActorId: body.granteeActorId,
        now,
      });
      if (!claimed) return json(403, { error: "share_unavailable" });
      const syncRes = await this.#machineStub(claimed.machineId).fetch(
        new Request("https://machine-relay.internal/internal/upsert-grant", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE,
          },
          body: JSON.stringify({
            grantId: claimed.grantId,
            granteeActorId: body.granteeActorId,
            allowExecution: claimed.allowExecution,
            ...(claimed.threadIds ? { threadIds: claimed.threadIds } : {}),
            grantEpoch: claimed.grantEpoch,
            expiresAt: claimed.expiresAt,
          }),
        }),
      );
      if (!syncRes.ok) return json(502, { error: "machine_grant_sync_failed" });
      const machine = this.#store.listMachines().find((m) => m.machineId === claimed.machineId);
      return json(200, {
        grant: claimed,
        ...(machine?.displayName ? { machineDisplayName: machine.displayName } : {}),
      });
    }

    if (request.method === "POST" && url.pathname === "/shares/revoke") {
      const body = (await request.json()) as { grantId?: unknown };
      if (typeof body.grantId !== "string" || !body.grantId) return json(400, { error: "invalid_grant_id" });
      const revoked = this.#store.revokeShareGrant(body.grantId, now);
      if (!revoked) return json(404, { error: "grant_not_found" });
      await this.#machineStub(revoked.machineId).fetch(
        new Request("https://machine-relay.internal/internal/revoke-grant", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE,
          },
          body: JSON.stringify({ grantId: body.grantId }),
        }),
      );
      return json(200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/license/activate") {
      const body = (await request.json()) as {
        licenseId?: unknown;
        tier?: unknown;
        machineLimit?: unknown;
        maxBlobBytes?: unknown;
        expiresAt?: unknown;
      };
      if (
        typeof body.licenseId !== "string" ||
        (body.tier !== "pro" && body.tier !== "team") ||
        typeof body.machineLimit !== "number" ||
        typeof body.maxBlobBytes !== "number" ||
        typeof body.expiresAt !== "number"
      ) {
        return json(400, { error: "invalid_license_payload" });
      }
      const updated = this.#store.activateLicense({
        licenseId: body.licenseId,
        tier: body.tier,
        machineLimit: body.machineLimit,
        maxBlobBytes: body.maxBlobBytes,
        expiresAt: body.expiresAt,
        now,
      });
      await Promise.all(
        this.#store.listMachines().map((m) =>
          this.#machineStub(m.machineId).fetch(
            new Request("https://machine-relay.internal/internal/set-max-blob-bytes", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER_VALUE,
              },
              body: JSON.stringify({ maxBlobBytes: updated.maxBlobBytes }),
            }),
          ),
        ),
      );
      return json(200, { ok: true, profile: updated });
    }

    return json(404, { error: "not_found" });
  }
}

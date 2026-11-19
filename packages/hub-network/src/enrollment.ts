import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { random, signed, parseInvitation, type HubStateOwner } from "./store.js";
import { publicOrigin, transportEndpoint } from "./contract.js";

export const HUB_ENROLLMENT_PATH = "/__opencraft_hub/join";
export interface HubEnrollmentProof {
  audience: "opencraft-hub-enrollment.v1";
  relay: string;
  hubId: string;
  publicKey: string;
  origin: string;
  timestamp: number;
  nonce: string;
}
export async function requestHubEnrollment(
  owner: HubStateOwner,
  endpoint: string,
  origin: string,
  ca: string | undefined,
  signal: AbortSignal,
) {
  transportEndpoint(endpoint);
  if (origin) publicOrigin(origin);
  const proof: HubEnrollmentProof = {
    audience: "opencraft-hub-enrollment.v1",
    relay: endpoint,
    hubId: owner.id,
    publicKey: owner.state.publicKey,
    origin,
    timestamp: Date.now(),
    nonce: random(),
  };
  const body = JSON.stringify({ ...proof, signature: signed(proof, owner.state.privateKey) });
  const url = new URL(HUB_ENROLLMENT_PATH, endpoint);
  const value = await new Promise<string>((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        ...(ca ? { ca } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Error("Relay enrollment denied"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) {
            res.destroy(Error("Invalid enrollment response"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  const { invitation } = JSON.parse(value),
    invite = parseInvitation(invitation);
  if (invite.endpoint !== endpoint) throw Error("Relay enrollment endpoint mismatch");
  return invitation as string;
}

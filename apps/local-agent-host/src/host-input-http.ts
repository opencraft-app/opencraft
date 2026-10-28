import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostInputPort } from "@opencraft/appserver-protocol/host-inputs";

/** Private loopback Host lane. It is never forwarded by the browser RPC proxy. */
export async function handleHostInput(request: IncomingMessage, response: ServerResponse, token: string, inputs: HostInputPort,
  authorize: ((threadId: string, inputId: string) => boolean | Promise<boolean>) | undefined, ownerReceipts?: {run<T>(operation:()=>Promise<T>,reconciliation?:boolean):Promise<T>;beginReceipt(request:unknown):(packet:Record<string,unknown>)=>unknown;acknowledgeReceipt(input:unknown):void}): Promise<void> {
  const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
  if (request.headers.origin !== undefined || request.headers.authorization !== `Bearer ${token}`) { send(403, { error: "denied" }); return; }
  if (request.method !== "POST" || request.headers["content-type"]?.split(";")[0] !== "application/json") { send(405, { error: "invalid_request" }); return; }
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 32_768) { send(413, { error: "body_too_large" }); return; } chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body?.action === "ack" && ownerReceipts) { ownerReceipts.acknowledgeReceipt(body.ownerReceipt);send(200,{accepted:true});return; }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["action", "threadId", "inputId", "text"].includes(key))
      || ![body.threadId, body.inputId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512)
      || !body.inputId.startsWith("actor-input:") || !["receipt", "submit"].includes(body.action)
      || body.action === "submit" && (typeof body.text !== "string" || !body.text.length)) { send(400, { error: "invalid_input" }); return; }
    const execute = async () => {
    const finish = body.action === "submit" ? ownerReceipts?.beginReceipt(body) : undefined;
    const receipt = body.action === "receipt" ? await inputs.receipt(body.threadId, body.inputId)
      : await inputs.submit(body.threadId, body.inputId, body.text, () => authorize?.(body.threadId, body.inputId) ?? false);
    const result = {receipt};
    send(200, {...result,...(finish ? {ownerReceipt:finish(result)} : {})});
    };
    if(ownerReceipts) await ownerReceipts.run(execute,body.action === "receipt");else await execute();
  } catch { send(503, { error: "input_outcome_unknown" }); }
}

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// These edits apply only to the separately locked native runtime. Refuse a
// changed boundary rather than silently shipping a partially fenced executor.
const gate = 'globalThis[Symbol.for("opencraft.dsh.owner.v1")]';
const required = 'process.env.OPENCRAFT_DSH_OWNER_REQUIRED === "1"';
export const ownerAdmissionEdits = {
  'dsh-session-persistence-jsonl': [
    ['\t\t\t\tif (first === void 0) continue;\n\t\t\t\tconst meta = parseHeaderMeta(first);', `\t\t\t\tif (first === void 0) { if (${required}) throw new Error("DSH history header missing"); continue; }\n\t\t\t\tconst meta = parseHeaderMeta(first);`],
    ['\t\t\t\tif (meta === void 0) continue;\n', `\t\t\t\tif (meta === void 0) { if (${required}) throw new Error("DSH history header invalid"); continue; }\n`],
  ],
  'dsh-agent-loop': [
    ['\t\tsignal.throwIfAborted();\n\t\tconst header = canonicalHeader({\n', '\t\tsignal.throwIfAborted();\n\t\tawait globalThis[Symbol.for("opencraft.dsh.model-policy.v1")]?.admit(session, turn, config);\n\t\tconst header = canonicalHeader({\n'],
    ['\t\t\t\tconst promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then((outcome) => {\n', `\t\t\t\tconst nativeOwner = ${required} ? ${gate} : null;\n\t\t\t\tconst effect = nativeOwner?.beginEffect({sessionId:String(session.id),turn,step,callId:call.block.id});\n\t\t\t\tconst promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then((outcome) => {\n\t\t\t\t\tnativeOwner?.effectResult(effect, outcome.result, signal.aborted);\n`],
    ['\t\t\tappendToolResult(session, turn, step, call.block, result, callSeqs[committed]);\n', `\t\t\tappendToolResult(session, turn, step, call.block, result, callSeqs[committed]);\n\t\t\tif (${required}) { await ctx.sessions.flush(session); ${gate}?.commitEffect({sessionId:String(session.id),turn,step,callId:call.block.id}); }\n`],
    ['\tsend(message, target, wakeup) {\n', `\tsend(message, target, wakeup) {\n\t\tif (${required}) {\n\t\t\tconst owner = ${gate};\n\t\t\tif (!owner) throw new Error("DSH owner authority unavailable");\n\t\t\tif (!owner.open()) {\n\t\t\t\tif (["user", "human"].includes(message.source?.kind)) throw new Error("DSH owner admission fenced");\n\t\t\t\ttarget = "next-turn"; wakeup = false;\n\t\t\t}\n\t\t}\n`],
    ['\twakeDriver(wakeAfterAbort = false) {\n', `\twakeDriver(wakeAfterAbort = false) {\n\t\tif (${required} && !${gate}?.open()) return;\n`],
    ['\t\tif (!this.inbox.hasPending) return false;\n', `\t\tif (!this.inbox.hasPending || (${required} && !${gate}?.open())) return false;\n`],
  ],
  'dsh-agent': [
    ['\tmutate(target, start, deleteCount, inserted, discardRemoved) {\n', `\tmutate(target, start, deleteCount, inserted, discardRemoved) {\n\t\tif (inserted.length && ${required} && !${gate}?.open()) {\n\t\t\tif (deleteCount) throw new Error("DSH inbox replacement fenced");\n\t\t\ttarget = "next-turn"; start = Infinity;\n\t\t}\n`],
  ],
  'dsh-host-apiproxy': [
    ['\t\tconst path = url.pathname;\n', `\t\tconst path = url.pathname;\n\t\tif (path === "/api/opencraft-owner-receipt" && ${required}) {\n\t\t\ttry { return Response.json(await ${gate}.receipt(await req.json())); }\n\t\t\tcatch { return new Response("DSH receipt rejected", {status:409}); }\n\t\t}\n`],
    ['\t\treturn handleUnary(api, method, message, req.signal);\n', `\t\tif (${required}) {\n\t\t\tconst owner = ${gate};\n\t\t\tif (!owner) return new Response("DSH owner unavailable", {status:503});\n\t\t\treturn owner.rpc(method, message, () => handleUnary(api, method, message, req.signal), req.headers.get("x-opencraft-owner-bootstrap"));\n\t\t}\n\t\treturn handleUnary(api, method, message, req.signal);\n`],
  ],
};
export async function patchDshOwnerAdmission(runtime) {
  const edits = [];
  for (const [name, replacements] of Object.entries(ownerAdmissionEdits)) {
    const path = resolve(runtime, `node_modules/@deepseek-ai/${name}/lib/index.js`);
    let source = await readFile(path, 'utf8');
    for (const [before, after] of replacements) {
      if (source.includes(after)) continue;
      if (source.split(before).length !== 2) throw new Error(`Pinned DSH owner boundary changed: ${name}`);
      source = source.replace(before, after);
    }
    edits.push([path, source]);
  }
  for (const [path, source] of edits) await writeFile(path, source);
}

export async function verifyDshOwnerAdmission(runtime) {
  const manifest = JSON.parse(await readFile(resolve(runtime,'node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
  if (manifest.version !== '0.1.1-rc.2') throw new Error('Unsupported DSH handoff compatibility baseline');
  for (const [name,edits] of Object.entries(ownerAdmissionEdits)) {
    const source = await readFile(resolve(runtime,`node_modules/@deepseek-ai/${name}/lib/index.js`),'utf8');
    if (edits.some(([,after])=>!source.includes(after))) throw new Error('DSH native owner admission missing');
  }
}

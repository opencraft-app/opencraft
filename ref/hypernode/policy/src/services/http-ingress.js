import { Service } from "@deepseek-ai/cordis";

const MAX_REQUEST_BYTES = 1024 * 1024;

function utf8Encode(text) {
  const bytes = [];
  for (const character of String(text)) {
    const value = character.codePointAt(0);
    if (value < 0x80) bytes.push(value);
    else if (value < 0x800) bytes.push(0xc0 | (value >> 6), 0x80 | (value & 63));
    else if (value < 0x10000) bytes.push(0xe0 | (value >> 12), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
    else bytes.push(0xf0 | (value >> 18), 0x80 | ((value >> 12) & 63), 0x80 | ((value >> 6) & 63), 0x80 | (value & 63));
  }
  return Uint8Array.from(bytes);
}

function utf8Decode(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    if (first < 0x80) text += String.fromCodePoint(first);
    else if ((first & 0xe0) === 0xc0) text += String.fromCodePoint(((first & 31) << 6) | (bytes[index++] & 63));
    else if ((first & 0xf0) === 0xe0) text += String.fromCodePoint(((first & 15) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63));
    else text += String.fromCodePoint(((first & 7) << 18) | ((bytes[index++] & 63) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63));
  }
  return text;
}

function concat(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function indexOf(bytes, sequence) {
  outer: for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function requestHead(bytes) {
  const marker = utf8Encode("\r\n\r\n");
  const headerEnd = indexOf(bytes, marker);
  if (headerEnd < 0) return null;
  const lines = utf8Decode(bytes.slice(0, headerEnd)).split("\r\n");
  const [method, target] = String(lines.shift() ?? "").split(" ");
  const headers = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { headerEnd, marker, method, target, headers };
}

const HTTP_PREFIXES = ["GET ", "POST ", "PUT ", "PATCH ", "DELETE ", "HEAD ", "OPTIONS "];

function protocol(bytes) {
  const prefix = String.fromCharCode(...bytes.slice(0, 8));
  if (prefix.startsWith("SSH-")) return "ssh";
  if (HTTP_PREFIXES.some((candidate) => prefix.startsWith(candidate))) return "http";
  if (bytes.length < 8 && [...HTTP_PREFIXES, "SSH-"].some((candidate) => candidate.startsWith(prefix))) return null;
  return "ssh";
}

function jsonResponse(status, value) {
  return response(status, JSON.stringify(value), "application/json; charset=utf-8");
}

function response(status, body, contentType) {
  const reason = { 200: "OK", 201: "Created", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error" }[status] ?? "Error";
  const payload = utf8Encode(body);
  const head = utf8Encode([
    `HTTP/1.1 ${status} ${reason}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${payload.length}`,
    "Cache-Control: no-store",
    "Connection: close",
    "",
    "",
  ].join("\r\n"));
  return concat(head, payload);
}

const DASHBOARD = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HyperNode</title><style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#171717;background:#f7f7f5}body{margin:0}.wrap{max-width:860px;margin:7vh auto;padding:24px}.card{background:white;border:1px solid #ddd;border-radius:18px;padding:26px;margin-bottom:18px;box-shadow:0 8px 32px #0000000d}h1,h2{margin:0 0 8px}h1{font-size:28px}h2{font-size:20px}p{color:#666}label{display:block;margin:18px 0 6px;font-weight:600}input,select,button{box-sizing:border-box;width:100%;font:inherit;padding:12px 14px;border:1px solid #ccc;border-radius:10px}button{margin-top:22px;background:#171717;color:white;border:0;cursor:pointer}.status{margin-top:18px;white-space:pre-wrap}.ok{color:#08783e}.error{color:#b42318}
</style></head><body><main class="wrap"><section class="card"><h1>☁️ HyperNode</h1><p>自包含的 Cordis 动态管理面板。</p><label>SSH 用户</label><select id="username"></select></section><div id="forms"></div></main>
<script>
const users=document.querySelector('#username'),root=document.querySelector('#forms');
boot().catch(show);users.addEventListener('change',load);
async function boot(){const v=await get('/api/users');users.innerHTML=v.users.map(u=>'<option>'+esc(u.username)+'</option>').join('');await load()}
async function load(){const v=await get('/api/dashboard?username='+encodeURIComponent(users.value));root.innerHTML='';v.forms.forEach(render)}
function render(spec){const card=document.createElement('section'),form=document.createElement('form');card.className='card';form.innerHTML='<h2>'+esc(spec.title)+'</h2>'+(spec.description?'<p>'+esc(spec.description)+'</p>':'');for(const field of spec.fields){const label=document.createElement('label'),input=document.createElement(field.type==='select'?'select':'input');label.textContent=field.label;input.name=field.id;if(input.tagName==='INPUT')input.type=field.type||'text';input.required=!!field.required;input.placeholder=field.placeholder||'';input.autocomplete=field.autocomplete||'';for(const option of field.options||[]){const node=document.createElement('option');node.value=option.value;node.textContent=option.label;input.append(node)}if(field.value!=null)input.value=field.value;label.append(input);form.append(label)}const button=document.createElement('button'),status=document.createElement('div');button.textContent=spec.submitLabel||'提交';status.className='status';form.append(button);form.addEventListener('submit',e=>submit(e,spec,status));card.append(form,status);root.append(card)}
async function submit(event,spec,status){event.preventDefault();const form=event.currentTarget,username=users.value,values=Object.fromEntries(new FormData(form));status.className='status';status.textContent='正在提交…';try{const r=await fetch('/api/dashboard/actions/'+encodeURIComponent(spec.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,values})});const v=await r.json();if(!r.ok)throw Error(v.error||r.statusText);form.querySelectorAll('input[type=password]').forEach(n=>n.value='');status.className='status ok';status.textContent='已完成'}catch(e){status.className='status error';status.textContent=e.message||String(e)}}
async function get(url){const r=await fetch(url),v=await r.json();if(!r.ok)throw Error(v.error||r.statusText);return v}function show(e){root.className='error';root.textContent=e.message||String(e)}function esc(v){const n=document.createElement('span');n.textContent=String(v);return n.innerHTML}
</script></body></html>`;

export class HttpIngressService extends Service {
  constructor(ctx) {
    super(ctx, "httpIngress");
    this.connections = new Map();
  }

  open(metadata) {
    this.connections.set(metadata.connectionId, { mode: null, bytes: new Uint8Array(), responded: false });
    return { allow: true, stdoutBytes: [] };
  }

  data(metadata) {
    const state = this.connections.get(metadata.connectionId);
    if (!state) return { allow: false };
    if (state.mode === "ssh") return this.ctx.vssh.data(metadata);
    if (state.mode === "model-gateway") return this.ctx.modelGatewayIngress.data(metadata);
    if (state.mode === "direct-websocket") return this.ctx.directWebSocketTransport.data(metadata);
    state.bytes = concat(state.bytes, Uint8Array.from(metadata.dataBytes ?? []));
    if (state.bytes.length > MAX_REQUEST_BYTES) return this.finish(state, jsonResponse(400, { error: "request too large" }));
    if (state.mode == null) {
      state.mode = protocol(state.bytes);
      if (state.mode == null) return { allow: true, stdoutBytes: [] };
      if (state.mode === "ssh") {
        const opened = this.ctx.vssh.open(metadata);
        const data = this.ctx.vssh.data({ ...metadata, dataBytes: state.bytes });
        state.bytes = new Uint8Array();
        return { ...data, stdoutBytes: concat(Uint8Array.from(opened.stdoutBytes ?? []), Uint8Array.from(data.stdoutBytes ?? [])) };
      }
    }
    if (state.mode === "http") {
      const head = requestHead(state.bytes);
      if (head) {
        const target = String(head.target ?? "");
        if (head.method === "GET"
          && String(head.headers.upgrade ?? "").toLowerCase() === "websocket"
          && String(head.headers.connection ?? "").toLowerCase().split(",").map((value) => value.trim()).includes("upgrade")) {
          state.mode = "direct-websocket";
          const opened = this.ctx.directWebSocketTransport.open({
            ...metadata,
            target,
            headers: head.headers,
          });
          if (opened.closeAfterWrite === true || opened.allow === false) {
            state.responded = true;
            return opened;
          }
          const bytes = state.bytes;
          state.bytes = new Uint8Array();
          return this.ctx.directWebSocketTransport.data({ ...metadata, dataBytes: bytes });
        }
        if (/^\/providers\/[^/?#]+\/v1\/(?:responses|chat\/completions)(?:[?#].*)?$/.test(target)) {
          state.mode = "model-gateway";
          this.ctx.modelGatewayIngress.open(metadata);
          const bytes = state.bytes;
          state.bytes = new Uint8Array();
          return this.ctx.modelGatewayIngress.data({ ...metadata, dataBytes: bytes });
        }
      }
    }
    return this.consumeHTTP(state);
  }

  consumeHTTP(state) {
    const head = requestHead(state.bytes);
    if (!head) return { allow: true, stdoutBytes: [] };
    const { headerEnd, marker, method, target, headers } = head;
    const length = Number(headers["content-length"] ?? 0);
    const bodyStart = headerEnd + marker.length;
    if (!Number.isInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) return this.finish(state, jsonResponse(400, { error: "invalid content-length" }));
    if (state.bytes.length < bodyStart + length) return { allow: true, stdoutBytes: [] };
    try {
      return this.finish(state, this.route(method, target, utf8Decode(state.bytes.slice(bodyStart, bodyStart + length))));
    } catch (error) {
      return this.finish(state, jsonResponse(400, { error: error.message ?? String(error) }));
    }
  }

  route(method, target, body) {
    const path = String(target ?? "").split("?", 1)[0];
    if (method === "GET" && path === "/") return response(200, DASHBOARD, "text/html; charset=utf-8");
    if (method === "GET" && path === "/healthz") return jsonResponse(200, { ok: true, transports: ["ssh", "http", "websocket", "model-gateway"], port: 9988 });
    if (method === "GET" && path === "/api/users") {
      return jsonResponse(200, { users: this.ctx.userDirectory.list().map((user) => ({ username: user.username })) });
    }
    if (method === "GET" && path === "/api/dashboard") {
      const username = decodeURIComponent(String(target).match(/[?&]username=([^&]*)/)?.[1] ?? "");
      const user = this.ctx.userDirectory.list().find((candidate) => candidate.username === username);
      if (!user) throw new Error("unknown SSH user");
      return jsonResponse(200, { forms: this.ctx.dashboard.describe(user) });
    }
    const action = path.match(/^\/api\/dashboard\/actions\/([^/]+)$/)?.[1];
    if (method === "POST" && action) {
      const params = JSON.parse(body || "{}");
      const user = this.ctx.userDirectory.list().find((candidate) => candidate.username === String(params.username ?? ""));
      if (!user) throw new Error("unknown SSH user");
      return jsonResponse(200, this.ctx.dashboard.submit(user, decodeURIComponent(action), params.values));
    }
    return jsonResponse(404, { error: "not found" });
  }

  finish(state, bytes) {
    state.responded = true;
    hostEvents.notify();
    return { allow: true, sensitive: true, stdoutBytes: bytes };
  }

  poll(metadata) {
    const state = this.connections.get(metadata.connectionId);
    if (!state || state.responded) return { allow: false };
    if (state.mode === "ssh") return this.ctx.vssh.poll(metadata);
    if (state.mode === "model-gateway") return this.ctx.modelGatewayIngress.poll(metadata);
    if (state.mode === "direct-websocket") return this.ctx.directWebSocketTransport.poll(metadata);
    return { allow: true, stdoutBytes: [] };
  }

  close(metadata) {
    const state = this.connections.get(metadata.connectionId);
    this.connections.delete(metadata.connectionId);
    if (state?.mode === "ssh") return this.ctx.vssh.close(metadata);
    if (state?.mode === "model-gateway") return this.ctx.modelGatewayIngress.close(metadata);
    if (state?.mode === "direct-websocket") return this.ctx.directWebSocketTransport.close(metadata);
    return { allow: true, stdoutBytes: [] };
  }
}

HttpIngressService.inject = ["dashboard", "directWebSocketTransport", "modelGatewayIngress", "userDirectory", "vssh"];

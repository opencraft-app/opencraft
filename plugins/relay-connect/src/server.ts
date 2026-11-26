import type { Duplex } from "node:stream";
import { createConnection } from "node:net";
import WebSocket from "ws";
import { bridgeRelayDuplex, relayDuplex, relayIdleDeadline } from '@opencraft/relay-protocol/node';
import { AssertionProvider, readPrivateJson, type AssertionProviderOptions } from '@opencraft/identity-core/node';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  CONTROL_PATH,
  DATA_PATH,
  STREAM_HEADER,
  RELAY_PROTOCOL,
  MAX_RELAY_STREAMS,
  parseOpen,
  DRAIN_HEADER,
  DRAIN_CAPABILITY,
  MACHINE_GATEWAY_CONTROL_PATH,
  MACHINE_GATEWAY_DATA_PATH,
} from "@opencraft/relay-protocol";

export type RelayConnectOptions = {
  readonly machineGateway?: boolean;
  readonly relay: string;
  readonly credential: string;
  readonly allowLoopbackInsecure?: boolean;
  readonly ca?: string;
  readonly headers?: Readonly<Record<string, string>>;
} & (
  | { readonly targetPort: number; readonly acceptStream?: never }
  | { readonly targetPort?: never; readonly acceptStream: (stream: Duplex) => void }
);
export async function loadRelayConnection(path: string, assertionOptions: AssertionProviderOptions = {}) {
  const input = await readPrivateJson(path) as Record<string, unknown>;
  if (!input || input.schemaVersion !== 1 || Object.keys(input).some(k => !['schemaVersion', 'relay', 'credential', 'targetPort', 'allowLoopbackInsecure', 'issuer', 'instanceId', 'origin', 'publicKey', 'caFile'].includes(k))
    || !['relay', 'credential', 'issuer', 'instanceId', 'origin', 'publicKey'].every(k => typeof input[k] === 'string')
    || (input.targetPort !== undefined && (!Number.isInteger(input.targetPort) || Number(input.targetPort) < 1 || Number(input.targetPort) > 65535))
    || (input.allowLoopbackInsecure !== undefined && typeof input.allowLoopbackInsecure !== 'boolean')) throw new Error('Invalid private relay connection');
  const provider = new AssertionProvider({ issuer: String(input.issuer), instanceId: String(input.instanceId), origin: String(input.origin) }, String(input.publicKey), Date.now, assertionOptions);
  if (input.caFile !== undefined && (typeof input.caFile !== 'string' || !isAbsolute(input.caFile))) throw new Error('Relay CA file requires an absolute path');
  const ca = input.caFile ? await readFile(String(input.caFile), 'utf8') : undefined;
  if (ca !== undefined && (ca.length > 262_144 || !ca.includes('-----BEGIN CERTIFICATE-----'))) throw new Error('Invalid relay CA bundle');
  return { provider, options: { relay: String(input.relay), credential: String(input.credential), targetPort: input.targetPort as number | undefined,
    allowLoopbackInsecure: input.allowLoopbackInsecure === true, ca } };
}
/** The operator pins one literal loopback target; the relay never supplies a target URL/port. */
export function connectRelay(options: RelayConnectOptions) {
  const endpoint = new URL(options.relay);
  const validTarget = typeof options.acceptStream === "function"
    ? options.targetPort === undefined
    : Number.isInteger(options.targetPort) && Number(options.targetPort) >= 1 && Number(options.targetPort) <= 65535;
  if (endpoint.origin !== options.relay || endpoint.username || endpoint.password
    || (endpoint.protocol !== 'https:' && !(options.allowLoopbackInsecure && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'))
    || !/^[A-Za-z0-9_-]{43}$/u.test(options.credential) || !validTarget) throw new Error('Invalid relay connection configuration');
  const base = endpoint.origin.replace(/^http/u, 'ws');
  const controlPath = options.machineGateway ? MACHINE_GATEWAY_CONTROL_PATH : CONTROL_PATH;
  const dataPath = options.machineGateway ? MACHINE_GATEWAY_DATA_PATH : DATA_PATH;
  const streams = new Set<WebSocket>();
  let control: WebSocket | undefined, stopped = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0;
  let lastPong = Date.now();
  const open = () => {
    if (stopped) return;
    const owned = new Set<WebSocket>();
    let preservesStreams = false;
    const ws = new WebSocket(base + controlPath, RELAY_PROTOCOL, { ca: options.ca, headers: { ...options.headers, authorization: `Bearer ${options.credential}`, [DRAIN_HEADER]: DRAIN_CAPABILITY }, perMessageDeflate: false, maxPayload: 4096, handshakeTimeout: 10_000 }); control = ws;
    ws.once('upgrade', response => { preservesStreams = response.headers[DRAIN_HEADER] === DRAIN_CAPABILITY; });
    ws.on('unexpected-response', (_request, response) => {
      if (control === ws && [401, 403].includes(response.statusCode ?? 0)) for (const stream of streams) stream.terminate();
      response.resume(); ws.terminate();
    });
    ws.on('open', () => { attempts = 0; lastPong = Date.now(); }); ws.on('error', () => {}); ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('message', raw => {
      try {
        if (stopped || control !== ws) return;
        const frame = parseOpen(JSON.parse(raw.toString()));
        // A completed server stream can still be closing locally. Reject only
        // this new open; its existing server deadline releases the reservation.
        // Capacity pressure must not revoke the control link and every live stream.
        if (streams.size >= MAX_RELAY_STREAMS) return;
        const data = new WebSocket(base + dataPath, RELAY_PROTOCOL, { ca: options.ca, headers: { authorization: `Bearer ${frame.token}`, [STREAM_HEADER]: frame.id }, perMessageDeflate: false, maxPayload: 65_536, handshakeTimeout: 10_000 });
        const idle = relayIdleDeadline(data, () => data.terminate());
        streams.add(data); owned.add(data); data.on('error', () => {}); data.once('close', () => { idle(); streams.delete(data); owned.delete(data); });
        data.once('open', () => {
          if (stopped || (!preservesStreams && control !== ws)) { data.terminate(); return; }
          const stream = relayDuplex(data);
          if (options.acceptStream) {
            try { options.acceptStream(stream); } catch { stream.destroy(); data.terminate(); }
            return;
          }
          const target = createConnection({ host: '127.0.0.1', port: options.targetPort });
          bridgeRelayDuplex(stream, target);
        });
      } catch { preservesStreams = false; ws.close(1008, 'Invalid relay control message'); }
    });
    ws.once('close', code => {
      // Policy/protocol rejection and explicit stop never retain data channels.
      // Each generation owns its own cleanup, including late close callbacks.
      if (stopped || !preservesStreams || ![1006, 1012].includes(code)) {
        for (const stream of control === ws && code === 1008 ? streams : owned) stream.terminate();
      }
      if (!stopped && control === ws) { attempts++; timer = setTimeout(open, Math.min(30_000, 250 * 2 ** Math.min(attempts, 7)) + Math.floor(Math.random() * 250)); timer.unref(); }
    });
  };
  const heartbeat = setInterval(() => {
    if (control?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > 45_000) control.terminate(); else control.ping();
  }, 15_000); heartbeat.unref(); open();
  return { connected: () => control?.readyState === WebSocket.OPEN, close() {
    stopped = true; clearTimeout(timer); clearInterval(heartbeat); control?.terminate(); for (const stream of streams) stream.terminate(); streams.clear();
  } };
}

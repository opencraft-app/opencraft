import WebSocket, { createWebSocketStream } from 'ws';
/** Shared byte transport for ordinary relay and Hub links; owners enforce admission and lifetime. */
export function relayDuplex(socket: WebSocket) { return createWebSocketStream(socket, { highWaterMark: 65_536 }); }

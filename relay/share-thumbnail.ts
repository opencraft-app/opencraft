import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

/** Only this product-owned raster is public; application admission stays in Relay. */
export function installJoinShareThumbnail(server: Server, image: Buffer): void {
  const etag = '"' + createHash('sha256').update(image).digest('hex') + '"';
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if ((request.url ?? '').split('?')[0] !== '/plugin-assets/join/join-share-thumbnail-v2.jpg') {
      for (const listener of listeners) listener.call(server, request, response);
      return;
    }
    response.setHeader('x-content-type-options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      response.end(); return;
    }
    response.setHeader('content-type', 'image/jpeg');
    response.setHeader('cache-control', 'public, max-age=86400');
    response.setHeader('etag', etag);
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304); response.end(); return;
    }
    response.writeHead(200, { 'content-length': image.length });
    response.end(request.method === 'HEAD' ? undefined : image);
  });
}

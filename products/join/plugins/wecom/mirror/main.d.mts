import type { RelayRedis } from '../../../../../apps/relay-server/src/redis.js';
import type { RelayIngress } from '../../../../../apps/relay-server/src/server.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '@opencraft/identity-core';
import type { RelayServerDirectory } from '../../../../../apps/relay-server/src/server.js';
import type { RelayEntryIdentity } from '../../../../../apps/relay-server/src/server.js';
interface SelectionOptions {
  listServers?: (principal: Principal) => Promise<RelayServerDirectory>;
  authenticateEntryRequest?: (request: IncomingMessage) => Promise<RelayEntryIdentity | null>;
  beginEntryAuthentication?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}
export const MIRROR_PATH: '/__opencraft_wecom_mirror';
export function createMirrorIngress(file: string, redis?: RelayRedis, options?: SelectionOptions): Promise<RelayIngress>;
export function createForwardingIngress(file: string, redis: RelayRedis | undefined, callbackIngress: (callback: {
  path: string;
  handle(request: IncomingMessage, response: ServerResponse, forward: (body: string) => Promise<void>): Promise<void>;
}) => RelayIngress, options?: SelectionOptions & {fetcher?: typeof fetch}): Promise<RelayIngress>;

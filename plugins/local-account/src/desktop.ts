import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActorContext } from '@opencraft/identity-core/actors';

export interface NativeHumanSubmission {
  readonly sender: null;
  readonly actorContext: ActorContext;
  readonly validUntil: number;
  readonly resourceOwner: { readonly id: string; assertCurrent(): void };
}
import { ActorStore } from '@opencraft/access-control/actors';
import { HumanAccounts } from '@opencraft/access-control/human-accounts';
import { HumanAuth } from '@opencraft/access-control/human-auth';
import { MembershipStore } from '@opencraft/access-control';
import { HumanAccountManagement } from '@opencraft/access-control/account-management';
import { LocalAccountServerPlugin } from './server.js';
import { LocalAccountApplication } from './application.js';

/** Native Main owns these stores and the private browser proof. No renderer supplies identity. */
export async function createDesktopAccountHost(directory: string, renderLogin: (nonce: string) => string, options: { openRemote?: (origin: string) => Promise<void> } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const disposers: (() => void)[] = [];
  const disposeAll = () => {
    const failures: unknown[] = [];
    for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Desktop account shutdown failed');
  };
  try {
    const actors = new ActorStore(join(directory, 'actors.sqlite'));
    disposers.push(() => actors.close());
    const accounts = new HumanAccounts(join(directory, 'human-logins.sqlite'), actors);
    disposers.push(() => accounts.close());
    accounts.registerLocalAccounts(new LocalAccountServerPlugin(accounts.localAccountRepository));
    const members = new MembershipStore(join(directory, 'memberships.sqlite'));
    disposers.push(() => members.close());
    const management = new HumanAccountManagement(join(directory, 'account-onboarding.sqlite'), accounts, actors, members);
    disposers.push(() => management.close());
    // Default desktop remains immediately usable; /setup is also available as a management entry.
    if (management.status().state !== 'complete') await management.initialize({ mode: 'desktop' });
    const configuration = { origin: '', local: true, oidc: [] };
    const auth = new HumanAuth(accounts, actors, configuration, renderLogin);
    disposers.push(() => auth.close());
    const browserProof = randomBytes(32).toString('base64url');
    const nativeOwner = (request: IncomingMessage) => {
      const raw = request.headers.cookie;
      if (typeof raw !== 'string' || raw.length > 16_384) return false;
      const values = raw.split(';').map(value => value.trim()).filter(value => value.startsWith('oc_desktop_owner='));
      if (values.length !== 1) return false;
      const value = values[0]!.slice('oc_desktop_owner='.length);
      return Buffer.byteLength(value) === Buffer.byteLength(browserProof) && timingSafeEqual(Buffer.from(value), Buffer.from(browserProof));
    };
    const application = new LocalAccountApplication({ auth, management, nativeOwner, openRemote: options.openRemote });
    disposers.push(() => application.close());
    let nativeSession = accounts.issue(management.desktopIdentity());
    return {
      browserProof,
      get browserSessionToken() { return nativeSession.token; },
      createNativeSession() {
        if (!accounts.authenticate(nativeSession.token) || nativeSession.login.context.expiresAt <= Date.now() + 60_000) nativeSession = accounts.issue(management.desktopIdentity());
        return nativeSession.token;
      },
      authenticateSession(token: string): NativeHumanSubmission | null {
        const login = accounts.authenticate(token);
        if (!login || members.actorMembership(login.context.actorId)?.enabled !== true) return null;
        const assertCurrent = () => {
          if (!accounts.authenticate(token) || members.actorMembership(login.context.actorId)?.enabled !== true) throw new Error('Human access revoked');
        };
        return { sender: null, actorContext: login.context, validUntil: login.context.expiresAt,
          resourceOwner: { id: login.context.actorId, assertCurrent } };
      },
      setOrigin(origin: string) {
        const url = new URL(origin);
        if (configuration.origin || url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Desktop account origin requires its private loopback listener');
        configuration.origin = origin;
      },
      async handle(request: IncomingMessage, response: ServerResponse) {
        if (!configuration.origin || request.headers.host !== new URL(configuration.origin).host) return false;
        const path = new URL(request.url ?? '/', configuration.origin).pathname;
        if (!['/setup', '/__opencraft_account', '/__opencraft_auth'].some(base => path === base || path.startsWith(base + '/'))) return false;
        if (await application.handle(request, response)) return true;
        return auth.handle(request, response);
      },
      close: disposeAll,
    };
  } catch (error) {
    try { disposeAll(); } catch { /* preserve initialization failure */ }
    throw error;
  }
}

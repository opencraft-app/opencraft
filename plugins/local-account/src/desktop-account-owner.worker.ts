// The desktop account owner Worker: the Server installation in the desktop
// human-account directory (writer lock, migrations, import) plus the one
// local-account write that must not run on Electron Main, the login-time
// password record upgrade. Main reaches it through `openServerCoreOwner(...).call`.
import { serveServerCoreOwner } from '@opencraft/storage-node/server-owner-serve';
import { localAccountPasswordUpgrade } from '@opencraft/access-control/local-account-upgrade-owner';

serveServerCoreOwner(owner => ({
  methods: {
    /** Compare-and-set on enabled, version and the verified record; see `localAccountPasswordUpgrade`. */
    upgradeLocalPassword: localAccountPasswordUpgrade(owner.database),
  },
}));

# Native Replica database identity

The native Replica adapter defaults to `opencraft-appserver-replica.db`.
The public Expo application selects `opencraft-workbench-replica.db`. These two
owned names have exact former-file inputs; custom database names remain opaque.

Before opening a current file, the single native application's storage owner
checks whether it already exists. Existing current state wins, including an
empty cache. A missing former file leaves fresh creation to SQLite. No directory
or account enumeration is used.

If only the former file exists, the Expo SQLite adapter validates its schema and
quick check, then serializes a consistent database snapshot through SQLite.
This reads committed WAL data through the database engine; copying just a live
`.db` file would omit it. A separate temporary file is written completely before
a non-overwriting move installs the current filename. The original file remains
intact. Failed snapshot/install leaves it recoverable, and the in-process gate
releases for retry. Concurrent clients of this native owner share one operation.
No two installed application versions are intended to write the same private
native storage directory simultaneously.

The Replica table/schema, storage keys, account/Host scopes, epochs, cursors and
payloads do not change. Clearing the current cache never imports old rows again.
Published product SQLite migrations are unchanged. A source-code merge does not
move an installed user's data or update an Android/iOS application.

Tests cover the migration gate and real SQLite backup/WAL/cursor behavior on
Node. That backup substitutes for the native serialize boundary; it does not
claim execution of Expo native modules. iOS bundle and Expo Web export check the
platform import closure. Actual Android/iOS installation and on-device migration
remain distinct hardware acceptance.

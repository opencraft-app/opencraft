# AppServer Channel models

These finite TLA+ models cover the channel sync and send contracts. They use
the application and its runtime tests as separate evidence.

| Model | Runtime boundary | Checked properties |
| --- | --- | --- |
| [ChannelSync](ChannelSync.tla) | `NativeChannels.sync`, the SQLite change index and the Workbench subscription loop | A cursor cannot advance past an unapplied current projection. Applied revisions and message states never regress. A stable connection with a sync wake eventually applies the demanded state. |
| [ChannelSend](ChannelSend.tla) | native channel admission, `ChannelSync` and startup reconciliation | A durable claim precedes provider handoff. A key claims a single payload and keeps its terminal receipt. Each provider step is called at most once. An image handoff requires a confirmed attribution. Retries return the same scoped intent or conflict. |
| [NativeChannelWake](NativeChannelWake.tla) | A native Channel send, its durable execution requests and the queue claim gate | A send commits its selected wake requests atomically. Each Bot claims at most once across retries and restart. A removal and rejoin fences the previous membership epoch. |

The sync model uses three messages and one message per delta page. It models
the database read and client apply separately, including concurrent commits,
coalesced revisions, dropped hints, a lost response and reconnect. Reconnect
forces a read from the last applied cursor. Progress assumes an eventually
stable connection and fair scheduling of enabled fetch and apply operations.
While connected, progress for a new change assumes the client gets a wake.
The recent snapshot fits in the model and represents the loaded history window.

The send model uses one client message ID across three actor and channel
scopes, with text and image payloads. The atomic claim represents the SQLite
unique insert. The model counts calls to the provider, allows lost receipts
and crashes, and resolves interrupted attempts to `unknown` on restart. It
does not assume that a provider ACK eventually arrives. The model covers
Headless state. Provider-side delivery, missed WeCom callbacks and the
implementation's conformance to this abstraction need separate evidence.

The native model bounds a single send key and two Bots. It explores retry,
restart, removal, rejoin and queue claim in arbitrary order. It models the
existing queue's durable claim as a single step. Runtime acknowledgement
loss and authorization in the AppHost adapter are covered by integration tests.

Run with Java and the official [TLA+ v1.8.0 tools jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0).
The published SHA-1 of the jar used for this check is
`0b57675323babad8ab3815b1db9f30e75dac1cdb`.

```sh
cd plugins/im/spec
java -cp /absolute/path/tla2tools.jar tlc2.TLC -workers 2 -noGenerateSpecTE -metadir /tmp/opencraft-channel-sync ChannelSync.tla
java -cp /absolute/path/tla2tools.jar tlc2.TLC -workers 2 -noGenerateSpecTE -metadir /tmp/opencraft-channel-send ChannelSend.tla
java -cp /absolute/path/tla2tools.jar tlc2.TLC -workers 2 -noGenerateSpecTE -metadir /tmp/opencraft-native-wake NativeChannelWake.tla
```

Pass one of the following files with `-config` to replay a deliberately
broken model. TLC should report the named violation.

| Config | Expected violation |
| --- | --- |
| `ChannelSync-SkipPage.cfg` | `CursorSound` |
| `ChannelSync-MissingUpdate.cfg` | `CursorSound` |
| `ChannelSync-MissingReconnectWake.cfg` | `CatchUp` |
| `ChannelSync-DropQueuedWake.cfg` | `CatchUp` |
| `ChannelSend-RetryUnknown.cfg` | `AtMostOnce` |
| `ChannelSend-CrossScopeReply.cfg` | `CorrectReply` |

The [real WebSocket integration test](../../../tests/extensions/im-channels-appserver.test.ts)
exercises the production path with a simulated provider. It checks a lost send
response, a service restart, bounded delta pages, an image state change and
reuse of the original send key.

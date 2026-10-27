# Remote interaction

Shared credit accounting, feedback and transport adapters for an existing remote
resource. The host retains resource creation, authorization, control leases,
document fences, DOM and decoder ownership.

| Entry | API | Runtime |
|---|---|---|
| root | CreditWindow, packetId, protocol parsers, transport contracts | Environment independent |
| /websocket | bindWebSocketInput, WebSocketMediaReceiver | WebSocket host |
| /webrtc | bindWebRTCInput | Existing reliable ordered RTCDataChannel |
| /server | MediaFlow | Gateway media adapter |
| spec/ | Protocol, TLA+ models and verifier | TLC, independent of the app |

The root contract has no React, Electron, Node or DOM import. Adapters accept
an already authorized attachment and existing channel. They do not create tabs,
negotiate ICE, change navigation or bypass authority. A DataChannel configured
with packet lifetime/retransmit limits or unordered delivery is rejected for
input. Both input adapters cap a message and local buffering at 64 KiB, return
sent/blocked/closed/oversize/unknown, and keep no replay queue.

The current browser uses WSS and the shared credit ledger. The RTC input adapter
has a real two-peer browser smoke test. Browser-service signaling, RTP video,
track recovery and automatic WSS/RTC switching are not implemented. Declaring
TransportKind does not advertise those capabilities to a user.

See [the wire protocol](spec/protocol.md) for reset and feedback semantics.
Run npm run test:remote-interaction from the repository root. Real browser
checks are npm run smoke:remote-interaction and npm run smoke:remote-interaction:rtc.
The first needs the normal packaged browser runtime and WebCodecs; both accept
OPENCRAFT_CHROMIUM_EXECUTABLE. These are isolated fixtures, not production
latency measurements or physical-device validation.

Formal checks:

~~~sh
python3 packages/remote-interaction/spec/verify.py \
  --jar /path/to/tla2tools.jar --output /tmp/interaction-formal
~~~

The verifier pins the official TLC binary hash. It checks finite credit and
recovery models and requires six deliberate mutants to fail. These model
checks do not establish implementation refinement or unrestricted correctness.

The /policy entry provides bounded input adaptation and exactly two adaptive
encoding buckets; the browser Gateway negotiates renewable native production
permits. Per-viewer and receiver diagnostics distinguish feedback evidence.
The absolute media window is twelve frames, with an adaptive working window.
ProducerDemand adds a finite two-consumer/two-bucket permit model with explicit
strong fairness assumptions and two more deliberate mutants (six total).

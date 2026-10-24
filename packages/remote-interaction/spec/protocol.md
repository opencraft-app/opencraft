# Remote interaction protocol v1

## Authority and delivery

Resource identity, native incarnation, connection generation, document identity,
and controller token have different lifetimes. An adapter attaches an existing
resource; its local identity is not an authorization credential. The Gateway and
native worker retain all existing authentication, visibility, document and
control checks. Reattaching transport does not navigate or replay input.

Input is reliable ordered. Each acknowledged input reserves one exact request ID
in a connection-local two-item/64-KiB credit window. Only its matching result
returns that credit. Caller timeout settles unknown and requests reconnection,
while retaining the debt until this connection retires. Unknown is never success;
there is no retry of the original operation. A retired local ledger is not
evidence that a previously dispatched native side effect was undone.

## WSS media negotiation

The existing open request may include mediaFeedback:1 and mediaStage:rendered or
received. Older peers remain on the existing bufferedAmount/keyframe flow.
After the open result the server sends:

~~~json
{"type":"media-config","version":1,"epoch":"opaque-nonreused-generation","stage":"rendered","profile":"h264-timestamp-v1","maxFrameBytes":4194304}
~~~

Media remains the existing nine-byte header: key flag at byte 0, uint64 BE
microsecond timestamp at bytes 1..8, followed by H264 Annex B payload. The
timestamp's decimal string identifies a frame within this ordered generation.
A different binary framing profile requires explicit negotiation.

Before sending ready the receiver synchronously discards its old decoder,
pending frame and media-buffer work. Old decoder callbacks are fenced by their
instance. The server pauses media and retains previous credits until matching
ready for this new epoch. An epoch is not reused. Duplicate ready in a live
generation cannot erase new work.

~~~json
{"version":1,"epoch":"opaque-nonreused-generation","received":null,"rendered":null,"ready":true,"fps":30}
~~~

Feedback travels in an existing quiet mediaFeedback request. Both watermark
fields are required: null or an unsigned decimal frame ID, never a JavaScript
number. Optional fps is an integer 5..30; optional requestReset asks for a new
handshake. Stale epochs, future IDs and malformed feedback cannot refund credit.

## Evidence and backpressure

Received means the client has accepted the packet into its receiver path.
Rendered means WebCodecs produced the frame and Canvas drawImage completed
submission. It does not prove physical display presentation. The MSE path
advertises received only; it does not claim decoder/render credit.

The negotiated rendered profile refunds cumulatively only through a held
rendered ID whose order does not exceed a held received ID. The received
profile refunds through held received IDs. Feedback is coalesced to 50 ms with
a one-second heartbeat; duplicate or old IDs are harmless.

Each viewer has at most six outstanding frames and 2 MiB ordinary payload.
One keyframe up to 4 MiB may use a separate burst allowance only when the window
is empty. A frame larger than 4 MiB closes that viewer. These bounds cover
application credits, not all browser/OS/kernel buffers; the WebSocket adapter
also retains its existing 4-MiB hard bufferedAmount limit.

When admission drops a frame, that viewer waits for a keyframe. Refresh requests
are limited to one per second. Control results/events bypass media credits.
Other viewers retain separate windows and recovery state.

## Recovery and pacing

Outstanding credit older than 1.5 seconds starts a new media handshake. A
receiver that never confirms ready closes after ten seconds. Three consecutive
recovery attempts without frame acknowledgement are allowed, then that
attachment closes with 1013. Only actual frame progress resets this attempt
budget. A quiet screen with no outstanding debt does not trigger recovery.
Hidden viewers are not diagnosed as stalled. Client recovery requests are
limited to one per generation.

WebCodecs queue/decode samples lower requested capture rate after three seconds
of sustained debt; twenty seconds of stable samples permit cautious recovery.
Idle periods are not capacity measurements. The Gateway uses the highest
requested rate among visible viewers, so a slow viewer cannot lower a faster
viewer to its own rate. Native input authority and renderer activity still
bound capture. This is frame-rate pacing, not codec bitrate adaptation.

## Formal boundary

CreditWindow models pending versus unknown outcomes, exact ACKs, item/byte
accounting and synchronized retirement. MediaRecovery models preserving old debt
until reset confirmation, stale feedback and finite recovery. Its liveness
property assumes weak fairness for admission, reset, confirmation/timeout
scheduling, visible receivers, and a receiver that makes no progress. Wall-clock
deadlines and real socket/decoder implementations are exercised in tests rather
than proved by TLC. The finite models are not an implementation refinement proof.

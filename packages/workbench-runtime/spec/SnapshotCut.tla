---------------------------- MODULE SnapshotCut ----------------------------
EXTENDS Integers
CONSTANT Fault
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "reading", server |-> 0, snapshot |-> -1,
  view |-> 0, notification |-> "none", delivered |-> FALSE,
  requestSeen |-> FALSE, requestWaiting |-> FALSE, requestDelivered |-> FALSE,
  requestLost |-> FALSE]
\* Persistence can advance beyond an already queued start observation. There
\* is no shared ordering token between a canonical Read and its notifications.
Start == /\ s.server = 0 /\ s.phase # "ready"
  /\ s' = [s EXCEPT !.server = 1]
Complete == /\ s.server = 1 /\ s.phase # "ready"
  /\ s' = [s EXCEPT !.server = 2]
Notify(kind) == /\ s.server >= 1 /\ ~s.delivered /\ s.phase # "ready"
  /\ s' = [s EXCEPT !.notification = kind, !.delivered = TRUE]
Request == /\ ~s.requestSeen /\ s.phase # "ready"
  /\ s' = [s EXCEPT !.requestSeen = TRUE, !.requestWaiting = TRUE]
Capture == /\ s.phase = "reading"
  /\ s' = [s EXCEPT !.phase = "captured", !.snapshot = s.server]
Overlap == s.notification # "none" /\ (Fault # "delta-only" \/ s.notification = "delta")
Reread == /\ s.phase = "captured" /\ Overlap
  /\ s' = [s EXCEPT !.phase = "reading", !.notification = "none",
    !.requestLost = @ \/ (Fault = "requests" /\ s.requestWaiting),
    !.requestWaiting = IF Fault = "requests" THEN FALSE ELSE @]
Release == /\ s.phase = "captured" /\ ~Overlap
  /\ s' = [s EXCEPT !.phase = "ready",
    !.view = IF s.notification = "none" THEN s.snapshot ELSE 1,
    !.requestDelivered = s.requestWaiting, !.requestWaiting = FALSE]
Next == Start \/ Complete \/ (\E kind \in {"delta", "lifecycle"}: Notify(kind))
  \/ Request \/ Capture \/ Reread \/ Release
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(Capture) /\ WF_vars(Reread) /\ WF_vars(Release)
TypeOK == /\ s.phase \in {"reading", "captured", "ready"}
  /\ s.server \in 0..2 /\ s.snapshot \in -1..2 /\ s.view \in 0..2
  /\ s.notification \in {"none", "delta", "lifecycle"} /\ s.delivered \in BOOLEAN
  /\ s.requestSeen \in BOOLEAN /\ s.requestWaiting \in BOOLEAN
  /\ s.requestDelivered \in BOOLEAN /\ s.requestLost \in BOOLEAN
CanonicalCut == s.phase = "ready" => s.view >= s.snapshot
RequestConserved == ~s.requestLost /\ (s.requestSeen => s.requestWaiting \/ s.requestDelivered)
ReadProgress == <>(s.phase = "ready")
=============================================================================

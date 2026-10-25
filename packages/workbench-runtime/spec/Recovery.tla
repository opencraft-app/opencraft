---------------------------- MODULE Recovery ----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS DropHint, HoldOldGate, AcceptOldGrant, CrossHostFailure,
          ReplayCommand, BypassBarrier
Hosts == {"a", "b"}
Epochs == {1, 2}
Phases == {"old", "wait", "dial", "ready", "blocked", "disposed"}
VARIABLE s
vars == <<s>>

\* One outage: A waits on old admission, B previously had an old lease.
\* The old logical admission may NEVER complete. Its physical barrier is separate.
Init == s = [net |-> FALSE, lost |-> FALSE, socket |-> 1,
  phase |-> [h \in Hosts |-> IF h = "a" THEN "old" ELSE "ready"],
  token |-> [h \in Hosts |-> 1], gate |-> [h \in Hosts |-> 1],
  leases |-> [h \in Hosts |-> IF h = "a" THEN {} ELSE {1}],
  age |-> [h \in Hosts |-> 0],
  barrier |-> [h \in Hosts |-> h = "b"],
  wake |-> {}, issued |-> {}, served |-> {}, started |-> {}, late |-> {},
  resumed |-> {}, baseline |-> 0, commands |-> 1,
  faulted |-> FALSE, badAdmission |-> FALSE, badCross |-> FALSE]

Eligible(h) == s.phase[h] \notin {"blocked", "disposed"}

LoseSocket == /\ ~s.lost
  /\ s' = [s EXCEPT !.lost = TRUE, !.socket = 0,
    !.leases = [h \in Hosts |-> {}], !.baseline = 0,
    !.phase = [h \in Hosts |-> IF s.phase[h] = "ready" THEN "wait" ELSE s.phase[h]],
    !.token = [h \in Hosts |-> IF s.phase[h] = "ready" THEN 0 ELSE s.token[h]]]

RecoverNetwork == /\ ~s.net /\ s' = [s EXCEPT !.net = TRUE]
OpenSocket == /\ s.lost /\ s.net /\ s.socket = 0
  /\ s' = [s EXCEPT !.socket = 2]
ReleaseBarrier(h) == /\ ~s.barrier[h]
  /\ s' = [s EXCEPT !.barrier[h] = TRUE]

Wake(h) == /\ Eligible(h) /\ h \notin s.issued
  /\ s' = [s EXCEPT !.issued = @ \cup {h},
    !.wake = IF s.phase[h] = "ready" /\ s.socket = 2 THEN @
      ELSE IF DropHint /\ s.phase[h] \in {"old", "dial"} THEN @ ELSE @ \cup {h},
    !.served = IF s.phase[h] = "ready" /\ s.socket = 2 THEN @ \cup {h} ELSE @]

Tick(h) == /\ s.phase[h] = "old" /\ s.age[h] < 2
  /\ s' = [s EXCEPT !.age[h] = @ + 1]
ResumeExpired(h) == /\ s.phase[h] = "old" /\ h \notin s.resumed
  /\ s' = [s EXCEPT !.age[h] = 2, !.resumed = @ \cup {h}]
TimeoutOld(h) == /\ s.phase[h] = "old" /\ s.age[h] = 2
  /\ s' = [s EXCEPT !.phase[h] = "wait", !.token[h] = 0,
    !.leases[h] = {}, !.baseline = IF h = "a" THEN 0 ELSE @]

\* Detach a retired LOCAL wait; do not manufacture physical barrier completion.
DetachOldGate(h) == /\ ~HoldOldGate /\ s.gate[h] = 1
  /\ ~(s.token[h] = 1 /\ s.phase[h] \in {"old", "ready"})
  /\ s' = [s EXCEPT !.gate[h] = 0]

StartNew(h) == /\ s.phase[h] = "wait" /\ h \notin s.started
  /\ s.socket = 2 /\ (s.barrier[h] \/ BypassBarrier)
  /\ s' = [s EXCEPT !.phase[h] = "dial", !.token[h] = 2,
    !.gate[h] = IF @ = 0 THEN 2 ELSE @, !.started = @ \cup {h},
    !.wake = @ \ {h}, !.served = IF h \in s.issued THEN @ \cup {h} ELSE @,
    !.badAdmission = @ \/ ~s.barrier[h]]
AttachNewGate(h) == /\ s.phase[h] = "dial" /\ s.gate[h] = 0
  /\ s.token[h] = 2 /\ s.barrier[h]
  /\ s' = [s EXCEPT !.gate[h] = 2]
Grant(h) == /\ s.phase[h] = "dial" /\ s.token[h] = 2
  /\ s.gate[h] = 2 /\ s.socket = 2 /\ s.net /\ s.barrier[h]
  /\ s' = [s EXCEPT !.phase[h] = "ready", !.leases[h] = {2},
    !.wake = @ \ {h}, !.served = IF h \in s.issued THEN @ \cup {h} ELSE @,
    !.commands = IF ReplayCommand /\ h = "a" THEN 2 ELSE @]
CatchUp == /\ s.phase["a"] = "ready" /\ s.leases["a"] = {2}
  /\ s.baseline # 2 /\ s' = [s EXCEPT !.baseline = 2]

LateGrant(h) == /\ s.phase[h] = "ready" /\ s.token[h] = 2
  /\ s.leases[h] = {2} /\ h \notin s.late
  /\ s' = [s EXCEPT !.late = @ \cup {h},
    !.leases[h] = IF AcceptOldGrant THEN @ \cup {1} ELSE @]

ManualBlock(h) == /\ s.phase[h] \in {"old", "wait", "dial"}
  /\ s' = [s EXCEPT !.phase[h] = "blocked", !.token[h] = 0,
    !.leases[h] = {}, !.wake = @ \ {h}, !.baseline = IF h = "a" THEN 0 ELSE @]
Dispose(h) == /\ s.phase[h] # "disposed"
  /\ s' = [s EXCEPT !.phase[h] = "disposed", !.token[h] = 0,
    !.leases[h] = {}, !.wake = @ \ {h}, !.baseline = IF h = "a" THEN 0 ELSE @]

\* A logical failure of B must not revoke the healthy A sharing its socket.
FaultB == /\ ~s.faulted /\ s.leases["a"] = {2} /\ s.phase["a"] = "ready"
  /\ s' = [s EXCEPT !.faulted = TRUE, !.badCross = CrossHostFailure,
    !.phase = [h \in Hosts |-> IF h = "b" THEN "blocked"
      ELSE IF CrossHostFailure THEN "wait" ELSE s.phase[h]],
    !.token = [h \in Hosts |-> IF h = "b" \/ CrossHostFailure THEN 0 ELSE s.token[h]],
    !.leases = [h \in Hosts |-> IF h = "b" \/ CrossHostFailure THEN {} ELSE s.leases[h]],
    !.wake = IF CrossHostFailure THEN {} ELSE @ \ {"b"},
    !.baseline = IF CrossHostFailure THEN 0 ELSE @]

Next == LoseSocket \/ RecoverNetwork \/ OpenSocket \/ CatchUp \/ FaultB
  \/ (\E h \in Hosts : ReleaseBarrier(h) \/ Wake(h) \/ Tick(h) \/ ResumeExpired(h)
    \/ TimeoutOld(h) \/ DetachOldGate(h) \/ StartNew(h) \/ AttachNewGate(h)
    \/ Grant(h) \/ LateGrant(h) \/ ManualBlock(h) \/ Dispose(h))
SafetySpec == Init /\ [][Next]_vars
FairSpec == SafetySpec /\ WF_vars(LoseSocket) /\ WF_vars(RecoverNetwork)
  /\ WF_vars(OpenSocket) /\ WF_vars(CatchUp)
  /\ (\A h \in Hosts : WF_vars(ReleaseBarrier(h)) /\ WF_vars(Tick(h))
    /\ WF_vars(TimeoutOld(h)) /\ WF_vars(DetachOldGate(h))
    /\ WF_vars(StartNew(h)) /\ WF_vars(AttachNewGate(h)) /\ WF_vars(Grant(h)))

TypeOK == /\ s.net \in BOOLEAN /\ s.lost \in BOOLEAN /\ s.socket \in 0..2
  /\ s.phase \in [Hosts -> Phases] /\ s.token \in [Hosts -> 0..2]
  /\ s.gate \in [Hosts -> 0..2] /\ s.leases \in [Hosts -> SUBSET Epochs]
  /\ s.age \in [Hosts -> 0..2] /\ s.barrier \in [Hosts -> BOOLEAN]
  /\ s.wake \subseteq Hosts /\ s.issued \subseteq Hosts /\ s.served \subseteq Hosts
  /\ s.started \subseteq Hosts /\ s.late \subseteq Hosts /\ s.resumed \subseteq Hosts
  /\ s.baseline \in 0..2 /\ s.commands \in 1..2
  /\ s.faulted \in BOOLEAN /\ s.badAdmission \in BOOLEAN /\ s.badCross \in BOOLEAN
SingleWriter == \A h \in Hosts : Cardinality(s.leases[h]) <= 1
FreshAuthority == \A h \in Hosts : \A e \in s.leases[h] :
  e = s.socket /\ e = s.token[h] /\ s.phase[h] = "ready"
ManualSafety == \A h \in Hosts : ~Eligible(h) =>
  s.leases[h] = {} /\ s.token[h] = 0 /\ h \notin s.wake
WakeConserved == \A h \in s.issued \ s.served : Eligible(h) => h \in s.wake
BaselineAuthority == s.baseline = 2 => s.leases["a"] = {2} /\ s.phase["a"] = "ready"
NoDuplicateCommand == s.commands = 1
PhysicalBarrier == ~s.badAdmission
HostIsolation == ~s.badCross
EventuallyEligible(h) == <>[](s.net /\ s.socket = 2 /\ s.barrier[h] /\ Eligible(h))
ConditionalRecovery == \A h \in Hosts : EventuallyEligible(h) => <>(s.leases[h] = {2})
ThreadRecovery == EventuallyEligible("a") => <>(s.baseline = 2)
NoHealthyRecoveryWitness == ~(s.net /\ s.socket = 2 /\ s.baseline = 2
  /\ (\A h \in Hosts : s.leases[h] = {2} /\ s.phase[h] = "ready"))
=============================================================================

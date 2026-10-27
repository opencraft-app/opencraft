---------------------- MODULE HostScopedIdentity ----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Layout, Outcome, Fault, FairLocal, FairProvider
Hosts == {"A", "B"}
None == "none"
Lease(h) == IF Layout = "shared" THEN "same" ELSE h
LogicalKey(h) == IF Fault = "flat-logical" THEN <<Lease(h)>> ELSE <<h, Lease(h)>>
LeaseKey(h) == IF Fault = "delimiter-key" /\ Layout = "delimiter"
 THEN <<"collision">> ELSE <<h, Lease(h)>>
LogicalKeys == {LogicalKey(h): h \in Hosts}
LeaseKeys == {LeaseKey(h): h \in Hosts}
VARIABLE s
vars == <<s>>
Init == s = [admitted |-> {}, retiring |-> {}, scheduled |-> {}, issued |-> {},
 nativeDone |-> {}, nativeLive |-> {}, settled |-> {}, fenced |-> {}, dropped |-> {},
 logical |-> [k \in LogicalKeys |-> None], leases |-> [k \in LeaseKeys |-> None],
 captured |-> [h \in Hosts |-> None], badNotification |-> FALSE]
Admit(h) == /\ h \notin s.admitted
 /\ s' = [s EXCEPT !.admitted = @ \cup {h}, !.nativeLive = @ \cup {h},
   !.logical[LogicalKey(h)] = h, !.leases[LeaseKey(h)] = h]
Release(h) == /\ h \in s.admitted \ s.retiring
 /\ s' = [s EXCEPT !.retiring = @ \cup {h}]
Detach == /\ s.admitted \ s.retiring # {}
 /\ s' = [s EXCEPT !.retiring = s.admitted]
Issue(h) == /\ h \in s.retiring \ s.scheduled
 /\ LET target == s.logical[LogicalKey(h)] IN
   s' = [s EXCEPT !.scheduled = @ \cup {h}, !.captured[h] = target,
     !.issued = IF target = None THEN @ ELSE @ \cup {target},
     !.badNotification = @ \/ (target # None /\ target # h)]
NativeFinish(h) == /\ h \in s.issued \ s.nativeDone
 /\ s' = [s EXCEPT !.nativeDone = @ \cup {h},
   !.nativeLive = IF Outcome = "success" THEN @ \ {h} ELSE @,
   !.fenced = IF Outcome = "failure" THEN @ \cup {h} ELSE @,
   !.logical = IF Outcome = "success" THEN
     [k \in LogicalKeys |-> IF (k = LogicalKey(h) /\ s.logical[k] = h)
       \/ (Fault = "forget-peer" /\ k # LogicalKey(h)) THEN None ELSE s.logical[k]] ELSE @]
Settle(h) == /\ h \in s.scheduled \ s.settled
 /\ (s.captured[h] = None \/ s.captured[h] \in s.nativeDone)
 /\ s' = [s EXCEPT !.settled = @ \cup {h}]
Echo(h) == /\ h \in s.admitted \ s.retiring
 /\ (s.leases[LeaseKey(h)] # h \/ h \notin s.nativeLive)
 /\ h \notin s.dropped
 /\ s' = [s EXCEPT !.dropped = @ \cup {h}]
Next == (\E h \in Hosts: Admit(h) \/ Release(h) \/ Issue(h)
 \/ NativeFinish(h) \/ Settle(h) \/ Echo(h)) \/ Detach
Spec == Init /\ [][Next]_vars
 /\ (IF FairLocal THEN \A h \in Hosts: WF_vars(Issue(h)) /\ WF_vars(Settle(h)) ELSE TRUE)
 /\ (IF FairProvider THEN \A h \in Hosts: WF_vars(NativeFinish(h)) ELSE TRUE)
TypeOK == /\ s.admitted \subseteq Hosts /\ s.retiring \subseteq s.admitted
 /\ s.scheduled \subseteq s.retiring /\ s.nativeDone \subseteq s.issued
 /\ s.issued \subseteq Hosts /\ s.nativeLive \subseteq s.admitted
 /\ s.logical \in [LogicalKeys -> Hosts \cup {None}]
 /\ s.leases \in [LeaseKeys -> Hosts \cup {None}]
RegistrationConserved == \A h \in s.admitted \ s.retiring: s.logical[LogicalKey(h)] = h
OwnNotification == ~s.badNotification
CurrentPeerAlive == s.admitted \ s.retiring \subseteq s.nativeLive
FencedOnlyRetired == s.fenced \subseteq s.retiring
NoDroppedCurrent == s.dropped = {}
CleanupProgress == \A h \in Hosts: (h \in s.retiring) ~> (h \in s.nativeDone)
CallerProgress == \A h \in Hosts: (h \in s.retiring) ~> (h \in s.settled)
=======================================================================
